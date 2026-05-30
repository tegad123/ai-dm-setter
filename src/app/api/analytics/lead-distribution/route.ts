// ---------------------------------------------------------------------------
// GET /api/analytics/lead-distribution
// ---------------------------------------------------------------------------
// Per-stage lead count for the current account. Powers the Lead Distribution
// donut on /dashboard/overview — each segment is a distinct LeadStage with
// its own color in the UI. Differs from /api/analytics/funnel which returns
// nested cumulative buckets (totalLeads ⊃ qualified ⊃ booked ⊃ …); this
// endpoint returns the partition: every lead lands in exactly one bucket.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { EXCLUDE_COLD_PITCH } from '@/lib/lead-state-sets';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    // F8 reconciliation: exclude cold-pitch leads from the Lead Distribution
    // pie so the home-page donut matches Overview + Funnel. Cold-pitch leads
    // remain visible (and tag-filterable) on the Leads page.
    const grouped = await prisma.lead.groupBy({
      by: ['stage'],
      where: { accountId: auth.accountId, ...EXCLUDE_COLD_PITCH },
      _count: { _all: true }
    });

    const stages = grouped.map((row) => ({
      stage: row.stage,
      count: row._count._all
    }));
    const total = stages.reduce((acc, s) => acc + s.count, 0);

    return NextResponse.json({ stages, total });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch lead distribution:', error);
    return NextResponse.json(
      { error: 'Failed to fetch lead distribution' },
      { status: 500 }
    );
  }
}
