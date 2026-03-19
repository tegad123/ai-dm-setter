import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { checkColdStart, DATA_THRESHOLDS } from '@/lib/cold-start';
import { NextRequest, NextResponse } from 'next/server';

interface StageMetrics {
  stage: string;
  totalSent: number;
  gotResponseCount: number;
  responseRate: number;
  avgResponseTime: number | null;
  continuedCount: number;
  continuedRate: number;
  avgSentiment: number | null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    // Get all AI messages for this account's conversations
    const aiMessages = await prisma.message.findMany({
      where: {
        sender: 'AI',
        conversation: { lead: { accountId: auth.accountId } },
        stage: { not: null }
      },
      select: {
        id: true,
        conversationId: true,
        stage: true,
        gotResponse: true,
        responseTimeSeconds: true,
        leadContinuedConversation: true
      }
    });

    // Get sentiment scores from LEAD reply messages grouped by conversation
    const leadMessages = await prisma.message.findMany({
      where: {
        sender: 'LEAD',
        conversation: { lead: { accountId: auth.accountId } },
        sentimentScore: { not: null }
      },
      select: {
        conversationId: true,
        sentimentScore: true,
        stage: true
      }
    });

    // Build a map of stage -> lead sentiment scores
    const stageSentiments = new Map<string, number[]>();
    for (const msg of leadMessages) {
      const stage = msg.stage;
      if (stage && msg.sentimentScore !== null) {
        if (!stageSentiments.has(stage)) stageSentiments.set(stage, []);
        stageSentiments.get(stage)!.push(msg.sentimentScore);
      }
    }

    // Group AI messages by stage and compute metrics
    const stageMap = new Map<string, typeof aiMessages>();
    for (const msg of aiMessages) {
      const stage = msg.stage!;
      if (!stageMap.has(stage)) stageMap.set(stage, []);
      stageMap.get(stage)!.push(msg);
    }

    const stages: StageMetrics[] = Array.from(stageMap.entries()).map(
      ([stage, messages]) => {
        const totalSent = messages.length;
        const gotResponseCount = messages.filter(
          (m) => m.gotResponse === true
        ).length;
        const continuedCount = messages.filter(
          (m) => m.leadContinuedConversation === true
        ).length;

        const responseTimes = messages
          .map((m) => m.responseTimeSeconds)
          .filter((t): t is number => t !== null);

        const avgResponseTime =
          responseTimes.length > 0
            ? Math.round(
                responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
              )
            : null;

        const sentiments = stageSentiments.get(stage) || [];
        const avgSentiment =
          sentiments.length > 0
            ? parseFloat(
                (
                  sentiments.reduce((a, b) => a + b, 0) / sentiments.length
                ).toFixed(3)
              )
            : null;

        return {
          stage,
          totalSent,
          gotResponseCount,
          responseRate: totalSent > 0 ? gotResponseCount / totalSent : 0,
          avgResponseTime,
          continuedCount,
          continuedRate: totalSent > 0 ? continuedCount / totalSent : 0,
          avgSentiment
        };
      }
    );

    const coldStart = await checkColdStart(
      auth.accountId,
      DATA_THRESHOLDS.MESSAGE_EFFECTIVENESS
    );

    return NextResponse.json({
      stages,
      coldStart: {
        hasEnoughData: coldStart.hasEnoughData,
        liveCount: coldStart.liveCount,
        seedCount: coldStart.seedCount
      }
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch message effectiveness:', error);
    return NextResponse.json(
      { error: 'Failed to fetch message effectiveness data' },
      { status: 500 }
    );
  }
}
