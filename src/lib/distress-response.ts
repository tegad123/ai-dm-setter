// ---------------------------------------------------------------------------
// distress-response.ts
// ---------------------------------------------------------------------------
// Dedicated supportive-response generator for the distress / crisis path.
// Called when the distress-detector fires on an inbound lead message.
// Does NOT sell. Does NOT pitch. Does NOT solve trading problems. Just
// acknowledges pain, expresses care, and surfaces a crisis resource.
//
// Uses Claude Haiku (claude-haiku-4-5) via the Anthropic SDK with the ENV
// ANTHROPIC_API_KEY — intentionally not per-account-BYOK so this safety
// path can't fail because a tenant hasn't wired up their own key. If the
// env key is missing or the API call errors, we ship a hardcoded fallback
// that always contains the 988 hotline reference. Safety-first: a
// generic message is better than silence.
// ---------------------------------------------------------------------------

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const SUPPORTIVE_SYSTEM_PROMPT = `You are responding to someone who has expressed distress, crisis language, or suicidal ideation in a DM.

ABSOLUTE RULES:
- Respond with genuine empathy, like a real person who cares.
- Do NOT sell anything. Do NOT pitch any product, course, mentorship, or call.
- Do NOT try to solve their trading or financial problems.
- Do NOT give advice on what they should do next (except "reach out to someone trained").
- Do NOT say "everything will be okay" or other hollow reassurances.

WHAT TO DO:
- Acknowledge what they said — their pain matters more than any business goal.
- Express care briefly and directly. Human, not scripted.
- Mention the 988 Suicide & Crisis Lifeline (call or text 988) as a resource. Do this gently, not like a disclaimer.
- Keep the whole message SHORT — 2-4 sentences. Long replies feel performative.
- Use DM-style casual language (lowercase ok, short sentences). Avoid corporate voice.

FORMAT:
- Plain text. No JSON. No markdown. No emojis except one 🫂 or ❤️ if it feels right.
- One message, not a list.

Example of the right tone:
"bro I hear you and what you're feeling matters way more than any trading stuff right now. if you're really going through it please reach out to someone who can actually help — you can call or text 988 anytime, they're trained for exactly this. I'm here but they'll be able to actually be there for you right now."

Respond now with ONE supportive message.`;

/**
 * Hardcoded fallback — always includes the 988 reference. Used when the
 * Haiku call fails for any reason (missing env key, API error, timeout).
 * Safety-first: we never want the distress path to silently drop.
 */
const HARDCODED_FALLBACK = `bro I hear you and what you're feeling matters way more than any trading stuff. if you're going through it right now please reach out to someone who can actually help — you can call or text 988 anytime (Suicide & Crisis Lifeline), they're trained for exactly this. 🫂`;

/**
 * Generate a single supportive message in response to distress language.
 *
 * @param leadMessage  The lead's message that triggered detection. Passed
 *                     to the model as context so the response can
 *                     acknowledge specifics without re-quoting.
 * @returns            One supportive message (plain text, 2-4 sentences).
 */
export async function generateSupportiveResponse(
  leadMessage: string
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(
      '[distress-response] ANTHROPIC_API_KEY not set — using hardcoded fallback'
    );
    return HARDCODED_FALLBACK;
  }

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: HAIKU_MODEL,
      system: SUPPORTIVE_SYSTEM_PROMPT,
      temperature: 0.5,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `The lead's message was:\n\n"${leadMessage.slice(0, 500)}"\n\nRespond supportively as instructed. Output only the message text, no wrapper or preamble.`
        }
      ]
    });

    const textBlock = response.content.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (block: any) => block.type === 'text'
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = ((textBlock as any)?.text ?? '').trim();

    if (!text || text.length < 20) {
      console.warn(
        '[distress-response] Haiku returned empty/too-short response — using hardcoded fallback'
      );
      return HARDCODED_FALLBACK;
    }
    // Safety net: if the model somehow returned pitch-like language, fall
    // back. Tight phrase list — "call 988" must NOT match, and references
    // to "trading stuff" in the acknowledgment are fine. Only explicit
    // sales / booking / commitment asks trigger the override.
    const pitchLanguage =
      /\b(book\s+a\s+call|schedule\s+a\s+call|sign\s+up|apply\s+now|mentorship\s+program|our\s+course|our\s+program|financial\s+freedom|ready\s+to\s+start|let'?s\s+hop\s+on|get\s+you\s+set\s+up|the\s+team\s+will\s+reach\s+out)\b/i;
    if (pitchLanguage.test(text)) {
      console.warn(
        '[distress-response] Haiku response contained pitch-like language — using hardcoded fallback'
      );
      return HARDCODED_FALLBACK;
    }
    return text;
  } catch (err) {
    console.error(
      '[distress-response] Haiku call failed — using hardcoded fallback:',
      err
    );
    return HARDCODED_FALLBACK;
  }
}
