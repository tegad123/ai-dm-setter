// ---------------------------------------------------------------------------
// script-parser.ts
// ---------------------------------------------------------------------------
// Parses a user-written script in the standardized markdown format into
// structured ParsedScript data. Also handles text extraction from .docx files.
//
// Self-contained LLM call logic — does NOT import from ai-engine.ts to avoid
// touching the production conversation path.
// ---------------------------------------------------------------------------

import { getCredentials } from '@/lib/credential-store';
import type { ScriptActionType } from '@/lib/script-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedAction {
  actionType: ScriptActionType;
  content: string | null;
  linkLabel: string | null;
  linkUrl: string | null;
  waitDuration: number | null;
  formRefName: string | null;
  confidence: 'high' | 'medium' | 'low';
  status: 'filled' | 'needs_review' | 'needs_user_input';
}

export interface ParsedBranch {
  label: string;
  conditionDescription: string | null;
  confidence: 'high' | 'medium' | 'low';
  actions: ParsedAction[];
}

export interface ParsedStep {
  stepNumber: number;
  title: string;
  confidence: 'high' | 'medium' | 'low';
  branches: ParsedBranch[];
}

export interface ParsedForm {
  name: string;
  description: string;
  fields: { fieldLabel: string; fieldValue: string }[];
}

