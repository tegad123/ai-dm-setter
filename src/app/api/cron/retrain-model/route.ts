import prisma from '@/lib/prisma';
import { trainModel } from '@/lib/booking-predictor';
import { NextRequest, NextResponse } from 'next/server';

const MIN_CONVERSATIONS = 200;

export async function GET(req: NextRequest) {
  try {
    // Validate bearer token against CRON_SECRET env var
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find all accounts that have enough resolved conversations
    const accountCounts = await prisma.conversation.groupBy({
      by: ['leadId'],
      where: { outcome: { not: 'ONGOING' } },
      _count: true
    });

    // We need account-level counts, so aggregate through leads
    const accountConvoCount: Record<string, number> = {};

    // Batch fetch leads to get their accountIds
    const leadIds = accountCounts.map((ac) => ac.leadId);
    const leads = await prisma.lead.findMany({
      where: { id: { in: leadIds } },
      select: { id: true, accountId: true }
    });

    const leadAccountLookup: Record<string, string> = {};
    for (const lead of leads) {
      leadAccountLookup[lead.id] = lead.accountId;
    }

    for (const entry of accountCounts) {
      const accountId = leadAccountLookup[entry.leadId];
      if (!accountId) continue;
      accountConvoCount[accountId] =
        (accountConvoCount[accountId] || 0) + entry._count;
    }

    let accountsTrained = 0;
    let modelsCreated = 0;

    // Train models for eligible accounts
    const accountIds = Object.keys(accountConvoCount);
    for (let i = 0; i < accountIds.length; i++) {
      const accountId = accountIds[i];
      const count = accountConvoCount[accountId];
      if (count < MIN_CONVERSATIONS) continue;

      try {
        await trainModel(accountId);
        accountsTrained++;
        modelsCreated++;
      } catch (error) {
        console.error(`Failed to train model for account ${accountId}:`, error);
      }
    }

    // Back-fill actualOutcome on PredictionLog entries where the conversation has resolved
    const unfilledPredictions = await prisma.predictionLog.findMany({
      where: { actualOutcome: null },
      select: { id: true, conversationId: true }
    });

    const conversationIds = Array.from(
      new Set(unfilledPredictions.map((p) => p.conversationId))
    );

    const resolvedConversations = await prisma.conversation.findMany({
      where: {
        id: { in: conversationIds },
        outcome: { not: 'ONGOING' }
      },
      select: { id: true, outcome: true }
    });

    const outcomeLookup: Record<string, string> = {};
    for (const convo of resolvedConversations) {
      outcomeLookup[convo.id] = convo.outcome;
    }

    let predictionsBackfilled = 0;

    for (const prediction of unfilledPredictions) {
      const outcome = outcomeLookup[prediction.conversationId];
      if (!outcome) continue;

      await prisma.predictionLog.update({
        where: { id: prediction.id },
        data: { actualOutcome: outcome }
      });
      predictionsBackfilled++;
    }

    return NextResponse.json({
      accountsTrained,
      modelsCreated,
      predictionsBackfilled
    });
  } catch (error) {
    console.error('GET /api/cron/retrain-model error:', error);
    return NextResponse.json(
      { error: 'Failed to run model retraining cron' },
      { status: 500 }
    );
  }
}
