// ---------------------------------------------------------------------------
// script-step-progression.ts
// ---------------------------------------------------------------------------
// Step-progression enforcement helpers for the daetradez 22-step script
// (and any operator script with a call-proposal stage).
//
// Two production failures motivate this module:
//
//  1. The script serializer dumps ALL of an account's script steps into
//     the system prompt every turn. The LLM sees Step 16 (call proposal)
//     while still on Step 2 and pattern-matches its way there, collapsing
//     a 22-step qualification flow into 4 exchanges (@daniel_elumelu
//     2026-05-08). The fix injects ONLY the current step + next step.
//
//  2. ScriptStep.completionRule is null for parsed scripts (the parser
//     doesn't synthesise rules), so isStepComplete defaults to TRUE for
//     every step and computeSystemStage just returns the last step.
//     Without a code-level gate, "the LLM thinks the call is appropriate"
//     is the only thing standing between a lukewarm lead and a premature
//     pitch. This module adds a hard gate keyed on capturedDataPoints.
//
// All helpers here are pure (no DB). Callers are ai-engine,
// script-serializer, and voice-quality-gate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CapturedDataPoints shape compatibility
// ---------------------------------------------------------------------------
// Two shapes coexist in Conversation.capturedDataPoints:
//   - structured (script-state-recovery): { key: { value, confidence } }
//   - flat (runtime-judgment captures): { key: "string" }
// hasCapturedDataPoint accepts both so the prereq gate doesn't care
// which pipeline wrote the value.
// ---------------------------------------------------------------------------

export function hasCapturedDataPoint(
  points: Record<string, unknown> | null | undefined,
  key: string
): boolean {
  if (!points) return false;
  const raw = points[key];
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'string') return raw.trim().length > 0;
  if (typeof raw === 'number') return Number.isFinite(raw);
  if (typeof raw === 'boolean') return raw === true;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const wrapped = raw as Record<string, unknown>;
    if (!('value' in wrapped)) return false;
    const v = wrapped.value;
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'boolean') return v === true;
    return Boolean(v);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Call-proposal prereq gate
// ---------------------------------------------------------------------------

/**
 * Each prereq has a list of acceptable keys — ANY captured key in the
 * list satisfies the prereq. Models the "obstacle OR early_obstacle"
 * and "deepWhy OR desiredOutcome" cases from the daetradez spec.
 */
export interface CallProposalPrereq {
  /** Stable id used in regen directives + audit logs. */
  id: string;
  /** Human label for the regen directive shown to the LLM. */
  label: string;
  /** Step number the operator script asks this in (1-indexed). */
  stepNumber: number;
  /** Any-of: at least one of these keys must be captured. */
  acceptableKeys: string[];
}

/**
 * Daetradez script call-proposal prerequisites — the eight data points
 * that MUST exist on the conversation before Step 16 can fire. If any
 * is missing when the AI emits call-proposal language, the gate blocks
 * the reply and forces a regen back to the first missing prereq.
 *
 * Order matches script step order so the regen directive can point to
 * the earliest missing step.
 */
