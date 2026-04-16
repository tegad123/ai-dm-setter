// ---------------------------------------------------------------------------
// inbound-qualification-classifier.ts
// ---------------------------------------------------------------------------
// Runs ONCE per conversation (on the first AI generation cycle) to detect
// when a lead arrived pre-qualified. If they've already told us their
// experience / pain / goal / financial context / explicit buying intent in
// their opening messages, we skip forward in the 7-stage funnel instead of
// asking Discovery questions they already answered.
//
// Universal feature — applies to every account and persona. The classifier
// is prompt-only; no per-tenant hardcoding.
// ---------------------------------------------------------------------------

import { getCredentials } from '@/lib/credential-store';

// ─── The 7 AI conversation stages ─────────────────────────────────────
// These match the stage names used in ai-prompts.ts MASTER_PROMPT_TEMPLATE
// and src/lib/conversation-state-machine.ts::recordStageTimestamp.
export const AI_STAGE_NAMES = [
  'OPENING',
  'SITUATION_DISCOVERY',
  'GOAL_EMOTIONAL_WHY',
  'URGENCY',
  'SOFT_PITCH_COMMITMENT',
  'FINANCIAL_SCREENING',
  'BOOKING'
] as const;

export type AIStageName = (typeof AI_STAGE_NAMES)[number];

/** Map 1-7 → stage name. Clamped to [1,7]. */
export function stageNumberToName(n: number): AIStageName {
  const idx = Math.max(1, Math.min(7, Math.round(n))) - 1;
  return AI_STAGE_NAMES[idx];
}

// ─── Types ────────────────────────────────────────────────────────────

export type ExperienceLevel = 'beginner' | 'intermediate' | 'experienced';
export type InboundIntentType =
  | 'learn_strategy'
  | 'join_mentorship'
  | 'get_help'
  | 'ask_question'
  | 'just_browsing';

export interface ExtractedInboundData {
  hasExperience: boolean;
  experienceLevel: ExperienceLevel | null;
  hasPainPoint: boolean;
  painPointSummary: string | null;
  hasGoal: boolean;
  goalSummary: string | null;
  hasUrgency: boolean;
  urgencySummary: string | null;
  hasFinancialInfo: boolean;
  financialSummary: string | null;
  hasExplicitIntent: boolean;
  intentType: InboundIntentType | null;
  isInbound: boolean;
}

export interface InboundClassificationResult {
  suggestedStartStage: number; // 1-7, raw classifier suggestion before skip-cap
  stageSkipReason: string;
  extractedData: ExtractedInboundData;
  confidence: number;
  /** Raw model JSON for logging/debugging. Null if we fell back to defaults. */
  raw: unknown | null;
}

const DEFAULT_EXTRACTED: ExtractedInboundData = {
  hasExperience: false,
  experienceLevel: null,
  hasPainPoint: false,
  painPointSummary: null,
  hasGoal: false,
  goalSummary: null,
  hasUrgency: false,
  urgencySummary: null,
  hasFinancialInfo: false,
  financialSummary: null,
  hasExplicitIntent: false,
  intentType: null,
  isInbound: false
};

/** Safe default return when classification fails. Starts at Opening, no skip. */
function defaultResult(
  isInbound: boolean,
  reason: string
): InboundClassificationResult {
  return {
    suggestedStartStage: 1,
    stageSkipReason: reason,
    extractedData: { ...DEFAULT_EXTRACTED, isInbound },
    confidence: 0,
    raw: null
  };
}

// ─── Classifier prompt ────────────────────────────────────────────────

function buildClassifierPrompt(
  leadMessages: string[],
  isInbound: boolean
): string {
  const joined = leadMessages
    .map((m, i) => `[Message ${i + 1}] ${m}`)
    .join('\n');

  return `You are an expert at reading inbound DM leads and deciding where they belong in a 7-stage sales conversation funnel.

The 7 stages of the funnel are:
1. OPENING — first hello, build rapport, no qualifying yet
2. SITUATION_DISCOVERY — learn the lead's situation, experience level, what they do
3. GOAL_EMOTIONAL_WHY — learn what they want and why it matters to them
4. URGENCY — learn why NOW, what's pushing them to act
5. SOFT_PITCH_COMMITMENT — introduce the solution, gauge interest in a call
6. FINANCIAL_SCREENING — qualify on budget / capital / readiness to invest
7. BOOKING — book the call

STAGE-SKIP RULES:
- Stage 1 (OPENING): default for cold/unknown leads
- Stage 2 (SITUATION_DISCOVERY): they showed some interest (followed, liked content) but no situation info
- Stage 3 (GOAL_EMOTIONAL_WHY): they already revealed their situation + experience level + what they currently do
- Stage 4 (URGENCY): they revealed situation AND a goal or pain point, but not why now
- Stage 5 (SOFT_PITCH_COMMITMENT): they revealed urgency/pain AND explicit interest in help ("want to learn your strategy", "how can you help me", "do you offer mentorship")
- Stage 6 (FINANCIAL_SCREENING): they asked about price / budget / capital readiness
- Stage 7 (BOOKING): they explicitly asked to book a call or said "sign me up"

IMPORTANT:
- Be conservative. Ambiguous signals → lower stage.
- Questions that aren't qualification signals (e.g., "is this a bot or a real person?") are NOT stage-skip data. Keep at Stage 1.
- Trust/skeptic questions = Stage 1 or 2, not higher.
- ${isInbound ? 'This lead is INBOUND — they messaged us first.' : 'This lead is OUTBOUND — we messaged them first.'}

LEAD'S OPENING MESSAGES (before any AI response):
${joined}

Return ONLY valid JSON matching this exact schema. No markdown, no commentary:

{
  "suggestedStartStage": 1-7,
  "stageSkipReason": "one sentence explaining why this stage was chosen",
  "confidence": 0.0-1.0,
  "extractedData": {
    "hasExperience": boolean,
    "experienceLevel": "beginner" | "intermediate" | "experienced" | null,
    "hasPainPoint": boolean,
    "painPointSummary": string | null,
    "hasGoal": boolean,
    "goalSummary": string | null,
    "hasUrgency": boolean,
    "urgencySummary": string | null,
    "hasFinancialInfo": boolean,
    "financialSummary": string | null,
    "hasExplicitIntent": boolean,
    "intentType": "learn_strategy" | "join_mentorship" | "get_help" | "ask_question" | "just_browsing" | null
  }
}`;
}

