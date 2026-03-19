import prisma from '@/lib/prisma';

export interface ColdStartCheck {
  hasEnoughData: boolean;
  liveCount: number;
  seedCount: number;
  totalResolved: number;
  minimumRequired: number;
}

export async function checkColdStart(
  accountId: string,
  minimumRequired: number = 20
): Promise<ColdStartCheck> {
  // Count resolved conversations (not ONGOING) by data source
  // Need to join through Lead to get accountId
  const [live, seed] = await Promise.all([
    prisma.conversation.count({
      where: {
        lead: { accountId },
        dataSource: 'LIVE',
        outcome: { not: 'ONGOING' }
      }
    }),
    prisma.conversation.count({
      where: { lead: { accountId }, dataSource: 'SEED' }
    })
  ]);

  const totalResolved = live + seed;
  return {
    hasEnoughData: totalResolved >= minimumRequired,
    liveCount: live,
    seedCount: seed,
    totalResolved,
    minimumRequired
  };
}

// Minimum thresholds from the spec
export const DATA_THRESHOLDS = {
  MESSAGE_EFFECTIVENESS: 30, // per message pattern
  FUNNEL_ANALYSIS: 50, // total conversations
  AB_TEST_RESULTS: 30, // per variant
  OPTIMIZATION_SUGGESTIONS: 100, // total conversations
  BOOKING_PREDICTION: 200, // historical conversations
  SEGMENT_ANALYSIS: 20 // per segment
} as const;
