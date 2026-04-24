// ---------------------------------------------------------------------------
// distress-detector.ts
// ---------------------------------------------------------------------------
// Scans inbound lead messages for suicidal ideation, self-harm, and
// giving-up-on-life language. Triggered BEFORE any AI generation so the
// sales pipeline never produces a pitch in response to a person in crisis.
//
// Incident that drove this feature (daetradez, 2026-04-18):
//   Lead: "i want to give up on life itself. too many debts, phone is
//          always off, lonely as fuck"
//   AI:   "let's focus on turning this around for you. what would it
//          mean for you to start seeing success in trading?"
// Shipping a sales pitch in response to suicidal language is unacceptable
// regardless of any other product consideration. This module is the code-
// level enforcement.
//
// Policy: false positives are ACCEPTABLE (a lead who joked about "this
// market is killing me lol" gets the supportive path and the operator
// can re-enable). False negatives are NOT. Err on the side of caution.
//
// Scope: English patterns only for now. Multi-language support is
// future work — leads should not be at risk of missed detection because
// the codebase didn't ship enough patterns yet, so a non-English
// language detection layer should be added when we learn what patterns
// matter most in production.
// ---------------------------------------------------------------------------

/**
 * Three-tier scan model (revised 2026-04-24 after Uzualu Francis false
 * positive — a lead asking for trading help wrote "please help me" and
 * the old any-match-fires detector routed him into the 988 crisis path).
 *
 *   HARD       — a single match fires the gate. Direct ideation, suicide
 *                mention, self-harm, indirect ideation, giving-up-on-
 *                life, spiritual crisis, last-hope appeals, "darkest
 *                season" wording. All unambiguous enough on their own.
 *
 *   SOFT       — ambiguous distress register ("broken", "stressed up",
 *                "going through a lot"). Too common in normal trading-
 *                complaint language to fire alone. Requires a HELP_PLEA
 *                match in the same message to promote to a fire.
 *
 *   HELP_PLEA  — "please help me" / "kindly help me" / "help me bro".
 *                Standalone these are NOT distress — they're common
 *                sales-assistance phrasing. They only matter as a
 *                combiner with a SOFT signal, indicating the plea is
 *                about an emotional state rather than a strategy ask.
 *
 * Fire rule:
 *   HARD match                       → fire
 *   SOFT match AND HELP_PLEA match   → fire (label=combination)
 *   HELP_PLEA alone                  → do NOT fire
 *   SOFT alone                       → do NOT fire
 */

interface Signal {
  pattern: RegExp;
  label: string;
}

