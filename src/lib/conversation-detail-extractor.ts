// ---------------------------------------------------------------------------
// conversation-detail-extractor.ts
// ---------------------------------------------------------------------------
// Pattern set + helpers for the Omar Moore 2026-04-27 bot-detection fixes.
//
// Two failure modes we're guarding against:
//
//   (1) AI ignores personal questions ("hbu", "what about you",
//       "what's your favorite prop") and pivots straight to its
//       next qualification question. A human never ignores "how
//       about you". Dodging it twice in a conversation is the
//       clearest bot tell possible.
//
//   (2) AI runs a scripted-feeling sequence of 3-6 qualification
//       questions back-to-back, never referencing the specific
//       details the lead shared (named prop firms, instruments,
//       strategies, personal context). The pattern becomes
//       detectable after 3-4 in a row.
//
// The patterns + helpers below feed:
//   - voice-quality-gate.ts (soft signals: ignored_personal_question,
//     scripted_question_sequence, generic_acknowledgment)
//   - ai-engine.ts (extraction + count of inputs to pass into the gate)
//   - tests (each pattern set independently testable)
// ---------------------------------------------------------------------------

/**
 * LEAD message patterns that signal a personal question directed at
 * the AI / Daniel ("how about you", "what's your favorite prop",
 * "have you ever blown an account"). Case-insensitive.
 */
export const PERSONAL_QUESTION_PATTERNS: RegExp[] = [
  // Direct turn-around openers
  /\b(hbu|h\.?b\.?u\.?)\b/i,
  /\bhow\s+(about|bout)\s+you\b/i,
  /\bwhat\s+(about|bout)\s+you\b/i,
  /\band\s+you\??$/i,
  /\byou\??$/i, // bare "?" or "you?" tail (caught conservatively, see logic)
  // "your <opinion noun>" — favourite, take, opinion, experience
  /\byour\s+(favorite|favourite|fav|thoughts|opinion|take|experience)\b/i,
  // "how long have you been trading" / "how long you been at it"
  /\bhow\s+long\s+(have\s+you\s+|you\s+)?(been|traded|trading|trade)\b/i,
  // "what pairs / what do you trade / what broker / what prop"
  /\bwhat\s+(pairs?|broker|prop|firm|strategy|instruments?)\b/i,
  /\bwhat\s+do\s+you\s+(trade|use|prefer|recommend|like)\b/i,
  // "have you ever / have you blown / have you passed"
  /\bhave\s+you\s+(ever|blown|passed|failed|tried|used)\b/i,
  // "do you trade / do you use / do you prefer"
  /\bdo\s+you\s+(trade|use|prefer|recommend|like|run|follow)\b/i
];

export interface PersonalQuestionResult {
  detected: boolean;
  match: string | null;
}

/**
 * Stateless: returns whether the input message contains a personal
 * question shape. Caller is responsible for gating on "this was the
 * LEAD's previous turn", not just any message.
 */
export function detectPersonalQuestion(text: string): PersonalQuestionResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { detected: false, match: null };
  }
  // Skip the bare-"you?" pattern unless the message is actually short
  // and ends with a question mark — otherwise "what do you do?" would
  // false-fire as a personal question.
  const trimmed = text.trim();
  for (const pat of PERSONAL_QUESTION_PATTERNS) {
    const m = trimmed.match(pat);
    if (!m) continue;
    if (pat.source === '\\byou\\??$' && trimmed.length > 30) {
      // Long messages ending in "you?" are usually about the lead's
      // own situation, not a turn-around. Skip the false-positive.
      continue;
    }
    return { detected: true, match: m[0] };
  }
  return { detected: false, match: null };
}

/**
 * First-person tokens that, when present in the AI reply, count as
 * the AI actually answering with a personal disclosure. Used by the
 * `ignored_personal_question` gate.
 */
