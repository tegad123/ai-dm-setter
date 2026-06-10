// Lead display-name helpers.
//
// Background: a production bug was observed where a Lead.name was overwritten
// with the text of a chat message (e.g. name = "let me check first my
// schedule") while Lead.handle stayed correct, so the conversation list showed
// the message body as the title. The root write-site is still being traced —
// these helpers are the defensive layer: never SHOW (and ideally never STORE)
// a "name" that is obviously a message body, falling back to the handle.

/**
 * Heuristic: does this string look like a chat message rather than a person's
 * name / handle? Real names/handles are short and don't read like sentences.
 * Intentionally conservative — only flags clear message bodies so a genuine
 * (if unusual) display name is never hidden.
 */
export function looksLikeMessageBody(
  value: string | null | undefined
): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;

  // IMPORTANT: be conservative. Real display names + IG bios legitimately
  // contain punctuation ("Eric Blair Jr.", "Dr. Chuks"), pipes ("Name | Forex
  // | Trader"), emoji, stylized unicode, and can be long. The ONLY reliable
  // signal for the message-body-as-name bug is that the corrupted value reads
  // like a typed sentence — multiple words STARTING with a lowercase
  // conversational opener ("let me check...", "that my whatsapp...", "honestly
  // whatever's open..."). Names/handles don't start that way.
  const words = v.split(/\s+/);
  if (words.length < 3) return false; // 1-2 words: treat as a name, never flag

  // Stylized names spaced out letter-by-letter ("s a m i", "C H O U D H A R Y")
  // are names, not sentences. If most "words" are single characters, bail.
  const singleCharWords = words.filter(
    (w) => w.replace(/[^A-Za-z0-9]/g, '').length <= 1
  );
  if (singleCharWords.length >= words.length / 2) return false;

  const firstChar = v[0];
  // A real name/bio almost always starts with a capital letter, digit,
  // emoji/symbol, or stylized unicode. A typed sentence starts with a plain
  // lowercase ASCII letter.
  const startsLowercaseAscii = /^[a-z]/.test(firstChar);
  if (!startsLowercaseAscii) return false;

  // Lowercase-led AND 3+ words AND contains a common sentence/pronoun word →
  // this is a chat message, not a name.
  const sentenceWord =
    /\b(i|i'?m|im|my|me|we|you|your|let|let'?s|lemme|that'?s?|this|the|is|are|was|were|do|does|did|can|could|would|will|gonna|wanna|just|check|first|here|there|what|when|where|how|why|number|schedule|whatsapp|message|reply|answer|works|slots?|available)\b/i;
  return sentenceWord.test(v);
}

/**
 * Resolve the best display name for a lead: prefer `name`, but if `name` looks
 * like a message body, fall back to `handle`, then `platformUserId`.
 */
export function leadDisplayName(lead: {
  name?: string | null;
  handle?: string | null;
  platformUserId?: string | null;
}): string {
  const { name, handle, platformUserId } = lead;
  if (name && !looksLikeMessageBody(name)) return name;
  if (handle) return handle;
  if (name) return name; // name was message-like but nothing better exists
  return platformUserId || 'Unknown';
}
