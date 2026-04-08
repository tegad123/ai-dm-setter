import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { checkColdStart, DATA_THRESHOLDS } from '@/lib/cold-start';
import { NextRequest, NextResponse } from 'next/server';

// Ordered conversation stages with their timestamp fields
// New 7-stage SOP sequence — used for current velocity analysis.
const STAGE_FIELDS = [
  { stage: 'opening', field: 'stageOpeningAt' },
  { stage: 'situation_discovery', field: 'stageSituationDiscoveryAt' },
  { stage: 'goal_emotional_why', field: 'stageGoalEmotionalWhyAt' },
  { stage: 'urgency', field: 'stageUrgencyAt' },
  { stage: 'soft_pitch_commitment', field: 'stageSoftPitchCommitmentAt' },
  { stage: 'financial_screening', field: 'stageFinancialScreeningAt' },
  { stage: 'booking', field: 'stageBookingAt' }
] as const;

type StageField = (typeof STAGE_FIELDS)[number]['field'];

interface ConversationRow {
  outcome: string;
  stageOpeningAt: Date | null;
  stageSituationDiscoveryAt: Date | null;
  stageGoalEmotionalWhyAt: Date | null;
  stageUrgencyAt: Date | null;
  stageSoftPitchCommitmentAt: Date | null;
  stageFinancialScreeningAt: Date | null;
  stageBookingAt: Date | null;
}

interface StageVelocity {
  stage: string;
  avgTimeBooked: number | null;
  avgTimeGhosted: number | null;
  velocityRatio: number | null;
  sampleBooked: number;
  sampleGhosted: number;
}

function getStageTimestamp(
  conv: ConversationRow,
  field: StageField
): Date | null {
  return conv[field];
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const coldStart = await checkColdStart(
      auth.accountId,
      DATA_THRESHOLDS.FUNNEL_ANALYSIS
    );

    // Fetch resolved conversations with stage timestamps
    const conversations = (await prisma.conversation.findMany({
      where: {
        lead: { accountId: auth.accountId },
        outcome: { not: 'ONGOING' }
      },
      select: {
        outcome: true,
        stageOpeningAt: true,
        stageSituationDiscoveryAt: true,
        stageGoalEmotionalWhyAt: true,
        stageUrgencyAt: true,
        stageSoftPitchCommitmentAt: true,
        stageFinancialScreeningAt: true,
        stageBookingAt: true
      }
    })) as ConversationRow[];

    // For each consecutive stage pair, calculate time deltas split by outcome
    const stages: StageVelocity[] = [];

    for (let i = 0; i < STAGE_FIELDS.length - 1; i++) {
      const current = STAGE_FIELDS[i];
      const next = STAGE_FIELDS[i + 1];
      const label = `${current.stage} → ${next.stage}`;

      const bookedDeltas: number[] = [];
      const ghostedDeltas: number[] = [];

      for (const conv of conversations) {
        const currentTs = getStageTimestamp(conv, current.field);
        const nextTs = getStageTimestamp(conv, next.field);

        if (!currentTs || !nextTs) continue;

        const deltaSeconds = Math.abs(
          (nextTs.getTime() - currentTs.getTime()) / 1000
        );

        if (conv.outcome === 'BOOKED') {
          bookedDeltas.push(deltaSeconds);
        } else if (conv.outcome === 'LEFT_ON_READ') {
          ghostedDeltas.push(deltaSeconds);
        }
      }

      const avgTimeBooked =
        bookedDeltas.length > 0
          ? Math.round(
              bookedDeltas.reduce((a, b) => a + b, 0) / bookedDeltas.length
            )
          : null;

      const avgTimeGhosted =
        ghostedDeltas.length > 0
          ? Math.round(
              ghostedDeltas.reduce((a, b) => a + b, 0) / ghostedDeltas.length
            )
          : null;

      const velocityRatio =
        avgTimeBooked !== null && avgTimeGhosted !== null && avgTimeGhosted > 0
          ? parseFloat((avgTimeBooked / avgTimeGhosted).toFixed(4))
          : null;

      stages.push({
        stage: label,
        avgTimeBooked,
        avgTimeGhosted,
        velocityRatio,
        sampleBooked: bookedDeltas.length,
        sampleGhosted: ghostedDeltas.length
      });
    }

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
    console.error('Failed to fetch velocity analysis:', error);
    return NextResponse.json(
      { error: 'Failed to fetch velocity analysis data' },
      { status: 500 }
    );
  }
}
