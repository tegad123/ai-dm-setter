import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/analytics/commissions — commission breakdown per team member
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const { searchParams } = req.nextUrl;
    const from = searchParams.get('from');
    const to = searchParams.get('to');

    // Get all team members with commission rates
    const members = await prisma.user.findMany({
      where: { accountId: auth.accountId, isActive: true },
      select: {
        id: true,
        name: true,
        role: true,
        avatarUrl: true,
        commissionRate: true,
        totalCommission: true,
        callsBooked: true,
        leadsHandled: true
      },
      orderBy: { totalCommission: 'desc' }
    });

    // Get closed deals in the date range
    const dateFilter = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {})
    };
    const hasDateFilter = from || to;

    const closedDeals = await prisma.lead.findMany({
      where: {
        accountId: auth.accountId,
        stage: 'CLOSED_WON',
        revenue: { not: null },
        ...(hasDateFilter ? { closedAt: dateFilter } : {})
      },
      select: {
        id: true,
        name: true,
        revenue: true,
        closedAt: true
      },
      orderBy: { closedAt: 'desc' }
    });

    const totalRevenue = closedDeals.reduce(
      (sum, d) => sum + (d.revenue ?? 0),
      0
    );
    const totalCommissions = members.reduce(
      (sum, m) => sum + m.totalCommission,
      0
    );

    return NextResponse.json({
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        avatarUrl: m.avatarUrl,
        commissionRate: m.commissionRate,
        totalCommission: m.totalCommission,
        callsBooked: m.callsBooked,
        leadsHandled: m.leadsHandled
      })),
      recentDeals: closedDeals.slice(0, 20).map((d) => ({
        id: d.id,
        leadName: d.name,
        revenue: d.revenue,
        closedAt: d.closedAt?.toISOString() ?? null
      })),
      totals: {
        totalRevenue,
        totalCommissions,
        totalDeals: closedDeals.length
      }
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/analytics/commissions error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch commissions' },
      { status: 500 }
    );
  }
}
