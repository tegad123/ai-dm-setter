// ---------------------------------------------------------------------------
// state-machine/copy-match.ts — pure "is this bubble a drift of that scripted
// block?" matcher, shared by the wait-boundary egress guard and the
// script-FSM fold (branch inference from delivered copy). No DB, no side
// effects, so it can be imported from the pure runtime and from unit tests.
// ---------------------------------------------------------------------------

import { normalizeForVerbatim } from '@/lib/verbatim-normalize';

const MIN_CHARS = 20;
const MIN_TOKENS = 4;
const JACCARD_THRESHOLD = 0.75;

function tokens(s: string): Set<string> {
  return new Set(normalizeForVerbatim(s).split(' ').filter(Boolean));
}

/** Can this line ever be matched by the matchers below? (≥20 chars, ≥4
 *  tokens after normalization.) Short generic lines are deliberately outside
 *  the matchers' reach, so callers must not treat them as "never sent". */
export function isMatchableCopy(text: string): boolean {
  const n = normalizeForVerbatim(text);
  return n.length >= MIN_CHARS && tokens(text).size >= MIN_TOKENS;
}

/** Is `bubble` a repeat of something we already sent? Normalized equality,
 *  or token Jaccard ≥ 0.75 on lines of ≥20 chars / ≥4 tokens. Containment is
 *  deliberately NOT a repeat here: a short new question that happens to sit
 *  inside an earlier long message is new content. Returns the prior text. */
export function findVerbatimRepeat(
  bubble: string,
  priorOutbound: string[]
): string | null {
  const nb = normalizeForVerbatim(bubble);
  if (nb.length < MIN_CHARS) return null;
  const tb = tokens(bubble);
  if (tb.size < MIN_TOKENS) return null;
  for (const p of priorOutbound) {
    const np = normalizeForVerbatim(p);
    if (np.length < MIN_CHARS) continue;
    if (nb === np) return p;
    const tp = tokens(p);
    if (tp.size < MIN_TOKENS) continue;
    // A delivered line repeated whole INSIDE the new bubble is a repeat (the
    // engine re-sent the opener glued to more text: "yo wassup, respect for
    // reaching out! let's see…" after "yo wassup, respect for reaching out!").
    // The other direction (new short line inside an old long one) stays new.
    if (nb.includes(np)) return p;
    let inter = 0;
    tb.forEach((t) => {
      if (tp.has(t)) inter++;
    });
    const union = tb.size + tp.size - inter;
    if (union > 0 && inter / union >= JACCARD_THRESHOLD) return p;
  }
  return null;
}

/** Returns the matching scripted block when `bubble` is (a drift of) one of
 *  `candidates`: normalized equality, containment either way, or token
 *  Jaccard ≥ 0.75. Short/generic lines never match (≥20 chars, ≥4 tokens). */
export function matchScriptedCopy(
  bubble: string,
  candidates: string[]
): string | null {
  const nb = normalizeForVerbatim(bubble);
  if (nb.length < MIN_CHARS) return null;
  const tb = tokens(bubble);
  if (tb.size < MIN_TOKENS) return null;
  for (const c of candidates) {
    const nc = normalizeForVerbatim(c);
    if (nc.length < MIN_CHARS) continue;
    if (nb === nc || nb.includes(nc) || nc.includes(nb)) return c;
    const tc = tokens(c);
    if (tc.size < MIN_TOKENS) continue;
    let inter = 0;
    tb.forEach((t) => {
      if (tc.has(t)) inter++;
    });
    const union = tb.size + tc.size - inter;
    if (union > 0 && inter / union >= JACCARD_THRESHOLD) return c;
  }
  return null;
}
