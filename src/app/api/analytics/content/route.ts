import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/analytics/content — content performance analytics
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const { searchParams } = req.nextUrl;
    const from = searchParams.get('from');
    const to = searchParams.get('to');

    const dateFilter = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {})
    };

    const hasDateFilter = from || to;

    // Top content by leads
    const topByLeads = await prisma.contentAttribution.findMany({
      where: {
        accountId: auth.accountId,
        ...(hasDateFilter ? { createdAt: dateFilter } : {})
      },
      orderBy: { leadsCount: 'desc' },
      take: 10,
      select: {
        id: true,
        contentType: true,
        caption: true,
        platform: true,
        leadsCount: true,
        revenue: true,
        callsBooked: true,
        postedAt: true
      }
    });

    // Top content by revenue
    const topByRevenue = await prisma.contentAttribution.findMany({
      where: {
        accountId: auth.accountId,
        revenue: { gt: 0 },
        ...(hasDateFilter ? { createdAt: dateFilter } : {})
      },
      orderBy: { revenue: 'desc' },
      take: 10,
      select: {
        id: true,
        contentType: true,
        caption: true,
        platform: true,
        leadsCount: true,
        revenue: true,
        callsBooked: true,
        postedAt: true
      }
    });

    // Breakdown by content type
    const byType = await prisma.contentAttribution.groupBy({
      by: ['contentType'],
      where: {
        accountId: auth.accountId,
        ...(hasDateFilter ? { createdAt: dateFilter } : {})
      },
      _sum: { leadsCount: true, revenue: true, callsBooked: true },
      _count: true
    });

    const typeBreakdown = byType.map((t) => ({
      contentType: t.contentType,
      contentCount: t._count,
      leadsCount: t._sum.leadsCount ?? 0,
      revenue: t._sum.revenue ?? 0,
      callsBooked: t._sum.callsBooked ?? 0
    }));

    // Breakdown by platform
    const byPlatform = await prisma.contentAttribution.groupBy({
      by: ['platform'],
      where: {
        accountId: auth.accountId,
        ...(hasDateFilter ? { createdAt: dateFilter } : {})
      },
      _sum: { leadsCount: true, revenue: true, callsBooked: true },
      _count: true
    });

    const platformBreakdown = byPlatform.map((p) => ({
      platform: p.platform,
      contentCount: p._count,
      leadsCount: p._sum.leadsCount ?? 0,
      revenue: p._sum.revenue ?? 0,
      callsBooked: p._sum.callsBooked ?? 0
    }));

    return NextResponse.json({
      topByLeads,
      topByRevenue,
      typeBreakdown,
      platformBreakdown
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/analytics/content error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch content analytics' },
      { status: 500 }
    );
  }
}
