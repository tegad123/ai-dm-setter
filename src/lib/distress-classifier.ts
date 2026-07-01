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

export async function classifyDistressIntent(
  text: string
): Promise<ClassifierResult> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { confirmed: false, reason: 'no_api_key' };
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Message: "${text}"` }]
    });

    const raw =
      response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : '';
    const parsed = JSON.parse(raw) as { confirmed: boolean; reason: string };
    return {
      confirmed: Boolean(parsed.confirmed),
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'parsed'
    };
  } catch {
    // Fail-open: don't block generation on classifier errors
    return { confirmed: false, reason: 'classifier_error' };
  }
}
