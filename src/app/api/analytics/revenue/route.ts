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

    // Group by month. Key on YYYY-MM so months sort chronologically and the
    // value is a real parseable date (first of the month) — the chart does
    // `new Date(point.date)`, so a "Jun 2026" string would render "Invalid
    // Date". (QD-038 follow-up)
    const monthMap = new Map<string, number>();
    for (const lead of leads) {
      if (!lead.closedAt || !lead.revenue) continue;
      const y = lead.closedAt.getUTCFullYear();
      const m = String(lead.closedAt.getUTCMonth() + 1).padStart(2, '0');
      const key = `${y}-${m}`;
      monthMap.set(key, (monthMap.get(key) || 0) + lead.revenue);
    }

    // Emit { date, revenue, cumulative } (matches the RevenuePoint type and
    // the Area chart). Running total because the card shows cumulative revenue.
    let cumulative = 0;
    const data = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, revenue]) => {
        const monthly = Math.round(revenue * 100) / 100;
        cumulative = Math.round((cumulative + monthly) * 100) / 100;
        return {
          date: `${key}-01T00:00:00.000Z`, // first of the month, ISO
          revenue: monthly,
          cumulative
        };
      });

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
