import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const leads = await prisma.lead.findMany({
      where: { accountId: auth.accountId, createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' }
    });

    // Group by date string
    const dateMap: Record<string, number> = {};
    for (const lead of leads) {
      const date = lead.createdAt.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      });
      dateMap[date] = (dateMap[date] || 0) + 1;
    }

    const data = Object.entries(dateMap).map(([date, count]) => ({
      date,
      count
    }));

    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch lead volume:', error);
    return NextResponse.json(
      { error: 'Failed to fetch lead volume' },
      { status: 500 }
    );
  }
}
