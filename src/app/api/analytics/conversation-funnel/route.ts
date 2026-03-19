import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

const STAGES = [
  { key: 'stageQualificationAt', label: 'Qualification' },
  { key: 'stageVisionBuildingAt', label: 'Vision Building' },
  { key: 'stagePainIdentificationAt', label: 'Pain Identification' },
  { key: 'stageUrgencyAt', label: 'Urgency' },
  { key: 'stageSolutionOfferAt', label: 'Solution Offer' },
  { key: 'stageCapitalQualificationAt', label: 'Capital Qualification' },
  { key: 'stageBookingAt', label: 'Booking' }
] as const;

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const conversations = await prisma.conversation.findMany({
      where: { lead: { accountId: auth.accountId } },
      select: {
        outcome: true,
        stageQualificationAt: true,
        stageVisionBuildingAt: true,
        stagePainIdentificationAt: true,
        stageUrgencyAt: true,
        stageSolutionOfferAt: true,
        stageCapitalQualificationAt: true,
        stageBookingAt: true
      }
    });

    const total = conversations.length;

    // Count how many conversations reached each stage
    const reachedCounts = STAGES.map(
      ({ key }) => conversations.filter((c) => c[key] !== null).length
    );

    // Build stages array with dropOff calculated as reached_this - reached_next
    const stages = STAGES.map(({ label }, i) => {
      const reached = reachedCounts[i];
      const nextReached =
        i < reachedCounts.length - 1 ? reachedCounts[i + 1] : reached;
      return {
        stage: label,
        reached,
        dropOff: reached - nextReached
      };
    });

    // Count conversations by outcome
    const outcomes: Record<string, number> = {};
    for (const c of conversations) {
      outcomes[c.outcome] = (outcomes[c.outcome] || 0) + 1;
    }

    return NextResponse.json({ stages, outcomes, total });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch conversation funnel:', error);
    return NextResponse.json(
      { error: 'Failed to fetch conversation funnel data' },
      { status: 500 }
    );
  }
}
