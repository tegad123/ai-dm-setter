// ---------------------------------------------------------------------------
// lead-script-tracker.ts
// ---------------------------------------------------------------------------
// Tracks each lead's current position in the active Script.
// Called from webhook-processor after the AI generates a reply.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';

/**
 * Maps the AI's reported stage/step to the corresponding ScriptStep
 * and upserts the LeadScriptPosition record.
 *
 * @param accountId - The account ID
 * @param leadId - The lead ID
 * @param reportedStage - The AI's reported stage (e.g., "QUALIFYING", "BOOKING")
 */
export async function updateLeadScriptPosition(
  accountId: string,
  leadId: string,
  reportedStage: string | undefined | null
): Promise<void> {
  if (!reportedStage) return;

  try {
    // Find the active script
    const script = await prisma.script.findFirst({
      where: { accountId, isActive: true },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
          select: { id: true, title: true, stepNumber: true }
        }
      }
    });

    if (!script || script.steps.length === 0) return;

    // Map the reported stage to a ScriptStep
    // Strategy: Try title match first, then fall back to stage-to-step mapping
    const normalizedStage = reportedStage.toLowerCase().replace(/_/g, ' ');

    let matchedStep = script.steps.find((s) =>
      s.title.toLowerCase().includes(normalizedStage)
    );

    // Stage-to-step title mapping (common patterns)
    if (!matchedStep) {
      const STAGE_TO_TITLE: Record<string, string[]> = {
        new_lead: ['initial engagement', 'engagement'],
        engaged: ['initial engagement', 'engagement'],
        qualifying: ['qualification', 'qualifying'],
        qualified: ['qualification', 'qualified'],
        pitch_made: ['present offer', 'pitch'],
        objection_handling: ['handle objections', 'objection'],
        closing: ['close', 'closing'],
        booking: ['book call', 'booking'],
        booked: ['book call', 'pre-call nurture'],
        pre_call: ['pre-call nurture', 'pre-call'],
        on_call: ['pre-call nurture'],
        no_show: ['no-show recovery', 'no show'],
        post_call: ['post-call follow-up', 'post-call'],
        closed_deal: ['post-call follow-up']
      };

      const keywords = STAGE_TO_TITLE[reportedStage.toLowerCase()] || [];
      for (const kw of keywords) {
        matchedStep = script.steps.find((s) =>
          s.title.toLowerCase().includes(kw)
        );
        if (matchedStep) break;
      }
    }

    if (!matchedStep) {
      // Default to first step if no match found
      return;
    }

    // Upsert the position
    await prisma.leadScriptPosition.upsert({
      where: {
        leadId_scriptId: {
          leadId,
          scriptId: script.id
        }
      },
      create: {
        leadId,
        scriptId: script.id,
        currentStepId: matchedStep.id,
        status: 'active'
      },
      update: {
        currentStepId: matchedStep.id,
        currentBranchId: null // Reset branch on step change
      }
    });
  } catch (err) {
    // Non-fatal — don't break the conversation flow
    console.error('[lead-script-tracker] Failed to update position:', err);
  }
}
