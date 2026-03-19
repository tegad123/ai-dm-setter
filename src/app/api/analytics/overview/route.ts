import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [totalLeads, leadsToday, statusCounts, revenueResult] =
      await Promise.all([
        prisma.lead.count({ where: { accountId: auth.accountId } }),
        prisma.lead.count({
          where: { accountId: auth.accountId, createdAt: { gte: todayStart } }
        }),
        prisma.lead.groupBy({
          by: ['status'],
          _count: { id: true },
          where: {
            accountId: auth.accountId,
            status: {
              in: ['BOOKED', 'SHOWED_UP', 'NO_SHOW', 'CLOSED']
            }
          }
        }),
        prisma.lead.aggregate({
          where: { accountId: auth.accountId },
          _sum: { revenue: true }
        })
      ]);

    const counts: Record<string, number> = {};
    for (const row of statusCounts) {
      counts[row.status] = row._count.id;
    }

    const booked = counts['BOOKED'] || 0;
    const showedUp = counts['SHOWED_UP'] || 0;
    const noShow = counts['NO_SHOW'] || 0;
    const closed = counts['CLOSED'] || 0;

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
