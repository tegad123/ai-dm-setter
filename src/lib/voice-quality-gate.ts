// ---------------------------------------------------------------------------
// voice-quality-gate.ts
// ---------------------------------------------------------------------------
// Post-generation quality scoring to enforce Daniel's texting voice.
// Runs on every AI response. Hard fails trigger regeneration.
// ---------------------------------------------------------------------------

export interface QualityResult {
  score: number; // 0.0 – 1.0
  passed: boolean;
  hardFails: string[];
  softSignals: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DANIEL_VOCAB = new Set([
  'bro',
  'g',
  'brotha',
  'man',
  'haha',
  'ahaha',
  'ahh',
  'damn',
  'fr',
  'tbh',
  'ye',
  'ngl',
  'gotchu',
  'lemme',
  'wanna',
  'gonna',
  'kinda',
  'gotta',
  'lotta',
  'fire',
  'sick',
  'bet',
  'fasho',
  'dialled',
  'dope',
  'tho',
  'nah',
  'yo',
  'yoo',
  'aight'
]);

const BANNED_PHRASES = [
  "i'm sorry to hear",
  'i understand that',
  'i understand how',
  'what specifically',
  'maybe i can help',
  "i'm here to listen",
  "i'm here for you",
  "i'd be happy to",
  'great question',
  "that's wonderful",
  "that's fantastic",
  "that's an excellent",
  'could you elaborate',
  'i appreciate you sharing',
  'let me explain',
  'allow me to',
  'it sounds like you',
  'i can certainly',
  'i completely understand',
  'that must be really',
  'that sounds really difficult'
];

const BANNED_WORDS = [
  'specifically',
  'ultimately',
  'essentially',
  'additionally',
  'furthermore',
  'therefore',
  'nevertheless',
  'consequently',
  'nonetheless'
];

// "however" only banned at sentence start (not mid-sentence like "however you want")
const BANNED_SENTENCE_STARTERS = ['however,', 'however '];

// Patterns that promise follow-up content ("I'll explain", "lemme show you").
// Exported because ai-engine uses them for promise-tracking across turns.
export const PROMISE_PATTERNS: RegExp[] = [
  /\bi['']ll explain\b/i,
  /\blemme explain\b/i,
  /\blet me explain\b/i,
  /\blet me show you\b/i,
  /\blemme show you\b/i,
  /\blet me tell you\b/i,
  /\blemme tell you\b/i,
  /\bi['']ll send you (something|a|the)\b/i,
  /\bhold up[.,]?\s*i['']ll\b/i,
  /\bgimme a sec\b/i,
  /\blemme break (it|this) down\b/i
];

/**
 * Check whether a message looks like an UNKEPT promise — a short cliffhanger
 * that promises content without delivering it. Used by ai-engine to detect
 * when the PREVIOUS AI turn made a promise that the next turn must fulfill.
 *
 * Returns the matched pattern if the message is a short unkept promise,
 * otherwise null. Uses the same 80-char threshold as the hard-fail gate.
 */
export function isUnkeptPromise(message: string): RegExp | null {
  if (!message || message.trim().length >= 80) return null;
  for (const pattern of PROMISE_PATTERNS) {
    if (pattern.test(message)) return pattern;
  }
  return null;
}

const BANNED_EMOJIS = [
  '🙏',
  '👍',
  '🙂',
  '😊',
  '😄',
  '✨',
  '🎯',
  '✅',
  '📈',
  '💰',
  '🚀',
  '💡',
  '🌟',
  '👏',
  '🤝',
  '💪' // without skin tone — Daniel uses 💪🏿 specifically
];

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

export interface VoiceQualityOptions {
  /**
   * When true, relax the 300-char length cap. Used when the turn is
   * delivering on a prior promise ("I'll explain") — explanations need
   * room to actually explain, so we allow up to 500 chars.
   */
  relaxLengthLimit?: boolean;
}

export function scoreVoiceQuality(
  reply: string,
  options?: VoiceQualityOptions
): QualityResult {
  const hardFails: string[] = [];
  const softSignals: Record<string, number> = {};

  const lower = reply.toLowerCase();

  // ── Hard fail checks ────────────────────────────────────────────

  // 1. Banned phrases
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      hardFails.push(`banned_phrase: "${phrase}"`);
    }
  }

  // 2. Banned words (full word match)
  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(reply)) {
      hardFails.push(`banned_word: "${word}"`);
    }
  }

  // 3. Banned sentence starters
  const sentences = reply.split(/[.!?\n]+/).map((s) => s.trim().toLowerCase());
  for (const sentence of sentences) {
    for (const starter of BANNED_SENTENCE_STARTERS) {
      if (sentence.startsWith(starter)) {
        hardFails.push(`banned_starter: "However"`);
        break;
      }
    }
  }

  // 4. Banned emojis
  for (const emoji of BANNED_EMOJIS) {
    if (reply.includes(emoji) && !reply.includes(emoji + '\u{1F3FF}')) {
      // Allow 💪🏿 (with dark skin tone) but ban plain 💪
      hardFails.push(`banned_emoji: ${emoji}`);
    }
  }

  // 5. Em dash or en dash
  if (reply.includes('—')) {
    hardFails.push('em_dash');
  }
  if (reply.includes('–')) {
    hardFails.push('en_dash');
  }

  // 6. Semicolon
  if (reply.includes(';')) {
    hardFails.push('semicolon');
  }

  // 7. "lol" (Daniel uses "haha")
  if (/\blol\b/i.test(reply)) {
    hardFails.push('lol_instead_of_haha');
  }

  // 8. Message too long — 300 chars normally, 500 when relaxed (e.g., when
  // the turn is delivering on a prior promise and needs room to explain).
  const lengthCap = options?.relaxLengthLimit ? 500 : 300;
  if (reply.length > lengthCap) {
    hardFails.push(
      `message_too_long: ${reply.length} chars (cap ${lengthCap})`
    );
  }

  // 9. Cliffhanger preamble — a short message that promises follow-up
  // content without delivering it. Happens when the LLM generates a
  // voice-note intro ("My G! I'll explain") but the voice note never
  // gets attached (empty library, matcher miss, ElevenLabs fails). The
  // result is a standalone fragment that reads like the AI ghosted the
  // lead mid-thought.
  for (const cliffhangerPattern of PROMISE_PATTERNS) {
    if (cliffhangerPattern.test(reply)) {
      if (reply.trim().length < 80) {
        hardFails.push(
          `cliffhanger_preamble: matched "${cliffhangerPattern.source}" in ${reply.trim().length}-char message`
        );
        break;
      }
    }
  }

  // 10b. Fabricated time-slot proposal — the booking flow is script-driven:
  // the AI sends the booking link from the script and the lead picks their
  // own time. The AI must NOT propose specific day+time combinations.
  // Hallucinated slots like "Monday at 2 PM" are a critical failure (R14)
  // because we have no way to guarantee the time is available and the
  // system isn't going to book it automatically.
  // Matches patterns like "Monday at 2 PM", "Tuesday 10am", "Friday at 4
  // PM CST", "tomorrow at 3pm", and the lead-in phrase "here are a couple
  // of slots".
  const TIME_SLOT_PATTERNS: RegExp[] = [
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm)\b/i,
    /\b(tomorrow|today)\s+(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm)\b/i,
    /\bhere are (a|some|2|3|two|three) (couple of )?slots?\b/i,
    /\bchoose from\b.*\b\d{1,2}\s*(am|pm)\b/i,
    /\b(which|what) (one|time|slot) works (best|better)\b/i
  ];
  for (const pat of TIME_SLOT_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `fabricated_time_slot: matched "${pat.source}" — booking is script-driven, don't propose specific times`
      );
      break;
    }
  }

  // 10. Title-case opener — Daniel's voice starts messages in lowercase.
  // "That's smart thinking bro" breaks the voice; "that's smart thinking bro"
  // keeps it. Only fires on the first alphabetic character — inside the
  // message proper nouns (names, FTMO) stay capitalized. Exceptions:
  //   - "I" as a standalone pronoun ("I feel you")
  //   - ALL-CAPS first word of <=3 chars ("OMG", "WYD", "IMO")
  const firstCharMatch = reply.trim().match(/[A-Za-z]/);
  if (
    firstCharMatch &&
    firstCharMatch.index !== undefined &&
    reply.trim().length >= 3
  ) {
    const ch = firstCharMatch[0];
    const firstWord = reply
      .trim()
      .slice(firstCharMatch.index)
      .split(/\s+/)[0]
      .replace(/[^A-Za-z]/g, '');
    const isAllCapsShort =
      firstWord.length > 0 &&
      firstWord.length <= 3 &&
      firstWord === firstWord.toUpperCase();
    const isStandaloneI = firstWord === 'I';
    if (
      ch === ch.toUpperCase() &&
      ch !== ch.toLowerCase() &&
      !isAllCapsShort &&
      !isStandaloneI
    ) {
      hardFails.push(
        `title_case_opener: starts with "${firstWord}" — voice requires lowercase openers`
      );
    }
  }

  // ── Soft scoring ────────────────────────────────────────────────

  // Under 200 chars
  if (reply.length <= 200) {
    softSignals.short_message = 1.0;
  } else if (reply.length <= 250) {
    softSignals.short_message = 0.5;
  } else {
    softSignals.short_message = 0;
  }

  // Contains Daniel vocab
  const words = lower.split(/\s+/);
  const hasVocab = words.some((w) =>
    DANIEL_VOCAB.has(w.replace(/[^a-z]/g, ''))
  );
  softSignals.has_daniel_vocab = hasVocab ? 1.0 : 0;

  // Sentence count (2 or fewer = good)
  const sentenceCount = reply
    .split(/[.!?]+/)
    .filter((s) => s.trim().length > 0).length;
  if (sentenceCount <= 2) {
    softSignals.short_sentences = 1.0;
  } else if (sentenceCount <= 3) {
    softSignals.short_sentences = 0.5;
  } else {
    softSignals.short_sentences = 0;
  }

  // Starts with lowercase (Daniel's style)
  if (reply.length > 0 && reply[0] === reply[0].toLowerCase()) {
    softSignals.lowercase_start = 0.5;
  } else {
    softSignals.lowercase_start = 0;
  }

  // Uses approved emoji
  const approvedEmojis = ['💪🏿', '😂', '🔥', '💯', '❤'];
  const hasApprovedEmoji = approvedEmojis.some((e) => reply.includes(e));
  softSignals.approved_emoji = hasApprovedEmoji ? 0.5 : 0;

  // ── Calculate final score ───────────────────────────────────────
  const maxScore = 4.0; // 1 + 1 + 1 + 0.5 + 0.5 (emoji is bonus, not required)
  const rawScore = Object.values(softSignals).reduce((a, b) => a + b, 0);
  const score = Math.min(1.0, rawScore / maxScore);

  return {
    score,
    passed: hardFails.length === 0 && score >= 0.7,
    hardFails,
    softSignals
  };
}
