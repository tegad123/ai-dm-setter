import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { checkColdStart, DATA_THRESHOLDS } from '@/lib/cold-start';
import { NextRequest, NextResponse } from 'next/server';

// Stage fields in logical conversation order, with readable labels
// New 7-stage SOP sequence (primary) + legacy fields for historical data
const STAGE_ENTRIES = [
  // New 7-stage SOP sequence
  { label: 'opening', field: 'stageOpeningAt' },
  { label: 'situation_discovery', field: 'stageSituationDiscoveryAt' },
  { label: 'goal_emotional_why', field: 'stageGoalEmotionalWhyAt' },
  { label: 'urgency', field: 'stageUrgencyAt' },
  { label: 'soft_pitch_commitment', field: 'stageSoftPitchCommitmentAt' },
  { label: 'financial_screening', field: 'stageFinancialScreeningAt' },
  { label: 'booking', field: 'stageBookingAt' },
  // Legacy fields (backward compat for historical conversations)
  { label: 'qualification', field: 'stageQualificationAt' },
  { label: 'vision_building', field: 'stageVisionBuildingAt' },
  { label: 'pain_identification', field: 'stagePainIdentificationAt' },
  { label: 'solution_offer', field: 'stageSolutionOfferAt' },
  { label: 'capital_qualification', field: 'stageCapitalQualificationAt' }
] as const;

type StageField = (typeof STAGE_ENTRIES)[number]['field'];

interface ConversationRow {
  outcome: string;
  // New 7-stage SOP sequence
  stageOpeningAt: Date | null;
  stageSituationDiscoveryAt: Date | null;
  stageGoalEmotionalWhyAt: Date | null;
  stageUrgencyAt: Date | null;
  stageSoftPitchCommitmentAt: Date | null;
  stageFinancialScreeningAt: Date | null;
  stageBookingAt: Date | null;
  // Legacy fields
  stageQualificationAt: Date | null;
  stageVisionBuildingAt: Date | null;
  stagePainIdentificationAt: Date | null;
  stageSolutionOfferAt: Date | null;
  stageCapitalQualificationAt: Date | null;
  _count: { messages: number };
}

interface SequenceResult {
  sequence: string;
  count: number;
  booked: number;
  bookingRate: number;
  avgMessages: number;
}

function getStageTimestamp(
  conv: ConversationRow,
  field: StageField
): Date | null {
  return conv[field];
}

function buildSequenceString(conv: ConversationRow): string {
  // Collect stages that were reached (have a timestamp), ordered by their timestamp
  const reached: { label: string; timestamp: Date }[] = [];

  for (const entry of STAGE_ENTRIES) {
    const ts = getStageTimestamp(conv, entry.field);
    if (ts) {
      reached.push({ label: entry.label, timestamp: ts });
    }
  }

  // Sort by actual timestamp order
  reached.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Build the sequence: opener → stages... → outcome
  const parts = ['opener', ...reached.map((r) => r.label)];

  // Append the outcome as the terminal node
  const outcomeLabel = conv.outcome.toLowerCase().replace(/_/g, '_');
  parts.push(outcomeLabel);

  return parts.join(' → ');
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const coldStart = await checkColdStart(
      auth.accountId,
      DATA_THRESHOLDS.FUNNEL_ANALYSIS
    );

    // Fetch all resolved conversations with stage timestamps and message counts
    const conversations = (await prisma.conversation.findMany({
      where: {
        lead: { accountId: auth.accountId },
        outcome: { not: 'ONGOING' }
      },
      select: {
        outcome: true,
        // New 7-stage SOP sequence
        stageOpeningAt: true,
        stageSituationDiscoveryAt: true,
        stageGoalEmotionalWhyAt: true,
        stageUrgencyAt: true,
        stageSoftPitchCommitmentAt: true,
        stageFinancialScreeningAt: true,
        stageBookingAt: true,
        // Legacy fields
        stageQualificationAt: true,
        stageVisionBuildingAt: true,
        stagePainIdentificationAt: true,
        stageSolutionOfferAt: true,
        stageCapitalQualificationAt: true,
        _count: { select: { messages: true } }
      }
    })) as ConversationRow[];

    // Group by sequence string
    const sequenceMap = new Map<
      string,
      { count: number; booked: number; totalMessages: number }
    >();

    for (const conv of conversations) {
      const seq = buildSequenceString(conv);
      const existing = sequenceMap.get(seq) || {
        count: 0,
        booked: 0,
        totalMessages: 0
      };

      existing.count += 1;
      if (conv.outcome === 'BOOKED') existing.booked += 1;
      existing.totalMessages += conv._count.messages;

      sequenceMap.set(seq, existing);
    }

    // Convert to array, sort by count descending, take top 20
    const sequences: SequenceResult[] = Array.from(sequenceMap.entries())
      .map(([sequence, data]) => ({
        sequence,
        count: data.count,
        booked: data.booked,
        bookingRate:
          data.count > 0
            ? parseFloat((data.booked / data.count).toFixed(4))
            : 0,
        avgMessages:
          data.count > 0
            ? parseFloat((data.totalMessages / data.count).toFixed(1))
            : 0
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return NextResponse.json({
      sequences,
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
    console.error('Failed to fetch sequence analysis:', error);
    return NextResponse.json(
      { error: 'Failed to fetch sequence analysis data' },
      { status: 500 }
    );
  }
}
