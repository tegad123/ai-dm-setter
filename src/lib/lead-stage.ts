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

  // 4. Broadcast update (dynamic import to avoid circular dependencies)
  const { broadcastLeadUpdate } = await import('@/lib/realtime');
  broadcastLeadUpdate({
    id: updatedLead.id,
    stage: updatedLead.stage,
    previousStage: updatedLead.previousStage,
    stageEnteredAt: updatedLead.stageEnteredAt?.toISOString()
  });

  return updatedLead;
}
