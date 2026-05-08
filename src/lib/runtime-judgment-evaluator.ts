// ---------------------------------------------------------------------------
// runtime-judgment-evaluator.ts
// ---------------------------------------------------------------------------
// Pure helpers for the Runtime Judgment system. Operators write judgments
// into ScriptAction.content like:
//
//   "If their reply mentions a struggle, frustration, or obstacle
//    unprompted → store as {{early_obstacle}}. Someone who volunteers
//    their pain without being asked is significantly warmer than
//    someone who is closed off — treat them accordingly, they're
//    giving you an open door."
//
// Before this module existed, that text was injected into the prompt
// but the LLM had no schema slot to record the captured value, and no
// directive telling it to PAUSE the linear script and respond to the
// signal. Result: the AI acknowledged the pain once and pivoted to the
// next scripted question, ignoring the open door.
//
// This module:
//   1. Extracts {{variable}} names from judgment content.
//   2. Renders a structured prompt block that instructs the LLM to
//      populate `captured_data_points` in its JSON response when a
//      judgment fires, AND to go deeper on the signal before advancing.
//   3. Parses + merges the LLM's `captured_data_points` field safely.
//   4. Renders a "prior captured signals" context block on subsequent
//      turns so the LLM keeps referencing the signal.
//
// Pure (no DB). All Prisma I/O lives in callers (ai-engine,
// script-serializer). Tests exercise these helpers directly.
// ---------------------------------------------------------------------------

/** Matches `{{variable_name}}` (snake or camel). Captures the var name. */
const VARIABLE_PATTERN = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;

export interface RuntimeJudgmentInput {
  /** Step number for operator-facing labelling in the prompt block. */
  stepNumber: number;
  /** Optional branch label / condition if the judgment lives in a branch. */
  branchLabel?: string | null;
  /** Raw judgment instruction text from ScriptAction.content. */
  content: string;
}

export interface ParsedRuntimeJudgment extends RuntimeJudgmentInput {
  /** Variable names referenced via {{var}} in `content`. */
  variableNames: string[];
}

// ---------------------------------------------------------------------------
// Variable extraction
// ---------------------------------------------------------------------------

/**
 * Pulls {{variable}} names out of a runtime judgment content string. Returns
 * a deduped, ordered list. Whitespace inside braces (e.g. "{{ early_obstacle }}")
 * is intentionally rejected — placeholders are normalised in the upstream
 * script editor and trimmed names belong elsewhere (free-text descriptions).
 */