export const CALL_PROPOSAL_PREREQS: CallProposalPrereq[] = [
  {
    id: 'work_background',
    label: "lead's job / current work situation",
    stepNumber: 5,
    acceptableKeys: ['workBackground', 'work_background', 'job']
  },
  {
    id: 'monthly_income',
    label:
      "lead's monthly income (or explicit skip per Step 7 judge condition)",
    stepNumber: 7,
    acceptableKeys: [
      'monthlyIncome',
      'monthly_income',
      'incomeMonthly',
      'monthlyIncomeSkipped',
      'monthly_income_skipped'
    ]
  },
  {
    id: 'replace_or_supplement',
    label: 'whether trading is meant to replace the job or supplement it',
    stepNumber: 8,
    acceptableKeys: ['replaceOrSupplement', 'replace_or_supplement']
  },
  {
    id: 'income_goal',
    label: "lead's monthly income goal from trading",
    stepNumber: 9,
    acceptableKeys: ['incomeGoal', 'income_goal']
  },
  {
    id: 'desired_outcome_or_deep_why',
    label:
      "lead's deeper why / desired outcome (the personal reason behind the goal)",
    stepNumber: 10,
    acceptableKeys: ['desiredOutcome', 'desired_outcome', 'deepWhy', 'deep_why']
  },
  {
    id: 'obstacle',
    label: "lead's main obstacle (specific, not a one-word answer)",
    stepNumber: 12,
    acceptableKeys: ['obstacle', 'early_obstacle', 'earlyObstacle']
  },
  {
    id: 'belief_break_delivered',
    label: 'belief-break / reframe message delivered (Step 13)',
    stepNumber: 13,
    acceptableKeys: ['beliefBreakDelivered', 'belief_break_delivered']
  },
  {
    id: 'buy_in_confirmed',
    label: 'buy-in confirmed (Step 14 — clear yes to the reframe)',
    stepNumber: 14,
    acceptableKeys: ['buyInConfirmed', 'buy_in_confirmed']
  }
];

/**
 * Returns the prereqs (in script-step order) that have NO captured
 * value yet. Empty array means all prereqs are satisfied and call
 * proposal is allowed.
 */
export function checkCallProposalPrereqs(
  points: Record<string, unknown> | null | undefined
): CallProposalPrereq[] {
  return CALL_PROPOSAL_PREREQS.filter(
    (prereq) =>
      !prereq.acceptableKeys.some((key) => hasCapturedDataPoint(points, key))
  );
}

// ---------------------------------------------------------------------------
// Call-proposal attempt detection
// ---------------------------------------------------------------------------

/**
 * Heuristic detection that the AI's reply is attempting to propose a
 * call (Step 16 / Step 17). Used by the gate to know when to apply the
 * prereq check. Conservative: false-negative is preferred (let
 * legitimate proposals through after prereqs are met) over false-
 * positive (gate blocking unrelated language).
 */
const CALL_PROPOSAL_PATTERNS: RegExp[] = [
  // "set up a (quick) call/chat/time with..." — matches the daetradez
  // Step 16 default branch ("set up a time with my right hand guy Anthony").
  /\bset\s+up\s+a\s+(quick\s+)?(call|chat|convo|conversation|zoom|time)\b/i,
  // "hop on / jump on / get on a (quick) call/chat" and the simpler
  // "book(ing) / schedule a call/chat".
  /\b(book(ing)?|schedule|hop(ping)?\s*on|jump(ing)?\s*on|get\s*you\s*on|get\s*on)\s+a?\s*(quick\s+)?(call|chat|convo|conversation|zoom)\b/i,
  // Bare "quick call / 15-min chat" anywhere in the message.
  /\b(quick|15[\s-]?min(ute)?)\s+(call|chat|convo)\b/i,
  // "call/chat with my right-hand / Anthony" — direct closer mentions.
  /\b(call|chat|time)\s+with\s+(my\s+(right.?hand|partner|head\s+coach|business\s+partner|closer)|anthony)\b/i,
  // Closer-handoff phrases that don't include "call" but clearly route
  // toward the booking handoff. Covers Step 16 ("set up a time with my
  // right hand guy Anthony to break down a roadmap"), Step 20 ("locked
  // in with my head coach Anthony"), and the Step 16-alt branch
  // ("set you up with my right hand guy").
  /\bset\s+(you\s+)?up\s+(a\s+time\s+)?with\s+(my\s+)?(right.?hand|head\s+coach|partner|anthony|closer)\b/i,
  /\blocked\s+in\s+with\s+(my\s+)?(right.?hand|head\s+coach|partner|anthony|closer)\b/i,
  // Typeform / booking-link delivery is the scheduling trigger.
  /\b(typeform|booking\s+link|application\s+link)\b/i
];

export function detectCallProposalAttempt(reply: string): boolean {
  if (!reply || typeof reply !== 'string') return false;
  return CALL_PROPOSAL_PATTERNS.some((p) => p.test(reply));
}

