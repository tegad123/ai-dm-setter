import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { Platform, Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET /api/leads/stage-counts
// Returns the TOTAL lead count per stage for the account, ignoring pagination.
//
// Why this exists: the Pipeline Kanban (pipeline-view.tsx) previously fetched
// a single page of leads (/api/leads caps at 100, newest-first) and grouped
// those into columns client-side. On accounts with thousands of leads, the
// 100 newest were all NEW_LEAD, so every other column rendered "No leads"
// even though qualified/booked leads existed further down the list — directly
// contradicting the Analytics funnel (which counts all rows). This endpoint
// gives the Kanban accurate per-stage totals so each column header is correct
// and the board can lazy-load each column's leads independently.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const { searchParams } = req.nextUrl;
    const platform = searchParams.get('platform') as Platform | null;
    const tag = searchParams.get('tag');

    const where: Prisma.LeadWhereInput = { accountId: auth.accountId };
    if (platform) where.platform = platform;
    if (tag) where.tags = { some: { tag: { name: tag } } };

    const grouped = await prisma.lead.groupBy({
      by: ['stage'],
      where,
      _count: { id: true }
    });

    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of grouped) {
      counts[row.stage] = row._count.id;
      total += row._count.id;
    }

    return NextResponse.json({ counts, total });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/leads/stage-counts error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stage counts' },
      { status: 500 }
    );
  }
}
