import prisma from '@/lib/prisma';
import { isQualityGateEscalationError } from '@/lib/quality-gate-escalation';

export interface DeliveredAiMessageEvidence {
  id: string;
  timestamp: Date;
  platformMessageId: string;
}

interface FindDeliveredAiMessageInput {
  conversationId: string;
  since: Date;
}

interface MarkScheduledReplySentInput {
  scheduledReplyId: string;
  deliveredMessage: DeliveredAiMessageEvidence;
  error: unknown;
}

interface ClearAttemptQualityHoldInput {
  conversationId: string;
  awaitingSince: Date;
  escalatedAt: Date;
}

export interface ScheduledReplyDeliveryReconciliationDependencies {
  findDeliveredAiMessage(
    input: FindDeliveredAiMessageInput
  ): Promise<DeliveredAiMessageEvidence | null>;
  markScheduledReplySent(input: MarkScheduledReplySentInput): Promise<void>;
  clearAttemptQualityHold(input: ClearAttemptQualityHoldInput): Promise<number>;
}

export interface ReconcileScheduledReplyAfterErrorInput {
  scheduledReplyId: string;
  conversationId: string;
  scheduledReplyCreatedAt: Date;
  reviewHoldExistedBeforeAttempt: boolean | null;
  error: unknown;
}

export interface ReconciledScheduledReplyDelivery {
  deliveredMessage: DeliveredAiMessageEvidence;
  clearedAttemptQualityHold: boolean;
}

/**
 * A reply can be delivered by a concurrent inline worker, sibling queue row,
 * or recovery path while this worker is still running. Only a native Meta MID
 * at or after the scheduled turn's causal boundary proves that this turn was
 * answered. An older AI message is not delivery evidence for the current row.
 */
export function scheduledReplyDeliveryCausalStart(input: {
  scheduledReplyCreatedAt: Date;
  error: unknown;
}): Date {
  const qualityAwaitingSince = isQualityGateEscalationError(input.error)
    ? input.error.awaitingSince
    : null;

  if (
    qualityAwaitingSince &&
    qualityAwaitingSince instanceof Date &&
    qualityAwaitingSince.getTime() > input.scheduledReplyCreatedAt.getTime()
  ) {
    return qualityAwaitingSince;
  }

  return input.scheduledReplyCreatedAt;
}

function errorLabel(error: unknown): string {
  if (isQualityGateEscalationError(error)) return error.code;
  if (error instanceof Error && error.name) return error.name;
  return 'processing error';
}

const defaultDependencies: ScheduledReplyDeliveryReconciliationDependencies = {
  async findDeliveredAiMessage({ conversationId, since }) {
    const message = await prisma.message.findFirst({
      where: {
        conversationId,
        sender: 'AI',
        platformMessageId: { not: null },
        timestamp: { gte: since }
      },
      orderBy: { timestamp: 'asc' },
      select: {
        id: true,
        timestamp: true,
        platformMessageId: true
      }
    });
    if (!message?.platformMessageId) return null;
    return {
      id: message.id,
      timestamp: message.timestamp,
      platformMessageId: message.platformMessageId
    };
  },

  async markScheduledReplySent({ scheduledReplyId, deliveredMessage, error }) {
    await prisma.scheduledReply.update({
      where: { id: scheduledReplyId },
      data: {
        status: 'SENT',
        processedAt: new Date(),
        lastError:
          `delivered by another path with Meta MID ${deliveredMessage.platformMessageId} ` +
          `before ${errorLabel(error)} was reconciled (no duplicate sent)`
      }
    });
  },

  async clearAttemptQualityHold({
    conversationId,
    awaitingSince,
    escalatedAt
  }) {
    const cleared = await prisma.conversation.updateMany({
      where: {
        id: conversationId,
        awaitingHumanReview: true,
        distressDetected: false,
        awaitingSince,
        lastSilentStopAt: escalatedAt
      },
      data: {
        awaitingHumanReview: false,
        awaitingAiResponse: false,
        awaitingSince: null
      }
    });
    return cleared.count;
  }
};

/**
 * Reconcile a processing error against durable delivery evidence before the
 * caller persists a terminal failure. The quality hold is cleared only when:
 *
 * 1. this is a quality-gate exception;
 * 2. no review hold existed before this processing attempt; and
 * 3. the current database hold still matches this attempt's timestamps.
 *
 * This deliberately preserves distress and unrelated/older operator holds.
 */
export async function reconcileScheduledReplyAfterError(
  input: ReconcileScheduledReplyAfterErrorInput,
  dependencies: ScheduledReplyDeliveryReconciliationDependencies = defaultDependencies
): Promise<ReconciledScheduledReplyDelivery | null> {
  const causalStart = scheduledReplyDeliveryCausalStart({
    scheduledReplyCreatedAt: input.scheduledReplyCreatedAt,
    error: input.error
  });
  const deliveredMessage = await dependencies.findDeliveredAiMessage({
    conversationId: input.conversationId,
    since: causalStart
  });
  if (!deliveredMessage?.platformMessageId) return null;

  await dependencies.markScheduledReplySent({
    scheduledReplyId: input.scheduledReplyId,
    deliveredMessage,
    error: input.error
  });

  let clearedAttemptQualityHold = false;
  if (
    isQualityGateEscalationError(input.error) &&
    input.reviewHoldExistedBeforeAttempt === false &&
    input.error.awaitingSince instanceof Date &&
    input.error.escalatedAt instanceof Date
  ) {
    // Delivery truth is already durable at this point. A best-effort hold
    // cleanup failure must not make the caller overwrite SENT with a terminal
    // failure. The exact timestamp predicates make a later retry safe.
    clearedAttemptQualityHold = await dependencies
      .clearAttemptQualityHold({
        conversationId: input.conversationId,
        awaitingSince: input.error.awaitingSince,
        escalatedAt: input.error.escalatedAt
      })
      .then((count) => count > 0)
      .catch((error) => {
        console.error(
          '[scheduled-reply-reconciliation] delivered reply was marked SENT, but its attempt-created quality hold could not be cleared:',
          error
        );
        return false;
      });
  }

  return { deliveredMessage, clearedAttemptQualityHold };
}
