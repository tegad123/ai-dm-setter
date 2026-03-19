import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { checkColdStart, DATA_THRESHOLDS } from '@/lib/cold-start';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const accountFilter = { lead: { accountId: auth.accountId } };
    const messageAccountFilter = {
      conversation: { lead: { accountId: auth.accountId } }
    };

    const [
      totalConversations,
      totalMessages,
      conversationsByOutcome,
      conversationsByDataSource,
      messagesWithStage,
      messagesWithSentiment,
      messagesWithResponseTracking,
      promptVersionsCount
    ] = await Promise.all([
      prisma.conversation.count({ where: accountFilter }),
      prisma.message.count({ where: messageAccountFilter }),

      // Conversations grouped by outcome
      prisma.conversation.groupBy({
        by: ['outcome'],
        where: accountFilter,
        _count: { _all: true }
      }),

      // Conversations grouped by dataSource
      prisma.conversation.groupBy({
        by: ['dataSource'],
        where: accountFilter,
        _count: { _all: true }
      }),

      // Messages with stage data
      prisma.message.count({
        where: { ...messageAccountFilter, stage: { not: null } }
      }),

      // Messages with sentiment data
      prisma.message.count({
        where: { ...messageAccountFilter, sentimentScore: { not: null } }
      }),

      // Messages with response tracking
      prisma.message.count({
        where: { ...messageAccountFilter, gotResponse: { not: null } }
      }),

      // Prompt versions count
      prisma.promptVersion.count({
        where: { accountId: auth.accountId }
      })
    ]);

    // Build outcome map
    const outcomeMap: Record<string, number> = {};
    for (const row of conversationsByOutcome) {
      outcomeMap[row.outcome] = row._count._all;
    }

    // Build dataSource map
    const dataSourceMap: Record<string, number> = {};
    for (const row of conversationsByDataSource) {
      dataSourceMap[row.dataSource] = row._count._all;
    }

    // Check cold start status for each threshold
    const thresholdEntries = Object.entries(DATA_THRESHOLDS) as [
      keyof typeof DATA_THRESHOLDS,
      number
    ][];
    const coldStartChecks = await Promise.all(
      thresholdEntries.map(async ([key, threshold]) => {
        const result = await checkColdStart(auth.accountId, threshold);
        return [key, result] as const;
      })
    );

    const coldStartStatus: Record<
      string,
      Awaited<ReturnType<typeof checkColdStart>>
    > = {};
    for (const [key, result] of coldStartChecks) {
      coldStartStatus[key] = result;
    }

    return NextResponse.json({
      totalConversations,
      totalMessages,
      conversationsByOutcome: outcomeMap,
      conversationsByDataSource: dataSourceMap,
      messageQuality: {
        withStage: messagesWithStage,
        withSentiment: messagesWithSentiment,
        withResponseTracking: messagesWithResponseTracking,
        total: totalMessages
      },
      coldStartStatus,
      promptVersionsCount
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch data quality:', error);
    return NextResponse.json(
      { error: 'Failed to fetch data quality metrics' },
      { status: 500 }
    );
  }
}
