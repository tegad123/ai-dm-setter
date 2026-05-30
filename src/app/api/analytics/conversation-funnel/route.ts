import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// New 7-stage SOP sequence — current funnel
const STAGES = [
  { key: 'stageOpeningAt', label: 'Opening' },
  { key: 'stageSituationDiscoveryAt', label: 'Situation Discovery' },
  { key: 'stageGoalEmotionalWhyAt', label: 'Goal / Emotional Why' },
  { key: 'stageUrgencyAt', label: 'Urgency' },
  { key: 'stageSoftPitchCommitmentAt', label: 'Soft Pitch / Commitment' },
  { key: 'stageFinancialScreeningAt', label: 'Financial Screening' },
  { key: 'stageBookingAt', label: 'Booking' }
] as const;

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const conversations = await prisma.conversation.findMany({
      where: { lead: { accountId: auth.accountId } },
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
    });

    const total = conversations.length;

    // QD-041 fix (2026-05-30): the funnel chart used to count "reached" over
    // ALL conversations, which meant any account with imported / pre-SOP
    // conversations saw the chart sit at zero (those rows have all stage*At
    // null by definition). Restrict the funnel to conversations that have
    // actually entered the SOP — at least one stage timestamp populated —
    // and report the excluded count so the UI can label "showing 12 of 22".
    const inFunnel = conversations.filter((c) =>
      STAGES.some(({ key }) => c[key] !== null)
    );
    const funnelDenominator = inFunnel.length;
    const excludedPreSop = total - funnelDenominator;

    const reachedCounts = STAGES.map(
      ({ key }) => inFunnel.filter((c) => c[key] !== null).length
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

    // Count conversations by outcome (over the full set — outcome is set for
    // every conversation regardless of whether it walked the new SOP).
    const outcomes: Record<string, number> = {};
    for (const c of conversations) {
      outcomes[c.outcome] = (outcomes[c.outcome] || 0) + 1;
    }

    return NextResponse.json({
      stages,
      outcomes,
      total,
      // The funnel denominator — count of conversations actually in the SOP
      // funnel — so the UI can show a meaningful "showing N of M" label
      // instead of a mysteriously zero chart.
      funnelDenominator,
      excludedPreSop
    });
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
