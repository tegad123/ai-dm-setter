// ---------------------------------------------------------------------------
// keepalive-generator.ts
// ---------------------------------------------------------------------------
// Lightweight Haiku-based natural check-in generator for the 24-hour Meta
// messaging window keepalive feature. Fires when a lead has a scheduled
// call but the conversation has gone 18-23h quiet — the next reminder
// (day-before, morning-of) needs an open window to land.
//
// Short. Casual. Doesn't read like a reminder bot. Gives the lead a
// reason to respond (which resets Meta's 24h clock for free).
//
// Uses env ANTHROPIC_API_KEY directly (not per-account BYOK) so this
// keepalive path can't fail because a tenant hasn't wired their own
// credentials. Falls back to a hardcoded template on API error —
// preferable to skipping the keepalive entirely and losing the window.
// ---------------------------------------------------------------------------

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const KEEPALIVE_SYSTEM_PROMPT = `You are generating a short, natural check-in DM for a lead who has a call scheduled with our team. The conversation has gone quiet for about 20 hours — if we don't get them to respond, Meta's 24-hour messaging window will close and we can't send them the pre-call reminder.

REQUIREMENTS:
- Feel like a casual check-in from a real person, NOT a reminder bot.
- Reference the upcoming call naturally, don't harp on it.
- Give them a reason to respond (a light question, a genuine "how you doing").
- Match a chill, warm, bro-style voice. Lowercase ok. Short sentences.
- UNDER 100 characters. One message only.

EXAMPLES OF GOOD KEEPALIVE MESSAGES:
- "yo bro how's the week going? excited for the call {day} 💪🏿"
- "what's good bro, you been checking out the vids before the call?"
- "yo bro just checking in, everything good for {day}?"
- "hey bro how you feeling about the call? any qs before we hop on?"
- "yo man hope the week's treating you well, ready for {day}?"

RULES:
- Plain text output. No JSON. No markdown.
- No emojis except 💪🏿 or 🔥 sparingly.
- Do NOT say "reminder" or "just reminding you".
- Do NOT attach a link or ask for booking info — the call is already scheduled.
- Do NOT mention 24-hour windows or Meta policies — that's our business, not theirs.

Respond with ONE message. No preamble, no wrapper.`;

function dayLabel(callAt: Date, now: Date): string {
  const diffMs = callAt.getTime() - now.getTime();
  const diffHrs = diffMs / (60 * 60 * 1000);
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffHrs < 24) return 'tomorrow';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays < 7) {
    // Weekday name
    return callAt.toLocaleDateString('en-US', { weekday: 'long' });
  }
  return callAt.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Hardcoded fallback templates. Used when the Haiku call fails so the
 * keepalive still lands. Rotates based on lead name length so
 * consecutive keepalives don't look identical if they happen to fire
 * for the same lead on the fallback path multiple times.
 */
function fallbackMessage(leadFirstName: string | null, day: string): string {
  const name = leadFirstName ? leadFirstName.trim() : null;
  const templates = [
    `yo bro how's the week going? excited for the call ${day} 💪🏿`,
    `yo${name ? ` ${name}` : ''} just checking in, all good for ${day}?`,
    `hey bro how you feeling about the call ${day}? any qs before we hop on?`
  ];
  const idx = (name ? name.length : 0 + day.length) % templates.length;
  return templates[idx];
}

export interface KeepaliveInput {
  leadName: string | null;
  scheduledCallAt: Date;
  now?: Date;
}

/**
 * Generate a single natural check-in message. Returns plain text
 * (no JSON envelope, no markdown). Always returns a usable string —
 * falls back to a hardcoded template on any Haiku failure so the
 * keepalive never silently drops.
 */
export async function generateKeepaliveMessage(
  input: KeepaliveInput
): Promise<string> {
  const now = input.now ?? new Date();
  const day = dayLabel(input.scheduledCallAt, now);
  const firstName = input.leadName
    ? input.leadName.split(/\s+/)[0] || null
    : null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(
      '[keepalive-generator] ANTHROPIC_API_KEY not set — using hardcoded fallback'
    );
    return fallbackMessage(firstName, day);
  }

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const userPrompt = `Lead first name: ${firstName ?? '(unknown)'}
Call scheduled for: ${day} (${input.scheduledCallAt.toISOString()})

Generate the check-in message now.`;
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      system: KEEPALIVE_SYSTEM_PROMPT,
      temperature: 0.7,
      max_tokens: 200,
      messages: [{ role: 'user', content: userPrompt }]
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textBlock = response.content.find((b: any) => b.type === 'text');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = ((textBlock as any)?.text ?? '').trim();

    if (!text || text.length < 8) {
      console.warn(
        '[keepalive-generator] Haiku returned empty/too-short output — using fallback'
      );
      return fallbackMessage(firstName, day);
    }
    // Guardrails on the output: reject obvious failure modes that
    // would break the message. Length, link-promise without URL,
    // reminder-bot language.
    if (text.length > 200) {
      console.warn(
        '[keepalive-generator] Haiku returned too-long output — using fallback'
      );
      return fallbackMessage(firstName, day);
    }
    const linkPromiseWithoutUrl =
      /\b(i'?ll|lemme|gonna|going to)\s+(send|drop|share)\b/i.test(text) &&
      !/\bhttps?:\/\//i.test(text);
    if (linkPromiseWithoutUrl) {
      console.warn(
        '[keepalive-generator] Haiku output promised a link without URL — using fallback'
      );
      return fallbackMessage(firstName, day);
    }
    const reminderBot =
      /\b(just\s+reminding|this\s+is\s+a\s+reminder|reminder:|friendly\s+reminder)\b/i.test(
        text
      );
    if (reminderBot) {
      console.warn(
        '[keepalive-generator] Haiku output had reminder-bot language — using fallback'
      );
      return fallbackMessage(firstName, day);
    }
    return text;
  } catch (err) {
    console.error(
      '[keepalive-generator] Haiku call failed — using hardcoded fallback:',
      err
    );
    return fallbackMessage(firstName, day);
  }
}
