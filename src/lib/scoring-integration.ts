/**
 * Scoring Integration Hook — QualifyDMs
 *
 * Wires the lead scoring engine into two places:
 *
 * 1. AFTER each message exchange:
 *    - Recomputes qualityScore and priorityScore
 *    - Backfills effectiveness metrics on previous AI message
 *    - Auto-tags the lead
 *    - Fires escalation notifications if triggered
 *
 * 2. BEFORE each AI reply generation:
 *    - Injects scoring context into the system prompt
 *    - So the AI adapts its behavior to lead temperature
 *
 * USAGE:
 *
 *   // After receiving a lead message:
 *   await runPostMessageScoring(conversationId, leadId, accountId, leadMessageTimestamp);
 *
 *   // Before generating AI reply, add to system prompt:
 *   const scoringContext = await getScoringContextForPrompt(conversationId, leadId, accountId);
 *   const fullPrompt = basePrompt + '\n\n' + scoringContext;
 */

import {
  computeLeadScore,
  backfillMessageEffectiveness,
  generateScoringContextForPrompt,
  type ScoringResult
} from '@/lib/lead-scoring-engine';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Post-Message Scoring Hook
// ---------------------------------------------------------------------------

/**
 * Call this AFTER processing an incoming lead message.
 * Non-blocking — errors here should NOT break the conversation flow.
 */
export async function runPostMessageScoring(
  conversationId: string,
  leadId: string,
  accountId: string,
  leadMessageTimestamp?: Date
): Promise<ScoringResult | null> {
  try {
    // 1. Backfill effectiveness data on the AI message this is replying to
    if (leadMessageTimestamp) {
      await backfillMessageEffectiveness(conversationId, leadMessageTimestamp);
    }

    // 2. Compute fresh scores
    const result = await computeLeadScore({
      conversationId,
      leadId,
      accountId
    });

    // 3. Fire notifications for escalation triggers
    if (result.shouldEscalateToHuman) {
      await fireEscalationNotification(
        accountId,
        leadId,
        conversationId,
        result
      );
    }

    // 4. Fire notification for newly hot leads
    if (
      result.temperatureLabel === 'ON_FIRE' ||
      result.temperatureLabel === 'HOT'
    ) {
      await fireHotLeadNotification(accountId, leadId, result);
    }

    // 5. Log scoring event for the self-optimizing layer
    console.log(
      `[Scoring] Lead ${leadId}: quality=${result.qualityScore} priority=${result.priorityScore} ` +
        `temp=${result.temperatureLabel} intent=${result.intentTag}` +
        (result.shouldEscalateToHuman
          ? ` ⚠️ ESCALATE: ${result.escalationReason}`
          : '')
    );

    return result;
  } catch (error) {
    console.error('[Scoring] Post-message scoring failed (non-fatal):', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pre-Reply Scoring Context
// ---------------------------------------------------------------------------

/**
 * Call this BEFORE generating an AI reply.
 * Returns a string to append to the system prompt so the AI
 * adapts its behavior based on lead temperature.
 */
export async function getScoringContextForPrompt(
  conversationId: string,
  leadId: string,
  accountId: string
): Promise<string> {
  try {
    const result = await computeLeadScore({
      conversationId,
      leadId,
      accountId
    });
    return generateScoringContextForPrompt(result);
  } catch (error) {
    console.error(
      '[Scoring] Failed to generate scoring context (non-fatal):',
      error
    );
    return ''; // Return empty string — AI will work without scoring context
  }
}

// ---------------------------------------------------------------------------
// Post-AI-Reply Scoring Hook
// ---------------------------------------------------------------------------

/**
 * Call this AFTER the AI generates a reply and it's stored in the DB.
 * Updates stage timestamps on the conversation when new stages are reached.
 */
export async function runPostAIReplyScoring(
  conversationId: string,
  stage: string | null
): Promise<void> {
  if (!stage) return;

  try {
    // Map stage to conversation timestamp field
    const stageFieldMap: Record<string, string> = {
      // New 7-stage SOP sequence
      OPENING: 'stageOpeningAt',
      SITUATION_DISCOVERY: 'stageSituationDiscoveryAt',
      GOAL_EMOTIONAL_WHY: 'stageGoalEmotionalWhyAt',
      URGENCY: 'stageUrgencyAt',
      SOFT_PITCH_COMMITMENT: 'stageSoftPitchCommitmentAt',
      FINANCIAL_SCREENING: 'stageFinancialScreeningAt',
      BOOKING: 'stageBookingAt',
      // Legacy stage names (backward compat for historical data)
      GREETING: 'stageOpeningAt',
      QUALIFICATION: 'stageQualificationAt',
      VISION_BUILDING: 'stageVisionBuildingAt',
      PAIN_IDENTIFICATION: 'stagePainIdentificationAt',
      SOLUTION_OFFER: 'stageSolutionOfferAt',
      CAPITAL_QUALIFICATION: 'stageCapitalQualificationAt'
    };

    const field = stageFieldMap[stage];
    if (!field) return;

    // Only set if not already set (first time reaching this stage)
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { [field]: true }
    });

    if (conversation && !(conversation as any)[field]) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { [field]: new Date() }
      });
    }
  } catch (error) {
    console.error('[Scoring] Post-AI-reply scoring failed (non-fatal):', error);
  }
}

