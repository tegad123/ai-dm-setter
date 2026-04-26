// ---------------------------------------------------------------------------
// cold-pitch-detector.ts
// ---------------------------------------------------------------------------
// Detect agency / SaaS / SMMA cold-outreach DMs that are trying to sell TO
// Daniel rather than buy from him. Fires only on a NEW_LEAD's very first
// inbound message — once a real conversation is underway, a lead casually
// mentioning their agency background is fine.
//
// Driver incident: Omar 2026-04-25 sent a textbook agency cold pitch
// ("helped a coach go from 800 to 55K followers ... want me to send it
// over?"). The AI engaged with it, burning credits and dirtying the
// pipeline with a non-lead. Solution: regex-match the most common pitch
// shapes pre-LLM, mark the conversation as SPAM + tag it 'cold-pitch',
// skip generation. No credits burned, no response sent, ops can review
// the bucket if they want to.
// ---------------------------------------------------------------------------

/**
 * Regex set covering the SMMA / agency-pitch surface area. Designed to
 * minimise false positives on legitimate qualified leads who happen to
 * mention numbers or content. Each pattern documents its target shape.
 *
 * Note: written multi-line for readability — the test runner uses these
 * verbatim, so any changes here are picked up by the test fixtures.
 */
export const COLD_PITCH_PATTERNS: RegExp[] = [
  // (1) Social-media growth claims: "took/grew/scaled/helped … from X to
  // Yk followers" — classic agency case-study opener.
  /\b(helped|took|grew|scaled).{0,40}(from\s+\d+k?\s+to\s+\d+k?|\d+k?\s*(followers|subs|subscribers))\b/i,

  // (2) Revenue claims on behalf of a client: "generated $X for a coach /
  // brand / client".
  /\b(generated|made|produced|drove).{0,30}(\$\d+[km]?|\d+[km]?\s*dollars).{0,30}(for\s+(a\s+|my\s+|their\s+)?(client|coach|brand))\b/i,

  // (3) "Want me to send it over?" — universal pitch CTA.
  /\bwant\s+me\s+to\s+(send|share|show|drop|forward)\s+(it|you|that|the)?\b/i,

  // (4) "Quick video / case study / loom / breakdown" pitch deliverable.
  /\b(put\s+together|made|created|recorded).{0,30}(quick\s+|short\s+)?(video|case\s+study|breakdown|demo|loom|walkthrough)\b/i,

  // (5) Volume claim: "helped 12 coaches / brands / businesses / clients".
  /\bhelped\s+\d+\s+(coaches?|brands?|businesses?|clients?)\b/i,

  // (6) "Our system/method/strategy/framework/process has helped …" —
  // SMMA template opener.
  /\bour\s+(system|method|strategy|framework|process)\s+(has\s+)?helped\b/i,

  // (7) "Are you open to a chat / call / discuss / explore" — cold
  // outreach close.
  /\bare\s+you\s+open\s+to.{0,50}(chat|call|talk|discuss|explore|see\s+how)\b/i
];

export interface ColdPitchResult {
  detected: boolean;
  /** Index into COLD_PITCH_PATTERNS — useful for telemetry. */
  patternIndex: number | null;
  /** The substring that matched. */
  match: string | null;
}

/**
 * Pure pattern check on an inbound message text. Stateless — gating on
 * "first message of a NEW_LEAD" is the caller's responsibility.
 */
export function detectColdPitch(text: string): ColdPitchResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { detected: false, patternIndex: null, match: null };
  }
  for (let i = 0; i < COLD_PITCH_PATTERNS.length; i++) {
    const m = text.match(COLD_PITCH_PATTERNS[i]);
    if (m) {
      return { detected: true, patternIndex: i, match: m[0] };
    }
  }
  return { detected: false, patternIndex: null, match: null };
}

/**
 * Tag name applied to leads detected as cold pitches. Centralised so the
 * conversations-list filter, leads-today metric, and any future audit
 * scripts all reference the same string.
 */
export const COLD_PITCH_TAG_NAME = 'cold-pitch';
