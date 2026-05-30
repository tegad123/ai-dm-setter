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
      // QD-039 fix (2026-05-30): the meaningful denominator for the
      // "data quality" ratio is AI-pipeline messages, not every message
      // ever sent. LEAD messages have no stage by design, and supportive /
      // handoff / distress messages explicitly set stage=null. Counting
      // them in the denominator made the ratio approach 0 even on healthy
      // accounts (QD-039: "With Stage Data: 0" despite 22 conversations).
      // Switch the denominator to AI messages and the numerator to AI
      // messages with stage data — that's the real "% of generated
      // messages we have stage telemetry on" question.
      aiMessageCount,
      conversationsByOutcome,
      conversationsByDataSource,
      messagesWithStage,
      messagesWithSentiment,
      messagesWithResponseTracking,
      promptVersionsCount
    ] = await Promise.all([
      prisma.conversation.count({ where: accountFilter }),
      prisma.message.count({ where: messageAccountFilter }),
      prisma.message.count({
        where: { ...messageAccountFilter, sender: 'AI' }
      }),

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

      // AI messages with stage data (QD-039: was counting ALL messages)
      prisma.message.count({
        where: {
          ...messageAccountFilter,
          sender: 'AI',
          stage: { not: null }
        }
      }),

      // AI messages with sentiment data
      prisma.message.count({
        where: {
          ...messageAccountFilter,
          sender: 'AI',
          sentimentScore: { not: null }
        }
      }),

      // AI messages with response tracking
      prisma.message.count({
        where: {
          ...messageAccountFilter,
          sender: 'AI',
          gotResponse: { not: null }
        }
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
        // Denominator changed (QD-039 fix): AI-pipeline messages, not every
        // message. Surfaced as `trackable` so older UIs reading `total` still
        // get a number that means "total messages" — and new UIs reading
        // `trackable` get the meaningful ratio denominator.
        total: totalMessages,
        trackable: aiMessageCount
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
