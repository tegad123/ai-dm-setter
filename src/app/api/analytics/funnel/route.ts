import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import {
  QUALIFIED_LEAD_STAGES_ARR,
  BOOKED_LEAD_STAGES_ARR,
  SHOWED_LEAD_STAGES_ARR,
  EXCLUDE_COLD_PITCH
} from '@/lib/lead-state-sets';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    // F8 reconciliation (2026-05-30): every count uses the canonical lead-state
    // sets + shared cold-pitch exclusion so Funnel matches Overview and the
    // Conversations tab. Previously this route hardcoded 3 different stage
    // arrays (qualified included NURTURE; no cold-pitch filter anywhere).
    const baseWhere = { accountId: auth.accountId, ...EXCLUDE_COLD_PITCH };

    const [totalLeads, qualified, booked, showedUp, closed] = await Promise.all(
      [
        prisma.lead.count({ where: baseWhere }),
        prisma.lead.count({
          where: { ...baseWhere, stage: { in: QUALIFIED_LEAD_STAGES_ARR } }
        }),
        prisma.lead.count({
          where: { ...baseWhere, stage: { in: BOOKED_LEAD_STAGES_ARR } }
        }),
        prisma.lead.count({
          where: { ...baseWhere, stage: { in: SHOWED_LEAD_STAGES_ARR } }
        }),
        prisma.lead.count({
          where: { ...baseWhere, stage: 'CLOSED_WON' }
        })
      ]
    );

    return NextResponse.json({
      totalLeads,
      qualified,
      booked,
      showedUp,
      closed
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch funnel data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch funnel data' },
      { status: 500 }
    );
  }
}