const HARD_PATTERNS: Signal[] = [
  {
    pattern:
      /\b(give\s+up\s+on\s+life|end\s+it\s+all|kill\s+myself|want\s+to\s+die|wanna\s+die|gonna\s+die|going\s+to\s+die|wish\s+i\s+(was|were)\s+dead|take\s+my\s+(own\s+)?life|end\s+my\s+life)\b/i,
    label: 'direct_ideation'
  },
  {
    pattern: /\b(suicide|suicidal)\b/i,
    label: 'suicide_mention'
  },
  {
    pattern: /\b(self[-\s]?harm|hurt(ing)?\s+myself|harm(ing)?\s+myself)\b/i,
    label: 'self_harm'
  },
  {
    pattern:
      /\b(rather\s+be\s+dead|better\s+off\s+dead|don'?t\s+want\s+to\s+(live|be\s+here)|tired\s+of\s+living|not\s+worth\s+living|no\s+reason\s+to\s+live|what'?s\s+the\s+point\s+of\s+living)\b/i,
    label: 'indirect_ideation'
  },
  {
    pattern:
      /\b(nothing\s+left\s+to\s+live\s+for|can'?t\s+go\s+on|done\s+with\s+life|no\s+point\s+(in\s+)?going\s+on)\b/i,
    label: 'giving_up'
  },
  // Spiritual crisis: "can't call on God", "don't know how to pray",
  // "lost my faith" are unambiguous enough to fire alone. The production
  // trigger (daetradez 2026-04-24) had a lead combining these with other
  // desperation — on their own they're still strong signals.
  {
    pattern:
      /\b(can'?t\s+call\s+on\s+god|don'?t\s+know\s+how\s+to\s+(pray|call\s+on\s+god)|lost\s+my\s+faith|lost\s+all\s+faith)\b/i,
    label: 'spiritual_crisis'
  },
  // Last-hope appeals: "you are my only hope", "you are my last chance".
  // Rarely false-positive in trading context.
  {
    pattern:
      /\b(i\s+believe\s+you\s+(can|are)\s+(be\s+)?the\s+light|you\s+are\s+my\s+(only\s+)?hope|you('?re|\s+are)\s+my\s+last\s+(hope|chance))\b/i,
    label: 'last_hope_appeal'
  },
  // "Darkest season/time/place/night" — strong enough to fire alone. The
  // extractor requires it to be modifying one of those nouns, so "my
  // darkest trade this year" still hits but is an acceptable false
  // positive given the weight of the phrase in distress register.
  {
    pattern: /\bdarkest\s+(season|time|place|moment|period|hour|day|night)\b/i,
    label: 'darkest_season'
  }
];

// SOFT signals — ambiguous distress register. Common in non-crisis
// trading complaints ("my system is broken", "been so stressed out
// these past weeks"). Require a HELP_PLEA combiner to promote to fire.
const SOFT_PATTERNS: Signal[] = [
  {
    pattern: /\b(broken(\s+down)?|stressed\s+(up|out))\b/i,
    label: 'emotional_breakdown'
  },
  {
    pattern:
      /\bgoing\s+through\s+(a\s+lot|it|my\s+darkest|so\s+much|hell|the\s+worst)\b/i,
    label: 'going_through'
  }
];

// HELP_PLEA — combiner signals. Common in normal sales-assistance
// context ("please help me with my strategy"). Do NOT fire alone. Only
// promote a SOFT match to a distress fire.
const HELP_PLEA_PATTERNS: Signal[] = [
  {
    pattern:
      /\b(kindly\s+help\s+me|please\s+help\s+me|help\s+me\s+(bro|sir|please|man|pls))\b/i,
    label: 'help_plea'
  }
];

export const DISTRESS_PATTERNS = [
  ...HARD_PATTERNS,
  ...SOFT_PATTERNS,
  ...HELP_PLEA_PATTERNS
];

export interface DistressDetectionResult {
  detected: boolean;
  /** Label of the first HARD pattern that fired, or `combination` when
   *  a SOFT + HELP_PLEA pairing promoted the detection. */
  label: string | null;
  /** Raw matched substring (for operator review / logging). For the
   *  `combination` label this is the SOFT match; the HELP_PLEA context
   *  is surfaced via `helpPleaMatch`. */
  match: string | null;
  /** Populated when label === 'combination': the HELP_PLEA that paired
   *  with the SOFT signal to trigger the fire. */
  helpPleaMatch?: string | null;
}

/**
 * Scan text for any distress signal. Pure function — no DB, no side
 * effects. Safe to call on every inbound lead message.
 *
 * Tiered fire logic:
 *   1. Any HARD pattern match → fire with that label.
 *   2. Otherwise, if ANY SOFT match AND ANY HELP_PLEA match exist in
 *      the same text, fire with label='combination' and record both
 *      the SOFT and HELP_PLEA substrings.
 *   3. HELP_PLEA alone → no fire. SOFT alone → no fire.
 *
 * Empty or whitespace-only input returns detected:false.
 */
export function detectDistress(text: string): DistressDetectionResult {
  if (typeof text !== 'string') {
    return { detected: false, label: null, match: null };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { detected: false, label: null, match: null };
  }

  // 1. HARD — any match fires alone.
  for (const { pattern, label } of HARD_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) {
      return { detected: true, label, match: m[0] };
    }
  }

  // 2. SOFT + HELP_PLEA combo — both must match the same message.
  let softMatch: { label: string; match: string } | null = null;
  for (const { pattern, label } of SOFT_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) {
      softMatch = { label, match: m[0] };
      break;
    }
  }
  if (softMatch) {
    for (const { pattern } of HELP_PLEA_PATTERNS) {
      const m = trimmed.match(pattern);
      if (m) {
        return {
          detected: true,
          label: `combination:${softMatch.label}`,
          match: softMatch.match,
          helpPleaMatch: m[0]
        };
      }
    }
  }

  // 3. HELP_PLEA alone or SOFT alone → no fire.
  return { detected: false, label: null, match: null };
}
