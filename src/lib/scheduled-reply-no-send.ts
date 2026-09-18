import prisma from '@/lib/prisma';

export const SUGGESTION_ONLY_MARKER =
  'suggestion_only: generated, not auto-sent (auto-send off for this conversation)';

export const NEAR_DUPLICATE_ANSWERED_MARKER =
  'suppressed:near_duplicate_answered';

export type ScheduledReplyNoSendReason =
  | 'suggestion_only'
  | 'near_duplicate_answered';

export interface ScheduledReplyNoSendOutcome {
  reason: ScheduledReplyNoSendReason;
  marker: string;
}

export interface ScheduledReplyTerminalRow {
  status: string;
  lastError: string | null;
}

export function isScheduledReplyNoSendForLeadTurn(
  row: (ScheduledReplyTerminalRow & { createdAt: Date }) | null,
  lastLeadAt: Date
): boolean {
  return Boolean(
    row && row.createdAt >= lastLeadAt && parseScheduledReplyNoSendOutcome(row)
  );
}

export interface NearDuplicateSuppressionPersistence {
  persist(input: {
    conversationId: string;
    scheduledReplyId?: string;
    processedAt: Date;
    marker: string;
  }): Promise<void>;
}

export function buildNearDuplicateSuppressionMutation(
  conversationId: string,
  processedAt: Date,
  scheduledReplyId: string,
  marker = NEAR_DUPLICATE_ANSWERED_MARKER
) {
  return {
    scheduledReply: {
      where: {
        conversationId,
        id: scheduledReplyId,
        status: {
          in: ['PENDING', 'PROCESSING'] as Array<'PENDING' | 'PROCESSING'>
        }
      },
      data: {
        status: 'CANCELLED' as const,
        processedAt,
        lastError: marker
      }
    },
    conversation: {
      where: { id: conversationId },
      data: {
        awaitingAiResponse: false,
        awaitingSince: null
      }
    }
  };
}

const prismaNearDuplicateSuppressionPersistence: NearDuplicateSuppressionPersistence =
  {
    async persist({ conversationId, scheduledReplyId, processedAt, marker }) {
      if (!scheduledReplyId) {
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { awaitingAiResponse: false, awaitingSince: null }
        });
        return;
      }

      const mutation = buildNearDuplicateSuppressionMutation(
        conversationId,
        processedAt,
        scheduledReplyId,
        marker
      );
      await prisma.$transaction(async (tx) => {
        const cancelled = await tx.scheduledReply.updateMany(
          mutation.scheduledReply
        );
        if (cancelled.count !== 1) {
          throw new Error('scheduled_reply_no_longer_active');
        }
        await tx.conversation.update(mutation.conversation);
      });
    }
  };

export function parseScheduledReplyNoSendOutcome(
  row: ScheduledReplyTerminalRow | null
): ScheduledReplyNoSendOutcome | null {
  if (row?.status !== 'CANCELLED') return null;

  if ((row.lastError ?? '').startsWith('suggestion_only:')) {
    return { reason: 'suggestion_only', marker: row.lastError! };
  }
  if ((row.lastError ?? '').startsWith(NEAR_DUPLICATE_ANSWERED_MARKER)) {
    return { reason: 'near_duplicate_answered', marker: row.lastError! };
  }
  return null;
}

export async function scheduledReplyTerminalNoSendOutcome(
  scheduledReplyId: string
): Promise<ScheduledReplyNoSendOutcome | null> {
  try {
    const row = await prisma.scheduledReply.findUnique({
      where: { id: scheduledReplyId },
      select: { status: true, lastError: true }
    });
    return parseScheduledReplyNoSendOutcome(row);
  } catch {
    return null;
  }
}

/**
 * Persist a genuine near-duplicate suppression as a successful no-send.
 * The queue row and conversation flags change atomically so a crash cannot
 * leave a terminal row looking like an unanswered conversation (or vice versa).
 */
export async function recordNearDuplicateAnsweredSuppression(
  conversationId: string,
  scheduledReplyId?: string,
  persistence: NearDuplicateSuppressionPersistence = prismaNearDuplicateSuppressionPersistence
): Promise<void> {
  const processedAt = new Date();
  await persistence.persist({
    conversationId,
    scheduledReplyId,
    processedAt,
    marker: NEAR_DUPLICATE_ANSWERED_MARKER
  });
}
