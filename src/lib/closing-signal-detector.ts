// ---------------------------------------------------------------------------
// closing-signal-detector.ts
// ---------------------------------------------------------------------------
// Detects when a lead's message is a conversation-closing signal — an
// emoji-only reaction or a short acknowledgment after the AI has already
// signed off. In those cases the AI should NOT respond; anything it says
// is noise that steps on the natural close.
//
// Real-world example this fixes:
//   AI:   "cool, take care bro. catch you later!"
//   Lead: 🫡🤝
//   AI:   "yo, that's a vibe! keep pushing forward, bro 🤙"   ← noise
//
// Pure function, no DB calls. Caller is responsible for fetching the last
// AI message and passing it in. Runs synchronously before any LLM call.
// ---------------------------------------------------------------------------

/** Single-word or short-phrase acknowledgments. Lowercase, no punctuation. */
const CLOSING_WORDS = new Set<string>([
  // Single-word acks
  'bet',
  'alright',
  'aight',
  'cool',
  'ok',
  'okay',
  'word',
  'fasho',
  'gotchu',
  'yessir',
  'yes',
  'yeah',
  'yep',
  'yup',
  'thanks',
  'thx',
  'ty',
  'peace',
  'later',
  'ttyl',
  'respect',
  'noted',
  'copy',
  'roger',
  // Multi-word — matched as a whole trimmed string below
  'say less',
  'appreciate it',
  'appreciate you',
  'thank you',
  'thanks bro',
  'thanks man',
  'all good',
  'good looks',
  'sounds good',
  'for sure',
  'will do',
  'take care',
  'talk soon',
  'bless up'
]);

/**
 * Phrases that indicate the AI's last message was a sign-off / conversation
 * closer. Match is case-insensitive substring.
 */
const AI_SIGNOFF_PATTERNS: string[] = [
  'catch you later',
  'catch u later',
  'take care',
  'hit me up',
  'hmu',
  'let me know',
  'lmk',
  'reach out',
  'talk soon',
  'here if you need',
  'here whenever',
  'have a good',
  'peace out',
  'bless up',
  'good luck',
  'stay tuned',
  'stay safe',
  'keep me posted',
  'appreciate you',
  'appreciate it',
  'catch up soon',
  'hit you up',
  'stay up'
];

/**
 * After this much time has passed since the AI's last message, we treat
 * any inbound lead message as a RE-ENGAGEMENT — close detection doesn't
 * apply even if the wording looks like a closer. People come back after
 * a day saying "yo" and the AI should respond to that, not go silent.
 */
const RECENT_SIGNOFF_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * If the lead's message is LONGER than this (and contains no closing word
 * triggers), we assume it carries substantive content. Empirically 20 chars
 * is long enough for "alright bro but how much is it?" (32 chars, has "?")
 * to also be caught by the question-mark rule, and short enough that
 * "cool sounds good" (16 chars) still reads as a close.
 */
const SHORT_MESSAGE_THRESHOLD = 20;

/**
 * Pure-gratitude patterns. Matches messages like "thank you", "am grateful",
 * "god bless you", "bless up", "appreciate it". Used for the 2+ consecutive
 * gratitude detection — after the AI has delivered a final resource (URL)
 * or signed off, the first gratitude gets a warm LLM response, but further
 * consecutive gratitude messages are suppressed to avoid thanks-loop spam.
 *
 * The threshold for "pure" gratitude is: regex match, no question mark, and
 * under a generous length (80 chars) so "thank you so much bro you're a
 * legend 🙏" still counts but a substantive follow-up question doesn't.
 */
const GRATITUDE_PATTERN =
  /\b(thank\s*you|thanks|thx|ty|grateful|appreciate|god\s+bless|bless\s+you|bless\s+up|blessed)\b/i;
const PURE_GRATITUDE_MAX_CHARS = 80;

/**
 * URL detection in the AI's last message. When the AI has just delivered a
 * link (YouTube video, downsell URL, booking link) we treat that as a
 * "final resource delivered" signal even if no soft-exit phrase was used.
 * The lead's gratitude that follows is acknowledging the resource, not
 * asking a question — the 2+ gratitude suppression applies.
 */
const URL_PATTERN = /\bhttps?:\/\/|\bwww\./i;

function isPureGratitude(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > PURE_GRATITUDE_MAX_CHARS) return false;
  if (/\?/.test(trimmed)) return false;
  return GRATITUDE_PATTERN.test(trimmed);
}

export interface ClosingSignalResult {
  isClosing: boolean;
  reason: string;
}

/**
 * True if the string contains no letters or digits (i.e. only emoji +
 * whitespace + punctuation). Handles all emoji forms including compound
 * emoji, skin tones, and variation selectors without needing unicode
 * property escapes (which require ES2018+ target).
 *
 * Examples that return true: "🫡🤝", "👍", "🔥🔥🔥"
 * Examples that return false: "bet", "alright", "ok 👍"
 */
function isEmojiOnly(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  return !/[A-Za-z0-9]/.test(trimmed);
}

/**
 * Normalize a lead message for matching against closing words. Lowercase,
 * trim, strip trailing punctuation.
 */
