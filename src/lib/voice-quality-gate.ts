// ---------------------------------------------------------------------------
// voice-quality-gate.ts
// ---------------------------------------------------------------------------
// Post-generation quality scoring. Runs on every AI response. Hard fails
// trigger regeneration.
// ---------------------------------------------------------------------------

import {
  checkCallProposalPrereqs,
  checkCapitalQuestionPrereqs,
  countQuestionMarks,
  detectAcknowledgmentOpener,
  detectCallProposalAttempt,
  detectCapitalQuestionAttempt,
  detectMandatoryAskSkipped,
  detectStep10Skipped,
  detectStepDistanceViolation,
  inferStepLabelFromReply,
  isRuntimePlaceholderOnly,
  maxQuestionSimilarityToScript
} from '@/lib/script-step-progression';

export interface QualityResult {
  score: number; // 0.0 – 1.0
  passed: boolean;
  hardFails: string[];
  softSignals: Record<string, number>;
}

export interface RequiredMessage {
  content: string;
  isPlaceholder?: boolean;
  embeddedQuotes?: string[];
}

export const FORBIDDEN_AI_DASH_PATTERN = /[\u2013\u2014]/;

export const METADATA_LEAK_PATTERNS: RegExp[] = [
  // Specific known leak surfaces from structured LLM output.
  /stage_confidence\s*[:=]\s*[\d.]+/i,
  /quality_score\s*[:=]\s*\d+/i,
  /confidence\s*[:=]\s*[\d.]+/i,
  /priority_score\s*[:=]\s*\d+/i,
  /stage\s*[:=]\s*[A-Z_]+/i,
  /intent\s*[:=]\s*[A-Z_]+/i,
  /sentiment\s*[:=]\s*[A-Z_]+/i,
  /next_action\s*[:=]/i,
  /script_step\s*[:=]/i,
  /current_stage\s*[:=]/i,

  // Generic field_name:value signatures where the value resembles system data.
  /\b[a-z_]+_(?:confidence|score|stage|level|count|id|status)\s*[:=]\s*[\w.]+/i,
  /\b[a-z]+_[a-z_]+\s*[:=]\s*[\w.]+/i,

  // JSON-like fragments and whole-message JSON payloads.
  /\{[^}]*"[^"]+"\s*:\s*[^}]+\}/,
  /^\s*\{[\s\S]*\}\s*$/,
  /\[[\s{]*"[^"]+"\s*:\s*[^\]]+\]/,

  // Variable-style placeholders and script/template leakage.
  /\[[A-Z][A-Z_\s]+\]/,
  /\{\{[^}]+\}\}/,
  /<[A-Z_]+>/,

  // System annotations and URL-encoded structured data fragments.
  /\(note\s*:\s*[^)]+\)/i,
  /\(system\s*:\s*[^)]+\)/i,
  /\(debug\s*:\s*[^)]+\)/i,
  /\(internal\s*:\s*[^)]+\)/i,
  /%7B|%7D|%5B|%5D|%22|%3A/i,
  /```[\s\S]*?(stage_confidence|quality_score|priority_score|current_stage|script_step|next_action)[\s\S]*?```/i,

  // Trailing machine fields appended after otherwise normal copy.
  /[.!?]\s+[a-z_]+[:=][\w.]+/i
];

const METADATA_LEAK_FALSE_POSITIVE_GUARDS: RegExp[] = [
  /^https?:/i,
  /\d+:\d+\s*(am|pm|cst|est|pst|mst|gmt|utc|ct|et|pt|mt)/i,
  /^[A-Z][a-z]+:/,
  /\bratio\s+(is\s+)?\d+\s*:\s*\d+\b/i,
  /\brisk\s*[:/]\s*reward\b/i
];

export function detectMetadataLeak(reply: string): {
  leak: boolean;
  matchedPattern: string | null;
  matchedText: string | null;
} {
  if (!reply || typeof reply !== 'string') {
    return { leak: false, matchedPattern: null, matchedText: null };
  }

  for (const pattern of METADATA_LEAK_PATTERNS) {
    const match = reply.match(pattern);
    if (!match) continue;
    const matchedText = match[0];
    const isFalsePositive = METADATA_LEAK_FALSE_POSITIVE_GUARDS.some((guard) =>
      guard.test(matchedText)
    );
    if (isFalsePositive) continue;
    return {
      leak: true,
      matchedPattern: pattern.toString(),
      matchedText
    };
  }

  return { leak: false, matchedPattern: null, matchedText: null };
}

export function surgicalStripMetadataLeak(
  reply: string,
  matchedText: string
): { success: boolean; content: string } {
  if (!reply || !matchedText) return { success: false, content: '' };

  let stripped = reply.replace(matchedText, '').trim();
  stripped = stripped
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/[.,]\s*$/, '')
    .trim();

  if (stripped.length < 10) return { success: false, content: '' };
  if (stripped.split(/\s+/).filter(Boolean).length < 3) {
    return { success: false, content: '' };
  }
  if (detectMetadataLeak(stripped).leak) {
    return { success: false, content: '' };
  }

  return { success: true, content: stripped };
}

/**
 * Last-line R17 sanitizer for AI delivery paths.
 *
 * The quality gate hard-fails em/en dashes and forces regeneration, but
 * manually approved suggestions, scheduled sends, and operator-triggered AI
 * sends can enter closer to delivery. Keep one shared scrubber so forbidden
 * dash characters never reach Meta even when generation was triggered outside
 * the normal webhook path.
 */
export function sanitizeDashCharacters(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/\u2013/g, '-')
    .replace(/\s+-\s+/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/ {2,}/g, ' ')
    .trim();
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
  'real',
  'makes',
  'sense',
  'actually',
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
  'that sounds really difficult',
  // 2026-04-26 — Rodrigo Moran: "real quick tho" had become a bot
  // tell. Used as a transition before nearly every qualifying
  // question. Hard-banned so the LLM has to find natural transitions.
  'real quick tho'
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

const CALL_PITCH_RE =
  /\b(hop on a (quick )?(call|chat)|call with [A-Z][a-z]+|quick (call|chat)|jump on a (quick )?(call|chat)|get on a (quick )?(call|chat)|15[- ]?min(ute)? (call|chat))\b/i;

const CALL_OR_BOOKING_ADVANCEMENT_RE =
  /\b(hop on a (quick )?(call|chat)|call with [A-Z][a-z]+|quick (call|chat)|jump on a (quick )?(call|chat)|get on a (quick )?(call|chat)|15[- ]?min(ute)? (call|chat)|typeform|application|booking link|book(ing)?\s+(a\s+)?call|send(ing)?\s+(you\s+)?(the\s+)?link\s+(to|for)\s+(apply|book|schedule)|fill\s+(it|this|the form|everything)\s+out)\b/i;

