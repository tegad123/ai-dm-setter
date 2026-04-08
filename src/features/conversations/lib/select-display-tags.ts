/**
 * Pick the most useful subset of tags to show in compact UI surfaces
 * (conversation header, summary card).
 *
 * The AI tag generator has historically created semantic + case-variant
 * duplicates (HIGH_INTENT vs high_intent, READY_TO_BOOK vs ready_to_book,
 * etc.) and a long tail of style descriptors (responsive, casual, direct,
 * persistent, ...). Showing all of them overflows the header and adds
 * noise.
 *
 * This helper:
 *   1. Dedupes by canonical name (uppercased, non-alphanumerics → _)
 *   2. When two variants exist, prefers the one with a non-gray color
 *      (the AI uses color to mark priority: green/orange/purple = signal,
 *      gray = noise)
 *   3. Sorts colored tags first, then gray
 *   4. Returns up to `max` tags
 */

const GRAY = '#6B7280';

export interface DisplayTag {
  id: string;
  name: string;
  color: string;
}

function canonicalize(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isColored(tag: { color: string }): boolean {
  return !!tag.color && tag.color.toUpperCase() !== GRAY;
}

export function selectDisplayTags<T extends DisplayTag>(
  tags: T[] | undefined,
  max: number
): T[] {
  if (!tags || tags.length === 0) return [];

  // Dedupe by canonical name, preferring colored over gray
  const byCanonical = new Map<string, T>();
  for (const tag of tags) {
    const key = canonicalize(tag.name);
    const existing = byCanonical.get(key);
    if (!existing) {
      byCanonical.set(key, tag);
      continue;
    }
    // Replace if current is gray and new one is colored
    if (!isColored(existing) && isColored(tag)) {
      byCanonical.set(key, tag);
    }
  }

  const deduped = Array.from(byCanonical.values());

  // Sort colored first, then by original order (stable)
  deduped.sort((a, b) => {
    const aColored = isColored(a) ? 0 : 1;
    const bColored = isColored(b) ? 0 : 1;
    return aColored - bColored;
  });

  return deduped.slice(0, max);
}
