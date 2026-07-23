// ---------------------------------------------------------------------------
// distress-classifier.ts
// ---------------------------------------------------------------------------
// LLM-backed distress classifier used as a secondary confirmation layer for
// MEDIUM-tier signals in distress-detector.ts. HARD-tier signals fire
// immediately from pure regex — this file is only called when a MEDIUM
// signal matches, to reduce false positives on phrases that occasionally
// appear in normal trading-DM context.
//
// Model: claude-haiku-4-5-20251001 — fast, cheap, sufficient for binary
// classification. Typical latency: 200–400ms. Fail-open: if the call
// throws or times out, distress is NOT assumed (the regex already fired a
// MEDIUM hit; we default to "not confirmed" to avoid blocking every
// "things are hard right now bro" message on an API outage).
//
// This is a pure function wrapper. No DB, no side effects.
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';

export interface ClassifierResult {
  confirmed: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `You are a distress classifier for a sales conversation platform. Your job is to decide whether an inbound message from a lead contains genuine personal distress, crisis, trauma, or hardship that should pause the sales pipeline and route to a human.

Respond with JSON only. No other text.

FIRE (confirmed=true) for:
- Caring for a seriously ill, disabled, or paralyzed family member
- Terminal illness (own or close family)
- Recent bereavement or grief
- Domestic abuse or unsafe home situation
- Homelessness or severe food/housing insecurity
- Mental health crisis language (breakdown, can't cope, falling apart)
- Severe financial desperation (can't pay for basics, about to lose home)
- Any combination of hardship that signals the person is in genuine crisis

DO NOT fire (confirmed=false) for:
- Normal trading frustration ("things are tough", "markets are hard")
- General financial aspiration ("I need more money", "my job doesn't pay enough")
- Sales-assistance requests ("please help me", "I need this")
- Mild life stress that is common in sales conversations

Response format:
{"confirmed": true|false, "reason": "<one sentence explaining decision>"}`;

// Standing production risk fixed here (2026-07-22), separate from the
// classifier-first rework: the SDK defaults to a 10-MINUTE request timeout
// and 2 retries. This call sits on the inbound webhook path (Layer 1
// distress gate), so a single hung Haiku request could block a webhook for
// up to ~10 minutes with retries. We bound it hard.
const CLASSIFIER_TIMEOUT_MS = 1200;
const CLASSIFIER_MAX_RETRIES = 1;

export async function classifyDistressIntent(
  text: string
): Promise<ClassifierResult> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { confirmed: false, reason: 'no_api_key' };
    }

    // Per-request timeout + a tight retry cap. maxRetries drops from the
    // SDK default of 2 to 1; the client-level timeout is a hard per-attempt
    // ceiling. Worst case is now ~2 attempts * 1200ms, not 10 minutes.
    const client = new Anthropic({
      apiKey,
      maxRetries: CLASSIFIER_MAX_RETRIES
    });
    const response = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Message: "${text}"` }]
      },
      { timeout: CLASSIFIER_TIMEOUT_MS }
    );

    const raw =
      response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : '';
    const parsed = JSON.parse(raw) as { confirmed: boolean; reason: string };
    return {
      confirmed: Boolean(parsed.confirmed),
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'parsed'
    };
  } catch (err) {
    // Fail-open here (secondary/MEDIUM-tier path): don't block generation on
    // classifier errors. The classifier-first rework introduces a distinct
    // `ok` field so the PRIMARY path can fail CLOSED instead — this function's
    // current callers all treat "no answer" as "not distress", which is
    // correct only because HARD regex already fired upstream.
    const kind =
      err instanceof Error &&
      (err.name === 'APIConnectionTimeoutError' || /timeout/i.test(err.message))
        ? 'classifier_timeout'
        : 'classifier_error';
    return { confirmed: false, reason: kind };
  }
}