// ---------------------------------------------------------------------------
// Notification Helpers
// ---------------------------------------------------------------------------

async function fireEscalationNotification(
  accountId: string,
  leadId: string,
  conversationId: string,
  result: ScoringResult
): Promise<void> {
  try {
    // Check if we already sent an escalation notification for this lead recently
    const recentNotification = await prisma.notification.findFirst({
      where: {
        accountId,
        leadId,
        type: 'HUMAN_OVERRIDE_NEEDED',
        createdAt: { gte: new Date(Date.now() - 4 * 60 * 60 * 1000) } // Within 4 hours
      }
    });

    if (recentNotification) return; // Don't spam

    await prisma.notification.create({
      data: {
        accountId,
        leadId,
        type: 'HUMAN_OVERRIDE_NEEDED',
        title: '🚨 Lead needs human attention',
        body: `${result.escalationReason} (Score: ${result.qualityScore}/100, ${result.temperatureLabel})`
      }
    });
  } catch (error) {
    console.error('[Scoring] Failed to create escalation notification:', error);
  }
}

async function fireHotLeadNotification(
  accountId: string,
  leadId: string,
  result: ScoringResult
): Promise<void> {
  try {
    // Only notify once per lead becoming hot
    const existingHotNotification = await prisma.notification.findFirst({
      where: {
        accountId,
        leadId,
        type: 'HOT_LEAD'
      }
    });

    if (existingHotNotification) return;

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { name: true, handle: true }
    });

    await prisma.notification.create({
      data: {
        accountId,
        leadId,
        type: 'HOT_LEAD',
        title: `🔥 ${result.temperatureLabel} lead detected`,
        body: `${lead?.name || lead?.handle} scored ${result.qualityScore}/100 — ${result.intentTag}`
      }
    });
  } catch (error) {
    console.error('[Scoring] Failed to create hot lead notification:', error);
  }
}

// ---------------------------------------------------------------------------
// Batch Rescoring (for cron jobs or manual triggers)
// ---------------------------------------------------------------------------

/**
 * Rescore all active conversations for an account.
 * Useful for: initial setup, after persona changes, or periodic recalibration.
 */
export async function batchRescoreAccount(accountId: string): Promise<{
  scored: number;
  errors: number;
}> {
  const conversations = await prisma.conversation.findMany({
    where: {
      lead: { accountId },
      outcome: 'ONGOING'
    },
    include: {
      lead: { select: { id: true } }
    }
  });

  let scored = 0;
  let errors = 0;

  for (const conv of conversations) {
    try {
      await computeLeadScore({
        conversationId: conv.id,
        leadId: conv.lead.id,
        accountId
      });
      scored++;
    } catch {
      errors++;
    }
  }

  console.log(
    `[Scoring] Batch rescore complete for account ${accountId}: ${scored} scored, ${errors} errors`
  );
  return { scored, errors };
}