export interface ParsedScript {
  name: string;
  steps: ParsedStep[];
  forms: ParsedForm[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Parser Prompt
// ---------------------------------------------------------------------------

const PARSER_SYSTEM_PROMPT = `You are parsing a sales/DM-setter script into a structured JSON format.
The script may be written in either a STANDARDIZED markdown format or a FREEFORM natural format.
Your job is to extract the step-by-step conversation flow and output JSON matching the schema below.

IMPORTANT RULES:
1. Scripts define FORWARD conversation flow only — the sequential progression of a sales conversation.
2. Each step should represent ONE exchange or decision point. If a step contains multiple sequential phases (e.g., ask about work → branch on answer → deliver video), split it into separate steps. Add a warning if you detect a step that contains multiple sequential exchanges.
3. {{placeholder}} syntax: Text inside double curly braces like {{customize to their goal}} is a RUNTIME PLACEHOLDER. The AI fills this dynamically at runtime based on conversation context. Preserve these exactly as-is in the content field. Mark the action status as "filled" (not needs_user_input) since the AI handles the substitution.
4. Time-based follow-up cadences (e.g., "Day 1: send X, Day 2: send Y, Day 3-5: check in") are OUT OF SCOPE for this format. If you detect a follow-up schedule, still parse the individual messages but add a warning: "Follow-up cadences with day-based timing are not supported in the script format. These should be configured as a separate follow-up sequence."
5. Objection handling lists (e.g., "If they say too expensive → respond with X, If they say no time → respond with Y") are NOT script steps. They should be voice notes in the voice note library with content_intent triggers. If you detect a step that is primarily a list of objection responses, add a warning: "This step appears to be an objection handling list. Objection responses work better as voice notes in the Voice Note Library with intent-based triggers, not as script steps."
6. Forms/reference data (FAQs, pricing tables, data sheets) are GLOBAL — they are available to the AI throughout the entire conversation, not tied to a specific step. Parse them into the top-level "forms" array.

STANDARDIZED FORMAT (high confidence):
If the script uses these explicit tags, parsing is straightforward:
- "# STEP N:" headings for steps (ONLY headings matching this pattern become steps)
- "## BRANCH:" headings for branches
- "[MSG]:", "[Q]:", "[VN]:", "[LINK]:", "[VIDEO]:", "[FORM]:", "[JUDGE]:", "[WAIT]:", "[DELAY]:" action tags
- {{placeholder}} inside any content = runtime AI substitution
- A top-level "# Sales/DM Script" or similar title heading is METADATA only — ignore it, do NOT create a step for it.
- A "# REFERENCE DATA" heading marks the forms section. Everything under it (including "## FORM: <name>" blocks) belongs in the top-level "forms" array, NOT in "steps". Do NOT create a step for REFERENCE DATA.
- A "Condition:" line immediately under a "## BRANCH:" heading is the condition_description for that branch.
- An "Objective:" line immediately under a "# STEP N:" heading is step metadata — ignore it, do NOT emit an action for it.

FREEFORM FORMAT (medium confidence):
If the script does NOT use explicit tags, you must infer the structure:
- Look for numbered sections, headings, or labeled phases (e.g., "Step 1", "1.", "Phase 1", "Intro", "Qualification") to identify steps.
- Each distinct stage of the conversation flow is a step.
- Within each step, if the script describes different paths based on the prospect's response, create separate branches. Otherwise create a single "Default" branch.
- For each piece of content within a step/branch, determine the action type:
  - Messages the setter sends → "send_message"
  - Questions the setter asks the prospect → "ask_question"
  - References to voice notes or audio → "send_voice_note" (label only, mark as needs_user_input)
  - References to links or URLs → "send_link" (if URL present, include it; otherwise mark needs_user_input)
  - References to videos → "send_video" (label only, mark as needs_user_input)
  - References to forms or questionnaires → "form_reference" (capture form name)
  - Instructions for the AI to judge/decide something at runtime → "runtime_judgment"
  - "Wait for reply" or similar → "wait_for_response"
  - Time delays → "wait_duration" (extract seconds)
- When inferring structure from freeform text, assign "medium" or "low" confidence.
- Add a "wait_for_response" action at the end of each step where the setter is expected to wait for the prospect to reply before continuing.
- If a step offers alternative opening moves (e.g., "send either a voice note OR a text"), create separate branches for each alternative so the AI can pick one based on context.

ACTION TAG REFERENCE (for standardized format):
- [MSG]: send_message — the message text (may contain {{placeholders}})
- [Q]: ask_question — the question text (may contain {{placeholders}})
- [VN]: send_voice_note — voice note label (needs_user_input)
- [LINK]: send_link — link label (needs_user_input if no URL)
- [VIDEO]: send_video — video label (needs_user_input)
- [FORM]: form_reference — form name (global, not step-specific)
- [JUDGE]: runtime_judgment — judgment instruction
- [WAIT]: wait_for_response — no content needed
- [DELAY]: wait_duration — duration in seconds

CONFIDENCE SCORING:
- "high": field is clearly and unambiguously present (explicit tags or obvious structure)
- "medium": field is present but inferred from context, or content is incomplete/ambiguous
- "low": significant inference was needed, content may be incorrect

STATUS:
- "filled": content is complete and usable (includes messages with {{placeholders}} — the AI fills those at runtime)
- "needs_review": content exists but may need human verification (e.g., inferred from freeform)
- "needs_user_input": content references something that can't be determined from text alone (e.g., a link label with no URL, a voice note reference)

OUTPUT SCHEMA:
{
  "script_name": "string, inferred from script title/context or 'Imported Script'",
  "steps": [
    {
      "step_number": number,
      "title": "string",
      "confidence": "high" | "medium" | "low",
      "branches": [
        {
          "name": "string",
          "condition_description": "string or null — when this branch applies",
          "is_default": boolean,
          "confidence": "high" | "medium" | "low",
          "actions": [
            {
              "action_type": "send_message" | "ask_question" | "send_voice_note" | "send_link" | "send_video" | "form_reference" | "runtime_judgment" | "wait_for_response" | "wait_duration",
              "content": "string or null (preserve {{placeholders}} exactly as-is)",
              "label": "string or null (for VN, LINK, VIDEO, FORM — the descriptive label)",
              "url": "string or null (for LINK or VIDEO — the raw URL if present in the script; include even if scheme-less like 'youtube.com/watch?v=abc')",
              "wait_duration_seconds": "number or null (only for wait_duration)",
              "form_ref_name": "string or null (for form_reference — the form name)",
              "confidence": "high" | "medium" | "low",
              "status": "filled" | "needs_user_input" | "needs_review"
            }
          ]
        }
      ],
      "forms_referenced": ["string array of form names referenced in this step, if any"]
    }
  ],
  "forms": [
    {
      "name": "string",
      "description": "string",
      "fields": []
    }
  ],
  "warnings": ["string array of any parsing issues or notes"]
}

Do not add commentary, explanations, or text outside the JSON. Output JSON only.`;

// ---------------------------------------------------------------------------
// AI Provider Resolution (self-contained, mirrors ai-engine.ts logic)
// ---------------------------------------------------------------------------

async function resolveProvider(accountId: string): Promise<{
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
}> {
  // Try per-account OpenAI
  // NOTE: parser-specific model — we force gpt-4o-mini for this task even if
  // the account uses gpt-4o for conversations. Script parsing is pure
  // structure extraction; gpt-4o-mini is ~3x faster, cheaper, and has the
  // same 16K output ceiling (vs. gpt-4o's 16K) but costs 10x less.
  const openaiCreds = await getCredentials(accountId, 'OPENAI');
  if (openaiCreds?.apiKey) {
    return {
      provider: 'openai',
      apiKey: openaiCreds.apiKey as string,
      model: 'gpt-4o-mini'
    };
  }

  // Try per-account Anthropic
  // Force Haiku 4.5 for parsing — faster than Sonnet for structured output.
  const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
  if (anthropicCreds?.apiKey) {
    return {
      provider: 'anthropic',
      apiKey: anthropicCreds.apiKey as string,
      model: 'claude-haiku-4-5'
    };
  }

  // Fallback to env vars
  const envProvider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
  const provider = envProvider === 'anthropic' ? 'anthropic' : 'openai';
  const apiKey =
    provider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;
  const model =
    process.env.SCRIPT_PARSER_MODEL ||
    (provider === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4o-mini');

  if (!apiKey) {
    throw new Error(
      'No AI provider configured. Please add your OpenAI or Anthropic API key in Settings → Integrations.'
    );
  }

  return { provider: provider as 'openai' | 'anthropic', apiKey, model };
}

// ---------------------------------------------------------------------------
// LLM Call (self-contained)
// ---------------------------------------------------------------------------

async function callParserLLM(
  provider: 'openai' | 'anthropic',
  apiKey: string,
  model: string,
  text: string
): Promise<string> {
  const userMessage = `Parse the following sales/DM script into the JSON structure described in your instructions. The script may use standardized tags or freeform natural language — handle either.\n\n---BEGIN SCRIPT---\n${text}\n---END SCRIPT---\n\nRespond with valid JSON only. No commentary.`;

  if (provider === 'openai') {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });

    const response = await client.chat.completions.create({
      model,
      temperature: 0.1,
      // 16384 is the max for gpt-4o-mini and gpt-4o. A 14-step script with
      // ~100 actions serializes to ~12–15k output tokens of JSON.
      max_tokens: 16384,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PARSER_SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ]
    });

    const choice = response.choices[0];
    const content = choice?.message?.content?.trim() || '';

    // Detect truncation explicitly so we can throw a useful error instead of
    // letting the downstream JSON parser fail with a generic message.
    if (choice?.finish_reason === 'length') {
      throw new Error(
        `The AI response was truncated (hit the ${response.usage?.completion_tokens ?? 'output'} token ceiling). Your script is too large to parse in one pass. Try splitting it into two halves and parsing each separately, or remove branches you're not using.`
      );
    }

    return content;
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model,
      system: PARSER_SYSTEM_PROMPT,
      temperature: 0.1,
      // Haiku 4.5 supports up to 8192 output tokens; Sonnet 4 supports 16384.
      // Use the higher ceiling when the model name suggests Sonnet.
      max_tokens: /sonnet|opus/i.test(model) ? 16384 : 8192,
      messages: [{ role: 'user', content: userMessage }]
    });

    // Detect truncation on the Anthropic side too.
    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        "The AI response was truncated (hit the output token ceiling). Your script is too large to parse in one pass. Try splitting it into two halves and parsing each separately, or remove branches you're not using."
      );
    }

    const textBlock = response.content.find(
      (block: any) => block.type === 'text'
    );
    return (textBlock as any)?.text?.trim() || '';
  }
}