// ─── Validation ───────────────────────────────────────────────────────

function sanitizeExperience(v: unknown): ExperienceLevel | null {
  return v === 'beginner' || v === 'intermediate' || v === 'experienced'
    ? v
    : null;
}

function sanitizeIntent(v: unknown): InboundIntentType | null {
  const allowed: InboundIntentType[] = [
    'learn_strategy',
    'join_mentorship',
    'get_help',
    'ask_question',
    'just_browsing'
  ];
  return typeof v === 'string' && allowed.includes(v as InboundIntentType)
    ? (v as InboundIntentType)
    : null;
}

function sanitizeString(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function normalizeResult(
  parsed: Record<string, unknown>,
  isInbound: boolean
): InboundClassificationResult {
  const rawStage = parsed.suggestedStartStage;
  const suggestedStartStage =
    typeof rawStage === 'number' && rawStage >= 1 && rawStage <= 7
      ? Math.round(rawStage)
      : 1;

  const confidence =
    typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

  const stageSkipReason =
    sanitizeString(parsed.stageSkipReason, 300) ||
    'Classifier returned no reason';

  const ex = (parsed.extractedData || {}) as Record<string, unknown>;
  const extractedData: ExtractedInboundData = {
    hasExperience: !!ex.hasExperience,
    experienceLevel: sanitizeExperience(ex.experienceLevel),
    hasPainPoint: !!ex.hasPainPoint,
    painPointSummary: sanitizeString(ex.painPointSummary),
    hasGoal: !!ex.hasGoal,
    goalSummary: sanitizeString(ex.goalSummary),
    hasUrgency: !!ex.hasUrgency,
    urgencySummary: sanitizeString(ex.urgencySummary),
    hasFinancialInfo: !!ex.hasFinancialInfo,
    financialSummary: sanitizeString(ex.financialSummary),
    hasExplicitIntent: !!ex.hasExplicitIntent,
    intentType: sanitizeIntent(ex.intentType),
    isInbound
  };

  return {
    suggestedStartStage,
    stageSkipReason,
    extractedData,
    confidence,
    raw: parsed
  };
}

// ─── Main classifier ──────────────────────────────────────────────────

/**
 * Classify the lead's opening messages to detect pre-qualification and
 * suggest a starting stage. Uses Claude Haiku with a 4-second timeout.
 * On ANY failure (no API key, timeout, malformed response), returns a
 * safe default: start at Stage 1, no skip.
 *
 * @param accountId - for BYOK API key resolution
 * @param leadMessages - every lead message received before the first AI response
 * @param isInbound - true if the lead messaged us first, false if we messaged them
 */
export async function classifyInboundQualification(
  accountId: string,
  leadMessages: string[],
  isInbound: boolean
): Promise<InboundClassificationResult> {
  if (!leadMessages.length || leadMessages.every((m) => !m.trim())) {
    return defaultResult(isInbound, 'No lead messages to classify');
  }

  try {
    const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
    const apiKey =
      (anthropicCreds?.apiKey as string) || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return defaultResult(
        isInbound,
        'No Anthropic API key available for inbound classifier'
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 600,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: buildClassifierPrompt(leadMessages, isInbound)
          }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[inbound-qualification-classifier] Haiku API error: ${response.status}`
      );
      return defaultResult(isInbound, `Haiku API error ${response.status}`);
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text || data?.content?.[0]?.value || '';

    // Strip markdown fences if the model wrapped the JSON
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    // Extract the first top-level JSON object
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      console.warn(
        '[inbound-qualification-classifier] No JSON object in response'
      );
      return defaultResult(isInbound, 'Classifier returned non-JSON');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {
      console.warn('[inbound-qualification-classifier] JSON parse failed');
      return defaultResult(isInbound, 'Classifier returned malformed JSON');
    }

    return normalizeResult(parsed, isInbound);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[inbound-qualification-classifier] Haiku call timed out');
      return defaultResult(isInbound, 'Classifier timed out');
    }
    console.warn('[inbound-qualification-classifier] Failed:', err);
    return defaultResult(isInbound, 'Classifier threw an error');
  }
}

// ─── Skip-cap policy ──────────────────────────────────────────────────

/**
 * Apply the skip-cap policy from the spec:
 *   - Never skip MORE than 3 stages from Opening
 *   - Inbound leads get +1 stage allowance (they sought us out)
 *
 * @param suggestedStartStage - raw classifier suggestion (1-7)
 * @param isInbound - true if lead messaged us first
 * @param currentStage - the stage the lead is actually at right now (1 for new convo)
 * @returns the capped final start stage
 */
export function applySkipCap(
  suggestedStartStage: number,
  isInbound: boolean,
  currentStage: number = 1
): { finalStartStage: number; capped: boolean } {
  const maxSkipFromCurrent = isInbound ? 4 : 3;
  const ceiling = Math.min(7, currentStage + maxSkipFromCurrent);
  const final = Math.max(
    currentStage,
    Math.min(ceiling, Math.round(suggestedStartStage))
  );
  return { finalStartStage: final, capped: final !== suggestedStartStage };
}
