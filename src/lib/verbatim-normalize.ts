// Shared verbatim-repeat normalization. Used by BOTH the generation-time
// voice-quality gate (verbatimRepeatGuard) and the ship-time re-validation in
// webhook-processor (which runs AFTER ship-time bubble mutations like the
// low-ticket link-strip). Keeping one implementation guarantees the two checks
// agree — a bubble that becomes a standalone verbatim repeat only after a
// ship-time strip must normalize identically to how the gate would have seen
// it. (Ali QA 2026-07-21: a duplicate-link strip left a verbatim CTA bubble
// that the generation-time gate never re-evaluated.)

export const VERBATIM_MIN_LEN = 20;

/** Lowercase, strip non-alphanumerics, collapse whitespace. */
export function normalizeForVerbatim(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns the normalized string that repeats a prior message verbatim, or
 * null. `candidateText` is checked whole AND line-by-line (multi-bubble
 * replies are newline-joined). Only strings ≥ VERBATIM_MIN_LEN count, so
 * short acks ("got it", "bet bro") never trip it.
 */
export function findVerbatimRepeat(
  candidateText: string,
  priorTexts: Array<string | null | undefined>
): string | null {
  const prior = new Set(
    priorTexts
      .map((t) => normalizeForVerbatim(t ?? ''))
      .filter((t) => t.length >= VERBATIM_MIN_LEN)
  );
  if (prior.size === 0) return null;
  const candidates = [
    normalizeForVerbatim(candidateText),
    ...candidateText
      .split('\n')
      .map((l) => normalizeForVerbatim(l))
      .filter((l) => l.length >= VERBATIM_MIN_LEN)
  ];
  return (
    candidates.find((c) => c.length >= VERBATIM_MIN_LEN && prior.has(c)) ?? null
  );
}

/** True if `bubble` (normalized, ≥ min len) exactly matches any prior message. */
export function isVerbatimRepeatBubble(
  bubble: string,
  priorTexts: Array<string | null | undefined>
): boolean {
  const norm = normalizeForVerbatim(bubble);
  if (norm.length < VERBATIM_MIN_LEN) return false;
  return priorTexts.some((t) => normalizeForVerbatim(t ?? '') === norm);
}