const FIRST_PERSON_TOKEN_RE =
  /\b(i|i'?m|im|i'?ve|ive|i'?ll|my|me|mine|myself)\b/i;

/**
 * Subject-dropped first-person openers — Daniel's voice frequently
 * drops "I" at the start of personal disclosures ("been at it for a
 * few years", "lost a lot before it clicked", "got into trading", "started in college").
 * These are still first-person answers and should NOT trip the
 * ignored-personal-question gate. Matches the START of a sentence
 * (after optional whitespace / leading filler).
 */
const IMPLICIT_FIRST_PERSON_OPENER_RE =
  /(^|[.!?\n]\s*)(been\s+(at|trading|doing|in|grinding|studying|running)|lost\s+(a\s+lot|everything|my|so\s+much)|got\s+(into|started|funded|my|tired)|started\s+(trading|out|with|in)|trading\s+for\s+\d|stayed\s+(consistent|focused|in)|grinded\s+|grinding\s+(this|for|my)|been\s+\d+\s*(years?|months?))/i;

export function replyContainsFirstPerson(reply: string): boolean {
  if (typeof reply !== 'string') return false;
  return (
    FIRST_PERSON_TOKEN_RE.test(reply) ||
    IMPLICIT_FIRST_PERSON_OPENER_RE.test(reply)
  );
}

// ---------------------------------------------------------------------------
// Specific-detail extraction (lead-side)
// ---------------------------------------------------------------------------
// What the AI must reference to pass the scripted_question_sequence
// gate. Each category has tokens that, when present in a lead's
// message, become "facts the AI must show it heard". When the AI
// asks 3+ questions in a row without any of these tokens echoing
// back, we soft-fail.
//
// Tokens are matched case-insensitively. Broker / prop-firm / strategy
// names are taken from Daniel's actual production conversations as of
// 2026-04. List can be extended without breaking the API.

const PROP_FIRM_NAMES: RegExp[] = [
  /\bAlpha(\s+(Capital|Futures|Trading|Funded))?\b/i,
  /\bTopStep\b/i,
  /\bLucid(\s+(Trading|Capital|Funding))?\b/i,
  /\bFTMO\b/i,
  /\bMy\s+Forex\s+Funds\b/i,
  /\bApex(\s+Trader\s+Funding)?\b/i,
  /\bThe5ers\b/i,
  /\bE8(\s+Funding)?\b/i,
  /\bThe\s+Funded\s+Trader\b/i,
  /\bEarn2Trade\b/i,
  /\bFundedNext\b/i,
  /\bFidelcrest\b/i,
  /\bSurge(\s+Trader)?\b/i,
  /\bBlueberry(\s+Funded)?\b/i
];

const INSTRUMENTS: RegExp[] = [
  // Futures tickers
  /\b(ES|NQ|YM|RTY|MNQ|MES|MGC|GC|CL|MCL|BTC|ETH)\b/,
  // Common forex pairs (4-6 char uppercase or with slash)
  /\b(EUR\/?USD|GBP\/?USD|USD\/?JPY|AUD\/?USD|USD\/?CAD|NZD\/?USD|EUR\/?GBP|EUR\/?JPY|GBP\/?JPY)\b/i,
  // Generic instrument words when capitalised mid-sentence
  /\b(Gold|Oil|Crude|Bitcoin|Ethereum|Indices|S&P|Nasdaq|Dow)\b/i,
  /\bgold\b/i,
  /\boil\b/i
];

const STRATEGIES: RegExp[] = [
  /\bAMD(\s+model|\s+pattern)?\b/i,
  /\bORB(\s+opening|\s+breakout)?\b/i,
  /\bICT\b/i,
  /\b(Smart\s+Money(\s+Concepts)?|SMC)\b/i,
  /\b(IFVG|FVG|Fair\s+Value\s+Gap)\b/i,
  /\b(Order\s+Block|OB)\b/i,
  /\b(Liquidity(\s+Grab|\s+Sweep)?|Stop\s+Hunt)\b/i,
  /\b(Supply(\s+and\s+Demand)?|Demand\s+Zone|Supply\s+Zone)\b/i,
  /\b(Wyckoff|Elliott\s+Wave|Fibonacci|Fib)\b/i,
  /\b(Break\s+of\s+Structure|BOS|MSS|CHoCH)\b/i
];

const PERSONAL_EXPERIENCES: RegExp[] = [
  /\b(blew|blow)\s+(up\s+)?(my|the|an)?\s*account\b/i,
  /\b(passed|failed)\s+(the\s+)?(eval|evaluation|challenge)\b/i,
  /\bgot\s+funded\b/i,
  /\bpayout\b/i,
  /\bstop[\s-]?loss(\s+hunting)?\b/i,
  /\b(been|trading)\s+for\s+(\d+|a\s+few|several|many)\s+(years?|months?|weeks?)\b/i,
  /\bself[\s-]?taught\b/i,
  /\bbacktest(ing|ed)?\b/i
];

const FAITH_FAMILY_CONTEXT: RegExp[] = [
  // Faith
  /\b(God|Jesus|Christ|Bible|faith|prayer|blessed|grateful)\b/i,
  // Family
  /\b(wife|husband|kid|kids|children|son|daughter|family|parents?|mom|dad|mother|father|fianc(é|e|ée|ee)|wedding|married|getting\s+married)\b/i,
  // Life context
  /\b(retire|retirement|side\s+stream|day\s+job|9[\s-]?to[\s-]?5|quit\s+(my\s+)?job|fired|laid\s+off)\b/i
];

const ALL_DETAIL_PATTERNS: Array<{
  category: string;
  patterns: RegExp[];
}> = [
  { category: 'prop_firm', patterns: PROP_FIRM_NAMES },
  { category: 'instrument', patterns: INSTRUMENTS },
  { category: 'strategy', patterns: STRATEGIES },
  { category: 'experience', patterns: PERSONAL_EXPERIENCES },
  { category: 'context', patterns: FAITH_FAMILY_CONTEXT }
];

export interface SpecificDetail {
  category: string;
  /** The exact substring matched in the lead message. */
  token: string;
}

/**
 * Pull all specific details from a single lead message. Returns an
 * array of {category, token} so the caller can tell what KIND of
 * detail it is (for logging) AND has the exact substring to
 * acknowledge.
 */
export function extractSpecificDetails(text: string): SpecificDetail[] {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  const out: SpecificDetail[] = [];
  for (const { category, patterns } of ALL_DETAIL_PATTERNS) {
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) {
        out.push({ category, token: m[0] });
      }
    }
  }
  return out;
}