// ---------------------------------------------------------------------------
// JSON Extraction
// ---------------------------------------------------------------------------

function extractJSON(raw: string): any {
  // Try direct parse first (cleanest case)
  try {
    return JSON.parse(raw);
  } catch {
    // Continue to extraction attempts
  }

  // Strip markdown code fences if present (greedy to handle full block)
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]+?)\n\s*```/);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }

  // Try to find the first { ... } block (handles leading/trailing text)
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
  }

  throw new Error('No JSON object found in response');
}

// ---------------------------------------------------------------------------
// Main Parser
// ---------------------------------------------------------------------------

export async function parseScriptMarkdown(
  accountId: string,
  text: string
): Promise<ParsedScript> {
  // 1. Basic validation — the text should look like a script (not random junk)
  const trimmed = text.trim();
  if (trimmed.length < 50) {
    throw new Error(
      'Your script is too short. Please paste the full script content.'
    );
  }

  // 2. Resolve AI provider
  const { provider, apiKey, model } = await resolveProvider(accountId);

  // 3. Call the LLM
  const t0 = Date.now();
  let rawResponse: string;
  try {
    rawResponse = await callParserLLM(provider, apiKey, model, text);
  } catch (err: any) {
    // Propagate truncation errors verbatim (they carry actionable guidance).
    if (err?.message?.includes('truncated')) {
      throw err;
    }
    throw new Error(
      `Failed to parse script with AI: ${err.message || 'Unknown error'}`
    );
  }
  console.log(
    `[script-parser] LLM call (${provider}/${model}) finished in ${Date.now() - t0}ms, ${rawResponse.length} chars`
  );

  if (!rawResponse) {
    throw new Error('AI returned an empty response. Please try again.');
  }

  // 4. Parse JSON response
  let parsed: any;
  try {
    parsed = extractJSON(rawResponse);
  } catch (firstErr) {
    console.warn(
      '[script-parser] First JSON extraction failed, retrying LLM call...',
      { responseLength: rawResponse.length, preview: rawResponse.slice(0, 200) }
    );
    // Retry once on JSON parse failure
    try {
      rawResponse = await callParserLLM(provider, apiKey, model, text);
      parsed = extractJSON(rawResponse);
    } catch (retryErr: any) {
      console.error('[script-parser] Second JSON extraction also failed', {
        responseLength: rawResponse.length,
        preview: rawResponse.slice(0, 500),
        retryErr: retryErr?.message
      });
      // If the retry threw a truncation error, surface that message — it's
      // more actionable than the generic "failed to return structured data".
      if (retryErr?.message?.includes('truncated')) {
        throw retryErr;
      }
      throw new Error(
        'The AI failed to return structured data for your script. This can happen with very long or complex scripts. Try breaking it into fewer steps or pasting a shorter section first.'
      );
    }
  }

  // 5. Validate and normalize the parsed output
  const warnings: string[] = [
    ...(Array.isArray(parsed.warnings) ? parsed.warnings : [])
  ];

  const steps: ParsedStep[] = [];
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];

  if (rawSteps.length === 0) {
    throw new Error(
      'The AI could not identify any steps in your script. Try adding clearer step divisions (e.g., "Step 1: Intro", "Step 2: Qualify") and try again.'
    );
  }

  // Collect form references
  const formNames = new Set<string>();

  for (const rawStep of rawSteps) {
    const stepNumber =
      typeof rawStep.step_number === 'number'
        ? rawStep.step_number
        : steps.length + 1;
    const title = rawStep.title || `Step ${stepNumber}`;
    const confidence = validateConfidence(rawStep.confidence);

    const branches: ParsedBranch[] = [];
    const rawBranches = Array.isArray(rawStep.branches) ? rawStep.branches : [];

    if (rawBranches.length === 0) {
      // Create a Default branch with empty actions
      branches.push({
        label: 'Default',
        conditionDescription: null,
        confidence: 'medium',
        actions: []
      });
      warnings.push(
        `Step ${stepNumber} has no branches — created a Default branch.`
      );
    }

    for (const rawBranch of rawBranches) {
      const actions: ParsedAction[] = [];
      const rawActions = Array.isArray(rawBranch.actions)
        ? rawBranch.actions
        : [];

      if (rawActions.length === 0) {
        warnings.push(
          `Step ${stepNumber}, branch "${rawBranch.name || 'Unknown'}" has no actions.`
        );
      }

      for (const rawAction of rawActions) {
        const actionType = validateActionType(rawAction.action_type);
        if (!actionType) {
          warnings.push(
            `Unknown action type "${rawAction.action_type}" in Step ${stepNumber} — skipped.`
          );
          continue;
        }

        let status = validateStatus(rawAction.status);
        const content = rawAction.content || rawAction.label || null;
        const formRefName = rawAction.form_ref_name || null;

        // Try to extract a URL for send_link / send_video from any field the
        // LLM may have tucked it into (explicit `url` field, content, label).
        // Auto-prepends https:// for scheme-less URLs like the Step 11
        // YouTube link ("youtube.com/watch?v=..." → "https://youtube.com/...").
        let linkUrl: string | null = null;
        if (actionType === 'send_link' || actionType === 'send_video') {
          linkUrl =
            normalizeUrl(rawAction.url) ||
            normalizeUrl(rawAction.link_url) ||
            extractUrl(content) ||
            extractUrl(rawAction.label);
        }

        // Mark voice notes, links, videos as needs_user_input if no binding.
        // If we successfully extracted a URL from the script text, the link
        // IS filled — don't downgrade it.
        if (
          ['send_voice_note', 'send_link', 'send_video'].includes(actionType) &&
          status === 'filled' &&
          !linkUrl
        ) {
          status = 'needs_user_input';
        }

        if (formRefName) {
          formNames.add(formRefName);
        }

        actions.push({
          actionType,
          content,
          linkLabel:
            actionType === 'send_link' || actionType === 'send_video'
              ? rawAction.label || content
              : null,
          linkUrl,
          waitDuration:
            actionType === 'wait_duration'
              ? parseInt(rawAction.wait_duration_seconds) || 0
              : null,
          formRefName,
          confidence: validateConfidence(rawAction.confidence),
          status
        });
      }

      branches.push({
        label: rawBranch.name || 'Default',
        conditionDescription: rawBranch.condition_description || null,
        confidence: validateConfidence(rawBranch.confidence),
        actions
      });
    }

    steps.push({ stepNumber, title, confidence, branches });

    // --- Post-step validation warnings ---

    // Warn: branch ends with JUDGE that implies continuation (sequential flow)
    for (const branch of branches) {
      if (branch.actions.length > 0) {
        const lastAction = branch.actions[branch.actions.length - 1];
        if (
          lastAction.actionType === 'runtime_judgment' &&
          lastAction.content
        ) {
          const lower = lastAction.content.toLowerCase();
          if (
            lower.includes('then') ||
            lower.includes('continue') ||
            lower.includes('proceed') ||
            lower.includes('next') ||
            lower.includes('follow up')
          ) {
            warnings.push(
              `Step ${stepNumber}, branch "${branch.label}": ends with a judgment that implies continuation. Consider splitting sequential phases into separate steps.`
            );
          }
        }
      }

      // Warn: too many wait_for_response actions suggests multiple exchanges
      const waitCount = branch.actions.filter(
        (a) => a.actionType === 'wait_for_response'
      ).length;
      if (waitCount > 1) {
        warnings.push(
          `Step ${stepNumber}, branch "${branch.label}": has ${waitCount} wait-for-response actions. Each wait usually means a new exchange — consider splitting into ${waitCount} separate steps.`
        );
      }
    }

    // Warn: step looks like an objection handling list
    const allBranchLabels = branches.map((b) => b.label.toLowerCase());
    const objectionPatterns = [
      'objection',
      'too expensive',
      'no time',
      'not interested',
      'think about it',
      'already have',
      "can't afford",
      'no money'
    ];
    const objectionBranchCount = allBranchLabels.filter((label) =>
      objectionPatterns.some((p) => label.includes(p))
    ).length;
    if (
      objectionBranchCount >= 2 ||
      title.toLowerCase().includes('objection')
    ) {
      warnings.push(
        `Step ${stepNumber} ("${title}") appears to be an objection handling list. Objection responses work better as voice notes in the Voice Note Library with intent-based triggers, not as script steps.`
      );
    }

    // Warn: step looks like a follow-up cadence
    const titleLower = title.toLowerCase();
    if (
      titleLower.includes('follow up') ||
      titleLower.includes('follow-up') ||
      titleLower.includes('day 1') ||
      titleLower.includes('cadence')
    ) {
      const branchContent = branches
        .flatMap((b) => b.actions.map((a) => a.content || ''))
        .join(' ')
        .toLowerCase();
      if (
        branchContent.includes('day 1') ||
        branchContent.includes('day 2') ||
        branchContent.includes('24 hours') ||
        branchContent.includes('48 hours')
      ) {
        warnings.push(
          `Step ${stepNumber} ("${title}") appears to be a follow-up cadence with day-based timing. Follow-up sequences are not supported in the script format and will be a separate feature.`
        );
      }
    }
  }

  // Build forms from references
  const forms: ParsedForm[] = [];
  const rawForms = Array.isArray(parsed.forms) ? parsed.forms : [];
  for (const rf of rawForms) {
    if (rf.name) {
      forms.push({
        name: rf.name,
        description: rf.description || '',
        fields: Array.isArray(rf.fields) ? rf.fields : []
      });
      formNames.delete(rf.name);
    }
  }
  // Create placeholder forms for any names referenced but not defined
  Array.from(formNames).forEach((name) => {
    forms.push({ name, description: '', fields: [] });
    warnings.push(
      `Form "${name}" is referenced but not defined — created an empty placeholder.`
    );
  });

  return {
    name: parsed.script_name || 'Imported Script',
    steps,
    forms,
    warnings
  };
}

// ---------------------------------------------------------------------------
// Text Extraction from uploaded files
// ---------------------------------------------------------------------------

export async function extractTextFromUpload(
  buffer: Buffer,
  fileName: string
): Promise<string> {
  const ext = (fileName || '').split('.').pop()?.toLowerCase();

  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // .txt, .md, or unknown — treat as UTF-8 text
  return buffer.toString('utf-8');
}

// ---------------------------------------------------------------------------
// URL extraction + auto-fix
// ---------------------------------------------------------------------------

// Match bare URLs with or without a scheme. Stops at whitespace or trailing
// punctuation that isn't typically part of a URL. Handles trailing `)`, `.`,
// `,` etc. by excluding them from the tail.
//
// Examples this matches:
//   https://calendly.com/x/30min
//   http://foo.bar/baz
//   calendly.com/x/30min?utm=y
//   youtube.com/watch?v=abc&feature=youtu.be
//
// Examples this does NOT match:
//   [BOOKING LINK]   — bracketed placeholder
//   some.sentence    — no path and no TLD-ish shape
const URL_REGEX =
  /\b((?:https?:\/\/)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[^\s<>()\[\]{}'"`]*)?(?:\?[^\s<>()\[\]{}'"`]*)?)/i;

/**
 * Pull a URL out of a free-text string. Returns the URL with scheme
 * guaranteed (auto-prepending "https://" if missing). Returns null if no
 * URL-like substring is found. Trims trailing punctuation that the LLM
 * frequently tacks on ("here's the link: foo.com." → "https://foo.com").
 */
function extractUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(URL_REGEX);
  if (!match) return null;
  let url = match[1];
  // Strip trailing punctuation that got eaten by the regex's path group.
  url = url.replace(/[.,;:!?)]+$/, '');
  // Auto-prepend scheme if missing. This fixes cases like
  // "youtube.com/watch?v=e7Ujmb019gE&feature=youtu.be" where the script
  // writer omitted the scheme — without it the link isn't clickable and
  // the AI may treat it as a non-URL string.
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url;
}

/**
 * Public helper so callers outside the parser (e.g. the binding preservation
 * path in the reupload route, manual edit handlers) can normalize user-
 * supplied URLs the same way.
 */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Try strict URL parse first (covers fully-qualified URLs with scheme).
  try {
    const u = new URL(trimmed);
    return u.toString();
  } catch {
    // Fall through to lenient extraction.
  }
  return extractUrl(trimmed);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_ACTION_TYPES: Set<string> = new Set([
  'send_message',
  'ask_question',
  'send_voice_note',
  'send_link',
  'send_video',
  'form_reference',
  'runtime_judgment',
  'wait_for_response',
  'wait_duration'
]);

function validateActionType(raw: string): ScriptActionType | null {
  if (VALID_ACTION_TYPES.has(raw)) return raw as ScriptActionType;
  return null;
}

function validateConfidence(raw: any): 'high' | 'medium' | 'low' {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return 'medium';
}

function validateStatus(
  raw: any
): 'filled' | 'needs_review' | 'needs_user_input' {
  if (raw === 'filled' || raw === 'needs_review' || raw === 'needs_user_input')
    return raw;
  return 'filled';
}
