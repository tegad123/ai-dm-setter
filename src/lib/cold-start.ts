import prisma from '@/lib/prisma';

/**
 * Minimum data thresholds for various analytics features.
 */
export const DATA_THRESHOLDS = {
  MIN_CONVERSATIONS: 10,
  MIN_COMPLETED_CONVERSATIONS: 5,
  MIN_MESSAGES: 50,
  MIN_DAYS_ACTIVE: 3,
  MIN_LEADS_FOR_SEGMENTS: 20,
  MIN_AI_MESSAGES_FOR_EFFECTIVENESS: 30,
  MIN_SEQUENCES_FOR_ANALYSIS: 10,
  MIN_PREDICTIONS_TRAINING: 30,
  MESSAGE_EFFECTIVENESS: 30,
  SEGMENT_ANALYSIS: 20,
  FUNNEL_ANALYSIS: 15
};

export interface ColdStartStatus {
  ready: boolean;
  hasEnoughData: boolean;
  conversationCount: number;
  completedConversationCount: number;
  messageCount: number;
  daysActive: number;
  liveCount: number;
  seedCount: number;
  missingRequirements: string[];
}

/**
 * Check if an account has enough data for analytics features.
 */
export async function checkColdStart(
  accountId: string,
  _thresholdOverride?: number
): Promise<ColdStartStatus> {
  const [conversationCount, completedCount, messageCount, oldestLead] =
    await Promise.all([
      prisma.conversation.count({
        where: { lead: { accountId } }
      }),
      prisma.conversation.count({
        where: {
          lead: { accountId },
          outcome: { not: 'ONGOING' }
        }
      }),
      prisma.message.count({
        where: { conversation: { lead: { accountId } } }
      }),
      prisma.lead.findFirst({
        where: { accountId },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true }
      })
    ]);

  const daysActive = oldestLead
    ? Math.floor(
        (Date.now() - new Date(oldestLead.createdAt).getTime()) /
          (1000 * 60 * 60 * 24)
      )
    : 0;

  const missingRequirements: string[] = [];
  if (conversationCount < DATA_THRESHOLDS.MIN_CONVERSATIONS) {
    missingRequirements.push(
      `Need ${DATA_THRESHOLDS.MIN_CONVERSATIONS - conversationCount} more conversations`
    );
  }
  if (completedCount < DATA_THRESHOLDS.MIN_COMPLETED_CONVERSATIONS) {
    missingRequirements.push(
      `Need ${DATA_THRESHOLDS.MIN_COMPLETED_CONVERSATIONS - completedCount} more completed conversations`
    );
  }
  if (messageCount < DATA_THRESHOLDS.MIN_MESSAGES) {
    missingRequirements.push(
      `Need ${DATA_THRESHOLDS.MIN_MESSAGES - messageCount} more messages`
    );
  }

  return {
    ready: missingRequirements.length === 0,
    hasEnoughData: missingRequirements.length === 0,
    conversationCount,
    completedConversationCount: completedCount,
    messageCount,
    daysActive,
    liveCount: conversationCount,
    seedCount: 0,
    missingRequirements
  };
}