const SCHEDULING_QUESTION_RE =
  /\b(what|which)\s+(day|time)\s+works|\bwhen\s+(are\s+you\s+free|works|can\s+you\s+hop\s+on)|\bwhen('?s| is)\s+(better|best|good)\s+for\s+you|\bwhat\s+(day|time)\s+are\s+you\s+free|\bwhat'?s\s+(a\s+good\s+time|your\s+schedule)|\bwhat\s+does\s+your\s+schedule\s+look\s+like/i;

const TIMEZONE_QUESTION_RE =
  /\b(what|which)\s+time\s*zone\b|\bwhat('?s| is)\s+your\s+time\s*zone\b|\bwhere\s+are\s+you\s+based\b|\bwhat\s+timezone\s+(are\s+you\s+in|you\s+in)\b/i;

const CALL_ACCEPTANCE_RE =
  /\b(yes|yeah|yep|yup|sure|sounds\s+good|let'?s\s+do\s+it|lets\s+do\s+it|i'?m\s+down|im\s+down|that\s+works|works\s+for\s+me|any\s+day|asap|send\s+(it|the\s+link)|drop\s+(it|the\s+link)|go\s+ahead|perfect|okay|ok)\b/i;

const VALIDATION_PHRASE_RE =
  /\b(facts bro|gotchu bro|yeah bro|bet bro|love that bro|fasho bro)\b/i;
const VALIDATION_THOUSAND_RE = /^\s*1000\b/i;

type RepeatOpenerPattern = {
  id: string;
  label: string;
  pattern: RegExp;
};

export type RepeatOpenerMatch = {
  id: string;
  label: string;
  match: string;
};

export const REPEAT_OPENER_PATTERNS: RepeatOpenerPattern[] = [
  {
    id: 'gotchu',
    label: 'gotchu bro',
    pattern: /^\s*["'“”‘’]?\s*gotchu\s+bro\b/i
  },
  { id: 'gotchu', label: 'gotchu', pattern: /^\s*["'“”‘’]?\s*gotchu\b/i },
  {
    id: 'facts',
    label: 'facts bro',
    pattern: /^\s*["'“”‘’]?\s*facts\s+bro\b/i
  },
  { id: 'facts', label: 'facts', pattern: /^\s*["'“”‘’]?\s*facts\b/i },
  { id: 'bet', label: 'bet bro', pattern: /^\s*["'“”‘’]?\s*bet\s+bro\b/i },
  {
    id: 'makes_sense_bro',
    label: 'makes sense bro',
    pattern: /^\s*["'“”‘’]?\s*makes\s+sense\s+bro\b/i
  }
];

export type MessageStructure =
  | 'single_ack_question'
  | 'two_short_reaction_question'
  | 'two_longer_empathy_question'
  | 'single_question'
  | 'three_react_dig_question'
  | 'other';

export const TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE =
  "no worries bro, the team will review your application and reach out directly if it's a good fit 🙏🏿";

const BOOKING_CONFIRMATION_QUESTION_PATTERNS: RegExp[] = [
  /\bwhat\s+day\s+and\s+time\s+did\s+you\s+book\b/i,
  /\bwhat\s+day\s*\/\s*time\s+did\s+you\s+book\b/i,
  /\bwhat\s+time\s+did\s+you\s+(book|schedule)\b/i
];

const BOOKED_DAY_TIME_PATTERNS: RegExp[] = [
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)\b/i,
  /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i,
  /\b(morning|afternoon|evening)\b/i
];

const TYPEFORM_FILLED_NO_BOOKING_PATTERNS: RegExp[] = [
  /\bnot\s+yet\b/i,
  /\bonly\s+(the\s+)?(basic|form|questions?)\b/i,
  /\bjust\s+(the\s+)?(form|questions?|basic)\b/i,
  /\bfilled\s+(it\s+)?out\b/i,
  /\bcompleted\s+(it|the\s+form)\b/i,
  /\bdone(\s+with\s+(it|the\s+form))?\b/i,
  /\bsubmitted\s+(it|the\s+form|the\s+application|my\s+application)\b/i,
  /\b(no|didn'?t\s+see\s+a)\s+(booking\s+)?(option|booking\s+option)\b/i,
  /\bno\s+time\s+(booked|selected|picked|chosen)\b/i,
  /\b(form|application)\s+(is\s+)?(done|complete|completed|submitted)\b/i
];

const SCHEDULING_CONFLICT_INSTEAD_OF_SCREENOUT_PATTERNS: RegExp[] = [
  /\b(couldn'?t|could\s+not|can'?t|cannot)\s+find\s+(any\s+)?(available\s+)?(times?|slots?)\b/i,
  /\bno\s+(available\s+)?(times?|slots?)\s+(available|showed|showed\s+up|were\s+available)\b/i,
  /\b(no|none\s+of\s+the)\s+(available\s+)?(times?|slots?)\s+(worked|work|fit)\b/i,
  /\bonly\s+(slot|time)\s+(was|is)\b/i,
  /\b(the\s+)?(times?|slots?)\s+(don'?t|didn'?t|do\s+not|did\s+not)\s+work\b/i
];

export function containsCallPitch(text: string): boolean {
  return CALL_PITCH_RE.test(text);
}

export function containsCallOrBookingAdvancement(text: string): boolean {
  return CALL_OR_BOOKING_ADVANCEMENT_RE.test(text);
}

export function containsSchedulingQuestion(text: string): boolean {
  return SCHEDULING_QUESTION_RE.test(text);
}

export function containsLogisticsQuestion(text: string): boolean {
  return SCHEDULING_QUESTION_RE.test(text) || TIMEZONE_QUESTION_RE.test(text);
}

export function isValidationOnlyMessage(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('?')) return false;
  return (
    VALIDATION_PHRASE_RE.test(trimmed) || VALIDATION_THOUSAND_RE.test(trimmed)
  );
}

export function containsBookingConfirmationQuestion(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return BOOKING_CONFIRMATION_QUESTION_PATTERNS.some((pat) => pat.test(text));
}

export function containsBookedDayTimeAnswer(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return BOOKED_DAY_TIME_PATTERNS.some((pat) => pat.test(text));
}

export function looksLikeSchedulingConflictInsteadOfScreenOut(
  text: string
): boolean {
  if (!text || typeof text !== 'string') return false;
  return SCHEDULING_CONFLICT_INSTEAD_OF_SCREENOUT_PATTERNS.some((pat) =>
    pat.test(text)
  );
}

export function looksLikeTypeformFilledNoBookingAnswer(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  if (containsBookedDayTimeAnswer(text)) return false;
  if (looksLikeSchedulingConflictInsteadOfScreenOut(text)) return false;
  return TYPEFORM_FILLED_NO_BOOKING_PATTERNS.some((pat) => pat.test(text));
}

export function detectTypeformFilledNoBookingContext(
  previousAIMessage: string | null | undefined,
  currentLeadMessage: string | null | undefined
): boolean {
  return (
    containsBookingConfirmationQuestion(previousAIMessage || '') &&
    looksLikeTypeformFilledNoBookingAnswer(currentLeadMessage || '')
  );
}

export function isTypeformNoBookingSoftExitReply(text: string): boolean {
  return (text || '').trim() === TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE.trim();
}

export function leadGaveLongTimeline(text: string | null | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const mentionsExperience =
    /\b(been|trading|trade|studying|study|experience|markets?|doing\s+this|at\s+it)\b/.test(
      normalized
    );
  const timelineAnchor =
    /\b(in|within|after|from\s+now|away|timeline|make\s+it\s+happen|ready|start|starting|maybe|probably|give\s+me|next|over)\b/.test(
      normalized
    );
  const rangeTwoThree =
    /\b(two|2)\s*(?:-|to|or|\/)\s*(three|3)\s*(?:years?|yrs?)\b/.test(
      normalized
    );
  const anchoredYears =
    /\b(in|within|after|give\s+me|next|over)\s+(two|three|[2-9]|[1-9]\d)\+?\s*(?:years?|yrs?)\b/.test(
      normalized
    ) ||
    /\b(two|three|[2-9]|[1-9]\d)\+?\s*(?:years?|yrs?)\s+(from\s+now|away|out)\b/.test(
      normalized
    );
  const shortAnswer =
    normalized.length <= 40 &&
    /\b(two|three|[2-9]|[1-9]\d)\+?\s*(?:years?|yrs?)\b/.test(normalized);

  if (rangeTwoThree || anchoredYears) return true;
  if (shortAnswer && (!mentionsExperience || timelineAnchor)) return true;
  return false;
}

// Casual ack openers that, when they OPEN a single-bubble reply that
// also ends in `?`, classify the turn as acknowledgment + question.
// That structure is allowed now; the classifier uses it for cadence
// rotation instead of forcing every ack/question pair into two bubbles.
const CONCATENATED_ACK_QUESTION_RE =
  /^(that'?s|gotchu|gotcha|love that|fasho|damn|bet|sick|respect|facts?|fire|yo|yeah|appreciate|ah|aight|word|nice|solid|dope|aw|oh|hey|hell yeah|hella|big bro|bro)\b[^?]*[.!,]\s+\w[^?]*\?$/i;

/**
 * True when a single bubble looks like acknowledgment-then-question:
 * opens with a casual ack phrase and ends in `?` with a sentence
 * boundary (period, exclamation, or comma) between.
 */
export function looksLikeConcatenatedAckQuestion(s: string): boolean {
  if (!s || typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (!trimmed.endsWith('?')) return false;
  if (trimmed.length < 30) return false; // legit short single thought
  return CONCATENATED_ACK_QUESTION_RE.test(trimmed);
}

export function detectRepeatOpener(text: string): RepeatOpenerMatch | null {
  if (!text || typeof text !== 'string') return null;
  for (const opener of REPEAT_OPENER_PATTERNS) {
    const match = text.match(opener.pattern);
    if (match) {
      return {
        id: opener.id,
        label: opener.label,
        match: match[0].trim()
      };
    }
  }
  return null;
}

function sentenceCount(text: string): number {
  return text.split(/[.!?]+/).filter((part) => part.trim().length > 0).length;
}

export function classifyMessageStructure(messages: string[]): MessageStructure {
  const cleaned = messages
    .map((message) => (message || '').trim())
    .filter(Boolean);
  if (cleaned.length === 0) return 'other';

  const hasQuestion = (message: string) => /\?/.test(message);

  if (cleaned.length === 1) {
    const only = cleaned[0];
    if (!hasQuestion(only)) return 'other';
    if (looksLikeConcatenatedAckQuestion(only)) {
      return 'single_ack_question';
    }
    return 'single_question';
  }

  if (cleaned.length === 2) {
    const [first, second] = cleaned;
    if (!hasQuestion(second)) return 'other';
    if (first.length <= 80 && sentenceCount(first) <= 1) {
      return 'two_short_reaction_question';
    }
    return 'two_longer_empathy_question';
  }

  if (
    cleaned.length >= 3 &&
    cleaned.some(hasQuestion) &&
    !hasQuestion(cleaned[0]) &&
    !hasQuestion(cleaned[1])
  ) {
    return 'three_react_dig_question';
  }

  return 'other';
}

export function isCallAcceptance(text: string): boolean {
  if (
    /\b(not\s+sure|maybe|i'?ll\s+think|let\s+me\s+think|not\s+now)\b/i.test(
      text
    )
  ) {
    return false;
  }
  return CALL_ACCEPTANCE_RE.test(text);
}

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

// Emojis that are NOT in Daniel's approved set (💪🏿 😂 🔥 💯 ❤) and
// have been observed slipping through in production. The gate hard-fails
// any reply containing one of these, forcing a retry. Keep this in sync
// with what the prompt tells the LLM is allowed.
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
  '🤙', // "call me" hand — LLM kept using this despite not being in the set
  '🙌', // raised hands — same
  '💪' // without skin tone — Daniel uses 💪🏿 specifically
];

const CALL_LOGISTICS_PATTERNS = [
  /\bquiet (spot|area|place|environment|room)\b/i,
  /make sure you('?re| are) in a/i,
  /be ready (for|with|by)/i,
  /come (prepared|ready)/i,
  /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+\d/i,
  /\d+\s*(am|pm)\s+(cst|est|pst|mst|gmt|utc|ct|et|pt|mt)\b/i,
  /see (the )?gameplan (clearly|properly)/i,
  /so you can (actually )?see/i
];

const ACK_ONLY_PATTERNS = [
  /^(sounds?\s+good|ok(ay)?|got it|cool|bet|word|aight|alright|sure|yes( that works)?|yep|yeah|nice|perfect)(\s+(bro|g|man|fam))?[\s.!?]*$/i,
  /^(👍|🤝|💪|💪🏿|🤝🏿)[\s.!?]*$/i
];

const SETTER_SENDERS = new Set(['AI', 'HUMAN', 'AI_SETTER', 'HUMAN_SETTER']);

export function containsCallLogisticsContent(
  text: string | null | undefined
): boolean {
  if (!text) return false;
  return CALL_LOGISTICS_PATTERNS.some((pattern) => pattern.test(text));
}

export function isAcknowledgmentOnlyLeadMessage(
  text: string | null | undefined
): boolean {
  if (!text) return false;
  return ACK_ONLY_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

export function callLogisticsAlreadyDeliveredInRecentHistory(
  messages: Array<{ sender?: string | null; content?: string | null }>
): boolean {
  return messages
    .slice(-8)
    .filter((message) => SETTER_SENDERS.has(String(message.sender)))
    .some((message) => containsCallLogisticsContent(message.content));
}

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
  /**
   * Opt-out for the R26 off-topic-advice regex. Defaults to false, which
   * means the gate blocks messages mentioning freelancing / Fiverr /
   * side-hustles / etc. — the AI is a sales setter for a specific
   * business, not a general wealth-building advisor. Set to true ONLY
   * for accounts whose actual business legitimately covers these topics
   * (a financial-literacy coach, a side-hustle teacher, etc.). Most
   * accounts should leave this false.
   */
  allowGeneralAdvice?: boolean;
  /**
   * Total number of messages in the conversation so far (LEAD + AI
   * combined). Used by the premature_soft_exit_warm_lead signal — a
   * "here's the video, good luck" style wrap on message 4 is almost
   * always an AI ghosting a warm lead, whereas the same phrasing
   * after message 20 is usually a legitimate close.
   */
  conversationMessageCount?: number;
  /**
   * Current Lead.stage snapshot (the same value that rides on
   * leadContext.status). Used by the premature_soft_exit signal to
   * skip firing on leads who have already been disqualified — "good
   * luck with your journey" after R24 failed is a legitimate SOFT_EXIT,
   * not a premature one.
   */
  leadStage?: string;
  /**
   * Current-turn R24 capital-verification outcome when available. Used
   * as a second safety net against firing premature_soft_exit on leads
   * whose most recent capital answer failed this turn (leadStage lags
   * by one webhook cycle; capitalOutcome is authoritative for the
   * current turn).
   */
  capitalOutcome?:
    | 'passed'
    | 'failed'
    | 'hedging'
    | 'ambiguous'
    | 'not_asked'
    | 'not_evaluated';
  /**
   * The most-recent AI bubble or joined message from the previous turn.
   * Used by two checks:
   *   • repeated_question (soft -0.4): the AI asked a question, the lead
   *     responded with their own question / off-topic msg, and the AI
   *     re-asked the same question this turn without acknowledging the
   *     interjection. Detected via Jaccard similarity of question
   *     sentences ≥ 0.7. Souljah J 2026-04-25.
   *   • repeated_call_pitch (hardFail): the previous AI message and the
   *     current one BOTH match a call-pitch pattern. Forces regen with
   *     the directive that the lead's interim response must be addressed
   *     before pitching again.
   * Pass null/undefined when there is no prior AI turn (e.g. the AI is
   * sending the first message); the checks no-op in that case.
   */
  previousAIMessage?: string | null;
  /**
   * Last few AI turns joined into one string per turn. Used by
   * repeated_opener to stop "gotchu bro" / "facts bro" / similar
   * openers from appearing back-to-back or repeatedly inside a short
   * window. Pass grouped turns rather than raw bubbles when available.
   */
  recentAIMessages?: string[];
  /**
   * Structure classifications for recent AI turns. The group gate uses
   * this to block the third identical shape in a row, e.g. short ack
   * bubble + question bubble every single turn.
   */
  priorMessageStructures?: MessageStructure[];
  /**
   * Prior AI questions from the wider conversation history. Used as a
   * backstop for repeated_question when the duplicate ask is not the
   * immediately previous AI bubble.
   */
  previousAIQuestions?: string[];
  /**
   * Count of AI Message rows after including the current generated turn.
   * Used for qualification pacing so the AI doesn't spend dozens of
   * messages in free trading consultation without moving the script.
   */
  aiMessageCount?: number;
  /**
   * Conversation origin. MANYCHAT conversations are outbound handoffs:
   * early lead acceptance means opening engagement, not permission to
   * skip discovery and ask capital immediately.
   */
  conversationSource?: 'INBOUND' | 'MANYCHAT' | 'MANUAL_UPLOAD' | string | null;
  /**
   * Script-state captured data points persisted on Conversation. Used by
   * the ManyChat early-capital guard to verify discovery has actually
   * happened before allowing any capital question.
   */
  capturedDataPoints?: Record<string, unknown> | null;
  /**
   * True when the current script step contains at least one branch
   * shaped like [MSG] + [WAIT] with no [ASK] (a "silent branch", e.g.
   * daetradez Step 4 "Obstacle given — detailed and emotional"). When
   * the AI's reply opens with an emotional acknowledgment phrase AND
   * contains a `?`, the gate hard-fails — the LLM took the silent
   * branch but appended an off-script question.
   */
  currentStepHasSilentBranch?: boolean;
  /**
   * Branch labels that are silent (used by the regen directive so the
   * LLM knows which branch to honor with acknowledgment-only).
   */
  currentStepSilentBranchLabels?: string[];
  /**
   * The exact [ASK] question texts the script defines for the current
   * step (across all branches). Used by the soft signal that flags
   * improvised off-script questions when their word overlap with the
   * scripted asks is below threshold.
   */
  currentStepScriptedQuestions?: string[];
  /**
   * Direct current-step [MSG] action contents that must be delivered
   * verbatim or near-verbatim before the model advances.
   */
  currentStepRequiredMessages?: string[];
  /**
   * [MSG] requirements scoped to the classifier-selected branch. When this
   * is present, it is authoritative for verbatim enforcement; the step-global
   * currentStepRequiredMessages list is only a fallback for unrouted steps.
   */
  activeBranchRequiredMessages?: RequiredMessage[];
  /** True when the current step has at least one [ASK] action in any branch. */
  currentStepHasAnyAskAction?: boolean;
  /** True when the classifier-selected branch has [MSG]+[WAIT] and no [ASK]. */
  activeBranchHasSilentBranch?: boolean;
  /** True when the classifier-selected branch contains an [ASK]. */
  activeBranchHasAskAction?: boolean;
  /**
   * True when the active/selected branch for the current step contains
   * an [ASK]. Falls back to currentStepHasAnyAskAction when routing
   * cannot identify the active branch.
   */
  currentStepHasAskBranch?: boolean;
  /** Diagnostic label for the active/selected branch used by ask gating. */
  currentStepActiveBranchLabel?: string | null;
  /** True when the active/selected branch is [MSG]+[WAIT] with no [ASK]. */
  currentStepActiveBranchIsSilent?: boolean;
  /** True when the active/selected branch contains only [JUDGE] actions. */
  currentStepActiveBranchIsJudgeOnly?: boolean;
  /**
   * The step number the AI is currently working on (inferred from
   * priorAIMessages.length + the script's snapshot). Used by the
   * step-distance violation detector to hard-fail when the reply's
   * inferred step is more than 3 ahead of currentScriptStepNumber.
   */
  currentScriptStepNumber?: number | null;
  /**
   * Full content list of all prior AI messages on this conversation.
   * Used by the mandatory-ask-skipped guard to verify that scripted
   * [ASK] phrasings actually fired in history before the AI is allowed
   * to advance to Step 9+. Distinct from `recentAIMessages` (last 3
   * only) and `previousAIQuestions` (questions only) — this includes
   * the full body so [MSG] phrasings (e.g. "how much is your job
   * bringing in monthly") can be detected even when not phrased as
   * questions.
   */
  aiMessageHistoryFull?: Array<{ content: string | null | undefined } | string>;
  /** Current LLM-reported stage for this generated turn. */
  currentStage?: string | null;
  /**
   * When true, suppresses the legacy hardcoded pacing gates that were
   * built for the old collapsed-script structure:
   *   - income_goal_overdue ("by the 4th AI message, ask income goal")
   *   - qualification_stalled ("if still in Goal/Why by message 8, advance")
   *   - capital_question_overdue ("by message 12, ask capital")
   * These gates conflict with the parsed 22-step relational Script
   * pacing (e.g. daetradez asks income from JOB at Step 7 and income
   * goal from TRADING at Step 9, and capital is Step 18 after call
   * proposal acceptance — all legitimately later than the legacy
   * message-count deadlines).
   * Defaulted true in ai-engine when an active relational Script is
   * present for the account; left false for legacy rawScript-only
   * accounts so existing behavior is preserved. Set explicitly via
   * AIPersona.promptConfig.skipLegacyPacingGates to override the
   * auto-detection.
   * Soft signal `qualification_pace_too_slow` is preserved either way —
   * it doesn't hard-fail and is informational.
   */
  skipLegacyPacingGates?: boolean;
  /** Whether any prior AI turn already asked about the lead's income goal. */
  incomeGoalAsked?: boolean;
  /** Whether any prior AI turn already asked the capital verification question. */
  capitalQuestionAsked?: boolean;
  /** Whether this account requires capital verification before booking/call pitch. */
  capitalVerificationRequired?: boolean;
  /** True only after a capital question was asked and a lead answer was received. */
  capitalVerificationSatisfied?: boolean;
  /** Most recent lead message before this generated reply. */
  previousLeadMessage?: string | null;
  /** True when the most recent lead message included an image attachment. */
  previousLeadHadImage?: boolean;
  /** Email already captured for this lead. Used to prevent repeat asks. */
  leadEmail?: string | null;
  /**
   * Conversation scheduled call timestamp. When null, homework links
   * must not be sent because the call time has not been confirmed.
   */
  scheduledCallAt?: Date | string | null;
  /** Configured pre-call homework URL for this account, when present. */
  homeworkUrl?: string | null;
  /**
   * Count of prior AI messages that contained a capital-verification
   * question (Rodrigo Moran 2026-04-26 fix). When >= 1 and the current
   * reply ALSO contains the capital question shape, the gate hard-fails
   * with `repeated_capital_question`. Capital is asked ONCE in a
   * conversation. If the lead's answer was ambiguous or unanswered,
   * the AI should advance the conversation differently — repeated
   * threshold asks make the bot feel stuck (which Rodrigo literally
   * called out: "I think your bot is stuck doing a loop").
   *
   * Distinct from `capitalQuestionAsked` (boolean used by the
   * qualification_stalled signal): that gates "must ask by message 10";
   * this gates "must NOT ask twice".
   */
  priorCapitalQuestionAskCount?: number;
  /**
   * Count of prior AI messages containing the phrase "real quick"
   * (Rodrigo Moran 2026-04-26 fix). Used by the
   * `overused_transition_phrase` soft signal to penalise the LLM
   * latching onto "real quick tho" as a default transition. > 2
   * priors + a fresh use in this turn fires the soft signal at -0.3
   * per occurrence above 2. "real quick tho" itself is also in
   * BANNED_PHRASES (hard-fail) — this signal catches softer variants
   * like "real quick" / "real quick g".
   */
  priorRealQuickPhraseCount?: number;
  /**
   * Count of trailing prior AI messages that were validation-only
   * ("facts bro", "yeah bro", etc.) with no question. Cedric Chaar
   * 2026-04-29 fix: 3 in a row becomes a soft retry signal so the AI
   * advances qualification instead of validating forever.
   */
  priorValidationOnlyCount?: number;
  /** Prior uses of "facts bro" in AI history. Max allowed: 2. */
  priorFactsBroCount?: number;
  /** Prior uses of "yeah bro" in AI history. Max allowed: 2. */
  priorYeahBroCount?: number;
  /**
   * True when any LEAD message in conversation history reads as an
   * implicit-no for capital — student / no money / unemployed /
   * "broke" / "I got nothing" — even though no AI capital question
   * has been asked yet. When true, the gate hard-fails any current-
   * turn capital question because the lead has already self-declared
   * below threshold. Rodrigo Moran 2026-04-26 spec rule 3.
   */
  leadImplicitlySignaledNoCapital?: boolean;
  /**
   * Omar Moore 2026-04-27 — count of consecutive AI messages
   * IMMEDIATELY before this turn that were "pure questions" (ended
   * in `?` AND didn't acknowledge any specific detail from recent
   * LEAD messages). When this is ≥ 2 and the current reply is also
   * a pure question, the `scripted_question_sequence` soft signal
   * fires at -0.3 per question over 2.
   *
   * Computed in ai-engine.ts via
   *   countConsecutivePureQuestions(priorAIMessages, recentLeadDetails)
   */
  priorConsecutivePureQuestionCount?: number;
  /**
   * Omar Moore 2026-04-27 — specific details (prop firm names,
   * instruments, strategies, personal experiences, faith / family
   * context) extracted from the lead's most recent 1-2 messages.
   * The current reply MUST reference at least one when it would
   * otherwise be the 3rd+ consecutive pure question. Pass the raw
   * matched tokens (case as written by the lead).
   */
  recentLeadDetails?: Array<{ category: string; token: string }>;
  /**
   * Steven Biggam 2026-04-30 — true when the most recent lead message
   * matches the vague-capital pattern set in ai-engine.ts. Combined
   * with the previous AI bubble being a capital question, fires the
   * `vague_capital_answer` soft signal (-0.4) when the current reply
   * doesn't contain a probe phrase. Backstop for the parser-level
   * routing in case the AI ignores its directive.
   */
  leadVagueCapitalAnswerInLastReply?: boolean;
  /**
   * Steven Biggam 2026-04-30 — true when ANY of the last 4 lead
   * messages contain a capital pre-objection phrase ("anyone asking
   * for a lot is a red flag", "I'm on a budget"). When true AND the
   * current AI reply asks the capital question (or pitches the call)
   * without any reassurance phrase, fires `pre_objection_not_addressed`
   * soft signal (-0.3). Encourages but doesn't force the regen.
   */
  leadPreObjectedToCapital?: boolean;
  /**
   * 2026-05-02 closer-scope guard. Configured closer names for this
   * persona (Account.closerName + promptConfig.callHandoff.closerName,
   * etc.). Used by the `anthony_or_call_in_downsell` hard fail to
   * detect when a downsell-context reply name-checks the closer.
   * Account-agnostic — every persona's closer names are matched
   * dynamically, no hardcoded "Anthony" anywhere.
   */
  closerNames?: string[];
  /**
   * Wout Lngrs 2026-05-01 — recent message corpus (lead + prior AI)
   * used to validate that any dollar amount the current reply
   * mentions actually appeared earlier in the conversation. Pass
   * the last ~30 messages joined or as an array. When the reply
   * contains a $ amount that's NOT in this corpus, the
   * `fabricated_capital_figure` soft signal (-0.5) fires — the
   * LLM is hallucinating a number the lead never stated.
   */
  priorMessageCorpus?: string;
  /**
   * Media placeholders injected into the LLM context. When this contains a
   * successful voice-note transcription, the reply must answer the content
   * instead of using the old audio-fallback wording.
   */
  mediaContextCorpus?: string;
  /**
   * R30 — true when AI or a human setter already delivered call logistics
   * (quiet spot, prep, day/time confirmation) in recent conversation history.
   */
  callLogisticsAlreadyDelivered?: boolean;
  /**
   * R30 — true when the most recent lead message was only an acknowledgment
   * like "sounds good" / "ok" / "got it". Any logistics after this is a
   * duplicate reminder, not useful conversation.
   */
  lastLeadMessageWasAcknowledgmentOnly?: boolean;
  /**
   * Jefferson @namejeffe 2026-05-03 (R37 burst extension) — slice of the
   * conversation that includes at minimum the consecutive LEAD tail
   * since the last AI/HUMAN turn. The group-level gate walks backward
   * from the end, collects the burst, and if it has ≥ 2 messages
   * containing either a question or reflective/emotional disclosure,
   * fails with `r37_burst_ignored:` unless the reply (a) cites a
   * topic word from the burst OR (b) opens with an emotional
   * acknowledgment. Single-message turns flow through the existing
   * `ignored_personal_question` soft signal unchanged. Pass the full
   * history when convenient — the extractor stops at the first AI/HUMAN
   * and ignores the rest.
   */
  conversationHistory?: ReadonlyArray<{ sender: string; content: string }>;
}

export interface MsgVerbatimViolation {
  expected: string;
  generated: string;
  overlap: number;
}

function stripScriptVariables(text: string): string {
  return text.replace(/\{\{\s*[^}]+\s*\}\}/g, ' ');
}

function normalizeForVerbatimCompare(text: string): string {
  return stripScriptVariables(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSetForVerbatimCompare(text: string): Set<string> {
  return new Set(
    normalizeForVerbatimCompare(text)
      .split(/\s+/)
      .filter((token) => token.length > 1)
  );
}

function wordOverlapRatio(required: string, generated: string): number {
  const requiredTokens = tokenSetForVerbatimCompare(required);
  if (requiredTokens.size === 0) return 1;
  const generatedTokens = tokenSetForVerbatimCompare(generated);
  let matches = 0;
  for (const token of Array.from(requiredTokens)) {
    if (generatedTokens.has(token)) matches++;
  }
  return matches / requiredTokens.size;
}

function requiredMessageMatchesGenerated(
  required: string,
  generated: string,
  overlapThreshold = 0.6
): boolean {
  const normalizedRequired = normalizeForVerbatimCompare(required);
  if (normalizedRequired.length === 0) return true;
  const normalizedGenerated = normalizeForVerbatimCompare(generated);
  if (normalizedGenerated.includes(normalizedRequired)) return true;
  return wordOverlapRatio(required, generated) >= overlapThreshold;
}

export function extractEmbeddedQuotes(content: string): string[] {
  const quotes: string[] = [];
  const regex = /"([^"]+)"|(?:^|[\s:([{])'([^']+)'(?=[\s.,;:!?)}\]]|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const quote = (match[1] || match[2] || '').trim();
    if (quote.length > 0) quotes.push(quote);
  }
  return quotes;
}

type RequiredMessageInput =
  | string
  | RequiredMessage
  | {
      content?: string | null;
      isPlaceholder?: boolean;
      embeddedQuotes?: string[];
    };

function normalizeRequiredMessages(
  currentStepMsgActions: RequiredMessageInput[]
): RequiredMessage[] {
  const messages: RequiredMessage[] = [];
  for (const action of currentStepMsgActions) {
    const content =
      typeof action === 'string' ? action : (action.content ?? null);
    if (!content || content.trim().length === 0) continue;
    const trimmed = content.trim();
    const actionMetadata =
      typeof action === 'string'
        ? null
        : (action as {
            isPlaceholder?: boolean;
            embeddedQuotes?: string[];
          });
    const isPlaceholder =
      typeof actionMetadata?.isPlaceholder === 'boolean'
        ? actionMetadata.isPlaceholder
        : isRuntimePlaceholderOnly(trimmed);
    const embeddedQuotes = isPlaceholder
      ? actionMetadata?.embeddedQuotes &&
        actionMetadata.embeddedQuotes.length > 0
        ? actionMetadata.embeddedQuotes
        : extractEmbeddedQuotes(trimmed)
      : [];
    messages.push({
      content: trimmed,
      isPlaceholder,
      embeddedQuotes
    });
  }
  return messages;
}

function literalRequiredMessages(
  currentStepMsgActions: RequiredMessageInput[]
): string[] {
  return normalizeRequiredMessages(currentStepMsgActions)
    .filter((message) => message.isPlaceholder !== true)
    .map((message) => message.content);
}

export function detectMsgVerbatimViolation(
  generatedReply: string,
  currentStepMsgActions: RequiredMessageInput[]
): MsgVerbatimViolation | null {
  const requiredMessages = normalizeRequiredMessages(currentStepMsgActions);

  for (const required of requiredMessages) {
    if (required.isPlaceholder) {
      for (const quote of required.embeddedQuotes ?? []) {
        if (!requiredMessageMatchesGenerated(quote, generatedReply, 0.85)) {
          return {
            expected: quote,
            generated: generatedReply,
            overlap: wordOverlapRatio(quote, generatedReply)
          };
        }
      }
      continue;
    }

    if (!requiredMessageMatchesGenerated(required.content, generatedReply)) {
      return {
        expected: required.content,
        generated: generatedReply,
        overlap: wordOverlapRatio(required.content, generatedReply)
      };
    }
  }

  return null;
}

export function detectMsgBubbleSequenceViolation(
  messages: string[],
  currentStepMsgActions: RequiredMessageInput[]
): MsgVerbatimViolation | null {
  const requiredMessages = literalRequiredMessages(currentStepMsgActions);
  if (requiredMessages.length <= 1) return null;

  let nextBubbleIndex = 0;
  for (const required of requiredMessages) {
    let matchedIndex = -1;
    let bestOverlap = 0;

    for (let i = nextBubbleIndex; i < messages.length; i++) {
      const bubble = messages[i] || '';
      const overlap = wordOverlapRatio(required, bubble);
      bestOverlap = Math.max(bestOverlap, overlap);
      if (requiredMessageMatchesGenerated(required, bubble)) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex === -1) {
      return {
        expected: required,
        generated: messages.join(' '),
        overlap: bestOverlap
      };
    }

    nextBubbleIndex = matchedIndex + 1;
  }

  return null;
}

// ─── R37 burst extension (Jefferson @namejeffe 2026-05-03) ────────
//
// The original R37 (`ignored_personal_question` soft signal at line
// ~1869) only inspects the immediately-preceding LEAD message. Jefferson
// sent three substantive messages in a row — two reflective disclosures
// plus a direct question about behavioural lapses — and the AI advanced
// the script with a single follow-up that ignored all three.
//
// `getUnacknowledgedLeadBurst` walks backward from the end of the
// history, collects consecutive LEAD messages, and stops at the first
// AI/HUMAN turn (which counts as "acknowledged-by-prior-reply"). The
// group-level gate uses the burst to decide whether the current reply
// must address what the lead just said.
//
// `acknowledgesEmotionally` is the safety valve — if the reply uses
// any of the listed acknowledgment phrases ("respect", "damn bro",
// "that takes guts"), the gate passes even without an exact topic
// match. The vocabulary is hardcoded for now; audit F5.1 will move it
// onto a per-persona field.

const R37_REFLECTIVE_PATTERNS: RegExp[] = [
  /\b(i feel|im feeling|i'?m feeling)\b/i,
  /\bsick of\b/i,
  /\b(hahaha|haha|hehe)\b/i,
  /\brebuild(ing)?\b/i,
  /\bstep(ped)? back\b/i,
  /\bself[-\s]?(flagellation|hate|criticism|doubt|sabotage|aware(ness)?)\b/i,
  /\b(pressure|burnout|exhausted|drained|frustrated|overwhelmed)\b/i,
  /\b(grateful|thankful|proud|excited|hopeful|blessed)\b/i,
  /\bgone be (alright|ok|okay)\b/i,
  /\btrust(ing)? (the )?(process|lord|god|timing)\b/i,
  /\bbehavioural? laps(es?|ing)\b/i
];

const R37_QUESTION_LEADER_RE =
  /^(what|how|when|where|why|do|does|did|can|could|will|would|is|are|am|have|has|should)\b/i;

const R37_ACK_PATTERNS: RegExp[] = [
  /\b(damn bro|fair bro|respect|that'?s real|i hear you|i feel that|that takes|that'?s wassup|wassup g|fair enough)\b/i,
  /\b(props|massive|big move|takes (guts|courage)|self[-\s]?aware(ness)?)\b/i,
  /\b(rebuild|reset|come back|bounce back|grind through)\b/i
];

export interface UnacknowledgedLeadBurst {
  messages: Array<{ sender: string; content: string }>;
  hasQuestion: boolean;
  hasReflectiveContent: boolean;
}

/**
 * Walk backward from the end of `history`, collecting consecutive LEAD
 * messages until the first AI/HUMAN turn (or the start of history).
 * SYSTEM messages are ignored (they don't count as "acknowledged" or
 * "unacknowledged" — they're internal notes, not lead-facing).
 *
 * Returns an empty `messages` array when the latest non-SYSTEM sender
 * is AI or HUMAN — the reply being scored is the first one after a
 * setter turn, so no burst exists.
 */
export function getUnacknowledgedLeadBurst(
  history: ReadonlyArray<{ sender: string; content: string }> | undefined
): UnacknowledgedLeadBurst {
  const empty: UnacknowledgedLeadBurst = {
    messages: [],
    hasQuestion: false,
    hasReflectiveContent: false
  };
  if (!history || history.length === 0) return empty;

  const burst: Array<{ sender: string; content: string }> = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    const sender = String(m.sender || '').toUpperCase();
    if (sender === 'SYSTEM') continue;
    if (sender === 'AI' || sender === 'HUMAN') break;
    if (sender === 'LEAD') {
      burst.unshift({ sender, content: String(m.content ?? '') });
      continue;
    }
    break;
  }

  if (burst.length === 0) return empty;

  const hasQuestion = burst.some((m) => {
    const trimmed = m.content.trim();
    if (trimmed.length === 0) return false;
    if (/\?\s*$/.test(trimmed)) return true;
    return R37_QUESTION_LEADER_RE.test(trimmed);
  });

  const hasReflectiveContent = burst.some((m) =>
    R37_REFLECTIVE_PATTERNS.some((p) => p.test(m.content))
  );

  return { messages: burst, hasQuestion, hasReflectiveContent };
}

/**
 * Reply contains acknowledgment language strong enough to count as
 * "addressed the lead's burst" without requiring an exact topic match.
 * Matches phrases like "respect bro", "damn that takes guts", "i hear
 * you", "rebuild" — the vocabulary the spec calls out as the safety
 * valve so the gate doesn't false-fire on emotional-but-non-topical
 * acknowledgments.
 */
export function acknowledgesEmotionally(reply: string): boolean {
  if (typeof reply !== 'string' || reply.trim().length === 0) return false;
  return R37_ACK_PATTERNS.some((p) => p.test(reply));
}

function escapeRegExpChars(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── R37 acceptance detection (extension) ─────────────────────────
//
// When the lead explicitly accepts an offer the AI just made ("yes",
// "sure", "sounds good", "definitely", "let's do it"), the next AI
// turn MUST deliver the promised artifact (link drop, booking URL,
// resource share). Looping back to a qualification question after an
// explicit acceptance is the worst possible signal — the lead said
// yes and the AI moved the goalposts. Strongest signal in the burst
// extension; overrides script-advancement logic entirely.
//
// The check has THREE conditions, all required:
//   1. Lead's last message is an explicit acceptance phrase.
//   2. The AI's previous turn promised an artifact (link, call, URL,
//      booking, resource).
//   3. The current AI reply is a pure question (no link, no URL, no
//      booking confirmation) — i.e. looping back instead of delivering.
//
// Hard fails with `r37_acceptance_loopback:` so the regen path can
// inject a directive that cites the acceptance + the prior promise
// and forces the AI to deliver.

const R37_ACCEPTANCE_PATTERNS: RegExp[] = [
  // Bare yes/affirmation — anchored start of trimmed message OR
  // immediately preceding a comma/period/end-of-text.
  /^(yes|yea|yeah|yep|yup|y)\b/i,
  /^(yes\s+(of\s+course|definitely|absolutely|please|sir|bro|man))/i,
  /^(definitely|absolutely|sure|surely|certainly|of\s+course)\b/i,
  /^(ok|okay|kk|k)\s*$/i,
  /^(ok|okay)\s+(bro|man|cool|sounds|sure|let'?s|let\s+me)/i,
  /^(sounds\s+(good|fire|cool|great|solid))/i,
  /^(that\s+(works|sounds\s+(good|fire)))/i,
  /^(let'?s\s+(do\s+it|go|get\s+it))/i,
  /^(lfg|lfgg+|let'?s\s+f\*?\*?\*?ing\s+go)/i,
  /^(bet|bet\s+bro|bet\s+man|aight\s+bet)\b/i,
  /^(100|100\s*%|hundo)/i,
  /^(i'?m\s+(in|down|game|ready)|down\s+(for\s+it|to))/i,
  /^(send\s+it|drop\s+it|hit\s+me|gimme|give\s+me)/i,
  /^(pls|please)\s+(send|do)/i
];

const R37_AI_PROMISE_PATTERNS: RegExp[] = [
  // "I'll send you the link" / "sending you the application" — link/URL promise
  /\b(i'?ll\s+(send|drop|shoot|share|grab)|let\s+me\s+(send|grab|drop)|sending\s+you|here'?s\s+(the\s+)?(link|url|application|form))\b/i,
  // Call pitch ("wanna hop on a quick call", "let's hop on a call")
  /\b(wanna\s+hop|let'?s\s+hop|hop\s+on\s+a\s+(quick\s+)?call|jump\s+on\s+a\s+call|get\s+on\s+a\s+call|book\s+(you|a)\s+call|book\s+a\s+(quick\s+)?call|schedule\s+a\s+call)\b/i,
  // Booking-flow promise ("let's get you booked", "I can lock you in")
  /\b(get\s+you\s+booked|lock\s+you\s+in|set\s+you\s+up|line\s+you\s+up)\b/i,
  // Yes/no offer: "you down", "you in", "you with it", "want me to send"
  /\b(you\s+(down|in|with\s+it|game)|want\s+me\s+to\s+send|wanna\s+(see|check)|ready\s+(to|when))\b\??/i,
  // Resource drop: "I'll send the bootcamp", "here's the free resource"
  /\b(send\s+(you\s+)?(the\s+)?(bootcamp|video|course|resource|breakdown|youtube)|free\s+(value|resource|video|content))\b/i,
  // Direct offer: "wanna check this out"
  /\b(check\s+this\s+out|peep\s+this|drop\s+the\s+(link|url))\b/i,
  // Bare-question offer: "want it?", "want the link?", "want the course?"
  /\bwant\s+(it|the\s+(link|url|course|bootcamp|video|breakdown|resource))\b\s*\??/i
];

const R37_DELIVERED_ARTIFACT_RE =
  /\b(https?:\/\/|\.com\/|here'?s\s+the\s+link|fill\s+(it|this|out)|grab\s+a\s+time|let\s+me\s+(know|lmk)\s+(once|when)|booking\.|calendar\.)/i;

/**
 * Lead's message reads as an explicit acceptance of an offer the AI
 * just made. Used by the r37_acceptance_loopback gate. Distinct from
 * a generic "yes" answer to a yes/no question — when this fires AND
 * the AI's previous turn was an offer, the AI must deliver, not loop.
 */
export function isExplicitAcceptance(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Long replies that happen to start with "sure"/"yes" are NOT
  // simple acceptances — the lead is saying more than just yes.
  // Cap at 30 chars: covers realistic acceptances ("yes of course",
  // "let's do it bro", "sounds good bro lfg") but excludes
  // substantive replies like "sure I trade alpha and topstep mostly".
  if (trimmed.length > 30) return false;
  return R37_ACCEPTANCE_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * The AI's previous-turn message offered or promised an artifact:
 * a link, a call, a booking, a resource. Used as a precondition for
 * the r37_acceptance_loopback gate so the check only fires on real
 * loopback (acceptance follows a promise) and not on bare yes/no
 * answers to qualification questions.
 */
export function aiPromisedArtifact(
  prevAiText: string | null | undefined
): boolean {
  if (typeof prevAiText !== 'string' || prevAiText.trim().length === 0) {
    return false;
  }
  return R37_AI_PROMISE_PATTERNS.some((p) => p.test(prevAiText));
}

/**
 * The current AI reply already delivers the promised artifact. URL
 * present, booking confirmation language, "fill this out" / "grab a
 * time" — all count as delivery. When this returns true, the
 * acceptance-loopback gate suppresses (the AI did the right thing).
 */
export function replyDeliversArtifact(reply: string): boolean {
  if (typeof reply !== 'string' || reply.trim().length === 0) return false;
  return R37_DELIVERED_ARTIFACT_RE.test(reply);
}

function capturedDataPointHasValue(
  points: VoiceQualityOptions['capturedDataPoints'],
  key: string
): boolean {
  if (!points || typeof points !== 'object') return false;
  const point = points[key];
  if (point === null || point === undefined) return false;

  if (typeof point === 'object' && 'value' in point) {
    const value = (point as { value?: unknown }).value;
    return value !== null && value !== undefined && value !== '';
  }

  return point !== '';
}

export function shouldBlockManyChatEarlyCapitalQuestion(
  reply: string,
  options?: VoiceQualityOptions
): boolean {
  if (options?.conversationSource !== 'MANYCHAT') return false;
  if (
    typeof options.aiMessageCount !== 'number' ||
    options.aiMessageCount > 3
  ) {
    return false;
  }
  if (capturedDataPointHasValue(options.capturedDataPoints, 'workBackground')) {
    return false;
  }
  if (capturedDataPointHasValue(options.capturedDataPoints, 'incomeGoal')) {
    return false;
  }

  return containsCapitalQuestion(reply);
}

const MANYCHAT_EARLY_CAPITAL_HARDFAIL =
  'manychat_early_capital_question: This lead came from a ManyChat outbound sequence. Discovery has not happened yet. Do NOT ask about capital. Ask about their trading background instead.';

export function scoreVoiceQuality(
  reply: string,
  options?: VoiceQualityOptions
): QualityResult {
  const hardFails: string[] = [];
  const softSignals: Record<string, number> = {};

  const lower = reply.toLowerCase();

  // ── Hard fail checks ────────────────────────────────────────────

  if (shouldBlockManyChatEarlyCapitalQuestion(reply, options)) {
    hardFails.push(MANYCHAT_EARLY_CAPITAL_HARDFAIL);
  }

  // Step-progression gate: block call-proposal language when the eight
  // prerequisites from the daetradez script (work, income, replace-vs-
  // supplement, income goal, deeper why, obstacle, belief break,
  // buy-in) have not been captured. Without this gate the LLM
  // collapses the 22-step flow into 4 exchanges (@daniel_elumelu
  // 2026-05-08). The regen directive in ai-engine references the
  // first missing prereq so the model resumes from the right step.
  if (detectCallProposalAttempt(reply)) {
    const missing = checkCallProposalPrereqs(options?.capturedDataPoints);
    if (missing.length > 0) {
      const firstMissing = missing[0];
      const summary = missing
        .map((p) => `step ${p.stepNumber} (${p.id})`)
        .join(', ');
      hardFails.push(
        `call_proposal_prereqs_missing: missing=${summary}. ` +
          `Resume the script from step ${firstMissing.stepNumber} — ${firstMissing.label}. ` +
          `Do NOT propose a call until every prerequisite is captured.`
      );
    }
  }

  // Silent-branch enforcement: when the current script step contains a
  // [MSG]+[WAIT]-only branch (no [ASK]) and the reply opens with an
  // emotional acknowledgment phrase ("that's real", "I hear you",
  // "respect that", etc.) AND contains a `?`, the LLM has clearly taken
  // the silent branch but improvised an off-script follow-up. Operator's
  // instruction on those branches is "sit in the moment". Hard-fail and
  // regen with a no-question constraint.
  // (@daniel_elumelu Turn 2/3 incident 2026-05-08: AI drilled the lead
  // for emotional depth three turns in a row instead of letting the
  // disclosure breathe.)
  const replyQuestionCount = countQuestionMarks(reply);
  const currentStepHasSilentBranch =
    options?.activeBranchHasSilentBranch ?? options?.currentStepHasSilentBranch;
  if (
    currentStepHasSilentBranch &&
    replyQuestionCount > 0 &&
    detectAcknowledgmentOpener(reply)
  ) {
    const silentLabels =
      options?.activeBranchHasSilentBranch &&
      options?.currentStepActiveBranchLabel
        ? `"${options.currentStepActiveBranchLabel}"`
        : (options?.currentStepSilentBranchLabels || [])
            .map((l) => `"${l}"`)
            .join(', ');
    hardFails.push(
      `silent_branch_violated_with_question: The script's current step has an acknowledgment-only branch (${silentLabels || 'unnamed silent branch'}) — [MSG]+[WAIT] with NO [ASK]. Your reply opened with an acknowledgment phrase but contained a question. The operator's intent on that branch is to sit in the moment and let the lead keep talking. Send the acknowledgment ONLY. End with a statement (period), not a question (?).`
    );
  }

  const currentStepHasAskBranch =
    options?.activeBranchHasAskAction ??
    options?.currentStepHasAskBranch ??
    options?.currentStepHasAnyAskAction;
  const stepNumber = options?.currentScriptStepNumber ?? null;
  const isBookingOrLinkStep =
    typeof stepNumber === 'number' && stepNumber >= 17;
  console.warn('[voice-quality-gate] ASK-BRANCH EVAL:', {
    currentStepHasAskBranch,
    activeBranchLabel: options?.currentStepActiveBranchLabel ?? null,
    replyHasQuestion: countQuestionMarks(reply) > 0,
    stepNumber,
    gateWouldFire:
      currentStepHasAskBranch === true && countQuestionMarks(reply) === 0
  });
  if (
    currentStepHasAskBranch === true &&
    replyQuestionCount === 0 &&
    options?.currentStepActiveBranchIsSilent !== true &&
    options?.currentStepActiveBranchIsJudgeOnly !== true &&
    !isBookingOrLinkStep
  ) {
    console.warn(
      '[voice-quality-gate] missing_required_question_on_ask_step:',
      {
        currentStepHasAskBranch,
        replyHasQuestion: countQuestionMarks(reply) > 0,
        replyFirst100: reply.slice(0, 100)
      }
    );
    hardFails.push(
      'missing_required_question_on_ask_step: Your reply must end with a question to advance the conversation. The current step requires you to ask the lead something. Add the required question from the script before sending.'
    );
  }

  // Step-10 (Deep Why) skip guard: when the lead's incomeGoal is
  // captured but deepWhy / desiredOutcome is NOT, the AI must not
  // advance to Step 12+ content (obstacle re-ask, belief break,
  // buy-in confirmation, urgency, call proposal). Fires the regen
  // override that points the LLM at Step 10's verbatim [MSG] + [ASK].
  // (@tegaumukoro_ 2026-05-08: AI jumped Step 9 → Step 12, dropping
  // the emotional hook the call proposal needs.)
  if (detectStep10Skipped(reply, options?.capturedDataPoints)) {
    hardFails.push(
      `step_10_deep_why_skipped: incomeGoal is captured but deepWhy / desiredOutcome is not. ` +
        `The lead has not yet shared the emotional reason behind their goal. ` +
        `Resume the script at Step 10 — send the verbatim [MSG] ("I respect that bro, I truly do. ` +
        `I hear so many people talk about cars and materialistic stuff so it's refreshing to hear this haha.") ` +
        `then the [ASK] ("But why is {{their stated goal}} so important to you though? ` +
        `Asking since the more I know the better I'll be able to help."). ` +
        `Do NOT advance to obstacle re-ask, belief break, urgency, or call proposal until deep why is captured.`
    );
  }

  // Multiple-questions guard: any single AI turn should fire AT MOST one
  // question. The daetradez script's [ASK] actions all contain exactly one
  // `?`. When the AI emits 2+ questions in a single reply, it's almost
  // always either (a) stacking an off-script probe on top of the scripted
  // ask, or (b) drilling the lead repeatedly within one turn. Hard-fail
  // and regen down to a single question.
  if (replyQuestionCount >= 2) {
    hardFails.push(
      `multiple_questions_in_reply: reply contained ${replyQuestionCount} question marks. Send ONE question per turn. Pick the most important one for the current script step and drop the rest.`
    );
  }

  // Capital-question premature guard (Step 18 skip): capital question
  // is the daetradez script's Step 18 ("Qualification — DQ Check"). It
  // CANNOT fire during discovery — the prereq chain is deepWhy +
  // obstacle + beliefBreakDelivered + buyInConfirmed +
  // callProposalAccepted (5 prereqs across Steps 10/12/13/14/17).
  // Production drift (@tegaumukoro_ 2026-05-08): AI fired
  // "real quick, what's your capital situation like..." right after the
  // lead's deep-why answer — Step 9 → Step 18, skipping 9 steps.
  const hasCapitalQuestionPattern = detectCapitalQuestionAttempt(reply);
  if (hasCapitalQuestionPattern) {
    console.warn('[gate-debug] capital check reached:', {
      replyFirst100: reply.slice(0, 100),
      deepWhy: options?.capturedDataPoints?.deepWhy,
      incomeGoal: options?.capturedDataPoints?.incomeGoal,
      hasCapitalPattern: hasCapitalQuestionPattern
    });
    const missingCapPrereqs = checkCapitalQuestionPrereqs(
      options?.capturedDataPoints
    );
    console.warn(
      `[voice-quality-gate] capital_question_premature CHECK: detected=true, missingPrereqs=${missingCapPrereqs.length}, capturedKeys=${JSON.stringify(Object.keys(options?.capturedDataPoints || {}))}`
    );
    if (missingCapPrereqs.length > 0) {
      const firstMissing = missingCapPrereqs[0];
      const summary = missingCapPrereqs
        .map((p) => `step ${p.stepNumber} (${p.id})`)
        .join(', ');
      hardFails.push(
        `capital_question_premature: missing=${summary}. ` +
          `Capital question is the script's Step 18 — it cannot fire until the lead has accepted the call proposal AND the script's earlier steps have completed. ` +
          `Resume the script from step ${firstMissing.stepNumber} — ${firstMissing.label}. ` +
          `Do NOT ask about capital, budget, or how much they have set aside until every prerequisite is captured.`
      );
    }
  }

  // Mandatory-ask guard (volunteered-data skip): when the lead
  // volunteers info inline ("I trade futures and work as a nurse"), the
  // AI may capture a data point AND skip the scripted [ASK] for the
  // related step. Step completion requires the [ASK] to actually fire
  // in AI history — capturing volunteered data does NOT short-circuit
  // discovery. Steps 6, 7, 8 are the most common skip targets here
  // (job, monthly income, replace-vs-supplement). When the reply
  // matches Step 9+ content but those asks haven't fired in history,
  // hard-fail and force a regen back to the first missing ask.
  if (Array.isArray(options?.aiMessageHistoryFull)) {
    const skippedAsks = detectMandatoryAskSkipped(
      reply,
      options.aiMessageHistoryFull,
      options.capturedDataPoints
    );
    console.warn(
      `[voice-quality-gate] mandatory_ask_skipped CHECK: aiHistoryLen=${options.aiMessageHistoryFull.length}, skipped=${skippedAsks ? skippedAsks.map((r) => r.stepNumber).join(',') : 'null'}`
    );
    if (skippedAsks && skippedAsks.length > 0) {
      const summary = skippedAsks
        .map((req) => `step ${req.stepNumber}`)
        .join(', ');
      const firstMissing = skippedAsks[0];
      hardFails.push(
        `mandatory_ask_skipped: ${summary} ask(s) have not fired in AI history. ` +
          `Volunteered data does NOT mark a step complete — the script's [ASK] must actually be sent. ` +
          `Resume the script from ${firstMissing.label}. ` +
          `Do NOT advance to Step 9+ content (income goal, deep why, obstacle, belief break, capital, etc.) until the discovery [ASK]s have fired.`
      );
    }
  } else {
    // Diagnostic: aiMessageHistoryFull missing means ai-engine isn't
    // plumbing it through. Fire-and-forget warning so production logs
    // surface the gap without affecting score.
    console.warn(
      `[voice-quality-gate] mandatory_ask_skipped SKIPPED — aiMessageHistoryFull is not provided in options`
    );
  }

  // Step-distance architectural guard: catches ALL future skip attempts
  // regardless of which specific phrasing the LLM improvises. When the
  // reply's inferred step (highest-matching pattern in STEP_PATTERN_MAP)
  // is more than 3 ahead of the AI's actual current step, hard-fail
  // and force a regen back to the current step's content.
  // Three skips caught individually today (Step 10, Step 12, Step 18)
  // motivated this generic check — enumerating every future-step
  // pattern manually doesn't scale.
  if (typeof options?.currentScriptStepNumber === 'number') {
    const violatedStep = detectStepDistanceViolation(
      reply,
      options.currentScriptStepNumber
    );
    console.warn(
      `[voice-quality-gate] step_distance_violation CHECK: currentStep=${options.currentScriptStepNumber}, violatedStep=${violatedStep ?? 'null'}`
    );
    if (violatedStep !== null) {
      const violatedLabel =
        inferStepLabelFromReply(reply) ?? `Step ${violatedStep}`;
      hardFails.push(
        `step_distance_violation: reply matches ${violatedLabel} content but the AI is currently on Step ${options.currentScriptStepNumber}. ` +
          `Skipping more than 3 steps ahead at once is not allowed. ` +
          `Return to Step ${options.currentScriptStepNumber} and follow the script's natural progression — one step per turn.`
      );
    }
  } else {
    console.warn(
      `[voice-quality-gate] step_distance_violation SKIPPED — currentScriptStepNumber is not provided`
    );
  }

  // Off-script question soft signal: when the current step DOES define
  // [ASK] content but the reply's question shares < 0.2 Jaccard overlap
  // with any scripted ask, the LLM is improvising a different question
  // (e.g. pain-future-pacing pulled from sales training that isn't in
  // the operator's script). Soft signal at -0.4 lets the score fall
  // below the regen threshold but doesn't hard-block — paraphrase is
  // still allowed when the question shape matches.
  if (
    options?.currentStepHasAnyAskAction &&
    replyQuestionCount > 0 &&
    Array.isArray(options.currentStepScriptedQuestions) &&
    options.currentStepScriptedQuestions.length > 0
  ) {
    const sim = maxQuestionSimilarityToScript(
      reply,
      options.currentStepScriptedQuestions
    );
    if (sim < 0.2) {
      softSignals.improvised_question_off_script = -0.4;
    }
  }

  // R34. Metadata leak guard — internal JSON fields, confidence scores,
  // placeholders, debug annotations, or structured fragments must never
  // reach lead-facing copy.
  const metadataLeak = detectMetadataLeak(reply);
  if (metadataLeak.leak) {
    hardFails.push(
      `r34_metadata_leak: matched "${metadataLeak.matchedText}" via ${metadataLeak.matchedPattern}`
    );
  }

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

  // 5. Em dash or en dash. Match the explicit Unicode code points so
  // lookalike/editor substitutions are obvious in tests and reviews:
  // U+2014 em dash, U+2013 en dash.
  if (/\u2014/.test(reply)) {
    hardFails.push('em_dash');
  }
  if (/\u2013/.test(reply)) {
    hardFails.push('en_dash');
  }

  // R29: once Whisper succeeded, the AI has the voice-note content. The
  // old fallback language is only allowed when the context explicitly says
  // transcription failed.
  if (options?.mediaContextCorpus?.includes('[Voice note (transcribed):')) {
    const ignoredTranscribedVoiceNoteRe =
      /(couldn'?t catch|didn'?t (catch|get that audio)|type it out|send (a )?text|hard to hear)/i;
    if (ignoredTranscribedVoiceNoteRe.test(reply)) {
      hardFails.push(
        'r29_transcribed_voice_note_ignored: voice note was transcribed in context, but reply used audio-fallback/type-it-out language'
      );
    }
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

  // 9b. Bracketed placeholder leak — e.g. "[BOOKING LINK]", "[CALENDAR LINK]",
  // "[APPLICATION LINK]", "[HOMEWORK LINK]", "[LINK]", "[URL]", "[RESULTS
  // VIDEO]", "[COURSE PAYMENT LINK]", "[WHOP LINK]". These are LITERAL
  // placeholder tokens the LLM learned from training examples (persona
  // breakdowns, script fragments). If one of them reaches the lead, they
  // see raw brackets in the message instead of a real URL — a critical
  // failure. The generic regex matches any bracketed ALL-CAPS token.
  // The explicit pattern set adds a belt-and-suspenders guard for the
  // course-payment / Whop / checkout variants that were specifically
  // surfaced by the George 2026-04-08 incident, and lets the retry
  // directive provide the EXACT replacement URL on regen.
  const BRACKETED_PLACEHOLDER_REGEX = /\[[A-Z][A-Z0-9 _]{2,}\]/;
  // Course-payment / Whop / checkout variants — case-insensitive so a
  // lowercase variant like "[course payment link]" doesn't slip past
  // the all-caps generic regex. Each is its own pattern so the failure
  // message names the specific token the operator can grep for.
  const COURSE_LINK_PLACEHOLDER_PATTERNS: RegExp[] = [
    /\[COURSE\s*(PAYMENT\s*)?LINK\]/i,
    /\[PAYMENT\s+LINK\]/i,
    /\[WHOP\s+LINK\]/i,
    /\[CHECKOUT\s+LINK\]/i,
    /\[COURSE\s+URL\]/i
  ];
  let courseLinkLeak: string | null = null;
  for (const pat of COURSE_LINK_PLACEHOLDER_PATTERNS) {
    const m = reply.match(pat);
    if (m) {
      courseLinkLeak = m[0];
      break;
    }
  }
  if (courseLinkLeak) {
    hardFails.push(
      `course_link_placeholder_leaked: "${courseLinkLeak}" — LITERAL placeholder where the actual course / payment URL belongs. The retry directive injects the real URL; do NOT ship a placeholder to a lead about to pay.`
    );
  } else {
    const placeholderMatch = reply.match(BRACKETED_PLACEHOLDER_REGEX);
    if (placeholderMatch) {
      hardFails.push(
        `bracketed_placeholder_leaked: "${placeholderMatch[0]}" — LITERAL placeholder token in outgoing message, not a URL. If the script has no matching URL, use the script-driven handoff flow instead of a placeholder.`
      );
    }
  }

  // 9c. R19 — fabricated action claims. The AI must NEVER claim to have taken
  // actions it didn't actually take. "Just sent the link", "just got your
  // booking", "just checked with the team", "email is on the way" — these are
  // all LIES when the system didn't actually perform those actions in this
  // turn. Violations degrade trust and can trigger lead confusion ("I never
  // got the email"). Observed pattern: conversation cmo38clid003tjp04wauomdtm
  // fired 4 fabrications on 2026-04-17. Prompt-only enforcement of R19 is
  // insufficient — this regex guard forces regeneration when the LLM slips.
  const FABRICATED_ACTION_PATTERNS: RegExp[] = [
    /\bjust (sent|got|checked|received|confirmed|grabbed|booked)\b/i,
    /\bjust (reached out|heard back|followed up)\b/i,
    /\bemail is on the way\b/i,
    /\blink is on the way\b/i,
    /\bjust saw (it|your)\b/i,
    /\bsent (the|it|this) (link|email|zoom)\b/i,
    /\bi (just )?received your\b/i,
    /\bi can see your (booking|email|payment|signup)\b/i
  ];
  for (const pat of FABRICATED_ACTION_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `r19_fabricated_action: matched "${pat.source}" — claims an action the system did not actually perform`
      );
      break;
    }
  }

  // 9c-ii. R19 EXTENSION — fabricated UNCERTAINTY about the next step. The
  // AI always knows the next step (it has a script). Lines like "give me
  // a sec to double-check the right next step", "let me get back to you
  // on that", "not sure what to send" all signal a hallucinated pause
  // and have caused multi-hour silence after capital was confirmed
  // (audit case 2026-05-05). Treated as a hard fail so regeneration
  // forces the AI to actually pick the next script step.
  const FABRICATED_UNCERTAINTY_PATTERNS: RegExp[] = [
    /\bgive me a sec to (check|double.?check|look|verify)\b/i,
    /\blet me (check|double.?check|verify|look into) the (right|next|best)\b/i,
    /\bi don.?t wanna point you wrong\b/i,
    /\bnot sure (what|how) to\b/i,
    /\blet me get back to you on (that|this)\b/i,
    /\bi need to (check|verify|confirm) (first|before)\b/i
  ];
  for (const pat of FABRICATED_UNCERTAINTY_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `fabricated_uncertainty: matched "${pat.source}" — the AI always knows the next script step; uncertainty is never a valid response`
      );
      break;
    }
  }

  // 9c-iii. REPEATED-QUESTION HARD BLOCK. The soft signal at the
  // jaccard ≥ 0.7 threshold below catches semantic re-asks but is
  // overrideable when the rest of the reply scores well. These five
  // exact phrases have shown up in production as same-question-twice
  // failures and never have a legitimate re-ask reason — hard-block
  // them when ANY recent AI message asked the same question.
  // Exact-phrase repeat-question detectors. The legacy daetradez urgency
  // timeline phrasing was removed from this list when the urgency wording
  // became per-persona (resolveScriptUrgencyQuestion). Generic re-ask
  // detection still fires via the Jaccard similarity threshold below, so
  // semantic repeats are still caught — we just no longer hardcode that
  // tenant's exact phrasing as a banned repeat shape.
  const REPEATED_QUESTION_EXACT_PATTERNS: RegExp[] = [
    /\bwhat'?s the main thing holding you back\b/i,
    /\bwhat'?s your capital situation\b/i,
    /\bwhat do you do for work\b/i,
    /\bhow much are you trying to make\b/i
  ];
  const recentAIBlob = [
    options?.previousAIMessage || '',
    ...(options?.recentAIMessages || []),
    ...(options?.previousAIQuestions || [])
  ]
    .filter((s): s is string => typeof s === 'string')
    .join('\n');
  if (recentAIBlob.trim().length > 0) {
    for (const pat of REPEATED_QUESTION_EXACT_PATTERNS) {
      if (pat.test(reply) && pat.test(recentAIBlob)) {
        hardFails.push(
          `repeated_question_exact: matched "${pat.source}" in both the new reply and a recent AI message — the lead has already answered, advance based on their answer`
        );
        break;
      }
    }
  }

  // 9d. R19 EXTENSION — fabricated FUTURE plans/releases. Mirror of 9c in
  // the forward direction. Production example: lead asked "is part 2 of
  // the video out?" and the AI invented "part 2 is in the works, stay
  // tuned" with zero context support. Unless the persona/script/campaigns
  // context explicitly describes an upcoming release, the AI must not
  // claim one. These phrases can be legitimate in narrow cases (e.g.
  // confirming a booked call is "coming up soon"), but the gate is
  // worth the occasional forced regeneration — the regen will pick
  // non-fabricated wording that still conveys any real meaning.
  const FABRICATED_FUTURE_PLAN_PATTERNS: RegExp[] = [
    /\bin the works\b/i,
    /\bcoming soon\b/i,
    /\bstay tuned\b/i,
    /\bdropping soon\b/i,
    /\bnext month\b/i,
    /\bnext week\b/i,
    /\bvery soon\b/i,
    /\baround the corner\b/i
  ];
  for (const pat of FABRICATED_FUTURE_PLAN_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `r19_fabricated_future_plan: matched "${pat.source}" — claims an upcoming release / feature / plan not supported by context`
      );
      break;
    }
  }

  // 9e. R26 — off-topic life/career/side-hustle advice. The AI is a sales
  // setter for the account owner's SPECIFIC business, not a general
  // wealth-building advisor. Real production example: when a lead said
  // they couldn't afford the mentorship, the AI started recommending
  // Fiverr freelancing and flipping items from thrift stores. That's
  // not what the account owner does; it wastes LLM budget and trains
  // leads to expect free coaching from the account.
  //
  // The persona-level `allowGeneralAdvice` flag bypasses this guard
  // (e.g. for a legit financial-literacy coach). Default = enforce.
  if (!options?.allowGeneralAdvice) {
    const OFF_TOPIC_ADVICE_PATTERNS: RegExp[] = [
      /\bside[\s-]?hustle(s|)\b/i,
      /\bflip(ping)?\s+(items|stuff|products|goods)\b/i,
      /\bFiverr\b/i,
      /\bUpwork\b/i,
      /\bfreelanc(e|ing|er)\b/i,
      /\bthrift\s+store(s|)\b/i,
      /\bgarage\s+sale(s|)\b/i,
      /\beBay\b/i,
      /\bFacebook\s+Marketplace\b/i,
      /\b(make|earn|build)\s+extra\s+(income|cash|money)\b/i
    ];
    for (const pat of OFF_TOPIC_ADVICE_PATTERNS) {
      if (pat.test(reply)) {
        hardFails.push(
          `r26_offtopic_advice: matched "${pat.source}" — AI drifted into general wealth-building / side-hustle advice outside the account owner's lane`
        );
        break;
      }
    }
  }

  // 9e-ii. R26 — third-party prop-firm / funded-account platform names.
  // Soft signal, not hard-fail: a glancing mention in a decline line
  // ("funding's a whole other convo") is fine, but detailed explanation
  // of how these platforms work is out of scope + factually suspect.
  // Production incident (daetradez 2026-04-24): AI emitted
  //   "1. Choose a funding program like FTMO or My Forex Funds..."
  //   "2. Pass the evaluation by hitting a profit target..."
  // Speculative, third-party, and unauthorised. The soft-signal weight
  // is aggressive enough to likely trigger a regen when combined with
  // other minor signals. Prompt R26 covers the stricter declined-
  // escalation behavior.
  const PROP_FIRM_PATTERNS: RegExp[] = [
    /\bFTMO\b/i,
    /\bMy\s+Forex\s+Funds\b/i,
    /\bTopStep\b/i,
    /\bApex(\s+Trader\s+Funding)?\b/i,
    /\b(The\s+)?Funded\s+Trader\b/i,
    /\bE8\s+Funding\b/i,
    /\bThe\s+5ers\b/i,
    /\bprop\s+firm(s)?\b/i
  ];
  let propFirmMatch: string | null = null;
  for (const pat of PROP_FIRM_PATTERNS) {
    const m = reply.match(pat);
    if (m) {
      propFirmMatch = m[0];
      break;
    }
  }
  if (propFirmMatch) {
    softSignals.r26_third_party_platform_mention = -0.4;
  }

  // 9e-ii-b. Repeated email request. Once we have the lead's email on
  // record, asking for it again makes the AI look stateless and breaks
  // booking flow trust. Soft penalty: usually enough to force regen when
  // combined with normal short-text scoring, while still allowing unusual
  // "is this the right email?" support cases to pass if phrased clearly.
  if (options?.leadEmail) {
    const EMAIL_REQUEST_PATTERNS: RegExp[] = [
      /\b(what'?s|what is|send|drop|shoot|share|give|can i get|lemme get|let me get)\s+(me\s+)?(your\s+)?(best\s+|preferred\s+|current\s+)?e-?mail\b/i,
      /\b(can|could|would)\s+you\s+(send|drop|shoot|share|give)\s+(me\s+)?(your\s+)?(best\s+|preferred\s+|current\s+)?e-?mail\b/i,
      /\b(best\s+|preferred\s+|current\s+)?e-?mail\s+(address\s+)?(to\s+send|for|so\s+i|so\s+we|where)\b/i,
      /\bwhere\s+should\s+i\s+(send|email)\b/i
    ];
    if (EMAIL_REQUEST_PATTERNS.some((pat) => pat.test(reply))) {
      softSignals.repeated_email_request = -0.5;
    }
  }

  // 9e-iii. IMAGE MESSAGES persona rule. The AI must not expose the
  // underlying technical limitation when an image is unavailable. A
  // human setter would say the image didn't load / isn't coming
  // through and ask what the lead sent.
  const IMAGE_LIMITATION_PATTERNS: RegExp[] = [
    /\b(can['’]?t see (images?|that|it)|images? (don['’]?t|doesn['’]?t|won['’]?t) (work|load|come through)|can['’]?t process images?|not able to (see|view|open) images?|no image (support|capability))\b/i
  ];
  for (const pat of IMAGE_LIMITATION_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `image_limitation_exposed: matched "${pat.source}" — do not reveal image-processing limitations; respond like a human whose image did not load`
      );
      break;
    }
  }

  // 9e-iv. IMAGE ANALYSIS / R25-R26 scope: chart screenshots are
  // conversation context, not a free signal service. The prompt tells
  // the AI to acknowledge the image and pivot to qualification; this
  // code gate catches concrete trade advice that would turn a DM into
  // specific entries, exits, targets, or setup validation.
  const CHART_ADVICE_PATTERNS: RegExp[] = [
    /\b(?:enter|buy|sell|short|long)\s+(?:now|here|at\s+\d|on\s+the\s+(?:break|retest|close))\b/i,
    /\b(?:entry|entries)\s+(?:is|are|at|around|near)\s+\d/i,
    /\b(?:stop\s*loss|take\s*profit|sl|tp)\s+(?:at|around|near|to|should\s+be)\s+\d/i,
    /\bset\s+(?:your\s+)?(?:stop|stop\s*loss|sl|tp|take\s*profit)\b/i,
    /\b(?:i'?d|i would)\s+(?:buy|sell|short|long|enter)\b/i,
    /\btargets?\s+(?:is|are|at|around|near)\s+\d/i,
    /\b(?:risk[-\s]?reward|r:r)\s+(?:looks|is|should\s+be|at)\b/i,
    /\bthis\s+(?:setup|trade)\s+(?:is|looks)\s+(?:valid|clean|good|solid)\b/i
  ];
  for (const pat of CHART_ADVICE_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `r_image_chart_advice: matched "${pat.source}" — image replies can acknowledge context, but must not give entries, exits, targets, or detailed chart analysis`
      );
      break;
    }
  }

  // 9e-v. Image-observation fabrication. When the lead's previous
  // message was an image, the AI must not claim it "saw the flow",
  // "checked the stats", or "noticed the chart" unless the vision
  // pipeline truly supplied that information. This catches the
  // persona-breaking middle ground between "I can't see images" and
  // pretending to see details that may not be available.
  if (options?.previousLeadHadImage) {
    const FABRICATED_IMAGE_OBSERVATION_RE =
      /\b(i\s+(saw|seen|noticed|looked at|checked).{0,30}(flow|stats|chart|numbers|that|it))\b/i;
    if (FABRICATED_IMAGE_OBSERVATION_RE.test(reply)) {
      hardFails.push(
        `fabricated_image_observation: matched "${FABRICATED_IMAGE_OBSERVATION_RE.source}" — do not claim to have seen image details; use human image-not-loading framing instead`
      );
      softSignals.fabricated_image_observation = -0.5;
    }
  }

  // 9e-vi. Markdown-formatted single message — the LLM emitted a
  // numbered list with bold headings in ONE bubble instead of using
  // the messages[] array to send each point as its own short bubble.
  // Triggered when a numbered list starts with **bold** (/^\d+\.\s+\*\*/m)
  // OR the reply has 2+ consecutive heading/double-star formatting
  // markers. Fires hardFail so the retry loop regenerates with a
  // directive ("no markdown, use messages[]"). Rare enough to regen
  // from; common enough in GPT-5.x output to be worth catching.
  const NUMBERED_BOLD_LIST_RE = /^\s*\d+\.\s+\*\*/m;
  const MULTIPLE_BOLD_MARKERS_RE = /\*\*[^*]+\*\*[\s\S]*?\*\*[^*]+\*\*/;
  const MARKDOWN_HEADER_RE = /(^|\n)\s{0,3}#{1,6}\s/;
  const markdownMatch =
    NUMBERED_BOLD_LIST_RE.test(reply) ||
    MARKDOWN_HEADER_RE.test(reply) ||
    MULTIPLE_BOLD_MARKERS_RE.test(reply);
  if (markdownMatch) {
    hardFails.push(
      'markdown_in_single_bubble: AI emitted markdown formatting (numbered list with **bold**, ## headers, or multiple **bold** markers) in a single message. This content should be split into separate bubbles via the messages[] array with no markdown at all.'
    );
  }

  // 9f. CTA mechanism leak — the active_campaigns prompt block asks the
  // AI to RECOGNISE a lead coming from a campaign and respond naturally,
  // not announce the matching mechanism. A real production failure had
  // the AI emit "welcome, my G! since you sent the word 'market', I'll
  // hook you up with some free insights. here's a link to get
  // started:..." — four violations in one message: it quoted the keyword,
  // over-narrated the link drop, used a corporate "welcome" opener, and
  // wall-of-texted everything into a single turn.
  //
  // These patterns hard-fail the obvious leaks. Not exhaustive (the LLM
  // can paraphrase), but catches the 80%+ shape of the failure mode.
  // Always on — no persona opt-out, because no legitimate account wants
  // the AI to quote the lead's keyword or open with "welcome".
  const CTA_MECHANISM_LEAK_PATTERNS: RegExp[] = [
    // "since you sent 'market'" / "since you typed the keyword"
    /\bsince\s+you\s+(sent|typed|wrote|used|messaged|dropped|commented)\s+(the\s+)?(word|keyword|magic\s+word|phrase|comment)\b/i,
    /\bsince\s+you\s+(sent|typed|wrote|dropped|commented)\s+['"\u2018\u2019\u201C\u201D][^'"\u2018\u2019\u201C\u201D]{1,40}['"\u2018\u2019\u201C\u201D]/i,
    // "you used the magic word" / "you said the keyword"
    /\byou\s+(used|said|sent|typed)\s+the\s+(magic\s+word|keyword|code\s+word|trigger\s+word)/i,
    // "I'll hook you up with some (free) insights/content/breakdown/video"
    /\bI'?ll\s+hook\s+you\s+up\s+with\s+(some\s+|a\s+|the\s+)?(free\s+)?(insights?|content|breakdown|info|video|training|resource)/i,
    // "here's a link to get started" / "here's the link to get you started"
    /\bhere'?s\s+(a|the)\s+link\s+to\s+get\s+(started|you\s+started)/i,
    // "thanks for reaching out via (the/my) campaign/post/story"
    /\bthanks\s+for\s+reaching\s+out\s+(via|through)\s+(the|my)\s+(campaign|story|post|content)/i,
    // Corporate opener at start of message
    /^(welcome\s+(my\s+g|to\s+the|aboard|in)|welcome[,!]|hey\s+there[,!]|greetings)/i
  ];
  for (const pat of CTA_MECHANISM_LEAK_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `cta_mechanism_leak: matched "${pat.source}" — AI exposed the campaign matching mechanism or used a corporate onboarding opener instead of recognising the lead naturally`
      );
      break;
    }
  }

  // 9g. CTA acknowledgment-only truncation check moved out of
  // scoreVoiceQuality and into scoreVoiceQualityGroup (see
  // checkCtaAckOnlyTruncation below). Rationale: when a multi-bubble
  // response splits the acknowledgment and the question across bubbles,
  // bubble 0 alone would false-fire this check. The correct check
  // operates on the CONCATENATED group so a legit split passes. For
  // single-message (flag-off) calls, the group wrapper still fires this
  // check over the one-element array, so single-message accounts see
  // identical behaviour to the pre-multi-bubble state.

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

  // 9h. Repeated call pitch (Souljah J 2026-04-25). Hard-fail when the
  // previous AI bubble AND the current one BOTH contain a call-pitch
  // phrase. The lead's interim response — whatever it was — should
  // have been acknowledged before pitching again. Pitching twice in
  // two turns reads as desperate and trains the lead to ghost.
  // Pattern is intentionally narrow so a legit "you ready to hop on?"
  // immediately after a clear yes/no doesn't false-fire.
  if (options?.previousAIMessage) {
    const prevHasPitch = CALL_PITCH_RE.test(options.previousAIMessage);
    const currHasPitch = CALL_PITCH_RE.test(reply);
    if (prevHasPitch && currHasPitch) {
      hardFails.push(
        "repeated_call_pitch: previous AI turn already pitched the call AND this turn pitches again. Acknowledge the lead's interim response before pitching twice in a row."
      );
    }
  }

  // 9h-ii. Repeated opener guard (daetradez 2026-05-03).
  // "gotchu bro" was showing up as the default opener in consecutive
  // turns, making otherwise-human bubbles read robotic as a sequence.
  // Compare the current opener against the last 3 AI turns and force a
  // retry when the same opener family appears again.
  const currentOpener = detectRepeatOpener(reply);
  if (currentOpener) {
    const recentAIMessages =
      options?.recentAIMessages && options.recentAIMessages.length > 0
        ? options.recentAIMessages
        : options?.previousAIMessage
          ? [options.previousAIMessage]
          : [];
    const repeatedFrom = recentAIMessages
      .slice(-3)
      .map((message) => detectRepeatOpener(message))
      .find((opener) => opener?.id === currentOpener.id);

    if (repeatedFrom) {
      hardFails.push(
        `repeated_opener: current reply starts with "${currentOpener.match}" and a recent AI turn started with "${repeatedFrom.match}". Your last message started with the same opener. Vary your response — skip the acknowledgment entirely or use a completely different opening. Options: react directly to what they said, start with the question, use a different expression.`
      );
    }
  }

  // 9i. Repeated capital question (Rodrigo Moran 2026-04-26). When the
  // AI history already has 1+ capital-verification questions AND this
  // reply contains another, hard-fail. Rodrigo's bot asked at 3:47
  // ("do you already have at least $1k set aside") and again at 3:58
  // ("just to confirm, you got at least $1k in capital ready"). The
  // lead had answered the first ask. Re-asking 11 minutes later made
  // the bot feel stuck in a loop, which the lead called out verbatim.
  // Cap is 1 — once asked, never re-ask. The retry directive in
  // ai-engine.ts tells the LLM to advance the conversation without
  // re-asking.
  if (
    typeof options?.priorCapitalQuestionAskCount === 'number' &&
    options.priorCapitalQuestionAskCount >= 1
  ) {
    // Use a local pattern set instead of importing from
    // conversation-facts to avoid a circular dependency (ai-engine →
    // voice-quality-gate → conversation-facts → ai-engine).
    const CAPITAL_Q_RE_LOCAL: RegExp[] = [
      /\byou got at least \$\d/i,
      /\byou have at least \$\d/i,
      /\bat least \$\d+[,\d]*\s*(in\s+capital|capital|ready|to\s+start)/i,
      /\bcapital ready\b/i,
      /\bready to start with \$/i,
      /\bjust to confirm.*\$\d/i,
      /\bhow much (do you |have you )?(got|have|set aside|saved|working with|to start|to invest|to put (in|aside))\b/i,
      /\bwhat(?:'|’)?s your (budget|capital|starting (amount|capital|budget))\b/i,
      /\bwhat is your (budget|capital|starting (amount|capital|budget))\b/i,
      /\bwhat(?:'|’)?s your capital situation\b/i,
      /\bcapital situation\s+like\b/i,
      /\bset aside\b.*\b(for|toward|for (the |this )?markets?|for (your |the )?(education|trading))/i,
      /\bhow much (are you )?(working with|looking to (invest|start with|put (in|aside)))\b/i,
      /\bwhat are you working with\b/i,
      /\bon the (capital|money|budget) side\b/i
    ];
    const currHasCapitalQ = CAPITAL_Q_RE_LOCAL.some((p) => p.test(reply));
    if (currHasCapitalQ) {
      hardFails.push(
        `repeated_capital_question: capital threshold has already been asked ${options.priorCapitalQuestionAskCount} time(s) earlier in this conversation. Do NOT ask it again — either the lead already answered (reference their answer instead) or they declined / changed topic, in which case advance the conversation differently.`
      );
    }
  }

  // 9i-2. Implicit-no capital signal (Rodrigo Moran 2026-04-26 spec
  // rule 3). When the lead has already self-declared below the
  // capital threshold (student, broke, no job, "I got nothing"), the
  // AI should treat that as a capital answer — NOT ask the threshold
  // question on top of it. Asking "do you have at least $1k" right
  // after a lead said "I'm a student, no money right now" reads as
  // the bot ignoring them entirely. Routes to the downsell branch
  // instead via the regen directive.
  if (options?.leadImplicitlySignaledNoCapital === true) {
    // Pattern set is the union of:
    //   • shapes the R24 gate considers an "ask"
    //   • the new open-ended phrasing ("what's your capital situation")
    //   • set-aside / saved variants ("at least $1k set aside")
    // Kept aligned with CAPITAL_Q_RE_LOCAL (the repeat-check set) plus
    // the spec's open-ended additions so any shape that COUNTS as a
    // capital question is blocked once implicit-no has been signaled.
    const CAPITAL_Q_RE_LOCAL_2: RegExp[] = [
      /\byou got at least \$\d/i,
      /\byou have at least \$\d/i,
      /\bat least \$\d+[,\d]*\s*(in\s+capital|capital|ready|to\s+start|set\s+aside|saved)/i,
      /\bcapital ready\b/i,
      /\bjust to confirm.*\$\d/i,
      /\bhow much (do you |have you )?(got|have|set aside|saved|working with|to start|to invest|to put (in|aside))\b/i,
      /\bwhat(?:'|’)?s your (budget|capital|starting (amount|capital|budget))\b/i,
      /\bwhat is your (budget|capital|starting (amount|capital|budget))\b/i,
      /\bwhat are you working with\b/i,
      /\bon the (capital|money|budget) side\b/i,
      // Open-ended phrasings introduced by Rodrigo Moran 2026-04-26
      /\bwhat(?:'|’)?s your capital situation\b/i,
      /\bcapital situation\s+like\b/i,
      /\banything set aside for (this|trading|the markets?)\b/i,
      /\bstill building toward it\b/i,
      // Generic threshold-confirming variations the LLM may produce
      /\bdo you (already )?have (at least )?\$\d/i,
      /\b\$\d+[,\d]*k?\s+(in\s+capital|capital|set\s+aside|saved|ready)\b/i
    ];
    if (CAPITAL_Q_RE_LOCAL_2.some((p) => p.test(reply))) {
      hardFails.push(
        'capital_q_after_implicit_no: the lead has already signaled they have no capital (student / no money / unemployed / broke). Asking the capital threshold question now ignores what they said — treat the prior signal as the answer and route to the downsell / free-resource branch instead.'
      );
    }
  }

  // A 2+ year timeline is a soft disqualifier. The next AI turn must
  // learn whether the blocker is capital or a low-urgency learning
  // goal before pitching Anthony / Typeform / booking.
  if (
    leadGaveLongTimeline(options?.previousLeadMessage) &&
    containsCallOrBookingAdvancement(reply)
  ) {
    hardFails.push(
      'long_timeline_call_pitch: lead gave a 2+ year timeline. Do NOT pitch the call yet. First ask what is holding it to 2-3 years and whether it is capital or wanting to learn first.'
    );
  }

  if (
    options?.capitalVerificationRequired === true &&
    options.capitalVerificationSatisfied !== true &&
    containsCallPitch(reply)
  ) {
    hardFails.push(
      'call_pitch_before_capital_verification: call pitch detected before the capital question has been asked and answered'
    );
  }

  if (
    options?.capitalVerificationRequired === true &&
    options.capitalVerificationSatisfied !== true &&
    containsLogisticsQuestion(reply)
  ) {
    softSignals.logistics_before_qualification = -0.4;
  }

  // 9i-4. Homework before call confirmation (Tareefah Allen 2026-04-28).
  // The homework page is call preparation, not a booking-flow asset. If
  // the conversation has no confirmed scheduledCallAt yet, sending the
  // homework link implies a call exists before the system has a real time
  // on file. Keep this as a soft signal for analytics, while ai-engine
  // treats the signal as a forced retry and strips the URL on exhaustion.
  if (
    options &&
    Object.prototype.hasOwnProperty.call(options, 'scheduledCallAt') &&
    !hasConfirmedScheduledCall(options.scheduledCallAt) &&
    containsHomeworkUrl(reply, options.homeworkUrl)
  ) {
    softSignals.homework_sent_before_call_confirmed = -0.3;
  }

  // 9j. "or nah" question tail (Rodrigo Moran 2026-04-26). Daniel's
  // voice does NOT use "or nah" as a yes/no question prompt — that
  // construction reads as scripted ("do you have at least $1k or
  // nah?"). Banned only at the question tail (end of a question),
  // not mid-sentence — "or nah" is fine when it's a casual aside.
  if (/\bor nah\?(\s|$)/i.test(reply) || /\bor nah\?+$/i.test(reply.trim())) {
    hardFails.push(
      'or_nah_question_tail: avoid "or nah?" as a yes/no question construction — it reads as scripted. Use open-ended phrasing instead.'
    );
  }

  // 9k. Overused "real quick" / "real quick tho" transition (Rodrigo
  // Moran 2026-04-26). The LLM had latched onto "real quick tho" as
  // a transition phrase before nearly every qualifying question,
  // making it a detectable bot tell. Soft-counts the prior usage in
  // the AI history; -0.3 per occurrence over 2. Combined with any
  // other soft loss this pushes a borderline reply under 0.7 and
  // forces regen.
  if (
    typeof options?.priorRealQuickPhraseCount === 'number' &&
    options.priorRealQuickPhraseCount > 2 &&
    /\breal\s+quick\b/i.test(reply)
  ) {
    const overuse = options.priorRealQuickPhraseCount - 2;
    softSignals.overused_transition_phrase = -0.3 * overuse;
  }

  // 9l. Validation-loop guard (Cedric Chaar 2026-04-29). Three
  // consecutive "facts bro" / "yeah bro" style replies with no
  // question means the AI is entertaining trading talk instead of
  // advancing qualification.
  const validationOnlyCount =
    (options?.priorValidationOnlyCount ?? 0) +
    (isValidationOnlyMessage(reply) ? 1 : 0);
  if (validationOnlyCount >= 3) {
    softSignals.validation_loop = -0.5;
  }

  // 9m. Validation phrase overuse. These phrases are not banned from
  // Daniel's voice, but the same one more than twice per conversation
  // becomes a bot tell.
  const usedFactsBro = /\bfacts bro\b/i.test(reply);
  const usedYeahBro = /\byeah bro\b/i.test(reply);
  if (
    (usedFactsBro && (options?.priorFactsBroCount ?? 0) >= 2) ||
    (usedYeahBro && (options?.priorYeahBroCount ?? 0) >= 2)
  ) {
    softSignals.overused_validation_phrase = -0.4;
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

  // R27 — third-party capability claim detection (soft signal, NOT a
  // hard fail). Unlike R19 fabrications which have tight surface
  // patterns, R27 violations are open-ended factual assertions
  // ("the closer speaks German", "we have 24/7 support", "the course
  // covers options"). Regex can't reliably catch every variant —
  // primary enforcement is at the prompt level (R27). These patterns
  // just flag the message for prioritised operator review so Daniel
  // can verify whether the claim was accurate and, if not, log a
  // correction + expand the persona's verifiedDetails block.
  //
  // We log to softSignals with 0 score impact so the quality gate
  // still passes (the message might be a legitimate citation of a
  // verifiedDetails entry), but the signal surfaces in downstream
  // analytics. The End-of-Day Review (future) queries on these keys.
  const R27_SOFT_PATTERNS: RegExp[] = [
    // Closer / team capability assertion: "<proper noun> <capability verb>"
    /\b(he|she|they|the team|the coach|the closer|our team|my team)\s+(speaks|offers|has|handles|works|gives|provides|covers|supports)\b/i,
    // Universal availability / language claims
    /\b(24\/7|any\s?time|anytime|any\s+time\s?zone|any\s+timezone|all\s+languages|every\s+language|in\s+any\s+language)\b/i,
    // Product/offer content claim: "we/the course/the program includes X"
    /\b(we|the\s+(?:course|program|mentorship|offer|package))\s+(includes?|covers?|offers?|guarantees?)\b/i,
    // Refund / guarantee fabrication: "30-day guarantee", "money-back"
    /\b\d+[\s-]?day\s+(money[\s-]?back|refund|guarantee|trial)\b/i,
    /\bmoney[\s-]?back\s+guarantee\b/i,
    // Credential invention: "<name> has a <noun> background"
    /\bhas\s+(a|an)\s+\w+\s+(background|degree|certification|license)\b/i
  ];
  let r27SoftCount = 0;
  for (const pat of R27_SOFT_PATTERNS) {
    if (pat.test(reply)) r27SoftCount++;
  }
  // NOT added to softSignals — that record feeds into the rawScore sum,
  // and a legit citation of a verifiedDetails entry shouldn't unfairly
  // lower an otherwise-good message's score. R27's enforcement is at the
  // prompt level; these patterns just surface borderline claims via
  // Vercel logs for operator audit. End-of-Day Review (future) can grep
  // for this log prefix or we can persist to a dedicated table if/when
  // the review queue ships.
  if (r27SoftCount > 0) {
    console.warn(
      `[voice-quality-gate] R27 soft signal fired ${r27SoftCount}x on reply (possible third-party fabrication): "${reply.slice(0, 120)}"`
    );
  }

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

  // ── R22 SOFT SIGNAL: stall-acceptance detection ─────────────────
  // Daniel's R22 (timing objections must be pinned, not accepted)
  // policy. Detect AI replies that let the lead walk away with
  // zero commitment ("hit me up when ready", "I'm here when you
  // need", "reach out whenever", "take your time"). These phrases
  // mean the conversation is ending without a follow-up anchor and
  // — empirically — those leads don't come back.
  //
  // Scored as a soft penalty (-0.3) rather than a hard fail:
  //   - The exact wording sometimes appears legitimately AFTER a
  //     lead has actually committed to a follow-up time, in which
  //     case context (not pattern alone) determines validity.
  //   - We want to accumulate signal in production before
  //     escalating to hard-fail status. -0.3 is enough to push a
  //     borderline reply (~0.7 score) under the 0.7 pass threshold
  //     when combined with other soft losses, but not enough to
  //     unilaterally fail an otherwise-clean reply.
  //
  // If this flags too many false positives in production logs,
  // tighten the regex; if it's reliable, upgrade to hard-fail.
  const stallAcceptancePatterns: RegExp[] = [
    /\bhit\s+me\s+up\s+when(\s+you'?re|\s+u'?re)?\s+ready\b/i,
    /\blet\s+me\s+know\s+when(\s+you'?re|\s+u'?re)?\s+ready\b/i,
    /\b(i'?m|im)\s+here\s+when\s+you\s+need\b/i,
    /\breach\s+out\s+whenever\b/i,
    /\bhit\s+me\s+up\s+whenever\b/i,
    /\btake\s+your\s+time\s+bro\b/i,
    /\bno\s+rush\s+(bro|man)?,?\s+(hit|reach|let)/i,
    /\bjust\s+let\s+me\s+know\s+when\s+you'?re\s+ready\b/i,
    /\b(i'?m|im)\s+here\s+whenever\s+you'?re\s+ready\b/i
  ];
  const stallAcceptanceMatched = stallAcceptancePatterns.some((p) =>
    p.test(reply)
  );
  if (stallAcceptanceMatched) {
    // Negative value — subtracts from rawScore. Tracked under a
    // distinct key so analytics can count fires over time.
    softSignals.r22_stall_acceptance = -0.3;
  }

  // ── R28 SOFT SIGNAL: free-resources mentioned without a URL ─────
  // Daniel's R28 (downsell-then-free-resources, with URL inline)
  // policy. When the AI references "my channel", "my yt", "free
  // content", "videos on my page" etc. WITHOUT a URL in the same
  // reply, the lead is being told to go searching for the resource.
  // Empirically they don't — naming the channel without dropping
  // the link is the same as not sending the resource at all. The
  // R22 free-resources rule (don't ask permission) already says
  // "just send it"; this signal catches the variant where the AI
  // thinks it's sending the resource by namechecking the channel
  // but never includes the URL.
  //
  // Scored as a soft penalty (-0.3) so the gate doesn't false-fire
  // on legitimate mentions like "we'll have content on the channel
  // soon" — those are rare. If the production logs show this is
  // reliable, upgrade to hard-fail.
  const hasUrl = /\bhttps?:\/\/\S+|\bwww\.\S+/i.test(reply);
  const channelMentionPatterns: RegExp[] = [
    /\bcheck\s+out\s+(my|the|our|some)\s+(channel|resources|free\s+content|videos|yt|youtube)\b/i,
    /\bgo\s+(check|look|see)\s+(out\s+)?(my|the|our)\s+(channel|yt|youtube|resources|videos)\b/i,
    /\bi\s+(have|got)\s+some\s+(free\s+)?(resources|videos|content)\s+(for\s+you|to\s+share)?\b/i,
    /\b(my|the|our)\s+(yt|youtube)\s+(channel\s+)?(has|got)\b/i,
    /\bon\s+(my|the|our)\s+(channel|yt|youtube|page)\b/i
  ];
  const channelMentioned = channelMentionPatterns.some((p) => p.test(reply));
  if (channelMentioned && !hasUrl) {
    softSignals.r28_free_resources_no_link = -0.3;
  }

  // ── QUALIFICATION PACE GATES ───────────────────────────────────
  // Message-count guardrails prevent the AI from giving free trading
  // consultation forever. By the fourth AI message the income-goal
  // question should be asked; if the AI is still in Goal/Why after
  // eight AI messages it must move to urgency, and if capital is not
  // asked by message 12 it must ask capital immediately.
  const aiMsgCount = options?.aiMessageCount;
  const currentStage = (options?.currentStage || '').toUpperCase();
  const stageGoalWhyOrEarlier =
    currentStage === 'OPENING' ||
    currentStage === 'DISCOVERY' ||
    currentStage === 'SITUATION_DISCOVERY' ||
    currentStage === 'GOAL' ||
    currentStage === 'GOAL_WHY' ||
    currentStage === 'GOAL_EMOTIONAL_WHY';
  const incomeGoalAskedThisTurn = containsIncomeGoalQuestion(reply);
  const capitalAskedThisTurn = containsCapitalQuestion(reply);

  if (
    typeof aiMsgCount === 'number' &&
    aiMsgCount >= 4 &&
    !options?.incomeGoalAsked &&
    !incomeGoalAskedThisTurn &&
    !options?.skipLegacyPacingGates
  ) {
    hardFails.push(
      "income_goal_overdue: by the 4th AI message, the reply must ask about the lead's income goal instead of continuing trading discussion"
    );
  }

  if (
    typeof aiMsgCount === 'number' &&
    aiMsgCount > 6 &&
    stageGoalWhyOrEarlier
  ) {
    softSignals.qualification_pace_too_slow = -0.3 * (aiMsgCount - 6);
  }

  if (
    typeof aiMsgCount === 'number' &&
    aiMsgCount > 12 &&
    !options?.capitalQuestionAsked &&
    !capitalAskedThisTurn &&
    !options?.skipLegacyPacingGates
  ) {
    hardFails.push(
      'capital_question_overdue: capital question has not been asked by message 12'
    );
  } else if (
    typeof aiMsgCount === 'number' &&
    aiMsgCount > 8 &&
    stageGoalWhyOrEarlier &&
    !options?.skipLegacyPacingGates
  ) {
    hardFails.push(
      'qualification_stalled: AI has been in discovery/goal discussion too long and must advance to urgency'
    );
  }

  // ── INCOMPLETE RESPONSE SIGNAL (soft penalty -0.4) ──────────────
  // Brian Dycey 2026-04-27. AI shipped a single short acknowledgment
  // ("gotchu bro, and that makes sense") with no question, no URL,
  // no next-step CTA. The conversation stalled. Root cause was a
  // multi-bubble dying mid-group, but as a defense-in-depth we also
  // soft-penalise generations that ship a stage-advancing turn with
  // no advancement language. Combined with any other soft loss this
  // pushes a borderline reply under 0.7 and forces regen.
  //
  // Gates:
  //   • reply is short (≤ 15 words on the joined turn)
  //   • reply has NO question mark
  //   • reply has NO URL (a link drop is forward motion even without
  //     a question)
  //   • leadStage / currentStage indicates we're past the opener — no
  //     point firing on stage 1 where a short ack is normal
  // The check runs against the JOINED reply (multi-bubble safe).
  const replyTrimmed = reply.trim();
  const wordCount = replyTrimmed
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  const hasQuestion = /\?/.test(replyTrimmed);
  const hasUrlInReply = /\bhttps?:\/\/\S+|\bwww\.\S+/i.test(replyTrimmed);
  const stageForCheck = (
    options?.currentStage ||
    options?.leadStage ||
    ''
  ).toUpperCase();
  const stageNeedsAdvancement =
    stageForCheck === 'QUALIFYING' ||
    stageForCheck === 'CALL_PROPOSED' ||
    stageForCheck === 'CALL_PENDING_VERIFICATION' ||
    stageForCheck === 'BOOKED' ||
    stageForCheck === 'SITUATION_DISCOVERY' ||
    stageForCheck === 'GOAL_EMOTIONAL_WHY' ||
    stageForCheck === 'URGENCY' ||
    stageForCheck === 'SOFT_PITCH_COMMITMENT' ||
    stageForCheck === 'FINANCIAL_SCREENING' ||
    stageForCheck === 'BOOKING';
  if (
    stageNeedsAdvancement &&
    wordCount > 0 &&
    wordCount < 15 &&
    !hasQuestion &&
    !hasUrlInReply
  ) {
    softSignals.incomplete_response_no_followup = -0.4;
    // Defense-in-depth: -0.4 alone may not fail the gate when the
    // ack-only reply also scores high on the standard positives
    // (lowercase opener, daniel vocab, short, etc.). For the
    // EGREGIOUS case — very short ack (≤ 8 words) on a stage that
    // genuinely needs advancement — escalate to a hard fail. The
    // gray-zone case (9-14 words, soft signal only) gives the LLM
    // room to retry without forcing.
    if (wordCount <= 8) {
      hardFails.push(
        `incomplete_response_acknowledgment_only: short acknowledgment (${wordCount} words) with no question or URL on a ${stageForCheck}-stage turn — the conversation stalls because the lead has nothing to respond to. Append a forward-moving question or a link drop on the same turn.`
      );
    }
  }

  // ── REPEATED QUESTION SIGNAL (soft penalty -0.4) ────────────────
  // Souljah J 2026-04-25: AI asked the capital question, the lead
  // responded with their OWN question (about strategy), and the AI
  // re-asked the capital question on the very next turn without
  // ever addressing the lead's interjection. Detect via per-question
  // Jaccard similarity: extract sentences ending with `?` from the
  // previous AI bubble + the current reply, compute pairwise word-
  // set Jaccard, fire when any pair scores ≥ 0.7. Soft-only — the
  // gate doesn't hard-fail on this because legit re-asking after a
  // clarifying digression is sometimes acceptable; combined with any
  // other soft loss it pushes the reply under 0.7 and forces regen.
  const priorQuestionTexts: string[] = [];
  if (options?.previousAIMessage) {
    priorQuestionTexts.push(...extractQuestions(options.previousAIMessage));
  }
  if (Array.isArray(options?.previousAIQuestions)) {
    priorQuestionTexts.push(
      ...options.previousAIQuestions
        .filter((q) => typeof q === 'string' && q.trim().length > 0)
        .map((q) => q.trim().toLowerCase().replace(/\s+/g, ' '))
    );
  }
  if (priorQuestionTexts.length > 0) {
    const currQs = extractQuestions(reply);
    let bestSim = 0;
    for (const p of priorQuestionTexts) {
      for (const c of currQs) {
        const sim = jaccardSimilarity(p, c);
        if (sim > bestSim) bestSim = sim;
      }
    }
    if (bestSim >= 0.85) {
      // Tighter than the soft-signal threshold below — at this similarity
      // it's effectively the same question. Force regeneration with a
      // directive to advance based on the lead's prior answer rather
      // than re-ask.
      hardFails.push(
        `repeated_question: similarity=${bestSim.toFixed(2)} between current question and a recent AI question — the lead has already answered, advance based on their answer instead of re-asking`
      );
    } else if (bestSim >= 0.7) {
      softSignals.repeated_question = -0.4;
    }
  }

  // ── IGNORED PERSONAL QUESTION (soft penalty -0.5) ───────────────
  // Omar Moore 2026-04-27. Lead said "Hbu" and "what's your favorite
  // prop" — twice the AI ignored or deflected. A human never ignores
  // "how about you". Two dodges in one conversation = guaranteed bot
  // detection. Detector: previous LEAD message matches a personal-
  // question pattern AND current AI reply has no first-person
  // language. Weighted -0.5 — strong enough to fail the gate on its
  // own when stacked with even one minor positive miss.
  if (
    options?.previousLeadMessage &&
    typeof options.previousLeadMessage === 'string'
  ) {
    const prev = options.previousLeadMessage.trim();
    if (prev.length > 0) {
      // Defer to the canonical detector + first-person check —
      // local copies kept in conversation-detail-extractor to avoid
      // a circular import (the gate is consumed by ai-engine, the
      // detector is consumed by ai-engine; importing the detector
      // here is one-way and safe).
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const det =
        require('./conversation-detail-extractor') as typeof import('./conversation-detail-extractor');
      const isPersonal = det.detectPersonalQuestion(prev).detected;
      if (isPersonal && !det.replyContainsFirstPerson(reply)) {
        softSignals.ignored_personal_question = -0.5;
      }
    }
  }

  // ── SCRIPTED QUESTION SEQUENCE (soft penalty -0.3 per >2) ───────
  // Omar Moore 2026-04-27. AI ran 6 qualification questions in a row
  // with no specific acknowledgment of what the lead shared (named
  // prop firms, instruments, strategies). After 3-4 the pattern is
  // detectable. Caller passes `priorConsecutivePureQuestionCount` —
  // the count of trailing pure-question AI messages already in the
  // history. If >= 2 AND current reply is ALSO a pure question, fire
  // the soft signal weighted by how far over 2 we are.
  if (
    typeof options?.priorConsecutivePureQuestionCount === 'number' &&
    options.priorConsecutivePureQuestionCount >= 2
  ) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const det =
      require('./conversation-detail-extractor') as typeof import('./conversation-detail-extractor');
    const recentDetails = options.recentLeadDetails ?? [];
    const currIsPureQ = det.isPureQuestion(reply, recentDetails);
    if (currIsPureQ) {
      // Total pure-question run including this turn = prior + 1.
      // Penalty fires for runs >= 3 total; -0.3 per question over 2.
      const totalRun = options.priorConsecutivePureQuestionCount + 1;
      const overage = Math.max(0, totalRun - 2);
      softSignals.scripted_question_sequence = -0.3 * overage;
    }
  }

  // ── GENERIC ACKNOWLEDGMENT (soft penalty -0.2) ──────────────────
  // Omar Moore 2026-04-27. "love that bro" / "love that bro big moves"
  // by themselves are empty acknowledgments. Combined with a question
  // they're fine, but as the ENTIRE reply they read as a stalled,
  // template-y filler. Light penalty (-0.2) — combined with any other
  // soft loss it nudges the reply under the pass threshold.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const detForGeneric =
    require('./conversation-detail-extractor') as typeof import('./conversation-detail-extractor');
  if (detForGeneric.isGenericAcknowledgmentOnly(reply)) {
    softSignals.generic_acknowledgment = -0.2;
  }

  // ── REPETITIVE QUESTION PATTERN SIGNAL (soft penalty -0.4) ─────
  // Looks beyond exact re-asks and catches the generic pivot template:
  // "what's the main thing...", "what's the biggest issue...",
  // "what's the hardest part..." repeated across turns.
  if (options?.previousAIQuestions?.length) {
    const currQs = extractQuestions(reply);
    let bestStructuralSim = 0;
    for (const prev of options.previousAIQuestions.slice(-3)) {
      for (const curr of currQs) {
        const sim = structuralQuestionSimilarity(prev, curr);
        if (sim > bestStructuralSim) bestStructuralSim = sim;
      }
    }
    if (bestStructuralSim > 0.6) {
      softSignals.repetitive_question_pattern = -0.4;
    }
  }

  // ── VAGUE CAPITAL ANSWER SIGNAL (soft penalty -0.4) ────────────
  // Steven Biggam 2026-04-30. Lead replied to the capital question
  // with a vague non-answer ("very little", "manageable amount",
  // "saving up"). The AI's response should be the multi-anchor probe
  // ("ballpark is fine bro — like under $500, closer to $1k, or
  // more than that?") — anything else (acknowledgment + advance,
  // generic question, soft exit) lets the lead keep dodging.
  if (options?.leadVagueCapitalAnswerInLastReply === true) {
    const PROBE_PHRASE_RE =
      /\b(ballpark|under\s+\$?500|closer\s+to\s+\$?1k|more\s+than\s+that|what'?s\s+the\s+(actual\s+)?number|how\s+much\s+(do\s+you\s+have\s+set\s+aside|are\s+you\s+working\s+with))\b/i;
    if (!PROBE_PHRASE_RE.test(reply)) {
      softSignals.vague_capital_answer = -0.4;
    }
  }

  // ── PRE-OBJECTION NOT ADDRESSED SIGNAL (soft penalty -0.3) ─────
  // Steven Biggam 2026-04-30. Lead expressed concern about cost
  // ("anyone asking for a lot is a red flag", "I'm on a budget").
  // The AI's reply asks the capital question (or pitches the call)
  // without acknowledging the concern. Soft penalty — encourages but
  // doesn't force regen, since the operator may legitimately want a
  // reassurance-light approach.
  if (options?.leadPreObjectedToCapital === true) {
    const ASKS_CAPITAL_RE =
      /\b(capital|how\s+much|set\s+aside|to\s+invest|to\s+start\s+with|working\s+with|budget)\b/i;
    const REASSURANCE_RE =
      /\b(no\s+pressure|not\s+(here\s+to\s+)?pressure|not\s+pushing|nah\s+bro\s+(i'?m|im)\s+not|just\s+need\s+to\s+know\s+(what|where)|point\s+you\s+in\s+the\s+right\s+direction|no\s+stress|chill\s+bro|not\s+forcing|not\s+(trying|trynna)\s+to\s+sell\s+you)\b/i;
    if (
      (ASKS_CAPITAL_RE.test(reply) || CALL_PITCH_RE.test(reply)) &&
      !REASSURANCE_RE.test(reply)
    ) {
      softSignals.pre_objection_not_addressed = -0.3;
    }
  }

  // ── DISQUALIFICATION AFTER CALL CONFIRMED (HARD FAIL) ──────────
  // Wout Lngrs 2026-05-01. Lead had $5,000 capital + a confirmed
  // Sunday call. R24 re-evaluated post-booking, parsed a stray "12"
  // out of a lead message, fell into the deterministic
  // answer_below_threshold fallback, and shipped the canned downsell
  // ("better move is the lower-ticket/free route while you build
  // closer to $2,000"). The lead read this as a hard rescind of the
  // qualified call — actively destructive.
  //
  // Primary fix is in ai-engine (R24 early-return when scheduledCallAt
  // is set). This gate is the belt-and-suspenders catch in case any
  // path produces qualification/downsell language while the call is
  // already booked.
  if (hasConfirmedScheduledCall(options?.scheduledCallAt)) {
    const DISQUAL_AFTER_BOOKING_RE =
      /\b(better\s+move\s+is|lower[-\s]?ticket|build\s+closer\s+to|revisit\s+the\s+full|wouldn'?t\s+force\s+the\s+main\s+call|free[-\s]?route|free\s+resource|i\s+wouldn'?t\s+force|youtube\.com|youtu\.be)\b/i;
    const QUAL_LANGUAGE_RE =
      /\b(at\s+least\s+\$\d|capital\s+ready|ready\s+to\s+start\s+with\s+\$|with\s+\$\d[\d,]*\s+i\s+wouldn'?t)\b/i;
    if (DISQUAL_AFTER_BOOKING_RE.test(reply) || QUAL_LANGUAGE_RE.test(reply)) {
      hardFails.push(
        'disqualification_after_call_confirmed: lead has a confirmed call (scheduledCallAt is set) but the AI reply contains downsell / qualification / disqualification language. The call is already booked — do not re-qualify or route to downsell.'
      );
    }
  }

  // ── FABRICATED CAPITAL FIGURE (soft penalty -0.5) ──────────────
  // Wout Lngrs 2026-05-01. AI's reply contained "$12" — a number
  // that appeared nowhere in the conversation history. The R24
  // parser hit a stray "12" in some message; the deterministic
  // fallback printed it back. Even outside R24, the LLM sometimes
  // hallucinates dollar figures the lead never said.
  //
  // Detection: extract every $<number> token from the reply. For
  // each, check whether the same numeric value appears in the
  // priorMessageCorpus. If ANY don't match, fire the signal.
  // Threshold check is "amount as a substring" (with thousands
  // separators normalized) — the lead said "5000" or "$5,000",
  // both forms count as present.
  if (typeof options?.priorMessageCorpus === 'string') {
    const replyAmounts: string[] = [];
    const replyAmountRe = /\$\s?(\d{1,3}(?:,\d{3})+|\d{2,7})/g;
    let amtMatch: RegExpExecArray | null;
    while ((amtMatch = replyAmountRe.exec(reply)) !== null) {
      const cleaned = amtMatch[1].replace(/,/g, '');
      if (cleaned.length > 0) replyAmounts.push(cleaned);
    }
    if (replyAmounts.length > 0) {
      const corpusNumbers = new Set<string>();
      const corpusRe = /\d{1,3}(?:,\d{3})+|\d{2,7}/g;
      let cMatch: RegExpExecArray | null;
      while ((cMatch = corpusRe.exec(options.priorMessageCorpus)) !== null) {
        corpusNumbers.add(cMatch[0].replace(/,/g, ''));
      }
      const fabricated = replyAmounts.filter((amt) => !corpusNumbers.has(amt));
      if (fabricated.length > 0) {
        softSignals.fabricated_capital_figure = -0.5;
      }
    }
  }

  // ── CLOSER / CALL MENTION IN DOWNSELL CONTEXT (HARD FAIL) ──────
  // 2026-05-02. Real example: a 900 CAD financially-strapped lead
  // already routed to YouTube/downsell asked "how much do I need to
  // pay" and the AI said "pricing is covered on the call with
  // Anthony, depends which program fits". The closer is ONLY for
  // the main mentorship — the downsell is a self-serve course with
  // a flat one-time price, no call, no closer. R24c in the master
  // prompt is the directive; this is the post-generation enforcement
  // so a slip regens with correct phrasing instead of shipping the
  // misleading line.
  //
  // Account-agnostic: closer name(s) are passed in via options so
  // this rule fires for any persona (no hardcoded "Anthony").
  //
  // Trigger: leadStage === 'UNQUALIFIED' OR capitalOutcome ===
  // 'failed' AND the reply contains call/closer language.
  const isUnqualifiedContext =
    options?.leadStage === 'UNQUALIFIED' ||
    options?.capitalOutcome === 'failed';
  if (isUnqualifiedContext) {
    const closerNamesEscaped = (options?.closerNames ?? [])
      .map((n) => (n || '').trim())
      .filter(Boolean)
      .map((n) => escapeRegex(n));
    const closerNameMatch =
      closerNamesEscaped.length > 0
        ? new RegExp(`\\b(${closerNamesEscaped.join('|')})\\b`, 'i')
        : null;
    const CALL_LANGUAGE_RE =
      /\b(hop\s+on\s+(a\s+)?(quick\s+)?(call|chat)|jump\s+on\s+(a\s+)?(call|chat)|on\s+the\s+call|main\s+call|with\s+the\s+closer|call\s+with\s+[A-Z][a-z]+|book(ing)?\s+(a\s+)?call|the\s+team\s+will\s+reach\s+out)\b/i;
    const PRICING_DEFER_TO_CALL_RE =
      /\b(price|pricing|cost|how\s+much)[^.]{0,80}\b(covered|discussed|broken\s+down|explained|shared)\s+on\s+the\s+call\b/i;
    if (
      (closerNameMatch && closerNameMatch.test(reply)) ||
      CALL_LANGUAGE_RE.test(reply) ||
      PRICING_DEFER_TO_CALL_RE.test(reply)
    ) {
      hardFails.push(
        'closer_or_call_in_downsell: lead is unqualified for the main program (UNQUALIFIED stage or capitalOutcome=failed), but the reply mentions the closer / a call / "pricing covered on the call". The downsell is a self-serve course with a flat price — no call, no closer. State the downsell price directly from the script, OR route to the YouTube fallback.'
      );
    }
  }

  // ── PREMATURE SOFT EXIT SIGNAL (soft penalty -0.4) ──────────────
  // Mbaabu Denis / Badchild Meshach / Jeffrey Barrios / Shishir Ibna
  // Moin / Nez Futurez (2026-04-20/21) all got soft-exited to YouTube
  // by the AI on messages 3-5 without ever being asked about capital,
  // pitched the call, or offered the downsell. The AI interpreted the
  // allowEarlyFinancialScreening flag as permission to bail out
  // entirely when a warm lead asked "can you recommend something to
  // backtest?" — treating the resource request as a goodbye instead of
  // a mid-funnel engagement signal.
  //
  // Pattern alone is insufficient (the same wording is fine after a
  // lead is R24-failed or has declined the downsell). Gate on three
  // additional conditions:
  //   • conversation < 12 total messages (warm / mid-funnel)
  //   • capitalOutcome !== 'failed' (this turn's R24 didn't disqualify)
  //   • leadStage !== 'UNQUALIFIED' (no prior terminal disqualification)
  //
  // Weighted -0.4 — stronger than R22/R28 (-0.3) because the failure
  // mode is a full conversation death, not a rhetorical flaw. Combined
  // with any other soft loss it pushes a reply under the 0.7 pass
  // threshold and triggers regen.
  const prematureSoftExitPatterns: RegExp[] = [
    /\bcheck\s+(it\s+|this\s+)?out\s+and\s+let\s+me\s+know\b/i,
    /\bbacktest\s+(it|this)\s+over\b/i,
    /\bgood\s+luck\b/i,
    /\bkeep\s+grinding\b/i,
    /\bhit\s+me\s+up\s+if\s+you\s+need\b/i,
    /\b(i'?m|im)\s+here\s+if\s+you\s+need\s+(anything|it|help)\b/i
  ];
  const prematureExitPatternMatched = prematureSoftExitPatterns.some((p) =>
    p.test(reply)
  );
  if (prematureExitPatternMatched) {
    const msgCount = options?.conversationMessageCount;
    const conversationShort =
      typeof msgCount === 'number' ? msgCount < 12 : false;
    const capitalNotFailed = options?.capitalOutcome !== 'failed';
    const leadNotUnqualified = options?.leadStage !== 'UNQUALIFIED';
    if (conversationShort && capitalNotFailed && leadNotUnqualified) {
      softSignals.premature_soft_exit_warm_lead = -0.4;
    }
  }

  // ── EXPLICIT SOFT-EXIT FROM LEAD (hard fail when AI ignores) ────
  // The lead has explicitly said "for now I'm not interested" / "I'll
  // come back when I'm ready" / "I appreciate you but…" — not
  // hesitation, an explicit decline. The AI must close gracefully and
  // stop qualifying. Hard-fail any reply that asks another
  // qualification question or pushes the script further. Forces regen
  // with a directive that produces a single warm-close message.
  const SOFT_EXIT_PATTERNS: RegExp[] = [
    /\bfor now i (don['’]?t|do not|won['’]?t|will not) (think|need|want)\b/i,
    /\bi['’]?(ll| will) (come back|reach out|hit you up|return) (later|when|if)\b/i,
    /\bi need to (do|go through|figure out) (this|it) (myself|on my own|alone)\b/i,
    /\bi think i (have|need) to go through it (myself|by myself|alone)\b/i,
    /\bi appreciate you[\.,]/i,
    /\bthank you.{0,30}but (for now|right now|at this point)\b/i
  ];
  if (
    typeof options?.previousLeadMessage === 'string' &&
    options.previousLeadMessage.trim().length > 0 &&
    SOFT_EXIT_PATTERNS.some((p) => p.test(options.previousLeadMessage!))
  ) {
    const replyHasQuestion = /\?/.test(reply);
    // Re-engagement keywords that would push the conversation forward
    // when the lead has explicitly tapped out. Calibration vs
    // false-positives kept tight: the AI is allowed to thank them and
    // leave the door open, just not ask another qualifying question or
    // pitch.
    const replyKeepsPushing =
      /\b(capital|trading background|how soon|how much|what['’]?s your|what do you|book a call|hop on a call|jump on a call|schedule|application|typeform)\b/i.test(
        reply
      );
    if (replyHasQuestion || replyKeepsPushing) {
      hardFails.push(
        `explicit_soft_exit_ignored: lead's previous message indicated explicit soft exit ("${options.previousLeadMessage.trim().slice(0, 60)}") but reply continues qualifying — close warmly and stop outreach`
      );
    }
  }

  // ── FUTURE-COMMITMENT FROM LEAD (hard fail when AI ignores) ─────
  // "I promise in half a year I'll buy your mentorship." — that's a
  // future commitment, a WIN, and the AI must close gracefully without
  // trying to compress the timeline. Hard-fail re-engagement /
  // qualification on this turn.
  const FUTURE_COMMITMENT_PATTERNS: RegExp[] = [
    /\bi['’]?(ll| will) (buy|get|join|come back for).{0,30}(mentorship|program|course|your thing)\b/i,
    /\bwhen i['’]?(m| am) (ready|in a better spot|more consistent)\b/i,
    /\bin (a|half|one|two).{0,20}(year|month).{0,30}(i will|i['’]?ll)\b/i,
    /\bpromise.{0,30}(i will|i['’]?ll|when)\b/i
  ];
  if (
    typeof options?.previousLeadMessage === 'string' &&
    options.previousLeadMessage.trim().length > 0 &&
    FUTURE_COMMITMENT_PATTERNS.some((p) => p.test(options.previousLeadMessage!))
  ) {
    // Same forward-push detection as soft-exit. The right reply is a
    // single appreciative line acknowledging the plan + door-open
    // closer; anything that re-opens qualification is wrong.
    const replyKeepsPushing =
      /\?|\b(capital|trading background|how soon|how much|what['’]?s your|book a call|hop on a call|jump on a call|schedule|application|typeform)\b/i.test(
        reply
      );
    if (replyKeepsPushing) {
      hardFails.push(
        `future_commitment_ignored: lead's previous message named a future commitment ("${options.previousLeadMessage.trim().slice(0, 60)}") but reply re-engages qualification — acknowledge gratefully and leave the door open instead`
      );
    }
  }

  // ── WRONG REGISTER AFTER MISSED CALL (hard fail) ────────────────
  // Lead just told the AI they missed their call / had a calendar
  // mixup / wasn't prepared. The right register is calm + apologetic +
  // reschedule. 🔥, "let's go", "that's the energy" all read as
  // celebrating a no-show — exact failure mode reported in audit
  // (Wout 2026-05-04).
  const MISSED_CALL_PATTERNS: RegExp[] = [
    /\bmix.?up.{0,30}(calendar|booking|time)\b/i,
    /\bwasn['’]?t prepared\b/i,
    /\bwas (already|in) bed\b/i,
    /\bmissed (the|my|our) call\b/i,
    /\breschedule\b/i,
    /\bdidn['’]?t (make it|show up|get the link)\b/i,
    /\bwrong time\b/i,
    /\btimezone (issue|problem|mixup)\b/i
  ];
  if (
    typeof options?.previousLeadMessage === 'string' &&
    options.previousLeadMessage.trim().length > 0 &&
    MISSED_CALL_PATTERNS.some((p) => p.test(options.previousLeadMessage!))
  ) {
    const CELEBRATION_REGISTER =
      /🔥|\blet['’]?s go+\b|\blet['’]?s gooo+\b|\bthat['’]?s the energy\b|\blfg+\b/i;
    if (CELEBRATION_REGISTER.test(reply)) {
      hardFails.push(
        `wrong_register_on_cancellation: lead reported a missed call / mixup ("${options.previousLeadMessage.trim().slice(0, 60)}") but reply uses celebration register — switch to calm, apologetic tone and offer to reschedule`
      );
    }
  }

  // ── SOFT HESITATION EXIT SIGNAL (soft penalty -0.5) ─────────────
  // Erik Torosian 2026-04-28. Lead had enough capital but said he
  // "wouldn't want to" use it. That's hesitation, not a hard refusal.
  // Routing immediately to YouTube / "better spot" kills a qualified
  // lead. Probe the concern instead.
  if (options?.previousLeadMessage) {
    const softHesitationPatterns: RegExp[] = [
      /\bwouldn['’]?t\s+want\s+to\b/i,
      /\bnot\s+sure\s+(about|if)\s+(that|this|it)\b/i,
      /\bprobably\s+not\b/i,
      /\bi['’]?d\s+rather\s+not\b/i,
      /\bnot\s+really\s+(sure|ready|there\s+yet)\b/i,
      /\bmaybe\s+not\b/i
    ];
    const hardNoPatterns: RegExp[] = [
      /\b(definitely|absolutely)\s+not\b/i,
      /\bno\s+way\b/i,
      /\bcan['’]?t\s+afford\s+(anything|it|that|this)\b/i,
      /\bnot\s+interested\b/i,
      /\bstop\s+(messaging|texting|contacting)\s+me\b/i,
      /\bleave\s+me\s+alone\b/i
    ];
    const prematureExitPatterns: RegExp[] = [
      /youtu\.be/i,
      /youtube\.com/i,
      /when\s+you['’]?re\s+in\s+a\s+better\s+spot/i,
      /hit\s+me\s+up\s+when/i,
      /start\s+with\s+the\s+free\s+video/i
    ];
    const prevLead = options.previousLeadMessage;
    const leadSoftHesitated = softHesitationPatterns.some((pat) =>
      pat.test(prevLead)
    );
    const leadHardNo = hardNoPatterns.some((pat) => pat.test(prevLead));
    const currentSoftExits = prematureExitPatterns.some((pat) =>
      pat.test(reply)
    );
    if (leadSoftHesitated && !leadHardNo && currentSoftExits) {
      softSignals.premature_exit_on_soft_hesitation = -0.5;
    }
  }

  if (
    options?.previousLeadMessage &&
    isCallAcceptance(options.previousLeadMessage) &&
    containsSchedulingQuestion(reply)
  ) {
    softSignals.unnecessary_scheduling_question = -0.4;
  }

  // ── TYPEFORM FILLED BUT NO BOOKING SLOT ───────────────────────
  // Atigib Bliz 2026-04-29. If the AI asked "what day and time did
  // you book for?" and the lead says they only completed the basic
  // form / did not get a time, that is not a logistics problem. The
  // Typeform screened them before the booking step. The only valid
  // reply is the fixed soft-exit line.
  if (
    detectTypeformFilledNoBookingContext(
      options?.previousAIMessage,
      options?.previousLeadMessage
    ) &&
    !isTypeformNoBookingSoftExitReply(reply)
  ) {
    hardFails.push(
      'typeform_filled_no_booking_wrong_path: lead filled Typeform but did not book a time slot; send the fixed screened-out soft exit only'
    );
  }

  // ── Calculate final score ───────────────────────────────────────
  const maxScore = 4.0; // 1 + 1 + 1 + 0.5 + 0.5 (emoji is bonus, not required)
  const rawScore = Object.values(softSignals).reduce((a, b) => a + b, 0);
  // Clamp to [0, 1] — the R22 negative penalty can push rawScore
  // below 0 on otherwise-empty replies; a negative score is
  // meaningless to downstream consumers and breaks the >= 0.7
  // pass threshold semantics.
  const score = Math.max(0, Math.min(1.0, rawScore / maxScore));

  return {
    score,
    passed: hardFails.length === 0 && score >= 0.7,
    hardFails,
    softSignals
  };
}

// ---------------------------------------------------------------------------
// Helpers — repeated-question detection
// ---------------------------------------------------------------------------

/**
 * Extract every sentence ending in `?` from a free-form message,
 * lowercased + whitespace-collapsed. Used by the repeated_question
 * soft signal so we compare question content, not the surrounding
 * acknowledgment ("yo bro that's wild — what's holding you back?").
 */
function extractQuestions(text: string): string[] {
  if (!text) return [];
  // Split on sentence-final ? . ! and keep only the segments that
  // ended in `?` in the original. We track that by re-scanning the
  // text and pairing each split chunk with the punctuation that
  // followed it.
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '?' || ch === '.' || ch === '!' || ch === '\n') {
      if (ch === '?') {
        const trimmed = buf.trim().toLowerCase().replace(/\s+/g, ' ');
        if (trimmed.length > 0) out.push(trimmed);
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

/**
 * Token-overlap coefficient: |A ∩ B| / min(|A|, |B|). Captures
 * "the same question, possibly padded with extra context words" —
 * which is exactly the failure mode (LLM rephrases the capital ask
 * with a leading acknowledgment, but the question keywords are
 * identical). Jaccard would underweight this case because the
 * acknowledgment words inflate the union; overlap-coefficient ignores
 * them. Stop-word filtering still applied so two questions that
 * share only "the / you / what" don't false-fire.
 */
function jaccardSimilarity(a: string, b: string): number {
  const STOP = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'do',
    'does',
    'did',
    'have',
    'has',
    'had',
    'i',
    'you',
    'we',
    'they',
    'it',
    'this',
    'that',
    'these',
    'those',
    'and',
    'or',
    'but',
    'if',
    'so',
    'on',
    'in',
    'at',
    'to',
    'for',
    'of',
    'with',
    'by',
    'as'
  ]);
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9'\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP.has(w))
    );
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersect = 0;
  Array.from(sa).forEach((w) => {
    if (sb.has(w)) intersect++;
  });
  const minSize = Math.min(sa.size, sb.size);
  return minSize === 0 ? 0 : intersect / minSize;
}

function hasConfirmedScheduledCall(value: Date | string | null | undefined) {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 && !Number.isNaN(new Date(value).getTime());
  }
  return false;
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsHomeworkUrl(
  text: string,
  homeworkUrl?: string | null
): boolean {
  if (!text || typeof text !== 'string') return false;

  const configured = typeof homeworkUrl === 'string' ? homeworkUrl.trim() : '';
  if (configured.length > 0) {
    const configuredRe = new RegExp(escapeRegex(configured), 'i');
    if (configuredRe.test(text)) return true;
  }

  return /\bhttps?:\/\/\S*(?:homework|thank-you-confirmation)\S*/i.test(text);
}

export function stripPreCallHomeworkFromMessages(
  messages: string[],
  homeworkUrl?: string | null
): string[] {
  const kept = messages
    .filter((message) => !containsHomeworkUrl(message, homeworkUrl))
    .map((message) => message.trim())
    .filter((message) => message.length > 0);

  if (kept.length > 0) return kept;

  return [
    "gotchu bro, once the call time is locked in i'll send the prep over."
  ];
}

export function containsCapitalQuestion(text: string): boolean {
  const patterns: RegExp[] = [
    /\bhow much.{0,40}(capital|set aside|ready|saved|available)\b/i,
    /\b(capital|money).{0,30}(situation|set aside|ready|available|working with)\b/i,
    /\b(capital|money).{0,30}ready to (invest|start)\b/i,
    /\bdo you have.{0,20}\$?(1[,.]?000|1k)\b/i,
    /\bgot.{0,15}\$?(1[,.]?000|1k)\b/i,
    /\bgot.{0,10}\$?(1[,.]?000|1k).{0,20}(ready|set aside|available)\b/i,
    /\byou got at least \$?\d/i,
    /\byou have at least \$?\d/i,
    /\bat least \$?\d+[,\d]*\s*(in\s+capital|capital|ready|to\s+start)/i,
    /\bcapital ready\b/i,
    /\bready to start with \$?\d/i,
    /\bjust to confirm.*\b(capital|\$|£)\b/i,
    /\bhow much (do you |have you )?(got|have|set aside|saved|working with|to start|to invest|to put (in|aside))\b/i,
    /\bwhat(?:'|’)?s your (budget|capital|starting (amount|capital|budget))\b/i,
    /\bwhat is your (budget|capital|starting (amount|capital|budget))\b/i,
    /\bwhat(?:'|’)?s your capital situation\b/i,
    /\bset aside\b.*\b(for|toward|for (the |this )?markets?|for (your |the )?(education|trading))/i,
    /\bhow much (are you )?(working with|looking to (invest|start with|put (in|aside)))\b/i,
    /\bwhat are you working with\b/i,
    /\bon the (capital|money|budget) side\b/i
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function containsIncomeGoalQuestion(text: string): boolean {
  const patterns: RegExp[] = [
    /\b(income|money|earnings?|revenue)\s+goal\b/i,
    /\bgoal\b.{0,40}\b(make|earn|income|month|monthly|week|weekly)\b/i,
    /\bhow much (do you|are you trying to|would you like to|you wanna|you want to)\s+(make|earn)\b/i,
    /\bwhat('s| is)\s+(your\s+)?(income|earning|monthly|weekly|money)\s+goal\b/i,
    /\bwhat('s| is)\s+the\s+number\s+you('re| are)?\s+(trying|looking|wanting)\s+to\s+(hit|make|earn)\b/i,
    /\bhow much (per|a)\s+(month|week)\b/i,
    /\btarget\s+(income|number|amount)\b/i
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function containsUrgencyQuestion(text: string): boolean {
  const patterns: RegExp[] = [
    /\bhow soon\b/i,
    /\bby when\b/i,
    /\b(timeline|time\s*frame|time\s*line)\b/i,
    /\bwhen are you (trying|tryna|hoping|looking|wanting|planning)\b/i,
    /\b(trying|tryna|hoping|looking|wanting|planning)\s+to\s+(make|hit)\s+(it|this|that)\s+happen\b/i,
    /\b(make|hit)\s+(it|this|that)\s+happen\b.*\?$/i,
    /\bwhat('s| is)\s+(your\s+)?(timeline|timeframe|urgency)\b/i,
    /\bhow (fast|quick|quickly|soon)\b.*\?/i
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeQuestionStructure(question: string): string {
  return question
    .toLowerCase()
    .replace(/\bwhat's\b/g, 'what is')
    .replace(/\bwanna\b/g, 'want to')
    .replace(
      /\b(main|biggest|hardest|toughest|primary|number one|#1)\b/g,
      'core'
    )
    .replace(
      /\b(thing|issue|problem|challenge|part|bottleneck|struggle)\b/g,
      'problem'
    )
    .replace(
      /\b(holding you back|stopping you|blocking you|keeping you stuck|getting in the way)\b/g,
      'obstacle'
    )
    .replace(/\b(fix|solve|change|improve|work on)\b/g, 'fix')
    .replace(/\b(right now|currently|at the moment|rn)\b/g, 'now')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function questionStructureFeatures(question: string): Set<string> {
  const normalized = normalizeQuestionStructure(question);
  const features = new Set<string>();
  if (/\bwhat\b/.test(normalized)) features.add('what');
  if (/\bcore\b/.test(normalized)) features.add('core');
  if (/\bproblem\b/.test(normalized)) features.add('problem');
  if (/\bobstacle\b/.test(normalized)) features.add('obstacle');
  if (/\bfix\b/.test(normalized)) features.add('fix');
  if (/\bnow\b/.test(normalized)) features.add('now');
  if (/\byou\b/.test(normalized)) features.add('you');
  if (/\bwant to\b|\btrying to\b|\blooking to\b/.test(normalized)) {
    features.add('goal-seeking');
  }
  if (/\bcapital\b|\bbudget\b|\bmoney\b/.test(normalized)) {
    features.add('capital');
  }
  if (/\bincome\b|\bearn\b|\bmake\b/.test(normalized)) {
    features.add('income');
  }
  return features;
}

function structuralQuestionSimilarity(a: string, b: string): number {
  const normalizedA = normalizeQuestionStructure(a);
  const normalizedB = normalizeQuestionStructure(b);
  const lexical = jaccardSimilarity(normalizedA, normalizedB);
  const featuresA = questionStructureFeatures(normalizedA);
  const featuresB = questionStructureFeatures(normalizedB);
  if (featuresA.size === 0 || featuresB.size === 0) return lexical;
  let intersect = 0;
  for (const feature of Array.from(featuresA)) {
    if (featuresB.has(feature)) intersect++;
  }
  const union = new Set([...Array.from(featuresA), ...Array.from(featuresB)])
    .size;
  const featureScore = union === 0 ? 0 : intersect / union;
  return Math.max(lexical, featureScore);
}

// ---------------------------------------------------------------------------
// Multi-bubble group scorer
// ---------------------------------------------------------------------------
// Wraps scoreVoiceQuality per-bubble and adds two group-level checks that
// must evaluate the joined string rather than each bubble independently:
//
//   1. cta_acknowledgment_only_truncation — a legitimate 2-bubble split
//      like ["yo bro caught the story 💪🏿", "what got you into trading?"]
//      has bubble-0 that matches the ack-only pattern but the group has a
//      "?" and is long enough. Running per-bubble would false-fire.
//
//   2. cliffhanger / isUnkeptPromise — a cliffhanger in a non-final bubble
//      is fine when a follow-on bubble fulfils it. isUnkeptPromise is only
//      interesting CROSS-TURN (did the previous turn's last bubble stall
//      the conversation) — that check stays in ai-engine.ts using the
//      last bubble. Inside a single turn, mid-group cliffhangers are OK.
//
// Everything else (R19/R22/R24/R26/R27, CTA mechanism leak, banned phrases,
// em-dashes, emoji, length) is per-bubble: any bubble with a violation
// fails the whole group. Individual hardFails are prefixed with [bubble=N]
// so the retry directive can tell the LLM which bubble to fix.
//
// Legacy single-message callers (flag-off path) pass [reply] and see
// byte-identical behaviour — the concatenated-group check sees the same
// string the per-bubble check would have.

const CTA_ACKNOWLEDGMENT_ONLY_PATTERNS: RegExp[] = [
  /\bcaught\s+(the|your)\s+(story|post|content|ad|video|drop|ig|instagram|vid|yt|youtube|reel)\b/i,
  /\bsliding\s+through\b/i,
  /\bappreciate\s+you\s+(sliding|reaching|messaging|pulling\s+up)\b/i,
  /\bsaw\s+you\s+through\s+the\s+(content|post|story|video|ad|reel)\b/i,
  /\bcaught\s+your\s+(message|dm|post|comment)\b/i,
  /\bglad\s+you\s+(reached\s+out|slid\s+through|messaged)\b/i
];

/**
 * Returns a hardFail reason string if the joined group is a stalled
 * acknowledgment (short + no `?` + matches an opener pattern). Returns
 * null if the group is fine. Operates on the concatenated string so
 * multi-bubble splits don't false-fire.
 */
function checkCtaAckOnlyTruncation(joinedText: string): string | null {
  const trimmed = joinedText.trim();
  if (trimmed.length >= 80) return null;
  if (trimmed.includes('?')) return null;
  for (const pat of CTA_ACKNOWLEDGMENT_ONLY_PATTERNS) {
    if (pat.test(trimmed)) {
      return `cta_acknowledgment_only_truncation: matched "${pat.source}" — reply is a short campaign acknowledgment with no qualifying question; the conversation stalls. Every campaign-matched reply MUST end with a forward-moving question in the same "message" field.`;
    }
  }
  return null;
}

// Link-promise-without-URL patterns. Match future/present-tense
// announcements of delivering a link / URL / application. Past-tense
// references ("I sent you the link yesterday") must NOT match — only
// current-turn promises that should include the URL inline.
//
// Incident driving this gate (Shishir 2026-04-20): AI said "I'm gonna
// send you the link to apply. fill everything out and lmk when you're
// done 💪🏿" with NO URL in the reply. Lead sat waiting. R22's [LINK]
// placeholder guard (commit 14e8115) covers "[BOOKING LINK]" literal
// leaks, but not this case where the AI announces the send in natural
// prose and never attaches the URL.
const LINK_PROMISE_PATTERNS: RegExp[] = [
  // "I'll send you the link" / "gonna send you the link" / "lemme
  // send you the link" / "i'm about to send you the link"
  /\b(i'?ll|lemme|let\s+me|gonna|going\s+to|about\s+to|i'?m\s+(gonna|going\s+to|about\s+to))\s+(send|drop|shoot|share|grab|get)\s+(you\s+)?(the\s+|a\s+|this\s+|your\s+|my\s+)?(link|url|application|typeform|form|booking\s+link|booking\s+url)\b/i,
  // Present continuous: "sending you the link" / "dropping the link"
  /\b(sending|dropping|shooting|sharing|grabbing)\s+(you\s+)?(the\s+|a\s+|this\s+|your\s+|my\s+)?(link|url|application|typeform|form|booking\s+link|booking\s+url)\b/i,
  // "here's the link" / "here is the link" — colon often follows with URL.
  // The URL-absence check in the caller is what makes this a fail.
  /\bhere'?s\s+(the\s+|a\s+|your\s+|my\s+)?(link|url|application|booking\s+link|typeform|form)\b/i,
  // "check your dm" / "check the link above" style — ambiguous. Skip
  // for now; false-positive risk too high.
  // Bare "send you the link" / "drop the link" / "shoot you the link"
  /\b(send|drop|shoot)\s+you\s+the\s+link\b/i
];

function containsUrl(text: string): boolean {
  return /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/i.test(text);
}

/**
 * Returns a hardFail reason string if the joined group promises to
 * send a link / URL / application but no URL is actually present.
 * Returns null if the group is fine (URL present, or no promise).
 *
 * Past-tense references ("I sent you the link earlier") do NOT match
 * because LINK_PROMISE_PATTERNS require present/future tense verbs.
 *
 * Multi-bubble safe: evaluates the JOINED group text. If bubble 0
 * promises and bubble 1 contains the URL, no fire — the URL IS in
 * the turn, just in a later bubble.
 */
function checkLinkPromiseWithoutUrl(joinedText: string): string | null {
  if (containsUrl(joinedText)) return null;
  for (const pat of LINK_PROMISE_PATTERNS) {
    const m = joinedText.match(pat);
    if (m) {
      return `link_promise_without_url: matched "${m[0]}" — reply announces sending a link but the URL is missing from the group. The lead is left waiting. Every link-promise reply MUST include the actual URL (from the script's Available Links & URLs section) in the same turn.`;
    }
  }
  return null;
}

export interface GroupQualityResult {
  /** Worst (minimum) per-bubble score. */
  score: number;
  /** All bubbles passed individually AND group-level checks passed. */
  passed: boolean;
  /** All hard-fail reasons, prefixed with [bubble=N] for per-bubble issues. */
  hardFails: string[];
  /** Per-bubble soft signals, flattened. */
  softSignals: Record<string, number>;
  /** Per-bubble individual results — useful for tests / diagnostics. */
  perBubble: QualityResult[];
}

export function scoreVoiceQualityGroup(
  messages: string[],
  options?: VoiceQualityOptions
): GroupQualityResult {
  if (messages.length === 0) {
    return {
      score: 0,
      passed: false,
      hardFails: ['empty_group: messages array is empty'],
      softSignals: {},
      perBubble: []
    };
  }

  // Hard fails: per-bubble. A banned phrase anywhere fails the group.
  // Exception: cliffhanger_preamble ("I'll explain", "lemme break it
  // down", etc.) in a non-final bubble is fine when a follow-on bubble
  // fulfills the promise in the same turn — that's the whole point of
  // splitting. Suppress that specific failure when the bubble isn't
  // last. On the FINAL bubble, cliffhanger still fires (the turn would
  // genuinely stall).
  const perBubble: QualityResult[] = messages.map((bubble) =>
    scoreVoiceQuality(bubble, options)
  );
  const lastIndex = messages.length - 1;
  const hardFails: string[] = [];
  perBubble.forEach((r, i) => {
    for (const failure of r.hardFails) {
      if (i !== lastIndex && failure.startsWith('cliffhanger_preamble:')) {
        continue; // follow-on bubble fulfills this — legit split
      }
      // Brian Dycey 2026-04-27 — same suppression pattern for the
      // incomplete-response hard fail. A short ack-only bubble is
      // fine when a follow-on bubble carries the forward-moving
      // question. The JOINED group check below catches the case
      // where the ENTIRE turn lacks a question.
      if (
        i !== lastIndex &&
        failure.startsWith('incomplete_response_acknowledgment_only:')
      ) {
        continue;
      }
      hardFails.push(`[bubble=${i}] ${failure}`);
    }
  });

  // Group-level ack-only check on the concatenated string — catches the
  // "yo bro caught the story 💪🏿" stall without false-firing on legit
  // multi-bubble splits where bubble 1 carries the question.
  const joined = messages.join(' ');
  const requiredMessagesForGate = Array.isArray(
    options?.activeBranchRequiredMessages
  )
    ? options.activeBranchRequiredMessages
    : (options?.currentStepRequiredMessages ?? []);
  const msgViolation =
    requiredMessagesForGate.length > 0
      ? detectMsgVerbatimViolation(joined, requiredMessagesForGate)
      : null;
  if (msgViolation) {
    console.warn(
      `[voice-quality-gate] msg_verbatim_violation: expected '${msgViolation.expected.slice(0, 50)}', got '${msgViolation.generated.slice(0, 50)}'`
    );
    hardFails.push(
      `[group] msg_verbatim_violation: expected="${msgViolation.expected.slice(0, 160)}" overlap=${msgViolation.overlap.toFixed(2)}`
    );
  }
  const msgSequenceViolation =
    !msgViolation && requiredMessagesForGate.length > 1
      ? detectMsgBubbleSequenceViolation(messages, requiredMessagesForGate)
      : null;
  if (msgSequenceViolation) {
    console.warn(
      `[voice-quality-gate] msg_verbatim_violation: expected separate bubble '${msgSequenceViolation.expected.slice(0, 50)}', got '${msgSequenceViolation.generated.slice(0, 50)}'`
    );
    hardFails.push(
      `[group] msg_verbatim_violation: required_message_not_in_separate_bubble expected="${msgSequenceViolation.expected.slice(0, 160)}" overlap=${msgSequenceViolation.overlap.toFixed(2)}`
    );
  }

  const ackFailure = checkCtaAckOnlyTruncation(joined);
  if (ackFailure) {
    hardFails.push(`[group] ${ackFailure}`);
  }

  // Group-level link-promise check (Shishir 2026-04-20 incident).
  // Evaluates the joined group so a multi-bubble turn where the URL
  // is in bubble 1 and the announcement is in bubble 0 doesn't fire.
  const linkPromiseFailure = checkLinkPromiseWithoutUrl(joined);
  if (linkPromiseFailure) {
    hardFails.push(`[group] ${linkPromiseFailure}`);
  }

  // R37 burst extension (Jefferson @namejeffe 2026-05-03).
  // Group-level: fires when the lead sent ≥ 2 consecutive messages
  // (since the last AI/HUMAN turn) AND any of them contains a question
  // or reflective/emotional content AND the joined reply addresses
  // none of it (no topic match, no emotional acknowledgment).
  // Single-message lead turns flow through the existing
  // `ignored_personal_question` soft signal at line ~1869 unchanged.
  const r37Burst = getUnacknowledgedLeadBurst(options?.conversationHistory);
  if (
    r37Burst.messages.length >= 2 &&
    (r37Burst.hasQuestion || r37Burst.hasReflectiveContent)
  ) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const det =
      require('./conversation-detail-extractor') as typeof import('./conversation-detail-extractor');
    const burstText = r37Burst.messages.map((m) => m.content).join(' ');
    const details = det.extractSpecificDetails(burstText);
    const replyLower = joined.toLowerCase();
    const topicAck =
      details.length > 0 &&
      details.some((d) => {
        const tok = String(d.token || '').trim();
        if (tok.length === 0) return false;
        return new RegExp(
          `\\b${escapeRegExpChars(tok.toLowerCase())}\\b`,
          'i'
        ).test(replyLower);
      });
    if (!topicAck && !acknowledgesEmotionally(joined)) {
      hardFails.push(
        `[group] r37_burst_ignored: size=${r37Burst.messages.length} hasQ=${r37Burst.hasQuestion} hasReflect=${r37Burst.hasReflectiveContent}`
      );
    }
  }

  // R37 acceptance-loopback extension. Strongest possible signal:
  // lead said yes to an offer the AI just made, and the AI's reply
  // is a question instead of the promised artifact. Three conditions
  // required, all together — keeps the gate from false-firing on
  // bare-yes answers to qualification questions.
  //
  // Source signals:
  //   - Most recent LEAD message is an explicit acceptance phrase.
  //   - Most recent AI message before that promised an artifact
  //     (link, call, booking, resource).
  //   - The current reply does NOT deliver the artifact (no URL, no
  //     booking confirmation language).
  if (
    options?.previousLeadMessage &&
    options?.previousAIMessage &&
    isExplicitAcceptance(options.previousLeadMessage) &&
    aiPromisedArtifact(options.previousAIMessage) &&
    !replyDeliversArtifact(joined)
  ) {
    hardFails.push(
      `[group] r37_acceptance_loopback: lead accepted prior offer ("${options.previousLeadMessage.trim().slice(0, 40)}") but reply re-asks instead of delivering`
    );
  }

  if (
    shouldBlockManyChatEarlyCapitalQuestion(joined, options) &&
    !hardFails.some((f) => f.includes('manychat_early_capital_question:'))
  ) {
    hardFails.push(`[group] ${MANYCHAT_EARLY_CAPITAL_HARDFAIL}`);
  }

  // Multi-bubble safety: call-pitch language can be split across bubbles
  // (closer name in one, "quick call" in the next). The per-bubble pass
  // catches most cases; the joined turn catches cross-bubble phrasing.
  if (
    options?.capitalVerificationRequired === true &&
    options.capitalVerificationSatisfied !== true &&
    containsCallPitch(joined) &&
    !hardFails.some((f) =>
      f.includes('call_pitch_before_capital_verification:')
    )
  ) {
    hardFails.push(
      '[group] call_pitch_before_capital_verification: call pitch detected before the capital question has been asked and answered'
    );
  }

  // R40 hard-fail (@shepherdgushe.zw 2026-05-05). Lead is BELOW the
  // capital threshold (capitalThresholdMet=false) AND has affirmed
  // downsell interest (downsellInterestConfirmed=true). The next AI
  // move MUST be deliver-the-course-URL, not pitch-the-call. Calls
  // are reserved for QUALIFIED leads only — pitching one to a lead
  // who's already been LOW_TICKET-routed loops them back into the
  // qualified-lead pipeline they don't belong in. See R40 in
  // ai-prompts.ts for the full rule + production incident.
  const r40Dp = options?.capturedDataPoints as
    | Record<string, { value?: unknown } | undefined>
    | undefined;
  const r40CapitalThresholdMet = r40Dp?.capitalThresholdMet?.value;
  const r40DownsellInterestConfirmed = r40Dp?.downsellInterestConfirmed?.value;
  if (
    r40CapitalThresholdMet === false &&
    r40DownsellInterestConfirmed === true &&
    (containsCallPitch(joined) || containsCallOrBookingAdvancement(joined)) &&
    !hardFails.some((f) =>
      f.includes('r40_call_pitch_to_unqualified_after_downsell_accept:')
    )
  ) {
    hardFails.push(
      '[group] r40_call_pitch_to_unqualified_after_downsell_accept: lead is below the capital threshold AND already affirmed the downsell. The next move is to deliver the downsell URL, not pitch the call. Calls are for QUALIFIED leads only.'
    );
  }

  // R40 second arm: downsell accepted but reply contains no URL.
  // The call-pitch arm above catches "wrong action"; this arm catches
  // "no action" — AI acknowledged acceptance but never dropped the link.
  if (
    r40CapitalThresholdMet === false &&
    r40DownsellInterestConfirmed === true &&
    !/https?:\/\//.test(joined) &&
    !hardFails.some((f) => f.includes('r40_downsell_accepted_missing_url:'))
  ) {
    hardFails.push(
      '[group] r40_downsell_accepted_missing_url: lead confirmed downsell interest but reply contains no URL. The ONLY valid next action is to deliver the downsell course URL inline.'
    );
  }

  if (
    leadGaveLongTimeline(options?.previousLeadMessage) &&
    containsCallOrBookingAdvancement(joined) &&
    !hardFails.some((f) => f.includes('long_timeline_call_pitch:'))
  ) {
    hardFails.push(
      '[group] long_timeline_call_pitch: lead gave a 2+ year timeline. Do NOT pitch the call yet. First ask what is holding it to 2-3 years and whether it is capital or wanting to learn first.'
    );
  }

  const generatedContainsCallLogistics = containsCallLogisticsContent(joined);
  if (
    generatedContainsCallLogistics &&
    options?.callLogisticsAlreadyDelivered === true
  ) {
    hardFails.push(
      '[group] r30_logistics_redelivery: call logistics were already delivered by AI or a human setter in recent history. Do not repeat quiet-spot, prep, day, or time reminders.'
    );
  }
  if (
    generatedContainsCallLogistics &&
    options?.lastLeadMessageWasAcknowledgmentOnly === true
  ) {
    hardFails.push(
      '[group] r30_logistics_after_acknowledgment: lead just acknowledged with a short reply. Respond with a brief closer only, no reminders or logistics.'
    );
  }

  // Voice quality score: evaluate the JOINED turn, NOT per-bubble.
  // Per-bubble scoring is too strict — a legitimate split like
  // ["yo bro caught the story 💪🏿", "what got you into trading?"] has
  // a pure-question bubble 1 with no Daniel vocab that scores below
  // the 0.7 threshold on its own, even though the full turn reads
  // like Daniel. Scoring the concatenation preserves single-message
  // semantics for flag-off accounts (joined one-element array is the
  // same string) and handles the multi-bubble case correctly.
  const joinedQuality = scoreVoiceQuality(joined, options);
  const softSignals = joinedQuality.softSignals;
  const score = joinedQuality.score;
  const currentStructure = classifyMessageStructure(messages);
  const recentStructures = (options?.priorMessageStructures ?? []).slice(-4);
  const lastTwoStructures = recentStructures.slice(-2);
  const recentSameStructureCount = recentStructures.filter(
    (structure) => structure === currentStructure
  ).length;

  if (
    currentStructure !== 'other' &&
    ((lastTwoStructures.length >= 2 &&
      lastTwoStructures.every((structure) => structure === currentStructure)) ||
      recentSameStructureCount >= 2)
  ) {
    hardFails.push(
      `[group] repeated_message_structure: recent AI turns already overused ${currentStructure}. Vary your message structure — use a single bubble, a longer empathy split, a direct question, or a three-bubble react/dig/question turn instead of repeating the same shape.`
    );
  } else if (
    currentStructure !== 'other' &&
    lastTwoStructures[lastTwoStructures.length - 1] === currentStructure
  ) {
    softSignals.repeated_message_structure = -0.15;
  }

  return {
    score,
    // Pass iff no hard fails AND the joined turn clears the soft-score
    // threshold. joinedQuality.passed already encodes both its own
    // hardFails-empty and score>=0.7, but we've pulled hardFails out
    // to per-bubble tagging so recompute the soft-only gate here.
    passed: hardFails.length === 0 && score >= 0.7,
    hardFails,
    softSignals,
    perBubble
  };
}
