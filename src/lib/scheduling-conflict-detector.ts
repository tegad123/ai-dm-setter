// ---------------------------------------------------------------------------
// scheduling-conflict-detector.ts
// ---------------------------------------------------------------------------
// Detects when a lead with a filled Typeform (stage=CALL_PROPOSED) is
// expressing a scheduling conflict the AI can't resolve — no calendar
// access, no ability to rebook. Fires an URGENT escalation so a human
// can reach out and confirm a working time.
//
// Incident driving this (Cristian Caciora, daetradez 2026-04-24):
//   AI sends Typeform link → lead fills it → lead says "I can't make
//   the available times, I'm free Sunday" → AI has no way to book
//   Sunday, loops back to generic qualifying questions, lead goes cold.
// ---------------------------------------------------------------------------

/**
 * Patterns that signal a scheduling conflict. Case-insensitive. False
 * positives are acceptable here (operator reviews before reaching out);
 * false negatives are not (a missed conflict = a dead lead).
 *
 * Ordered by specificity so the matched substring gives the best hint
 * to the operator on what the lead actually said.
 */
export const SCHEDULING_CONFLICT_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
}> = [
  // Explicit inability to make the offered times
  {
    pattern:
      /\b(can'?t\s+(make\s+it|do\s+it|attend|make\s+that|make\s+those|do\s+that\s+time)|(those|the)\s+times?\s+(don'?t|won'?t|dont|wont)\s+work|none\s+of\s+(those|the)\s+times?\s+work|the\s+times?\s+offered\s+don'?t\s+work)\b/i,
    label: 'cannot_make_offered_times'
  },
  // Availability statements that hint at needing a different slot
  {
    pattern:
      /\b(not\s+available|i'?m\s+not\s+free|i'?m\s+busy\s+(on|that|next|this)|only\s+(free|available)\s+on)\b/i,
    label: 'availability_mismatch'
  },
  // "can we do X instead / what about X / move to X"
  {
    pattern:
      /\b(can\s+(we|you|i)\s+(do|make|schedule|move\s+it\s+to)\s+[a-z0-9:\s]+(instead|pls|please)?|what\s+about\s+[a-z]+(day|\s+morning|\s+afternoon|\s+evening|\s+night)?|any\s+way\s+we\s+can\s+move|move\s+(it|this)\s+to)\b/i,
    label: 'counter_proposal'
  },
  // "I can do X / I'm free on X / I'm available X"
  {
    pattern:
      /\b(i\s+can\s+do\s+([a-z]+day|tomorrow|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night|next\s+week|this\s+week)|i'?m\s+(free|available)\s+(on|this|next)|works?\s+for\s+me\s+(on|is))\b/i,
    label: 'stated_preference'
  },
  // Bare day mention when the stage is CALL_PROPOSED is itself a strong
  // signal. Intentionally narrow — only fires on weekday words appearing
  // as standalone tokens (not "Mondays I work out" casual talk).
  {
    pattern: /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
    label: 'day_mention'
  }
];

export interface SchedulingConflictResult {
  detected: boolean;
  label: string | null;
  match: string | null;
  /** The lead's stated preference, if one was extracted. Free-form. */
  preference: string | null;
}

/**
 * Scan a LEAD message for scheduling-conflict signals. Pure function —
 * no DB. Returns the first matching pattern's label + matched substring.
 *
 * `preference` is a best-effort extraction of the day/time the lead
 * offered instead (e.g. "Sunday", "Monday afternoon", "next week") so
 * the operator can confirm the alternative slot without re-reading the
 * thread.
 */
export function detectSchedulingConflict(
  text: string
): SchedulingConflictResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { detected: false, label: null, match: null, preference: null };
  }
  const trimmed = text.trim();

  for (const { pattern, label } of SCHEDULING_CONFLICT_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) {
      return {
        detected: true,
        label,
        match: m[0],
        preference: extractPreference(trimmed)
      };
    }
  }
  return { detected: false, label: null, match: null, preference: null };
}

/**
 * Best-effort pull of a day/time string from the lead's message. Returns
 * null when nothing parseable is present. Combines day + optional
 * time-of-day modifier ("monday afternoon", "sunday at 3pm").
 */
function extractPreference(text: string): string | null {
  const dayTimeRe =
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|next\s+week|this\s+week|weekend)(?:\s+(morning|afternoon|evening|night))?(?:\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?/i;
  const m = text.match(dayTimeRe);
  if (m) {
    return m[0].trim();
  }
  const bareTimeRe = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;
  const t = text.match(bareTimeRe);
  if (t) return t[0].trim();
  return null;
}
