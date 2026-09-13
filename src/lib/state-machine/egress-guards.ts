// ---------------------------------------------------------------------------
// egress-guards.ts — content guards that run at the physical send choke point.
// ---------------------------------------------------------------------------
// Fix D / M5 item 7 foundation, M5 item 1 first guard (2026-09-11, Tega).
//
// The retry loop in ai-engine SHAPES a reply (regen on quality-gate misses).
// These guards are the deterministic BACKSTOP that no send path can bypass:
// they run inside shadowEgressCheck, which every AI send passes through
// (instagram.ts sendDM / facebook.ts sendMessage), per bubble, on every path
// including the crons. A guard that throws fails OPEN for that guard only —
// a guard bug must never block a real send; a clean verdict enforces.
//
// Guard 1 — WAIT_BOUNDARY (Tega item 1). A script step is
//   [pre-wait blocks…] wait_for_response [post-wait blocks…]
// The post-wait blocks are the REACTION to the lead's answer; they must never
// ship in the same turn as the pre-wait ask. Evidence: Warm Inbound blocks 1,
// 2 and 4 shipped in one turn and the lead received "That's awesome, I'm over
// in here in Texas" before answering the location question. Rule: if the
// outgoing bubble is post-wait copy for the conversation's current (or just
// advanced-from) step AND the lead has not spoken since the last AI bubble,
// block it. Enforced on EVERY platform regardless of the authoritative flag —
// it is a structural script rule with no state ambiguity — and reported in
// dry run (generate-only) so the shadow window shows what it would hold.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { matchScriptedCopy } from '@/lib/state-machine/copy-match';

export type GuardAction = 'allow' | 'block';

export interface GuardVerdict {
  action: GuardAction;
  /** Stable machine tag, e.g. 'WAIT_BOUNDARY'. Present iff action === 'block'. */
  reason?: string;
  detail?: string;
}

export interface GuardContext {
  accountId: string;
  conversationId: string | null;
  platform: string | null;
  /** The exact bubble about to ship. */
  bubble: string;
}

export interface EgressGuard {
  name: string;
  run(ctx: GuardContext): Promise<GuardVerdict>;
}

export const WAIT_BOUNDARY_REASON = 'WAIT_BOUNDARY';

const ALLOW: GuardVerdict = { action: 'allow' };

// ── Pure core (unit-tested) ────────────────────────────────────────────────

export interface StepActionLike {
  actionType: string;
  content?: string | null;
  sortOrder?: number | null;
}
export interface StepLike {
  actions?: StepActionLike[];
  branches?: { actions?: StepActionLike[] }[];
}

const DELIVERABLE = new Set(['send_message', 'ask_question']);
const WAIT = new Set(['wait_for_response', 'wait_duration']);

function bySort(a: StepActionLike, b: StepActionLike): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
}

/** Contents of send_message / ask_question blocks that sit AFTER the first
 *  Wait in a sequence. Applied to the step's direct actions and to each
 *  branch's actions independently (a branch is its own sequence). */
export function collectPostWaitContents(step: StepLike): string[] {
  const out: string[] = [];
  const scan = (actions: StepActionLike[] | undefined) => {
    if (!actions?.length) return;
    let afterWait = false;
    for (const a of [...actions].sort(bySort)) {
      if (WAIT.has(a.actionType)) {
        afterWait = true;
        continue;
      }
      if (afterWait && DELIVERABLE.has(a.actionType)) {
        const c = (a.content ?? '').trim();
        if (c) out.push(c);
      }
    }
  };
  scan(step.actions);
  for (const b of step.branches ?? []) scan(b.actions);
  return out;
}

/** Returns the matching scripted block when `bubble` is (a drift of) one of
 *  `postWaitContents`. The matcher lives in state-machine/copy-match.ts so the
 *  script-FSM fold can share it without pulling in the DB glue below. */
export function matchPostWaitCopy(
  bubble: string,
  postWaitContents: string[]
): string | null {
  return matchScriptedCopy(bubble, postWaitContents);
}

// ── DB glue ────────────────────────────────────────────────────────────────

async function loadStepsForGuard(
  accountId: string,
  stepNumbers: number[]
): Promise<StepLike[]> {
  const script = await prisma.script.findFirst({
    where: { accountId, isActive: true },
    select: {
      steps: {
        where: { stepNumber: { in: stepNumbers } },
        select: {
          actions: {
            select: { actionType: true, content: true, sortOrder: true }
          },
          branches: {
            select: {
              actions: {
                select: { actionType: true, content: true, sortOrder: true }
              }
            }
          }
        }
      }
    }
  });
  return script?.steps ?? [];
}

export const waitBoundaryGuard: EgressGuard = {
  name: 'wait_boundary',
  async run(ctx) {
    if (!ctx.conversationId) return ALLOW;
    const conv = await prisma.conversation.findUnique({
      where: { id: ctx.conversationId },
      select: {
        currentScriptStep: true,
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 1,
          select: { sender: true }
        }
      }
    });
    if (!conv) return ALLOW;
    // The lead (or a human) spoke last → this bubble opens a fresh turn and a
    // post-wait react is exactly what should ship now. Only when the previous
    // message in the thread is OUR bubble (same turn, lead hasn't answered)
    // is post-wait copy a violation.
    if (conv.messages[0]?.sender !== 'AI') return ALLOW;
    // The cursor may already have advanced past the step whose react is being
    // shipped (advancement is computed before generation), so check the
    // current step and the one before it.
    const cur = conv.currentScriptStep ?? 1;
    const steps = await loadStepsForGuard(
      ctx.accountId,
      [cur, cur - 1].filter((n) => n >= 1)
    );
    const postWait = steps.flatMap(collectPostWaitContents);
    if (postWait.length === 0) return ALLOW;
    const hit = matchPostWaitCopy(ctx.bubble, postWait);
    if (!hit) return ALLOW;
    return {
      action: 'block',
      reason: WAIT_BOUNDARY_REASON,
      detail: `post-Wait copy shipped before the lead replied (step ${cur}): "${hit.slice(0, 80)}"`
    };
  }
};

export const EGRESS_GUARDS: EgressGuard[] = [waitBoundaryGuard];

/** First block wins. A guard that throws is skipped (fail-open for that guard). */
export async function runEgressGuards(
  ctx: GuardContext,
  guards: EgressGuard[] = EGRESS_GUARDS
): Promise<GuardVerdict & { guard?: string }> {
  for (const g of guards) {
    try {
      const v = await g.run(ctx);
      if (v.action === 'block') return { ...v, guard: g.name };
    } catch (err) {
      console.error(
        `[fix-d/egress] guard "${g.name}" threw (skipped, fail-open):`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return ALLOW;
}
