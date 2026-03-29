import prisma from '@/lib/prisma';

export interface EffectivenessResult {
  stage: string;
  totalMessages: number;
  responseRate: number;
  avgResponseTime: number;
  continuationRate: number;
  topPerformingMessages: Array<{
    content: string;
    responseRate: number;
    avgResponseTime: number;
  }>;
}

/**
 * Calculate message effectiveness metrics by conversation stage.
 */
export async function calculateMessageEffectiveness(
  accountId: string,
  stage?: string
): Promise<EffectivenessResult[]> {
  const where: any = {
    conversation: { lead: { accountId } },
    sender: 'AI',
    gotResponse: { not: null }
  };

  if (stage) {
    where.stage = stage;
  }

  const messages = await prisma.message.findMany({
    where,
    select: {
      stage: true,
      content: true,
      gotResponse: true,
      responseTimeSeconds: true,
      leadContinuedConversation: true
    }
  });

  // Group by stage
  const byStage = new Map<string, typeof messages>();
  for (const msg of messages) {
    const s = msg.stage || 'UNKNOWN';
    if (!byStage.has(s)) byStage.set(s, []);
    byStage.get(s)!.push(msg);
  }

  const results: EffectivenessResult[] = [];

  for (const [stageName, msgs] of Array.from(byStage.entries())) {
    const total = msgs.length;
    const responded = msgs.filter((m) => m.gotResponse === true).length;
    const continued = msgs.filter((m) => m.leadContinuedConversation === true).length;
    const responseTimes = msgs
      .filter((m) => m.responseTimeSeconds !== null)
      .map((m) => m.responseTimeSeconds!);

    const avgResponseTime =
      responseTimes.length > 0
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
        : 0;

    results.push({
      stage: stageName,
      totalMessages: total,
      responseRate: total > 0 ? responded / total : 0,
      avgResponseTime: Math.round(avgResponseTime),
      continuationRate: total > 0 ? continued / total : 0,
      topPerformingMessages: [] // Simplified
    });
  }

  return results.sort((a, b) => b.responseRate - a.responseRate);
}
