// ---------------------------------------------------------------------------
// script-fsm/shadow.ts — dual-run the compiled FSM next to the legacy
// judge / computeSystemStage and log every disagreement; per-account
// authoritative flag. Same discipline as state-machine/shadow.ts: best-effort
// awaited logging that can never change the live decision, fail-open-but-loud.
//
// Flags:
//   FIX_D_ROUTING_SHADOW          default ON  — log-only rows.
//   FIX_D_ROUTING_AUTHORITATIVE   csv of accountIds (or ALL) whose routing
//                                 and advancement the FSM OWNS. daetradez
//                                 is flipped LAST (it is the oracle).
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';

const SHADOW_ENABLED = process.env.FIX_D_ROUTING_SHADOW !== 'false';

export function isRoutingAuthoritative(accountId: string): boolean {
  const raw = process.env.FIX_D_ROUTING_AUTHORITATIVE;
  if (!raw) return false;
  const set = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return set.includes('ALL') || set.includes(accountId);
}

export function isRoutingShadowEnabled(): boolean {
  return SHADOW_ENABLED;
}

export async function recordRoutingShadow(row: {
  accountId: string;
  conversationId: string | null;
  scriptId: string | null;
  stepNumber: number;
  legacyBranchLabel: string | null;
  fsmBranchLabel: string | null;
  fsmReason: string | null;
  legacyNextStep?: number | null;
  fsmNextStep?: number | null;
}): Promise<void> {
  if (!SHADOW_ENABLED) return;
  const branchAgreed =
    (row.legacyBranchLabel ?? '').trim().toLowerCase() ===
    (row.fsmBranchLabel ?? '').trim().toLowerCase();
  const advanceAgreed =
    row.legacyNextStep == null && row.fsmNextStep == null
      ? null
      : row.legacyNextStep === row.fsmNextStep;
  try {
    await prisma.routingShadowLog.create({
      data: {
        accountId: row.accountId,
        conversationId: row.conversationId,
        scriptId: row.scriptId,
        stepNumber: row.stepNumber,
        legacyBranchLabel: row.legacyBranchLabel,
        fsmBranchLabel: row.fsmBranchLabel,
        fsmReason: row.fsmReason,
        legacyNextStep: row.legacyNextStep ?? null,
        fsmNextStep: row.fsmNextStep ?? null,
        branchAgreed,
        advanceAgreed
      }
    });
    if (!branchAgreed || advanceAgreed === false) {
      console.warn(
        `[script-fsm/shadow] DISAGREEMENT conv ${row.conversationId} step ${row.stepNumber}: ` +
          `branch legacy=${JSON.stringify(row.legacyBranchLabel)} fsm=${JSON.stringify(row.fsmBranchLabel)} (${row.fsmReason}) ` +
          `| advance legacy=${row.legacyNextStep ?? '-'} fsm=${row.fsmNextStep ?? '-'}`
      );
    }
  } catch (err) {
    console.error(
      '[script-fsm/shadow] log write failed (non-fatal):',
      err instanceof Error ? err.message : err
    );
  }
}
