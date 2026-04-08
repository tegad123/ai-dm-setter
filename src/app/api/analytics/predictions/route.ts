import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { predictBookingProbability } from '@/lib/booking-predictor';
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

const MIN_CONVERSATIONS = 200;

function anonymizeLeadId(leadId: string): string {
  const hash = createHash('sha256').update(leadId).digest('hex').slice(0, 6);
  return `Lead #${hash}`;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    // Check if an active model exists
    const activeModel = await prisma.predictionModel.findFirst({
      where: { accountId: auth.accountId, isActive: true }
    });

    if (!activeModel) {
      const resolvedCount = await prisma.conversation.count({
        where: {
          lead: { accountId: auth.accountId },
          outcome: { not: 'ONGOING' }
        }
      });

      return NextResponse.json({
        available: false,
        reason: 'No trained prediction model available',
        conversationsNeeded: Math.max(0, MIN_CONVERSATIONS - resolvedCount)
      });
    }

    // Get all ongoing conversations for this account
    const ongoingConversations = await prisma.conversation.findMany({
      where: {
        lead: { accountId: auth.accountId },
        outcome: 'ONGOING'
      },
      select: {
        id: true,
        leadId: true,
        // New 7-stage SOP sequence
        stageOpeningAt: true,
        stageSituationDiscoveryAt: true,
        stageGoalEmotionalWhyAt: true,
        stageUrgencyAt: true,
        stageSoftPitchCommitmentAt: true,
        stageFinancialScreeningAt: true,
        stageBookingAt: true
      }
    });

    const predictions = [];

    for (const convo of ongoingConversations) {
      try {
        const prediction = await predictBookingProbability(
          auth.accountId,
          convo.id
        );

        predictions.push({
          conversationId: convo.id,
          leadAnonymized: anonymizeLeadId(convo.leadId),
          probability: prediction.probability,
          confidence: prediction.confidence,
          stage: prediction.stage,
          velocity: prediction.velocity
        });
      } catch {
        // Skip conversations that fail prediction (e.g. insufficient messages)
        continue;
      }
    }

    // Sort by probability descending so highest-likelihood leads appear first
    predictions.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));

    return NextResponse.json({
      predictions,
      modelVersion: activeModel.version,
      modelAccuracy: activeModel.accuracy
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/analytics/predictions error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch booking predictions' },
      { status: 500 }
    );
  }
}
