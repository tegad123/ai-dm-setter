import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Conversation State Machine — transition outcomes based on lead behaviour
// ---------------------------------------------------------------------------

const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;

/**
 * Evaluate and update the outcome of a conversation.
 *
 * Transition rules (only from ONGOING):
 *  - ONGOING → BOOKED:                   lead.status === 'BOOKED' or lead.bookedAt !== null
 *  - ONGOING → LEFT_ON_READ:             No lead message for 72+ hours after last AI message
 *  - ONGOING → UNQUALIFIED_REDIRECT:     lead.status === 'UNQUALIFIED'
 *  - ONGOING → RESISTANT_EXIT:           Last 2 lead messages have sentimentScore < -0.5
 *  - ONGOING → SOFT_OBJECTION:           lead.status is SERIOUS_NOT_READY and no response 72h
 *  - ONGOING → PRICE_QUESTION_DEFLECTED: lead.status is MONEY_OBJECTION and no response 72h
 *
 * Re-engagement (handled in webhook-processor when saving a LEAD message):
 *  - LEFT_ON_READ → ONGOING
 */
export async function updateConversationOutcome(
  conversationId: string
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      lead: true,
      messages: {
        orderBy: { timestamp: 'desc' },
        take: 10
      }
    }
  });

  if (!conversation) return;

  // Only transition from ONGOING
  if (conversation.outcome !== 'ONGOING') return;

  const { lead, messages } = conversation;
  const now = Date.now();

  // --- BOOKED ---
  if (lead.status === 'BOOKED' || lead.bookedAt !== null) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { outcome: 'BOOKED' }
    });
    return;
  }

  // --- UNQUALIFIED_REDIRECT ---
  if (lead.status === 'UNQUALIFIED') {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { outcome: 'UNQUALIFIED_REDIRECT' }
    });
    return;
  }

  // --- RESISTANT_EXIT: last 2 lead messages both have sentimentScore < -0.5 ---
  const recentLeadMessages = messages.filter((m) => m.sender === 'LEAD');
  if (recentLeadMessages.length >= 2) {
    const lastTwo = recentLeadMessages.slice(0, 2);
    const bothNegative = lastTwo.every(
      (m) => m.sentimentScore !== null && m.sentimentScore < -0.5
    );
    if (bothNegative) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { outcome: 'RESISTANT_EXIT' }
      });
      return;
    }
  }

  // --- Time-based transitions: check for 72h gap after last AI message ---
  const lastAIMessage = messages.find((m) => m.sender === 'AI');
  const lastLeadMessage = messages.find((m) => m.sender === 'LEAD');

  if (lastAIMessage) {
    const lastAITime = lastAIMessage.timestamp.getTime();
    const lastLeadTime = lastLeadMessage
      ? lastLeadMessage.timestamp.getTime()
      : 0;

    // Lead has NOT replied since the last AI message, and 72h has passed
    const noReplyFor72h =
      lastLeadTime < lastAITime && now - lastAITime >= SEVENTY_TWO_HOURS_MS;

    if (noReplyFor72h) {
      // --- SOFT_OBJECTION ---
      if (lead.status === 'SERIOUS_NOT_READY') {
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { outcome: 'SOFT_OBJECTION' }
        });
        return;
      }

      // --- PRICE_QUESTION_DEFLECTED ---
      if (lead.status === 'MONEY_OBJECTION') {
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { outcome: 'PRICE_QUESTION_DEFLECTED' }
        });
        return;
      }

      // --- LEFT_ON_READ (generic 72h no-reply) ---
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { outcome: 'LEFT_ON_READ' }
      });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Record the timestamp when a conversation first reaches a given stage
// ---------------------------------------------------------------------------

const STAGE_FIELD_MAP: Record<string, keyof typeof STAGE_FIELDS> = {};

// We use a helper object so TypeScript knows the valid field names
const STAGE_FIELDS = {
  stageQualificationAt: true,
  stageVisionBuildingAt: true,
  stagePainIdentificationAt: true,
  stageUrgencyAt: true,
  stageSolutionOfferAt: true,
  stageCapitalQualificationAt: true,
  stageBookingAt: true
} as const;

type StageField = keyof typeof STAGE_FIELDS;

/**
 * Maps an AI stage name (e.g. "Stage 2 — Qualification") to a conversation
 * timestamp field and sets it — but only if the field is currently null.
 */
export async function recordStageTimestamp(
  conversationId: string,
  stage: string
): Promise<void> {
  const stageLower = stage.toLowerCase();
  let field: StageField | null = null;

  if (stageLower.includes('qualification') || stageLower.includes('stage 2')) {
    field = 'stageQualificationAt';
  } else if (stageLower.includes('vision')) {
    field = 'stageVisionBuildingAt';
  } else if (stageLower.includes('pain')) {
    field = 'stagePainIdentificationAt';
  } else if (stageLower.includes('urgency')) {
    field = 'stageUrgencyAt';
  } else if (
    stageLower.includes('solution') ||
    stageLower.includes('free value') ||
    stageLower.includes('stage 3')
  ) {
    field = 'stageSolutionOfferAt';
  } else if (stageLower.includes('capital')) {
    field = 'stageCapitalQualificationAt';
  } else if (stageLower.includes('booking') || stageLower.includes('stage 4')) {
    field = 'stageBookingAt';
  }

  if (!field) return;

  // Only set if currently null
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { [field]: true }
  });

  if (!conversation || conversation[field] !== null) return;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { [field]: new Date() }
  });
}