// ---------------------------------------------------------------------------
// Belief-break detection
// ---------------------------------------------------------------------------
// Step 13 (belief break / reframe) is critical to the daetradez script's
// authority shift. Two distinct messages signal it landed:
//   (a) Psychology / Discipline branch: "99% of traders ... actually
//       don't know what the real problem is" plus the systems-vs-
//       discipline reframe.
//   (b) Beginner branch: "Brother that's totally normal ... you're not
//       carrying all the bad habits..."
// We watch the AI's emitted history; once either fires, set
// capturedDataPoints.beliefBreakDelivered = true so the call-proposal
// gate can clear that prereq.

const BELIEF_BREAK_TRIGGER_PATTERNS: RegExp[] = [
  // Psychology/Discipline branch
  /\b99%\s+of\s+traders\b/i,
  /\bdon'?t\s+know\s+what\s+the\s+real\s+problem\s+is\b/i,
  /\bdiscipline\s+takes\s+time\s+to\s+build\b/i,
  /\bsystems?\s+you\s+have\s+in\s+place\b/i,
  // Beginner / Overwhelmed branch
  /\bthat'?s\s+totally\s+normal\b.{0,80}\b(bad\s+habits|first\s+step)\b/i,
  /\bnot\s+carrying\s+all\s+the\s+bad\s+habits\b/i,
  /\bgood\s+spot\s+to\s+be\s+in\s+because\b/i
];

export function detectBeliefBreakInMessage(message: string): boolean {
  if (!message || typeof message !== 'string') return false;
  return BELIEF_BREAK_TRIGGER_PATTERNS.some((p) => p.test(message));
}