export function extractVariableNames(
  content: string | null | undefined
): string[] {
  if (!content) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  // Reset state — global regex retains lastIndex across calls.
  VARIABLE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VARIABLE_PATTERN.exec(content)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Annotate a list of judgments with their referenced variable names. */
export function parseRuntimeJudgments(
  inputs: RuntimeJudgmentInput[]
): ParsedRuntimeJudgment[] {
  return inputs
    .filter((j) => typeof j.content === 'string' && j.content.trim().length > 0)
    .map((j) => ({
      ...j,
      variableNames: extractVariableNames(j.content)
    }));
}

// ---------------------------------------------------------------------------
// Prompt block builder — variable capture & behavioral adaptation
// ---------------------------------------------------------------------------

/**
 * Renders the structured prompt block that teaches the LLM:
 *   (a) WHEN a runtime judgment matches the lead's most recent message,
 *       populate `captured_data_points` in its JSON response with the
 *       variable name → captured phrase.
 *   (b) When a judgment fires, DO NOT advance to the next scripted step on
 *       this turn. Respond to the signal first — go deeper on the lead's
 *       disclosure with a follow-up. Reference the captured phrase
 *       naturally; don't acknowledge-and-pivot.
 *
 * Returns null when there are no judgments containing {{variable}} refs —
 * judgments without variables stay in the pre-existing "Runtime Judgment
 * Instructions" block (no behavior change for those).
 */
export function buildRuntimeJudgmentBlock(
  judgments: ParsedRuntimeJudgment[]
): string | null {
  const judgmentsWithVars = judgments.filter((j) => j.variableNames.length > 0);
  if (judgmentsWithVars.length === 0) return null;

  const lines: string[] = [
    '## RUNTIME JUDGMENT — VARIABLE CAPTURE & BEHAVIORAL ADAPTATION',
    '',
    "The active script contains runtime judgments that monitor for specific signals in the lead's messages. Evaluate EACH of the judgments below against the lead's most recent reply on every turn.",
    '',
    'WHEN ANY JUDGMENT FIRES:',
    '  1. In your JSON response, populate `captured_data_points` with an entry for each {{variable}} mentioned in the judgment. The value is the lead\'s exact relevant phrase (or a short paraphrase if their phrasing is long), e.g. `{"early_obstacle": "can\'t stop blowing accounts, frustrating"}`.',
    '  2. DO NOT advance to the next scripted step on this turn. The judgment is a signal that overrides linear flow.',
    "  3. Your reply MUST go DEEPER on the lead's disclosure with a focused follow-up — reference the specific phrase or detail they shared. Do NOT acknowledge-and-pivot to the next script question.",
    '  4. After the lead replies to your follow-up, resume the script.',
    '',
    'WHEN NO JUDGMENT FIRES: omit `captured_data_points` (or set it to {}) and continue with the script as normal.',
    '',
    'ACTIVE JUDGMENTS:'
  ];

  for (const j of judgmentsWithVars) {
    const varList = j.variableNames.map((v) => `{{${v}}}`).join(', ');
    const branchPrefix = j.branchLabel ? `[branch: ${j.branchLabel}] ` : '';
    lines.push(`  - Step ${j.stepNumber} ${branchPrefix}— captures ${varList}`);
    // Indent each line of the judgment content for readability in the
    // rendered prompt.
    for (const contentLine of j.content.split(/\r?\n/)) {
      lines.push(`      ${contentLine.trim()}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Safely pulls `captured_data_points` from an LLM JSON response. Accepts
 * any object shape the LLM might emit and normalises it into a flat
 * Record<string, string>. Non-string values are coerced via String().
 * Empty strings are dropped. Returns null when nothing usable is present.
 */
export function parseCapturedDataPointsFromResponse(
  raw: unknown
): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.trim().length === 0) continue;
    if (value === null || value === undefined) continue;
    const str = typeof value === 'string' ? value : String(value);
    const trimmed = str.trim();
    if (trimmed.length === 0) continue;
    out[key] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merge incoming captures into the existing capturedDataPoints record.
 * Newer non-empty values overwrite older ones (operator's intent: the
 * most recent disclosure is the freshest signal). Existing keys NOT
 * present in `incoming` are preserved as-is. Returns a new object —
 * does not mutate inputs.
 */
export function mergeCapturedDataPoints(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, string> | null | undefined
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...existing }
      : {};
  if (!incoming) return base;
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    base[key] = value;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Prior captured signals — next-turn context block
// ---------------------------------------------------------------------------

/**
 * Renders a context block that tells the LLM "you previously captured these
 * signals from this lead — keep them in mind on this turn." Filtered to the
 * variable names that judgments actually reference, so unrelated structured
 * fields (verifiedCapitalUsd, incomeGoal, etc.) don't pollute the block.
 *
 * Returns null when no relevant captures exist.
 */
export function buildPriorCapturedSignalsBlock(
  capturedDataPoints: Record<string, unknown> | null | undefined,
  knownVariableNames: string[]
): string | null {
  if (!capturedDataPoints || knownVariableNames.length === 0) return null;
  const known = new Set(knownVariableNames);
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(capturedDataPoints)) {
    if (!known.has(key)) continue;
    if (value === null || value === undefined) continue;
    const str = typeof value === 'string' ? value : String(value);
    const trimmed = str.trim();
    if (trimmed.length === 0) continue;
    entries.push([key, trimmed]);
  }
  if (entries.length === 0) return null;

  const lines: string[] = [
    '## PRIOR CAPTURED SIGNALS (from earlier turns)',
    '',
    "You have already captured these signals from this lead in previous turns. Reference them naturally when relevant — do NOT re-extract them, do NOT re-ask, and do NOT pretend you don't know them.",
    ''
  ];
  for (const [key, value] of entries) {
    lines.push(`  - {{${key}}}: ${value}`);
  }
  return lines.join('\n');
}
