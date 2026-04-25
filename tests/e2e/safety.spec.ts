/**
 * SUITE 3 — Safety gates exercised through /api/ai/test-message.
 *
 * The test-message endpoint runs the real generation pipeline (system
 * prompt + voice gate + retry loop) without making Meta API calls or
 * persisting Message rows. It's perfect for smoke-testing structural
 * outputs of the gates without a live conversation.
 *
 * Caveat: the endpoint is stateless — no prior conversation history,
 * the lead context is always NEW_LEAD. Tests 9/10 simulate a capital
 * answer by putting the dollar figure directly in the lead's message
 * ("I have $5000 ready, can we set up a call?"). This isn't a perfect
 * mid-funnel simulation but it does exercise the persona prompt's
 * capital-answer recognition + downsell branching well enough to
 * catch regressions in either rule.
 *
 * Per the user's spec: don't test exact AI wording — assert structural
 * outcomes (no placeholder, contains downsell, contains call pitch).
 */
import { test, expect } from '@playwright/test';

interface TestMessageReply {
  reply?: string;
  message?: string;
  // The endpoint historically returned different shapes. Accept all.
  text?: string;
  error?: string;
}

async function callTestMessage(
  request: import('@playwright/test').APIRequestContext,
  leadMessage: string
): Promise<{ status: number; body: TestMessageReply; text: string }> {
  const res = await request.post('/api/ai/test-message', {
    data: { leadMessage, leadName: 'E2E Test Lead', platform: 'INSTAGRAM' }
  });
  const status = res.status();
  let body: TestMessageReply = {};
  try {
    body = (await res.json()) as TestMessageReply;
  } catch {
    body = { error: 'non-json response' };
  }
  const text = (body.reply ?? body.message ?? body.text ?? '').toString();
  return { status, body, text };
}

test.describe('Safety gates', () => {
  // Live AI generation can take 8-15s, plus voice-gate retries can push
  // to ~25s on a bad turn. Use a generous per-test timeout.
  test.setTimeout(60_000);

  test('8 — Bracketed placeholder never reaches output', async ({
    request
  }) => {
    const { status, body, text } = await callTestMessage(
      request,
      'can you send me the booking link to apply for the call?'
    );
    expect(status, `body=${JSON.stringify(body)}`).toBe(200);
    expect(text.length).toBeGreaterThan(0);

    // The literal "[BOOKING LINK]" / "[CALENDAR LINK]" / "[LINK]"
    // bracketed-placeholder family is what the ship-time guard exists
    // to block. Any of them in the output is a regression.
    const placeholderRe = /\[[A-Z][A-Z0-9 _]{2,}\]/;
    expect(text).not.toMatch(placeholderRe);
  });

  test('9 — Capital answer at threshold routes to call pitch', async ({
    request
  }) => {
    const { status, text } = await callTestMessage(
      request,
      "I've been trading 2 years and have $5,000 ready to invest. can we hop on that call with Anthony?"
    );
    expect(status).toBe(200);
    expect(text.length).toBeGreaterThan(0);

    // Structural assertion: the reply should advance toward booking,
    // not pivot to the downsell or generic small talk. We look for
    // call-related language OR Anthony's name OR a Typeform reference
    // OR a "let me get you set up" style phrase.
    const callRoutingRe =
      /\b(anthony|book(ing)?|call (with|on the)|hop on|typeform|application|let'?s set this up|let me get you set up|let me have the team)\b/i;
    expect(text.toLowerCase()).toMatch(callRoutingRe);
  });

  test('10 — Capital answer below threshold routes to downsell, not Typeform', async ({
    request
  }) => {
    const { status, text } = await callTestMessage(
      request,
      "I only have $200 right now and I'm trying to learn. what should I do?"
    );
    expect(status).toBe(200);
    expect(text.length).toBeGreaterThan(0);

    // Should NOT contain the Typeform URL (call-handoff path is wrong
    // for a sub-threshold lead).
    expect(text).not.toMatch(/form\.typeform\.com/i);
    expect(text).not.toMatch(/AGUtPdmb/);

    // Should contain downsell language. The script's exact wording
    // varies — accept any of: "$497", "course", "session liquidity",
    // "free", "video", "youtube" (free-resource branch). At least
    // one of these has to appear when the lead is sub-threshold.
    const downsellRe =
      /(\$?\s?497|course|session liquidity|free (video|resource)|youtube|youtu\.be)/i;
    expect(text).toMatch(downsellRe);
  });
});
