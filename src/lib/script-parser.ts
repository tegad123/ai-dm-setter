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

STANDARDIZED FORMAT (high confidence):
If the script uses these explicit tags, parsing is straightforward:
- "# STEP N:" headings for steps
- "## BRANCH:" headings for branches
- "[MSG]:", "[Q]:", "[VN]:", "[LINK]:", "[VIDEO]:", "[FORM]:", "[JUDGE]:", "[WAIT]:", "[DELAY]:" action tags

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

ACTION TAG REFERENCE (for standardized format):
- [MSG]: send_message — the message text
- [Q]: ask_question — the question text
- [VN]: send_voice_note — voice note label (needs_user_input)
- [LINK]: send_link — link label (needs_user_input if no URL)
- [VIDEO]: send_video — video label (needs_user_input)
- [FORM]: form_reference — form name
- [JUDGE]: runtime_judgment — judgment instruction
- [WAIT]: wait_for_response — no content needed
- [DELAY]: wait_duration — duration in seconds

CONFIDENCE SCORING:
- "high": field is clearly and unambiguously present (explicit tags or obvious structure)
- "medium": field is present but inferred from context, or content is incomplete/ambiguous
- "low": significant inference was needed, content may be incorrect

STATUS:
- "filled": content is complete and usable
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
              "content": "string or null",
              "label": "string or null (for VN, LINK, VIDEO, FORM — the descriptive label)",
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
  const openaiCreds = await getCredentials(accountId, 'OPENAI');
  if (openaiCreds?.apiKey) {
    return {
      provider: 'openai',
      apiKey: openaiCreds.apiKey as string,
      model: (openaiCreds.model as string) || 'gpt-4o'
    };
  }

  // Try per-account Anthropic
  const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
  if (anthropicCreds?.apiKey) {
    return {
      provider: 'anthropic',
      apiKey: anthropicCreds.apiKey as string,
      model: (anthropicCreds.model as string) || 'claude-sonnet-4-20250514'
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
    process.env.AI_MODEL ||
    (provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o');

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
      max_tokens: 8192,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PARSER_SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ]
    });

    return response.choices[0]?.message?.content?.trim() || '';
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model,
      system: PARSER_SYSTEM_PROMPT,
      temperature: 0.1,
      max_tokens: 8192,
      messages: [{ role: 'user', content: userMessage }]
    });

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
  let rawResponse: string;
  try {
    rawResponse = await callParserLLM(provider, apiKey, model, text);
  } catch (err: any) {
    throw new Error(
      `Failed to parse script with AI: ${err.message || 'Unknown error'}`
    );
  }

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
    } catch (retryErr) {
      console.error('[script-parser] Second JSON extraction also failed', {
        responseLength: rawResponse.length,
        preview: rawResponse.slice(0, 500)
      });
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

        // Mark voice notes, links, videos as needs_user_input if no binding
        if (
          ['send_voice_note', 'send_link', 'send_video'].includes(actionType) &&
          status === 'filled'
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
          linkUrl: null,
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
