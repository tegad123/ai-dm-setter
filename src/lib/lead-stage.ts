// ---------------------------------------------------------------------------
// Lead Stage Transition Utility
// ---------------------------------------------------------------------------
// Core stage transition logic for the Lead Lifecycle System.
// All stage changes should flow through `transitionLeadStage` to ensure
// atomic updates, audit trail (LeadStageTransition), and real-time broadcasts.
// ---------------------------------------------------------------------------

import { LeadStage } from '@prisma/client';
import prisma from '@/lib/prisma';

// -- Pipeline order (used for priority / upgrade comparisons) ----------------

export const STAGE_ORDER: LeadStage[] = [
  'NEW_LEAD',
  'ENGAGED',
  'QUALIFYING',
  'QUALIFIED',
  'CALL_PROPOSED',
  'BOOKED',
  'SHOWED',
  'NO_SHOWED',
  'RESCHEDULED',
  'CLOSED_WON',
  'CLOSED_LOST',
  'UNQUALIFIED',
  'GHOSTED',
  'NURTURE'
];

// Terminal stages — once a lead reaches one of these, lateral moves between
// them are NOT considered upgrades.
const TERMINAL_STAGES: Set<LeadStage> = new Set<LeadStage>([
  'CLOSED_WON',
  'CLOSED_LOST',
  'UNQUALIFIED',
  'GHOSTED',
  'NURTURE'
]);

// Auto-generated positive-intent tag names that stop making sense once a
// lead is disqualified. Stripped from the lead when stage → UNQUALIFIED
// so the operator's view doesn't show a "Hot Lead + Ready To Book"
// combination on someone who can't book. Only tags with isAuto=true AND
// a name in this set get cleaned up — operator-added tags (isAuto=false)
// and AI-added non-positive tags (e.g. the "UNQUALIFIED" intent tag
// created by the scoring engine) are preserved because they still
// describe the lead's actual state.
export const POSITIVE_INTENT_AUTO_TAGS: ReadonlySet<string> = new Set([
  'ON_FIRE',
  'HOT_LEAD',
  'HIGH_INTENT',
  'READY_TO_BOOK'
]);

// -- Helpers -----------------------------------------------------------------

/**
 * Returns true if moving from `from` → `to` is an upgrade (forward progress
 * in the pipeline). Moves between terminal stages are never upgrades.
 */
export function isUpgrade(from: LeadStage, to: LeadStage): boolean {
  if (TERMINAL_STAGES.has(from) && TERMINAL_STAGES.has(to)) {
    return false;
  }
  const fromIdx = STAGE_ORDER.indexOf(from);
  const toIdx = STAGE_ORDER.indexOf(to);
  return toIdx > fromIdx;
}

/**
 * Returns the manual transition buttons available for a given stage.
 * - `primary`   — context-specific actions for the stage
 * - `secondary` — always-available options (currently just NURTURE)
 */
export function getStageActions(stage: LeadStage): {
  primary: LeadStage[];
  secondary: LeadStage[];
} {
  let primary: LeadStage[] = [];

  switch (stage) {
    case 'BOOKED':
      primary = ['SHOWED', 'NO_SHOWED', 'RESCHEDULED'];
      break;
    case 'SHOWED':
      primary = ['CLOSED_WON', 'CLOSED_LOST'];
      break;
    // Other stages have no special primary actions
  }

  return {
    primary,
    secondary: ['NURTURE']
  };
}

// -- Core transition function ------------------------------------------------

/**
 * Atomically transitions a lead to a new stage.
 *
 * - No-ops if the lead is already at `toStage`.
 * - Updates `stage`, `previousStage`, and `stageEnteredAt` on the Lead.
 * - Creates a `LeadStageTransition` audit record.
 * - Broadcasts the update via the real-time event bus.
 *
 * @param leadId         - ID of the lead to transition
 * @param toStage        - Target stage
 * @param transitionedBy - Who initiated the transition ("ai" | "user" | "system")
 * @param reason         - Optional human-readable reason for the transition
 * @returns The updated Lead record, or the unchanged lead on no-op.
 */
