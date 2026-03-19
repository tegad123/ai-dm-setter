import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const leads = await prisma.lead.findMany({
      where: {
        accountId: auth.accountId,
        revenue: { gt: 0 },
        closedAt: { not: null }
      },
      select: {
        revenue: true,
        closedAt: true
      },
      orderBy: { closedAt: 'asc' }
    });

    // Group by month
    const monthMap: Record<string, number> = {};
    for (const lead of leads) {
      if (!lead.closedAt || !lead.revenue) continue;
      const month = lead.closedAt.toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric'
      });
      monthMap[month] = (monthMap[month] || 0) + lead.revenue;
    }

    const data = Object.entries(monthMap).map(([month, revenue]) => ({
      month,
      revenue: Math.round(revenue * 100) / 100
    }));

    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch revenue data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch revenue data' },
      { status: 500 }
    );
  }
}
