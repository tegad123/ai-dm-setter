// ---------------------------------------------------------------------------
// Fix D — Phase 0: egress shadow-compare.
// ---------------------------------------------------------------------------
// Called (fire-and-forget) from the physical send choke point. By
// construction the live code has ALREADY decided to send when this runs, so
// the live verdict is always ALLOW; every row where the machine disagrees
// (machineAllow=false) is the shadow-diff review queue for Ali's Phase 0
// sign-off packet.
//
// Flag: FIX_D_EGRESS_SHADOW, default ON (log-only, no behavior change).
// Lesson from A6: a shadow mode that ships default-off never accumulates
// data. Kill switch: set FIX_D_EGRESS_SHADOW=false.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { canSend, deriveMachineState } from './can-send';

const SHADOW_ENABLED = process.env.FIX_D_EGRESS_SHADOW !== 'false';

// Coarse caller tag from the stack — first app frame outside this module and
// the send module. Diagnostic only; never load-bearing.
function inferSendPath(): string {
  try {
    const frames = (new Error().stack ?? '').split('\n').slice(1);
    const app = frames.find(
      (f) =>
        f.includes('/src/') &&
        !f.includes('/state-machine/') &&
        !f.includes('/instagram')
    );
    const m = app && /\/src\/(.+?\.ts)/.exec(app);
    return m ? m[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function shadowEgressCheck(params: {
  accountId: string;
  recipientId: string;
  messageText: string;
  // true for sends a human explicitly initiated (manual reply / approved
  // suggestion routes pass this once call sites adopt it; default false =
  // treat as AI-initiated, the conservative shadow reading).
  operatorInitiated?: boolean;
}): void {
  if (!SHADOW_ENABLED) return;
  // Fire-and-forget: a shadow failure must never delay or break a real send.
  void (async () => {
    try {
      const lead = await prisma.lead.findFirst({
        where: {
          accountId: params.accountId,
          platformUserId: params.recipientId
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true }
      });
      const conv = lead
        ? await prisma.conversation.findFirst({
            where: { leadId: lead.id },
            orderBy: { lastMessageAt: 'desc' },
            select: {
              id: true,
              aiActive: true,
              distressDetected: true,
              schedulingConflict: true,
              awaitingHumanReview: true
            }
          })
        : null;

      // No conversation resolvable — machine has no state to gate on;
      // record it (these rows themselves are a finding: sends that bypass
      // conversation state entirely).
      if (!conv) {
        await prisma.egressShadowLog.create({
          data: {
            accountId: params.accountId,
            conversationId: null,
            sendPath: inferSendPath(),
            draftPreview: params.messageText.slice(0, 300),
            machineAllow: true,
            machineReason: 'NO_CONVERSATION_STATE',
            agreed: true
          }
        });
        return;
      }

      // Distinguish gate-exhaustion holds from generic review holds for the
      // typed-reason requirement (cheap check, shadow-only).
      let qualityGateHeld = false;
      if (conv.awaitingHumanReview) {
        const gateFail = await prisma.voiceQualityFailure.findFirst({
          where: {
            accountId: params.accountId,
            createdAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) }
          },
          select: { id: true }
        });
        qualityGateHeld = Boolean(gateFail);
      }

      const state = deriveMachineState({ ...conv, qualityGateHeld });
      const verdict = canSend(state, {
        text: params.messageText,
        operatorInitiated: params.operatorInitiated ?? false
      });

      await prisma.egressShadowLog.create({
        data: {
          accountId: params.accountId,
          conversationId: conv.id,
          sendPath: inferSendPath(),
          draftPreview: params.messageText.slice(0, 300),
          machineAllow: verdict.allow,
          machineReason: verdict.allow ? null : verdict.reason,
          machineHold: verdict.allow ? null : (verdict.hold ?? null),
          agreed: verdict.allow // live verdict is ALLOW by construction
        }
      });
    } catch (err) {
      console.error(
        '[fix-d/shadow] egress shadow log failed (non-fatal):',
        err
      );
    }
  })();
}