/**
 * Aggregate specific details across a window of recent lead messages
 * (typically the last 2). Caller passes the window; we return a
 * deduped flat list.
 */
export function extractRecentLeadDetails(
  leadMessages: Array<{ content: string }>
): SpecificDetail[] {
  const seen = new Set<string>();
  const out: SpecificDetail[] = [];
  for (const m of leadMessages) {
    for (const d of extractSpecificDetails(m.content || '')) {
      const key = `${d.category}:${d.token.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

/**
 * True if the AI reply's content references at least one of the
 * supplied lead-side specific details. Match is substring +
 * case-insensitive — partial matches like "lucid" inside the AI's
 * "lucid is interesting" satisfy "Lucid Trading" from the lead.
 */
export function replyAcknowledgesSpecificDetail(
  reply: string,
  details: SpecificDetail[]
): boolean {
  if (!reply || details.length === 0) return false;
  const lower = reply.toLowerCase();
  for (const d of details) {
    if (lower.includes(d.token.toLowerCase())) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pure-question detection
// ---------------------------------------------------------------------------
// A "pure question" is an AI message that ends with a question mark
// AND does not reference a specific detail from the most recent lead
// messages. Stacking 3+ pure-questions in a row is the scripted-
// sequence pattern.

/**
 * True if the AI message looks like a pure question with no specific
 * acknowledgment of `recentDetails`. Used to count consecutive
 * pure-question turns.
 */
export function isPureQuestion(
  aiMessage: string,
  recentDetails: SpecificDetail[]
): boolean {
  if (!aiMessage || typeof aiMessage !== 'string') return false;
  const trimmed = aiMessage.trim();
  if (!trimmed.endsWith('?')) return false;
  return !replyAcknowledgesSpecificDetail(trimmed, recentDetails);
}

/**
 * Count the trailing run of consecutive pure-question AI messages.
 * Caller passes the AI message history (oldest → newest). The count
 * is the size of the suffix that matches `isPureQuestion`. Once a
 * non-pure-question is encountered, the count stops.
 */
export function countConsecutivePureQuestions(
  aiMessages: Array<{ content: string }>,
  recentDetails: SpecificDetail[]
): number {
  let count = 0;
  for (let i = aiMessages.length - 1; i >= 0; i--) {
    if (isPureQuestion(aiMessages[i].content, recentDetails)) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Generic acknowledgment detection
// ---------------------------------------------------------------------------
// "love that bro" / "love that bro big moves" / similar empty
// acknowledgments. Fires only when the ENTIRE reply (or first
// sentence) is one of these — combined with specific content the
// phrase is fine.

/**
 * Returns true when the reply is JUST a generic acknowledgment with
 * no specific content. Examples:
 *   "love that bro"
 *   "love that bro, big moves"
 *   "love that bro big moves."
 * The fenced ^ and $ make this match the entire reply only.
 */
const GENERIC_ACK_RE =
  /^(love\s+that\s+bro[,.]?\s*(big\s+moves\.?)?|that['']s\s+(solid|fire|sick|dope|huge|great)\.?|nice\s+bro\.?|bet\s+bro\.?|fasho\s+bro\.?|let'?s\s+goooo*\s+bro\.?|love\s+to\s+(see|hear)\s+(that|it)\s+bro[,.]?)\s*$/i;

export function isGenericAcknowledgmentOnly(reply: string): boolean {
  if (typeof reply !== 'string') return false;
  return GENERIC_ACK_RE.test(reply.trim());
}