function normalizeForAckMatch(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.!,?\-]+$/g, '')
    .trim();
}

/**
 * Main entry point. Decide whether to suppress AI response on this lead
 * message. Returns `{ isClosing: true, reason }` if the AI should NOT
 * reply; returns `{ isClosing: false, reason }` otherwise.
 *
 * @param leadMessage        The text of the lead's latest message.
 * @param lastAIMessage      Content of the AI's most recent message in
 *                           this conversation, or null.
 * @param lastAIMessageAt    Timestamp of that AI message, or null.
 * @param priorLeadMessage   The lead's PREVIOUS message (the one before
 *                           `leadMessage`), regardless of any AI reply in
 *                           between. Used to detect 2+ consecutive
 *                           gratitude messages. Pass null when there is
 *                           no prior lead message (new conversation).
 */
export function isClosingSignal(
  leadMessage: string,
  lastAIMessage: string | null,
  lastAIMessageAt: Date | null,
  priorLeadMessage?: string | null
): ClosingSignalResult {
  const trimmed = leadMessage.trim();
  if (!trimmed) {
    return { isClosing: true, reason: 'empty message' };
  }

  // Question mark almost always means the lead wants engagement, even
  // if the message starts with a closing word ("alright bro but how
  // much is it?").
  if (/\?/.test(trimmed)) {
    return { isClosing: false, reason: 'contains question' };
  }

  // No recent AI message → treat as fresh engagement, don't suppress.
  if (!lastAIMessage || !lastAIMessageAt) {
    return { isClosing: false, reason: 'no recent AI message' };
  }

  // Re-engagement after 2h → don't suppress regardless of content.
  const ageMs = Date.now() - lastAIMessageAt.getTime();
  if (ageMs > RECENT_SIGNOFF_WINDOW_MS) {
    return {
      isClosing: false,
      reason: `re-engagement (${Math.round(ageMs / 60000)}m since AI)`
    };
  }

  // Did the AI sign off OR deliver a final resource (URL)?
  // URL presence is a strong "handed off something for you to go do"
  // signal — after the AI drops a YouTube link or downsell URL, any
  // gratitude that follows is ack'ing the resource, not asking.
  const aiLower = lastAIMessage.toLowerCase();
  const signoffMatch = AI_SIGNOFF_PATTERNS.find((p) => aiLower.includes(p));
  const aiDeliveredResource = URL_PATTERN.test(lastAIMessage);
  const aiClosed = Boolean(signoffMatch) || aiDeliveredResource;

  // ── 2+ consecutive gratitude suppression ──────────────────────
  // Pattern: AI closes (signoff or resource URL). Lead says "thanks"
  // — AI responds with one warm close via normal LLM generation. Lead
  // then says "god bless" / "appreciate you" / etc. — THAT second
  // gratitude is where we suppress, because the conversation has
  // naturally ended and further acknowledgments are noise. This logic
  // runs BEFORE the existing word-list ack check so gratitude paths
  // get their dedicated treatment (first gratitude always allowed
  // through when AI closed, regardless of CLOSING_WORDS overlap).
  if (aiClosed && isPureGratitude(trimmed)) {
    if (priorLeadMessage && isPureGratitude(priorLeadMessage)) {
      return {
        isClosing: true,
        reason: `2+ consecutive gratitude after AI ${aiDeliveredResource ? 'delivered resource' : `signoff "${signoffMatch}"`} — suppressing thanks-loop`
      };
    }
    // First gratitude after AI closed — let the LLM respond warmly
    // ("appreciate you bro, keep grinding 💪🏿" or similar). The
    // prompt's close-conversation guidance handles the tone; we just
    // need to not block the response here.
    return {
      isClosing: false,
      reason: 'first gratitude after AI closed — allow warm close response'
    };
  }

  if (!signoffMatch) {
    return { isClosing: false, reason: 'AI did not sign off' };
  }

  // Case 1: emoji-only response
  if (isEmojiOnly(trimmed)) {
    return {
      isClosing: true,
      reason: `emoji-only response after AI signoff "${signoffMatch}"`
    };
  }

  // Below this point, only SHORT messages qualify. A long message that
  // starts with "cool" is probably substantive.
  if (trimmed.length > SHORT_MESSAGE_THRESHOLD) {
    return {
      isClosing: false,
      reason: `message length ${trimmed.length} > ${SHORT_MESSAGE_THRESHOLD}`
    };
  }

  // Case 2: exact short acknowledgment (with punctuation tolerance)
  const normalized = normalizeForAckMatch(trimmed);
  if (CLOSING_WORDS.has(normalized)) {
    return {
      isClosing: true,
      reason: `exact closing ack "${normalized}" after AI signoff "${signoffMatch}"`
    };
  }

  // Case 3: starts with a closing word and is short
  //   e.g. "bet bro", "cool 🔥", "alright man"
  const firstWord = normalized.split(/\s+/)[0];
  if (firstWord && CLOSING_WORDS.has(firstWord)) {
    return {
      isClosing: true,
      reason: `starts with closing word "${firstWord}" (${trimmed.length} chars)`
    };
  }

  return { isClosing: false, reason: 'no close pattern matched' };
}
