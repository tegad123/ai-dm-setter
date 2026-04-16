// ---------------------------------------------------------------------------
// Content Intent Classifier — lightweight Haiku-based intent detection
// ---------------------------------------------------------------------------
// Runs on every message generation cycle. Uses Claude Haiku for speed and cost.
// Falls back to keyword heuristics on LLM failure.
// ---------------------------------------------------------------------------

import { getCredentials } from '@/lib/credential-store';
import {
  CONTENT_INTENTS,
  CONTENT_INTENT_LABELS,
  INTENT_CONFIDENCE_THRESHOLD,
  type ContentIntent
} from '@/lib/voice-note-triggers';

export interface IntentClassificationResult {
  intent: ContentIntent | null;
  confidence: number;
}

// ─── Keyword Fallback ─────────────────────────────────────────────────────

const KEYWORD_MAP: Record<string, ContentIntent> = {};

// Price / budget keywords
for (const kw of [
  'expensive',
  'too much',
  'afford',
  'cost',
  'price',
  'pricing',
  'investment',
  'money',
  'budget',
  'pay',
  'pricey',
  'cheap'
]) {
  KEYWORD_MAP[kw] = 'price_objection';
}

// Time concern keywords
for (const kw of [
  "don't have time",
  'no time',
  'too busy',
  'schedule',
  'time commitment',
  'how long does',
  'time consuming'
]) {
  KEYWORD_MAP[kw] = 'time_concern';
}

// Skepticism keywords
for (const kw of [
  'scam',
  'legit',
  'fake',
  'too good to be true',
  'trust',
  'skeptic',
  'sounds like',
  'is this real',
  'sus',
  'pyramid'
]) {
  KEYWORD_MAP[kw] = 'skepticism_or_scam_concern';
}

// Past failure keywords
for (const kw of [
  'tried before',
  "didn't work",
  'failed',
  'lost money',
  'burned',
  'been burned',
  'waste of'
]) {
  KEYWORD_MAP[kw] = 'past_failure';
}

// Not interested keywords
for (const kw of [
  'not interested',
  'no thanks',
  'pass',
  'unsubscribe',
  'stop messaging',
  "don't want"
]) {
  KEYWORD_MAP[kw] = 'not_interested';
}

// Ready to buy keywords
for (const kw of [
  'sign me up',
  'ready',
  "let's do it",
  'i want in',
  "i'm in",
  'shut up and take',
  'where do i pay',
  'how do i start',
  'enroll'
]) {
  KEYWORD_MAP[kw] = 'ready_to_buy';
}

// Need to think keywords
for (const kw of [
  'think about it',
  'need time',
  'sleep on it',
  'let me think',
  'get back to you',
  'not sure yet'
]) {
  KEYWORD_MAP[kw] = 'need_to_think';
}

// Budget question keywords
for (const kw of [
  'how much',
  'what does it cost',
  'payment plan',
  'financing',
  'installments'
]) {
  KEYWORD_MAP[kw] = 'budget_question';
}

// Timeline question keywords
for (const kw of [
  'how long',
  'when will',
  'how quickly',
  'results timeline',
  'how fast',
  'time frame'
]) {
  KEYWORD_MAP[kw] = 'timeline_question';
}

// Experience question keywords
for (const kw of [
  'experience',
  'background',
  'qualifications',
  'how long have you',
  'credentials',
  'results you got'
]) {
  KEYWORD_MAP[kw] = 'experience_question';
}

// Complexity concern keywords
for (const kw of [
  'complicated',
  'complex',
  'confusing',
  'hard to',
  'difficult',
  'overwhelm',
  'technical'
]) {
  KEYWORD_MAP[kw] = 'complexity_concern';
}

function keywordFallback(message: string): IntentClassificationResult {
  const lower = message.toLowerCase();
  for (const [keyword, intent] of Object.entries(KEYWORD_MAP)) {
    if (lower.includes(keyword)) {
      return { intent, confidence: 0.65 };
    }
  }
  return { intent: null, confidence: 0 };
}

// ─── LLM Classification Prompt ────────────────────────────────────────────

const INTENT_LIST = CONTENT_INTENTS.map(
  (i) => `- ${i}: ${CONTENT_INTENT_LABELS[i]}`
).join('\n');

function buildClassificationPrompt(
  lastMessage: string,
  context: string
): string {
  return `Classify the lead's most recent message into exactly one of these intents.

INTENTS:
${INTENT_LIST}

CONVERSATION CONTEXT (for reference):
${context}

LEAD'S LATEST MESSAGE:
"${lastMessage}"

INSTRUCTIONS:
- If the message clearly matches an intent, return it with high confidence.
- If the message is ambiguous or doesn't match any intent, return null.
- Return ONLY valid JSON, no explanation.

OUTPUT FORMAT:
{"intent": "<intent_key_or_null>", "confidence": <0.0_to_1.0>}`;
}

// ─── Main Classifier ──────────────────────────────────────────────────────

/**
 * Classify the lead's latest message into one of 11 content intents.
 * Uses Claude Haiku for speed/cost; falls back to keyword matching on failure.
 */
export async function classifyContentIntent(
  accountId: string,
  lastLeadMessage: string,
  conversationContext: string
): Promise<IntentClassificationResult> {
  if (!lastLeadMessage.trim()) {
    return { intent: null, confidence: 0 };
  }

  try {
    // Resolve Anthropic API key (account BYOK → env fallback)
    const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
    const apiKey =
      (anthropicCreds?.apiKey as string) || process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      // No Anthropic key available — use keyword fallback
      return keywordFallback(lastLeadMessage);
    }

    // Call Claude Haiku with a 3-second timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: buildClassificationPrompt(
              lastLeadMessage,
              conversationContext
            )
          }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[content-intent-classifier] Haiku API error: ${response.status}`
      );
      return keywordFallback(lastLeadMessage);
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text || data?.content?.[0]?.value || '';

    // Parse JSON response
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      return keywordFallback(lastLeadMessage);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const intent = parsed.intent;
    const confidence =
      typeof parsed.confidence === 'number' ? parsed.confidence : 0;

    // Validate intent is one of the known intents
    if (
      intent &&
      CONTENT_INTENTS.includes(intent as ContentIntent) &&
      confidence >= INTENT_CONFIDENCE_THRESHOLD
    ) {
      return { intent: intent as ContentIntent, confidence };
    }

    return { intent: null, confidence };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[content-intent-classifier] Haiku call timed out (3s)');
    } else {
      console.warn(
        '[content-intent-classifier] LLM classification failed:',
        err
      );
    }
    return keywordFallback(lastLeadMessage);
  }
}
