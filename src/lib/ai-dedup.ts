// ---------------------------------------------------------------------------
// ai-dedup.ts
// ---------------------------------------------------------------------------
// Last-line defense against near-duplicate AI sends. Used by BOTH the
// regular sendAIReply path AND the scheduled-message / keepalive crons so
// a reminder that accidentally rehashes the previous message (or a retry
// loop that regenerates after a failed Meta send) gets caught before
// shipping a second copy to the lead.
//
// Compares the candidate reply against the most recent N AI messages in
// the same conversation using word-level Jaccard similarity. Threshold
// 0.85 catches copy-pastes and trivial rewordings while allowing
// genuinely different replies that share common filler ("bro", "gotchu").
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';

export interface DedupOptions {
  /** How many recent AI messages to compare against (default 3). */
  lookbackCount?: number;
  /** Only consider AI messages newer than this (defaults to unlimited). */
  since?: Date;
  /** Jaccard similarity threshold above which we suppress (default 0.85). */
  threshold?: number;
}

export interface DedupVerdict {
  isDuplicate: boolean;
  /** Max similarity observed against the lookback set (0–1). */
  maxSimilarity: number;
  /** ID of the message that matched (when isDuplicate=true). */
  matchedMessageId?: string;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Word-level Jaccard similarity between two strings.
 * Returns 0 when either side is empty.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const aArr = tokenize(a);
  const bArr = tokenize(b);
  const aTokens = new Set(aArr);
  const bTokens = new Set(bArr);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  // Intersection via the smaller set for efficiency.
  let intersection = 0;
  aTokens.forEach((w) => {
    if (bTokens.has(w)) intersection++;
  });
  // Union = |A| + |B| − |A ∩ B|
  const union = aTokens.size + bTokens.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Look up the most recent AI messages in `conversationId` and return
 * whether `candidate` is near-duplicate of any of them.
 *
 * Best-effort: if the DB query throws, returns isDuplicate=false so we
 * don't block real sends on dedup failures. Callers that want to abort
 * on error should check maxSimilarity === 0 and log accordingly.
 */
export async function isNearDuplicateOfRecentAiMessages(
  conversationId: string,
  candidate: string,
  opts: DedupOptions = {}
): Promise<DedupVerdict> {
  const { lookbackCount = 3, since, threshold = 0.85 } = opts;
  try {
    const recent = await prisma.message.findMany({
      where: {
        conversationId,
        sender: 'AI',
        ...(since ? { timestamp: { gte: since } } : {})
      },
      orderBy: { timestamp: 'desc' },
      take: lookbackCount,
      select: { id: true, content: true }
    });

    let maxSim = 0;
    let matchedId: string | undefined;
    for (const prev of recent) {
      const sim = jaccardSimilarity(candidate, prev.content);
      if (sim > maxSim) {
        maxSim = sim;
        matchedId = prev.id;
      }
    }
    return {
      isDuplicate: maxSim >= threshold,
      maxSimilarity: maxSim,
      matchedMessageId: maxSim >= threshold ? matchedId : undefined
    };
  } catch (err) {
    console.error(
      '[ai-dedup] lookup failed (non-fatal, returning not-duplicate):',
      err
    );
    return { isDuplicate: false, maxSimilarity: 0 };
  }
}
