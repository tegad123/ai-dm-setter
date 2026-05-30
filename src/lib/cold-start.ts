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
 * Check if an account has enough data for an analytics feature.
 *
 * `thresholdOverride` lets callers gate against a feature-specific message
 * threshold (e.g. MESSAGE_EFFECTIVENESS=30, SEGMENT_ANALYSIS=20) instead of
 * the default MIN_MESSAGES=50. QD-040 fix (2026-05-30): this parameter used
 * to be `_thresholdOverride` (silently ignored), so /api/analytics/data-quality
 * called it once per threshold key and got the same result every time —
 * surfacing as "Cold Start Thresholds 0/50, 0/30, 0/20".
 */
export async function checkColdStart(
  accountId: string,
  thresholdOverride?: number
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

  // The message-count threshold honors the override; conversation thresholds
  // stay at defaults (the override historically only ever scaled a message-
  // count cutoff per analytics feature).
  const messageThreshold = thresholdOverride ?? DATA_THRESHOLDS.MIN_MESSAGES;

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
  if (messageCount < messageThreshold) {
    missingRequirements.push(
      `Need ${messageThreshold - messageCount} more messages`
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
