import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Cold-pitch / SPAM exclusion: Omar-style agency pitches that hit
    // the cold-pitch detector are tagged 'cold-pitch' and outcome=SPAM.
    // They count as their own bucket — not part of the regular Leads
    // Today / Total Leads numbers. Filter at the query level so every
    // KPI built off these counts inherits the exclusion.
    const excludeColdPitchTag = {
      tags: { none: { tag: { name: 'cold-pitch' } } }
    };
    const [
      totalLeads,
      leadsToday,
      leadsTodayFiltered,
      stageCounts,
      revenueResult
    ] = await Promise.all([
      prisma.lead.count({
        where: { accountId: auth.accountId, ...excludeColdPitchTag }
      }),
      prisma.lead.count({
        where: {
          accountId: auth.accountId,
          createdAt: { gte: todayStart },
          ...excludeColdPitchTag
        }
      }),
      prisma.lead.count({
        where: {
          accountId: auth.accountId,
          createdAt: { gte: todayStart },
          tags: { some: { tag: { name: 'cold-pitch' } } }
        }
      }),
      prisma.lead.groupBy({
        by: ['stage'],
        _count: { id: true },
        where: {
          accountId: auth.accountId,
          stage: {
            in: ['BOOKED', 'SHOWED', 'NO_SHOWED', 'CLOSED_WON']
          }
        }
      }),
      prisma.lead.aggregate({
        where: { accountId: auth.accountId },
        _sum: { revenue: true }
      })
    ]);

    const counts: Record<string, number> = {};
    for (const row of stageCounts) {
      counts[row.stage] = row._count.id;
    }

    const booked = counts['BOOKED'] || 0;
    const showedUp = counts['SHOWED'] || 0;
    const noShow = counts['NO_SHOWED'] || 0;
    const closed = counts['CLOSED_WON'] || 0;

    const callsBooked = booked + showedUp + noShow + closed;
    const showDenominator = callsBooked;
    const showRate =
      showDenominator > 0 ? ((showedUp + closed) / showDenominator) * 100 : 0;
    const closeDenominator = showedUp + closed;
    const closeRate =
      closeDenominator > 0 ? (closed / closeDenominator) * 100 : 0;
    const revenue = revenueResult._sum.revenue || 0;

    return NextResponse.json({
      totalLeads,
      leadsToday,
      // Separate count of cold-pitch / SPAM leads created today. Lets the
      // dashboard show "12 leads today (+3 filtered)" instead of hiding
      // the bucket entirely. Frontend optional — safe to ignore.
      leadsTodayFiltered,
      callsBooked,
      showRate: Math.round(showRate * 100) / 100,
      closeRate: Math.round(closeRate * 100) / 100,
      revenue
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch analytics overview:', error);
    return NextResponse.json(
      { error: 'Failed to fetch analytics overview' },
      { status: 500 }
    );
  }
}
