// ---------------------------------------------------------------------------
// conversation-facts.ts
// ---------------------------------------------------------------------------
// Long-conversation context preservation. When a conversation grows past
// ~20 messages, LLMs (even ones with large context windows) start to lose
// track of facts buried in the middle — the classic "lost in the middle"
// failure mode. Result: AI re-asks questions the lead already answered.
//
// Driver incident: Rodrigo Moran 2026-04-26 (daetradez Facebook).
// 68-message conversation. Lead answered "I'm a heavy equipment operator"
// at message 16, "5 years" at message 18. Two hours later (message 60+)
// the AI asked both questions again, the lead caught it: "I think your
// bot is stuck doing a loop".
//
// Fix: scan the LEAD-side history for a small set of high-leverage
// facts (work, income current, income goal, capital, timeline,
// experience), produce a tight bulleted block, and prepend it to the
// system prompt. The LLM sees it FIRST every turn — it can't miss
// something that's at the top of every prompt.
//
// All extractors are best-effort regex. False positives are acceptable
// (the lead doesn't suffer if we list "extra" facts they didn't quite
// say); false negatives degrade to the pre-fix behaviour. We intentionally
// don't summarise via an LLM — that would burn cost on every long
// conversation and add a fail mode for marginal value.
// ---------------------------------------------------------------------------

export interface EstablishedFacts {
  /** Job/profession from "I work at X", "I'm a Y", etc. */
  work: string | null;
  /** Years of experience in current role / trading. */
  experienceYears: string | null;
  /** Current income (dollars/period if stated). */
  incomeCurrent: string | null;
  /** Income goal from trading. */
  incomeGoal: string | null;
  /** Capital amount available / available-after-something. */
  capital: string | null;
  /** Lead-stated timeline / blockers ("after wedding in 3 weeks"). */
  timeline: string | null;
  /** First name if obvious from a self-intro. */
  name: string | null;
}

const EMPTY: EstablishedFacts = {
  work: null,
  experienceYears: null,
  incomeCurrent: null,
  incomeGoal: null,
  capital: null,
  timeline: null,
  name: null
};

/**
 * Extract a sentence/short phrase that follows a regex match. Used to
 * pull the "noun phrase after the verb" out of free-form lead replies
 * without a true NLP parser. Trims to a max of `maxChars` so a long
 * lead message doesn't dump a paragraph into the facts block.
 */
function clean(
  value: string | null | undefined,
  maxChars = 120
): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return null;
  return trimmed.length > maxChars
    ? trimmed.slice(0, maxChars).trim() + '…'
    : trimmed;
}

