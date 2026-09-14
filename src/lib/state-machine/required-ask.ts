// ---------------------------------------------------------------------------
// state-machine/required-ask.ts — M5 item 7, the required-ask check.
// ---------------------------------------------------------------------------
// A turn generated at a script step whose selected branch ASKS something
// (completion lead_reply_after_ask) must contain that ask — the compiled
// script's own deliverable, matched drift-tolerantly — unless the ask already
// went out earlier in the step. This is the generic form of the
// Daniel-hardcoded "capital question must be asked" detector
// (CAPITAL_QUESTION_PREREQS / MANDATORY_ASK_STEPS) and the fix for the
// freelance case (conv cmtws66km0003l504a5toczil: the engine asked its own
// question at step 11 instead of the $200 qualification ask).
//
// SHADOW-FIRST: this module only OBSERVES. deliverBubbleGroup calls
// shadowRequiredAskCheck, which writes an EgressShadowLog row with
// machineAllow=true, machineReason='REQUIRED_ASK_MISSING' when the ask is
// missing, and never blocks. Block-vs-append is decided on the collected
// rows (paraphrase rate vs true freelance), not on one conversation.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import {
  isMatchableCopy,
  matchScriptedCopy
} from '@/lib/state-machine/copy-match';
import type { FsmNode } from '@/lib/script-fsm/types';

export const REQUIRED_ASK_MISSING_REASON = 'REQUIRED_ASK_MISSING';
export const REQUIRED_ASK_SEND_PATH = 'required_ask_shadow';

export type RequiredAskStatus =
  | 'not_applicable'
  | 'satisfied'
  | 'already_asked'
  | 'missing';

export interface RequiredAskVerdict {
  status: RequiredAskStatus;
  stepNumber: number;
  branchLabel: string | null;
  /** The scripted ask(s) the turn was expected to contain. */
  asks: string[];
  /** Which ask matched (satisfied / already_asked). */
  matched?: string;
}

function askTexts(edge: FsmNode['edges'][number]): string[] {
  return edge.deliverables
    .filter((d) => d.kind === 'ask')
    .map((d) => (d as { text: string }).text)
    .filter((t) => t.trim().length > 0);
}

/** Pure. `priorDelivered` = outbound already delivered in the conversation
 *  (newest last); a match there means the ask went out earlier in the step. */
export function evaluateRequiredAsk(
  node: FsmNode,
  selectedBranchLabel: string | null,
  bubbles: string[],
  priorDelivered: string[]
): RequiredAskVerdict {
  const base = {
    stepNumber: node.stepNumber,
    branchLabel: selectedBranchLabel,
    asks: [] as string[]
  };
  if (node.edges.length === 0) return { ...base, status: 'not_applicable' };
  const norm = (s: string) => s.trim().toLowerCase();
  const selected = selectedBranchLabel
    ? (node.edges.find(
        (e) => norm(e.branchLabel) === norm(selectedBranchLabel)
      ) ?? null)
    : node.edges.length === 1
      ? node.edges[0]
      : null;
  // Unknown selection on a fork: any branch's ask satisfies; missing only if
  // none of them appears.
  const candidates = selected ? [selected] : node.edges;
  const applicable = candidates.filter(
    (e) => e.completion.kind === 'lead_reply_after_ask'
  );
  if (applicable.length === 0) return { ...base, status: 'not_applicable' };
  // Asks under the matcher floor ("Why now?") can never be matched either way;
  // they are outside this check, not "missing".
  const asks = applicable.flatMap(askTexts).filter(isMatchableCopy);
  if (asks.length === 0) return { ...base, status: 'not_applicable' };
  for (const b of bubbles) {
    const hit = matchScriptedCopy(b, asks);
    if (hit) return { ...base, asks, status: 'satisfied', matched: hit };
  }
  for (const p of priorDelivered.slice(-10)) {
    const hit = matchScriptedCopy(p, asks);
    if (hit) return { ...base, asks, status: 'already_asked', matched: hit };
  }
  return { ...base, asks, status: 'missing' };
}

/** Shadow-only: evaluate the turn about to ship and log a row when the
 *  scripted ask is missing. Never throws, never blocks. */
export async function shadowRequiredAskCheck(params: {
  accountId: string;
  conversationId: string;
  bubbles: string[];
}): Promise<RequiredAskVerdict | null> {
  try {
    const { getActiveScriptFsm } = await import('@/lib/script-fsm/store');
    const { nodeForStep } = await import('@/lib/script-fsm/runtime');
    const { branchHistorySelectedLabelForStep } = await import(
      '@/lib/script-state-recovery'
    );
    const active = await getActiveScriptFsm(params.accountId);
    if (!active) return null;
    const conv = await prisma.conversation.findUnique({
      where: { id: params.conversationId },
      select: {
        currentScriptStep: true,
        capturedDataPoints: true,
        messages: {
          where: {
            sender: { in: ['AI', 'HUMAN'] },
            platformMessageId: { not: null },
            deletedAt: null
          },
          orderBy: { timestamp: 'desc' },
          take: 10,
          select: { content: true }
        }
      }
    });
    if (!conv) return null;
    const step = conv.currentScriptStep ?? 1;
    const node = nodeForStep(active.fsm, step);
    if (!node) return null;
    const label = branchHistorySelectedLabelForStep(
      conv.capturedDataPoints as never,
      step
    );
    const verdict = evaluateRequiredAsk(
      node,
      label,
      params.bubbles,
      [...conv.messages].reverse().map((m) => m.content)
    );
    if (verdict.status === 'missing') {
      const preview =
        `step ${verdict.stepNumber}${verdict.branchLabel ? ` "${verdict.branchLabel}"` : ''} expected ask: "${verdict.asks[0].slice(0, 120)}"` +
        ` | turn: "${params.bubbles.join(' / ').slice(0, 200)}"`;
      await prisma.egressShadowLog.create({
        data: {
          accountId: params.accountId,
          conversationId: params.conversationId,
          sendPath: REQUIRED_ASK_SEND_PATH,
          draftPreview: preview.slice(0, 500),
          machineAllow: true,
          machineReason: REQUIRED_ASK_MISSING_REASON,
          machineHold: null,
          agreed: true
        }
      });
      console.warn(
        `[required-ask/shadow] conv ${params.conversationId} step ${verdict.stepNumber}: scripted ask missing from the turn (${preview.slice(0, 160)})`
      );
    }
    return verdict;
  } catch (err) {
    console.error(
      '[required-ask/shadow] check failed (non-fatal):',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
