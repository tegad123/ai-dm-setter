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
 * Distress patterns. Each regex is a separate entry so we can log WHICH
 * phrase triggered the gate — useful for operator review and for
 * measuring false-positive rate over time.
 *
 * Ordered roughly by severity / specificity. Patterns cover:
 *   - Direct suicidal ideation ("kill myself", "end it all", "want to die")
 *   - Indirect ideation ("rather be dead", "better off dead", "what's the
 *     point of living")
 *   - Giving-up-on-life language ("give up on life", "nothing left to
 *     live", "tired of living", "done with life")
 *   - Self-harm ("self harm", "hurt myself")
 *
 * Case-insensitive on all. Spacing tolerant where phrases have common
 * variants ("self harm" / "self-harm", "god bless" / "godbless").
 */
export const DISTRESS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
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
    // Match "hurt/hurting myself", "harm/harming myself", "self-harm",
    // "self harm". Verb stem + ing handled by optional "ing" suffix.
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
  }
];

export interface DistressDetectionResult {
  detected: boolean;
  /** Label of the pattern that fired, or null if no match. */
  label: string | null;
  /** Raw matched substring (for operator review / logging). */
  match: string | null;
}

/**
 * Scan text for any distress signal. Pure function — no DB, no side
 * effects. Safe to call on every inbound lead message.
 *
 * Returns `{ detected: true, label, match }` on the first pattern hit.
 * Subsequent patterns are not evaluated — one signal is enough. Empty
 * or whitespace-only input returns `detected: false`.
 */
export function detectDistress(text: string): DistressDetectionResult {
  if (typeof text !== 'string') {
    return { detected: false, label: null, match: null };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { detected: false, label: null, match: null };
  }
  for (const { pattern, label } of DISTRESS_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) {
      return { detected: true, label, match: m[0] };
    }
  }
  return { detected: false, label: null, match: null };
}