export function detectBeliefBreakDelivered(
  aiMessages: Array<{ content: string | null | undefined }>
): boolean {
  if (!Array.isArray(aiMessages)) return false;
  for (const m of aiMessages) {
    if (
      typeof m?.content === 'string' &&
      detectBeliefBreakInMessage(m.content)
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Current-step scoping
// ---------------------------------------------------------------------------

/**
 * Compact step shape the serializer + ai-engine pass into the prompt
 * builder. Keeps script-serializer.ts decoupled from Prisma types.
 */
export interface CompactScriptAction {
  actionType: string;
  content?: string | null;
  linkUrl?: string | null;
  linkLabel?: string | null;
  waitDuration?: number | null;
}

export interface CompactScriptBranch {
  branchLabel: string;
  conditionDescription?: string | null;
  actions: CompactScriptAction[];
}

export interface CompactScriptStep {
  stepNumber: number;
  title: string;
  objective?: string | null;
  canonicalQuestion?: string | null;
  directActions: CompactScriptAction[];
  branches: CompactScriptBranch[];
}

const ACTION_TAG: Record<string, string> = {
  send_message: 'MSG',
  ask_question: 'ASK',
  send_voice_note: 'VOICE NOTE',
  send_link: 'LINK',
  send_video: 'VIDEO',
  form_reference: 'FORM',
  runtime_judgment: 'JUDGE',
  wait_for_response: 'WAIT',
  wait_duration: 'WAIT'
};

function formatCompactAction(action: CompactScriptAction): string {
  const tag = ACTION_TAG[action.actionType] || action.actionType.toUpperCase();
  switch (action.actionType) {
    case 'send_message':
    case 'ask_question':
      return `[${tag}] ${action.content || '(empty)'}`;
    case 'runtime_judgment':
      return `[${tag}] ${action.content || 'Use your judgment'}`;
    case 'send_link':
    case 'send_video':
      if (action.linkUrl) {
        return `[${tag}] ${action.linkLabel || action.content || 'Link'}: ${action.linkUrl}`;
      }
      return `[${tag}] ${action.content || '(URL not yet configured)'}`;
    case 'wait_for_response':
      return `[${tag}] Wait for response`;
    case 'wait_duration':
      return `[${tag}] Wait ${action.waitDuration ?? 0} seconds`;
    default:
      return `[${tag}] ${action.content || ''}`;
  }
}

function renderStepLines(step: CompactScriptStep, indent = '  '): string[] {
  const lines: string[] = [];
  lines.push(`${indent}Step ${step.stepNumber}: ${step.title}`);
  if (step.objective && step.objective.trim().length > 0) {
    lines.push(`${indent}Objective: ${step.objective.trim()}`);
  }
  if (step.canonicalQuestion && step.canonicalQuestion.trim().length > 0) {
    lines.push(`${indent}Canonical question: ${step.canonicalQuestion.trim()}`);
  }
  if (step.directActions.length > 0) {
    for (const a of step.directActions) {
      lines.push(`${indent}  ${formatCompactAction(a)}`);
    }
  }
  for (const branch of step.branches) {
    const cond = branch.conditionDescription
      ? ` (${branch.conditionDescription})`
      : '';
    lines.push(`${indent}  IF ${branch.branchLabel}${cond}:`);
    for (const a of branch.actions) {
      lines.push(`${indent}    ${formatCompactAction(a)}`);
    }
  }
  return lines;
}

/**
 * Renders the focused step block: CURRENT + NEXT only. Replaces the
 * legacy "all 22 steps" dump that lets the LLM pattern-match its way
 * to step 16. Returns null when there's nothing to show.
 */
export function buildCurrentStepBlock(
  currentStep: CompactScriptStep | null,
  nextStep: CompactScriptStep | null
): string | null {
  if (!currentStep && !nextStep) return null;

  const parts: string[] = [
    '## Script Framework — CURRENT STEP ONLY',
    '',
    "You are working through a multi-step qualification script. Below is your CURRENT step and a brief preview of the NEXT step. Subsequent steps are intentionally hidden — DO NOT improvise your way to a later stage of the script. Complete the current step, wait for the lead's reply, then advance to the next step on the next turn.",
    '',
    'IMPORTANT: When a [MSG] action has explicit content, use that content verbatim or near-verbatim — do not paraphrase into a different shape. When [ASK] has explicit content, use that exact question (light wording adjustments OK to match flow). Do not skip a step\'s [JUDGE], [MSG], or [ASK] just because the lead\'s last message could "pattern-match" a later stage.',
    ''
  ];

  if (currentStep) {
    parts.push('CURRENT STEP:');
    parts.push(...renderStepLines(currentStep, '  '));
  }

  if (nextStep) {
    parts.push('');
    parts.push(
      "NEXT STEP (preview — fire only AFTER current step's [WAIT] resolves):"
    );
    parts.push(...renderStepLines(nextStep, '  '));
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Silent-branch enforcement (Step 4 "Obstacle given — detailed and emotional"
// pattern)
// ---------------------------------------------------------------------------
// Some script branches end with [MSG] + [WAIT] and have NO [ASK]. The
// operator's intent is "acknowledge what the lead just shared and SIT IN
// THE MOMENT — the lead will keep talking on their own". When the AI
// improvises a follow-up question on those branches, it kills the
// emotional disclosure mid-flight (@daniel_elumelu Turn 2/3 incident
// 2026-05-08). The helpers below let the gate detect:
//
//   1. The current step contains at least one branch shaped like
//      [MSG] + [WAIT] with no [ASK] (a "silent branch").
//   2. The list of scripted [ASK] question texts across all branches in
//      the current step — used to flag improvised off-script questions.
// ---------------------------------------------------------------------------

export interface StepActionShape {
  /**
   * True when at least one branch in the step has [MSG]/[WAIT] actions
   * but NO [ASK] action. Operator's intent on that branch is "send the
   * acknowledgment, end on a statement, do not append a question".
   */
  hasSilentBranch: boolean;
  /**
   * True when at least one branch in the step has any [ASK] action.
   * Used to relax the no-question rule when the step does want a
   * question on the branch the LLM is taking.
   */
  hasAnyAskAction: boolean;
  /** Concatenated [ASK] content strings across branches (for off-script comparison). */
  scriptedQuestionContents: string[];
  /** Branch labels that are silent (for prompt directive + audit log). */
  silentBranchLabels: string[];
}

interface MinimalStep {
  stepNumber: number;
  actions: Array<{
    actionType: string;
    content?: string | null;
  }>;
  branches: Array<{
    branchLabel: string;
    actions: Array<{
      actionType: string;
      content?: string | null;
    }>;
  }>;
}

/**
 * Pure-data: derives the action shape for a given step number. Pass an
 * already-loaded script (from script-serializer's query) so this stays
 * synchronous and DB-free.
 */
export function getStepActionShape(
  script: { steps: MinimalStep[] } | null,
  stepNumber: number
): StepActionShape | null {
  if (!script) return null;
  const step = script.steps.find((s) => s.stepNumber === stepNumber);
  if (!step) return null;

  const allBranches: Array<{
    label: string;
    actions: Array<{ actionType: string; content?: string | null }>;
  }> = [];
  if (step.actions.length > 0) {
    allBranches.push({ label: '__direct__', actions: step.actions });
  }
  for (const branch of step.branches) {
    allBranches.push({ label: branch.branchLabel, actions: branch.actions });
  }

  const silentBranchLabels: string[] = [];
  const scriptedQuestionContents: string[] = [];
  let hasAnyAskAction = false;

  for (const branch of allBranches) {
    const askActions = branch.actions.filter(
      (a) => a.actionType === 'ask_question'
    );
    const msgActions = branch.actions.filter(
      (a) => a.actionType === 'send_message'
    );
    const waitActions = branch.actions.filter(
      (a) => a.actionType === 'wait_for_response'
    );
    if (askActions.length > 0) {
      hasAnyAskAction = true;
      for (const a of askActions) {
        if (typeof a.content === 'string' && a.content.trim().length > 0) {
          scriptedQuestionContents.push(a.content.trim());
        }
      }
    } else if (
      msgActions.length > 0 &&
      waitActions.length > 0 &&
      branch.label !== '__direct__'
    ) {
      // Silent branch: operator wrote acknowledgment + wait, no question.
      silentBranchLabels.push(branch.label);
    }
  }

  return {
    hasSilentBranch: silentBranchLabels.length > 0,
    hasAnyAskAction,
    scriptedQuestionContents,
    silentBranchLabels
  };
}

// ---------------------------------------------------------------------------
// Step-10 (Deep Why) enforcement
// ---------------------------------------------------------------------------
// Step 10 — "Desired Outcome — Deep Why" — captures the lead's emotional
// reason behind their income goal. Without this, the call proposal lands
// without a hook AND the script's belief-break + soft-pitch beats lose
// their leverage. Production drift (@tegaumukoro_ 2026-05-08): AI was
// jumping from Step 9 (income goal captured) directly to Step 12
// (obstacle identification) because the LLM picked up Step 12's
// "if obstacle already stored → skip to Step 13" rule and conflated
// the early_obstacle (captured at Step 2) with the deliberate Step 12
// obstacle ask.
//
// The detector + gate below force Step 10 to fire BEFORE any Step 12+
// content is allowed once incomeGoal is captured.

/**
 * Phrases that signal the AI is trying to advance past Step 10.
 *   - obstacle re-ask shapes (Step 12)
 *   - belief-break / reframe openers (Step 13)
 *   - buy-in confirmation language (Step 14)
 *   - urgency ask (Step 15)
 *   - call-proposal language (Step 16) — also covered by
 *     detectCallProposalAttempt; included here for completeness.
 */
const STEP_12_PLUS_PATTERNS: RegExp[] = [
  // Step 12: explicit obstacle re-ask
  /\bwhat\s+(do\s+you\s+feel|would\s+you\s+say)\s+is\s+(the\s+)?main\s+(thing|obstacle)\s+holding\s+you\s+back\b/i,
  /\bmain\s+(thing|obstacle)\s+(stopping|holding)\s+you\b/i,
  // Step 13: belief-break openers
  /\b99%\s+of\s+traders\b/i,
  /\bdon'?t\s+know\s+what\s+the\s+real\s+problem\s+is\b/i,
  /\bsystems?\s+you\s+have\s+in\s+place\b/i,
  /\bthat'?s\s+totally\s+normal\b.{0,80}\bbad\s+habits\b/i,
  // Step 14: buy-in confirmation phrasing
  /\bwould\s+(that|having)\s+(kind\s+of\s+)?(structure|system|guidance)\s+(help|change)\b/i,
  // Step 15: urgency ask shapes
  /\bis\s+now\s+the\s+time\s+to\s+(actually\s+)?overcome\b/i
];

export function detectStep12PlusContent(reply: string): boolean {
  if (!reply || typeof reply !== 'string') return false;
  if (STEP_12_PLUS_PATTERNS.some((p) => p.test(reply))) return true;
  // Step 16 call-proposal language is its own category but also blocks
  // Step 10 when fired prematurely.
  return detectCallProposalAttempt(reply);
}

/**
 * Returns true when the AI's reply attempts to advance past Step 10
 * but the lead's emotional why has not been captured. Combined check:
 *   - reply contains Step 12+ shaped content
 *   - capturedDataPoints has incomeGoal (Step 9 done)
 *   - capturedDataPoints does NOT have deepWhy / desiredOutcome (Step 10 skipped)
 */
export function detectStep10Skipped(
  reply: string,
  capturedDataPoints: Record<string, unknown> | null | undefined
): boolean {
  if (!detectStep12PlusContent(reply)) return false;
  const incomeGoalPresent =
    hasCapturedDataPoint(capturedDataPoints, 'incomeGoal') ||
    hasCapturedDataPoint(capturedDataPoints, 'income_goal');
  if (!incomeGoalPresent) return false;
  const deepWhyPresent =
    hasCapturedDataPoint(capturedDataPoints, 'deepWhy') ||
    hasCapturedDataPoint(capturedDataPoints, 'deep_why') ||
    hasCapturedDataPoint(capturedDataPoints, 'desiredOutcome') ||
    hasCapturedDataPoint(capturedDataPoints, 'desired_outcome');
  return !deepWhyPresent;
}

// ---------------------------------------------------------------------------
// Acknowledgment-opener detection
// ---------------------------------------------------------------------------
// When a reply starts with an emotional acknowledgment phrase AND the
// current step contains a silent branch, that's a strong signal the AI
// took the silent branch — but if the reply also contains a `?`, the
// AI is violating the operator's "sit in the moment" instruction.

const ACKNOWLEDGMENT_OPENER_PATTERNS: RegExp[] = [
  /^that'?s\s+(real|heavy|tough|deep|crazy|wild|a\s+lot)\b/i,
  /^(i\s+)?hear\s+you\b/i,
  /^(i\s+)?feel\s+you\b/i,
  /^respect\s+(that|you)\b/i,
  /^appreciate\s+(you|that)\b/i,
  /^damn\s+bro\b/i,
  /^that\s+takes\s+real\b/i,
  /^genuinely\s+(respect|appreciate|hear)\b/i,
  /^thank\s+you\s+for\s+(sharing|opening)\b/i,
  /^(makes\s+sense|gotcha)\b/i
];

export function detectAcknowledgmentOpener(reply: string): boolean {
  if (!reply || typeof reply !== 'string') return false;
  const trimmed = reply.trim();
  return ACKNOWLEDGMENT_OPENER_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Question detection helpers
// ---------------------------------------------------------------------------

export function countQuestionMarks(reply: string): number {
  if (!reply || typeof reply !== 'string') return 0;
  return (reply.match(/\?/g) || []).length;
}

export function containsQuestion(reply: string): boolean {
  return countQuestionMarks(reply) > 0;
}

// ---------------------------------------------------------------------------
// Off-script question detection (Jaccard word overlap)
// ---------------------------------------------------------------------------
// When the current step has scripted [ASK] content AND the AI emits a
// question, compare their word sets. Low overlap = AI is improvising a
// different question. Fires as a SOFT signal (not hard) to allow
// reasonable paraphrase while penalising inventing pain-future-pacing
// questions that aren't in the script anywhere.

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'does',
  'for',
  'from',
  'have',
  'has',
  'i',
  'if',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'their',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'with',
  'you',
  'your',
  'how',
  'why',
  'who',
  'which',
  'whose',
  'about',
  'after',
  'all',
  'any',
  'been',
  'being',
  'can',
  'could',
  'did',
  'down',
  'each',
  'few',
  'had',
  'he',
  'her',
  'here',
  'him',
  'his',
  'just',
  'like',
  'm',
  'more',
  'most',
  'no',
  'not',
  'now',
  'off',
  'one',
  'only',
  'other',
  'our',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'some',
  'such',
  'than',
  'them',
  'then',
  'there',
  'these',
  'those',
  'through',
  'too',
  'up',
  'very',
  'will',
  'would',
  'bro',
  'man',
  'tho',
  'yeah',
  'yo'
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  );
}

export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  setA.forEach((w) => {
    if (setB.has(w)) intersection++;
  });
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Returns the maximum Jaccard similarity between the reply's question
 * sentences and any scripted [ASK] content. Used to flag improvised
 * off-script questions when similarity is below a threshold (e.g. 0.2).
 */
export function maxQuestionSimilarityToScript(
  reply: string,
  scriptedQuestions: string[]
): number {
  if (scriptedQuestions.length === 0) return 1; // no script to compare against
  const replyQuestions = reply
    .split(/(?<=[.?!])\s+/)
    .filter((s) => s.includes('?'));
  if (replyQuestions.length === 0) return 1;
  let maxSim = 0;
  for (const replyQ of replyQuestions) {
    for (const scriptQ of scriptedQuestions) {
      const sim = jaccardSimilarity(replyQ, scriptQ);
      if (sim > maxSim) maxSim = sim;
    }
  }
  return maxSim;
}

/**
 * Returns the array index of the step that the AI should be working
 * on right now. Heuristic, robust to missing completionRule:
 *
 *   1. If the snapshot's currentScriptStep > 1 AND that step exists in
 *      the script, use it. (script-state-recovery is the source of
 *      truth when it has signal.)
 *   2. Else fall back to a floor: the AI message count (each scripted
 *      [ASK]+[WAIT] pair consumes one AI turn, so floor = AI turns
 *      sent so far + 1, capped at script length).
 *   3. Always at least 1 (Step 1).
 *
 * The result is a stepNumber, NOT a zero-indexed array index.
 */
export function inferCurrentStepNumber(params: {
  snapshotCurrentStep: number | null | undefined;
  totalSteps: number;
  aiMessageCount: number;
}): number {
  const { snapshotCurrentStep, totalSteps, aiMessageCount } = params;
  const lastStep = Math.max(1, totalSteps);
  const floor = Math.min(lastStep, Math.max(1, aiMessageCount + 1));
  if (
    typeof snapshotCurrentStep !== 'number' ||
    snapshotCurrentStep <= 0 ||
    snapshotCurrentStep > lastStep
  ) {
    return floor;
  }
  // Stale-snapshot guard (bug-26): with completionRule defaulting to
  // INCOMPLETE for parsed scripts, computeSystemStage returns Step 1
  // even when the AI has progressed several turns past it. When the
  // snapshot says Step 1 but AI turns have happened, trust the
  // AI-turn floor instead.
  if (snapshotCurrentStep === 1 && aiMessageCount >= 2) {
    return floor;
  }
  // Snapshot is trustworthy (> 1) — cap at AI-turn floor so a faulty
  // all-complete reading can't push the AI past where the conversation
  // has actually been.
  return Math.min(snapshotCurrentStep, floor);
}