export async function transitionLeadStage(
  leadId: string,
  toStage: LeadStage,
  transitionedBy: string,
  reason?: string
) {
  // 1. Read current stage
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId }
  });

  // 2. No-op if already at target stage
  if (lead.stage === toStage) {
    return lead;
  }

  const fromStage = lead.stage;
  const now = new Date();

  // 3. Atomic update — set new stage + create audit record in one transaction
  const [updatedLead] = await prisma.$transaction([
    prisma.lead.update({
      where: { id: leadId },
      data: {
        stage: toStage,
        previousStage: fromStage,
        stageEnteredAt: now
      }
    }),
    prisma.leadStageTransition.create({
      data: {
        leadId,
        fromStage,
        toStage,
        transitionedBy,
        reason: reason ?? null
      }
    })
  ]);

  // 3b. Tag cleanup on disqualification. Fires AFTER the stage commit so
  //     a crash mid-cleanup still leaves the stage transition intact.
  //     Best-effort — tag cleanup errors don't unwind the transition.
  if (toStage === 'UNQUALIFIED') {
    try {
      await cleanupPositiveIntentTagsOnDisqualify(leadId);
    } catch (err) {
      console.error(
        '[lead-stage] Tag cleanup on UNQUALIFIED transition failed (non-fatal):',
        err
      );
    }

    // 3c. Cancel pending follow-ups (Kelvin Kelvot 2026-04-25). Once a
    //     lead is marked UNQUALIFIED, any 12h chain row still PENDING
    //     would fire on a soft-exited conversation. Tear down the
    //     cascade so no "yo bro you still there?" lands hours later.
    //     We need the conversationId — fetched off the updated lead.
    try {
      const convo = await prisma.conversation.findFirst({
        where: { leadId },
        select: { id: true }
      });
      if (convo) {
        const { cancelAllPendingFollowUps } = await import(
          '@/lib/follow-up-sequence'
        );
        const cancelled = await cancelAllPendingFollowUps(convo.id);
        if (cancelled > 0) {
          console.log(
            `[lead-stage] cancelled ${cancelled} pending follow-up(s) on UNQUALIFIED transition for lead ${leadId} (convo ${convo.id})`
          );
        }
      }
    } catch (err) {
      console.error(
        '[lead-stage] cancelAllPendingFollowUps on UNQUALIFIED transition failed (non-fatal):',
        err
      );
    }

    try {
      const convo = await prisma.conversation.findFirst({
        where: { leadId },
        select: { id: true }
      });
      if (convo) {
        const { cancelCallConfirmationSequence } = await import(
          '@/lib/call-confirmation-sequence'
        );
        const cancelled = await cancelCallConfirmationSequence(convo.id);
        if (cancelled > 0) {
          console.log(
            `[lead-stage] cancelled ${cancelled} pending call-confirmation message(s) on UNQUALIFIED transition for lead ${leadId} (convo ${convo.id})`
          );
        }
      }
    } catch (err) {
      console.error(
        '[lead-stage] cancelCallConfirmationSequence on UNQUALIFIED transition failed (non-fatal):',
        err
      );
    }
  }

  if (toStage === 'QUALIFIED') {
    try {
      const { handleQualifiedCallConfirmationTrigger } = await import(
        '@/lib/call-confirmation-sequence'
      );
      await handleQualifiedCallConfirmationTrigger(leadId);
    } catch (err) {
      console.error(
        '[lead-stage] call-confirmation trigger on QUALIFIED transition failed (non-fatal):',
        err
      );
    }
  }

  // 4. Broadcast update (dynamic import to avoid circular dependencies)
  const { broadcastLeadUpdate } = await import('@/lib/realtime');
  broadcastLeadUpdate(updatedLead.accountId, {
    id: updatedLead.id,
    stage: updatedLead.stage,
    previousStage: updatedLead.previousStage,
    stageEnteredAt: updatedLead.stageEnteredAt?.toISOString()
  });

  return updatedLead;
}

/**
 * Remove auto-generated positive-intent tags from a lead. Called when
 * the lead transitions to UNQUALIFIED — a "Hot Lead" badge on a
 * disqualified lead is actively misleading to the operator.
 *
 * Deletes `LeadTag` rows where:
 *   - The linked `Tag.isAuto === true` (never touch operator-added tags)
 *   - The `Tag.name` is in `POSITIVE_INTENT_AUTO_TAGS`
 *
 * Returns the number of LeadTag rows removed.
 */
export async function cleanupPositiveIntentTagsOnDisqualify(
  leadId: string
): Promise<number> {
  const result = await prisma.leadTag.deleteMany({
    where: {
      leadId,
      tag: {
        isAuto: true,
        name: { in: Array.from(POSITIVE_INTENT_AUTO_TAGS) }
      }
    }
  });
  if (result.count > 0) {
    console.log(
      `[lead-stage] Stripped ${result.count} positive-intent auto tag(s) from UNQUALIFIED lead ${leadId}`
    );
  }
  return result.count;
}