const WORK_PATTERNS: RegExp[] = [
  // "I'm a heavy equipment operator" / "im a software engineer"
  /\bi'?m\s+a\s+([a-z][a-z\s/'-]{2,60}?)(?=[.!?\n,;]|$)/i,
  // "I work at/as/in <X>"
  /\bi\s+work\s+(?:at|as|in)\s+(?:an?\s+)?([a-z][a-z\s/'-]{2,60}?)(?=[.!?\n,;]|$)/i,
  // "I do <X> for work / for a living"
  /\bi\s+do\s+([a-z][a-z\s/'-]{2,60}?)\s+for\s+(?:work|a\s+living)\b/i,
  // "I'm in <X>" — only for known job-like nouns to avoid "I'm in trading mode"
  /\bi'?m\s+in\s+(real\s+estate|sales|construction|finance|tech|software|marketing|insurance|hospitality|healthcare|engineering|education|the\s+military|the\s+army|the\s+navy|the\s+air\s+force|law\s+enforcement|trades?)\b/i,
  // "I run <X>" — common entrepreneur opener
  /\bi\s+run\s+a\s+([a-z][a-z\s/'-]{2,60}?)(?=[.!?\n,;]|$)/i
];

const YEARS_PATTERNS: RegExp[] = [
  // "5 years" / "for 3 years" / "about 4 years now"
  /\b(?:for\s+|about\s+|been\s+(?:doing\s+(?:it|that|this)\s+)?(?:for\s+)?)?(\d+(?:\.\d+)?)\s+(?:years?|yrs?|yr)\b/i,
  // "5 yesrs" (typo Rodrigo actually used)
  /\b(\d+(?:\.\d+)?)\s+yesrs?\b/i
];

const INCOME_GOAL_PATTERNS: RegExp[] = [
  // "1200 a week" / "$1200/week" / "1200 USD a month" / "5k/month"
  /(?:make|earn|need(?:s|ing)?|making|hit|target|trying\s+to\s+(?:make|earn|hit)|aim(?:ing)?\s+for)[\s\w]*?(?:\$|usd\s*|£\s*)?(\d+(?:[,.]\d+)?)\s*(?:k)?\s*(?:\/|per|a\s+|each\s+)?\s*(week|month|year|day|hr|hour)\b/i,
  // "clear at least 1200 a week"
  /\b(?:clear|net|pull|bring(?:ing)?|hit)\s+(?:at\s+least\s+)?(?:\$|usd\s*|£\s*)?(\d+(?:[,.]\d+)?)\s*(?:k)?\s*(?:\/|per|a\s+|each\s+)?\s*(week|month|year|day|hr|hour)\b/i
];

const CAPITAL_PATTERNS: RegExp[] = [
  // "I have 1k", "got $1,000 saved", "I can put aside £800"
  /\b(?:i\s+have|i'?ve\s+(?:got|saved)|got|i\s+can\s+(?:put|set)\s+aside|i\s+can\s+(?:come\s+up\s+with|do))\s+(?:about\s+|around\s+|at\s+least\s+)?(?:\$|usd\s*|£\s*)?(\d+(?:[,.]\d+)?)\s*(k|thousand)?\b(?:[\s\w]{0,30}?(?:saved|set\s+aside|capital|to\s+start|in\s+capital|ready))?/i,
  // "I can after my wedding" — softer, captured as raw timeline anchor
  /\b(?:after\s+(?:my\s+)?(?:wedding|paycheck|next\s+(?:month|week)|tax\s+return)|when\s+i\s+(?:get\s+paid|sell|finish))\b/i
];

const TIMELINE_PATTERNS: RegExp[] = [
  // "in 3 weeks", "next month", "after my wedding", "by june"
  /\b(?:in\s+\d+\s+(?:weeks?|months?|days?)|after\s+(?:my\s+)?(?:wedding|trip|move|paycheck|tax\s+return|bonus|interview)|next\s+(?:week|month|paycheck|payday|quarter)|by\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|next\s+\w+)|getting\s+married\s+in\s+\d+\s+(?:weeks?|months?|days?))\b/i
];

const EXPERIENCE_PATTERNS: RegExp[] = [
  // "studying for X years", "trading for Y", "been at it Z"
  /\b(?:trading|studying|in\s+the\s+markets|been\s+at\s+(?:it|trading)|been\s+doing\s+(?:this|trading))[\s\w]*?(\d+(?:\.\d+)?)\s+(?:years?|months?|yrs?|yr|mo)\b/i
];

/**
 * Pull a small set of high-signal facts from the LEAD-side messages of
 * a conversation. Pure function — no DB. The caller is responsible for
 * filtering to LEAD messages before passing.
 *
 * Each fact field is set the FIRST time we match — we don't try to
 * track corrections ("actually I meant 3 years"). Daniel's voice gate
 * catches reply contradictions; this block is just preventing the
 * "ask question that was already answered" loop.
 */
export function extractEstablishedFacts(
  leadMessages: Array<{ content: string }>
): EstablishedFacts {
  const facts: EstablishedFacts = { ...EMPTY };
  for (const m of leadMessages) {
    const text = m.content;
    if (!text || typeof text !== 'string') continue;

    if (!facts.work) {
      for (const pat of WORK_PATTERNS) {
        const match = text.match(pat);
        if (match && match[1]) {
          facts.work = clean(match[1]);
          break;
        }
      }
    }
    if (!facts.experienceYears) {
      for (const pat of EXPERIENCE_PATTERNS) {
        const match = text.match(pat);
        if (match && match[1]) {
          facts.experienceYears = clean(match[0]);
          break;
        }
      }
      if (!facts.experienceYears) {
        for (const pat of YEARS_PATTERNS) {
          const match = text.match(pat);
          if (match) {
            facts.experienceYears = clean(match[0]);
            break;
          }
        }
      }
    }
    if (!facts.incomeGoal) {
      for (const pat of INCOME_GOAL_PATTERNS) {
        const match = text.match(pat);
        if (match) {
          facts.incomeGoal = clean(match[0]);
          break;
        }
      }
    }
    if (!facts.capital) {
      for (const pat of CAPITAL_PATTERNS) {
        const match = text.match(pat);
        if (match) {
          facts.capital = clean(match[0]);
          break;
        }
      }
    }
    if (!facts.timeline) {
      for (const pat of TIMELINE_PATTERNS) {
        const match = text.match(pat);
        if (match) {
          facts.timeline = clean(match[0]);
          break;
        }
      }
    }
    if (!facts.incomeCurrent) {
      // "I make $35.5/hour", "earning 3000 a month right now",
      // "I make $35.5 usd an hour" (Rodrigo's exact wording).
      // Allows an optional currency word between the number and the
      // time unit so "$35.5 usd an hour" parses cleanly.
      const m = text.match(
        /\b(?:i\s+(?:make|earn|am\s+(?:making|earning)))\s+(?:about\s+|around\s+)?(?:\$|usd\s*|£\s*)?(\d+(?:[,.]\d+)?)\s*(?:k)?\s*(?:usd\s+|gbp\s+|dollars?\s+|pounds?\s+)?(?:\/|per\s+|a\s+|an\s+)?\s*(?:hr|hour|week|month|year|day)\b/i
      );
      if (m) facts.incomeCurrent = clean(m[0]);
    }
  }
  return facts;
}

/**
 * Render a tight bullet block for the system prompt. Returns null if
 * no facts were extracted (no need to inject empty block). Caller
 * decides whether to emit based on conversation length + return value.
 */
export function buildEstablishedFactsBlock(
  facts: EstablishedFacts,
  leadName?: string | null
): string | null {
  const lines: string[] = [];
  if (leadName && leadName.trim().length > 0 && leadName.trim() !== 'User') {
    lines.push(`- Name: ${leadName.trim()}`);
  }
  if (facts.work) lines.push(`- Work: ${facts.work}`);
  if (facts.experienceYears)
    lines.push(`- Experience / tenure: ${facts.experienceYears}`);
  if (facts.incomeCurrent)
    lines.push(`- Current income: ${facts.incomeCurrent}`);
  if (facts.incomeGoal) lines.push(`- Income goal: ${facts.incomeGoal}`);
  if (facts.capital) lines.push(`- Capital: ${facts.capital}`);
  if (facts.timeline) lines.push(`- Timeline: ${facts.timeline}`);
  if (lines.length === 0) return null;
  return `## ESTABLISHED FACTS (DO NOT RE-ASK)
The lead has ALREADY answered these in this conversation. Do NOT ask them again — reference them naturally if relevant, but never re-ask.
${lines.join('\n')}
=====`;
}

// ---------------------------------------------------------------------------
// Capital-question repetition cap
// ---------------------------------------------------------------------------
// Bug 2 from the same Rodrigo incident: capital question asked at 3:47
// PM, asked again at 3:58 PM (11 min apart, within the same long
// conversation). The lead had answered the first one ("I can after my
// wedding") and the AI re-asked anyway. Pre-this-commit there was no
// hard cap — Souljah J's repeated_question soft signal only fires for
// CONSECUTIVE turns, not asks 11 minutes / 5 messages apart.
//
// Hard cap: AT MOST ONE prior capital-question ask in the AI history.
// On the SECOND ask attempt, the voice-quality-gate hard-fails. The
// retry directive tells the LLM the lead has already answered (or
// declined to answer) and to advance the conversation differently.

/**
 * Patterns used to identify a capital-verification question in any AI
 * message. Mirrors the patterns in checkR24Verification — kept in
 * sync because the same shape that COUNTS as an "ask" for R24's
 * downstream classification is the shape we cap here.
 */
const CAPITAL_QUESTION_PATTERNS: RegExp[] = [
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

/** True if `text` looks like a capital-verification question. */
export function looksLikeCapitalQuestion(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return CAPITAL_QUESTION_PATTERNS.some((p) => p.test(text));
}

/** Count how many AI messages in the history match a capital-question shape. */
export function countCapitalQuestionAsks(
  aiMessages: Array<{ content: string }>
): number {
  let n = 0;
  for (const m of aiMessages) {
    if (looksLikeCapitalQuestion(m.content)) n++;
  }
  return n;
}

/**
 * Patterns matching LEAD messages that implicitly signal "no capital
 * available" without a number. When ANY lead message in conversation
 * history matches one of these, the AI should NOT ask the threshold
 * question — the lead already answered. Mirrors a SUBSET of the
 * disqualifier patterns in `parseLeadCapitalAnswer` (ai-engine.ts),
 * specifically the "no money / no job / student / broke" family. The
 * "lost capital" / "need time to raise" / capital-access-issue
 * variants are also covered.
 */
const IMPLICIT_NO_CAPITAL_PATTERNS: RegExp[] = [
  // No money baseline
  /\b(broke|nothing\s+(really|man|bro)?|no\s+money|don'?t\s+have\s+(any\s+)?(money|capital|anything|much))\b/i,
  // Explicit capital blocker. "Capital and lack of knowledge" is a
  // capital answer, not an invitation to ask R24 again.
  /\bcapital\b.{0,30}\b(problem|issue|obstacle|holding|stopping|lack|don.?t have)\b/i,
  /\b(lack of|no)\s+capital\b/i,
  /\bdon'?t\s+have\s+(any\s+)?capital\b/i,
  /\bneed\s+(to\s+(get|raise|build)\s+)?capital\s+first\b/i,
  /\bcapital\b.{0,20}\bknowledge\b/i,
  // Student / school
  /\b(i'?m\s+(a\s+|currently\s+a\s+)?student|still\s+in\s+school|in\s+(college|university|highschool|high\s+school))\b/i,
  // No job
  /\b(jobless|unemployed|no\s+job|lost\s+my\s+job|between\s+jobs|laid\s+off|no\s+income|no\s+work|out\s+of\s+work)\b/i,
  // Can't afford basics
  /\b(can'?t\s+(eat|pay\s+rent|pay\s+bills|afford))\b/i,
  // "I have nothing" / "got nothing"
  /\b(i\s+(have|got)\s+nothing|got\s+nothing\s+(right\s+now|rn|atm|man|bro))\b/i,
  // "Need time to raise"
  /\b(need\s+(some\s+)?time\s+to\s+(raise|save|come\s+up\s+with)|gotta\s+(save|raise)\s+(up\s+)?first)\b/i,
  // Lost capital
  /\b(lost\s+(everything|it\s+all|my\s+money|all\s+my\s+(money|capital|savings)))\b/i
];

/**
 * Returns true when ANY message in `leadMessages` reads as the lead
 * self-declaring below the capital threshold without a number. Used
 * by the voice gate to hard-fail a threshold-confirming capital
 * question when the lead has already given an implicit-no answer.
 */
export function leadHasImplicitNoCapitalSignal(
  leadMessages: Array<{ content: string }>
): boolean {
  for (const m of leadMessages) {
    if (typeof m.content !== 'string' || m.content.trim().length === 0)
      continue;
    if (IMPLICIT_NO_CAPITAL_PATTERNS.some((p) => p.test(m.content))) {
      return true;
    }
  }
  return false;
}

/**
 * Count how many AI messages contain "real quick" anywhere — used by
 * the `overused_transition_phrase` soft signal in the voice gate.
 */
export function countRealQuickPhraseUsage(
  aiMessages: Array<{ content: string }>
): number {
  let n = 0;
  for (const m of aiMessages) {
    if (typeof m.content === 'string' && /\breal\s+quick\b/i.test(m.content)) {
      n++;
    }
  }
  return n;
}
