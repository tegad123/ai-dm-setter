import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';
import { ContentType, Platform } from '@prisma/client';

// GET /api/content — list content attributions with metrics
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const { searchParams } = req.nextUrl;
    const contentType = searchParams.get('contentType') as ContentType | null;
    const platform = searchParams.get('platform') as Platform | null;
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const sortBy = searchParams.get('sortBy') || 'leadsCount'; // leadsCount, revenue, callsBooked, createdAt
    const order = searchParams.get('order') || 'desc';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.max(
      1,
      Math.min(50, parseInt(searchParams.get('limit') || '20', 10))
    );
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      accountId: auth.accountId
    };

    if (contentType) where.contentType = contentType;
    if (platform) where.platform = platform;
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {})
      };
    }

    // Validate sortBy
    const validSortFields = [
      'leadsCount',
      'revenue',
      'callsBooked',
      'createdAt',
      'postedAt'
    ];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'leadsCount';

    const [content, total] = await Promise.all([
      prisma.contentAttribution.findMany({
        where,
        include: {
          _count: { select: { leads: true } }
        },
        orderBy: { [sortField]: order === 'asc' ? 'asc' : 'desc' },
        skip,
        take: limit
      }),
      prisma.contentAttribution.count({ where })
    ]);

    // Calculate conversion rate for each piece
    const result = content.map((c) => ({
      id: c.id,
      contentType: c.contentType,
      contentId: c.contentId,
      contentUrl: c.contentUrl,
      caption: c.caption,
      platform: c.platform,
      leadsCount: c.leadsCount,
      actualLeadsCount: c._count.leads,
      revenue: c.revenue,
      callsBooked: c.callsBooked,
      conversionRate:
        c.leadsCount > 0 ? Math.round((c.callsBooked / c.leadsCount) * 100) : 0,
      postedAt: c.postedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString()
    }));

    // Aggregate totals
    const totals = await prisma.contentAttribution.aggregate({
      where: { accountId: auth.accountId },
      _sum: { leadsCount: true, revenue: true, callsBooked: true }
    });

    return NextResponse.json({
      content: result,
      total,
      page,
      limit,
      totals: {
        totalLeads: totals._sum.leadsCount ?? 0,
        totalRevenue: totals._sum.revenue ?? 0,
        totalCallsBooked: totals._sum.callsBooked ?? 0
      }
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/content error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch content attributions' },
      { status: 500 }
    );
  }
}
