import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/analytics/team — team performance metrics with activity heatmap data
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

    // Get all active team members
    const members = await prisma.user.findMany({
      where: { accountId: auth.accountId, isActive: true },
      select: {
        id: true,
        name: true,
        role: true,
        avatarUrl: true,
        leadsHandled: true,
        callsBooked: true,
        closeRate: true,
        commissionRate: true,
        totalCommission: true,
        avgResponseTime: true
      }
    });

    // Get message counts per user for activity heatmap
    // Group by hour-of-day and day-of-week
    const messageActivity = await prisma.message.findMany({
      where: {
        sender: { in: ['AI', 'HUMAN'] },
        conversation: {
          lead: { accountId: auth.accountId }
        },
        ...(hasDateFilter ? { timestamp: dateFilter } : {})
      },
      select: {
        sentByUserId: true,
        sender: true,
        timestamp: true
      }
    });

    // Build heatmap: { userId: { "day-hour": count } }
    const heatmapData: Record<string, Record<string, number>> = {};
    const memberMsgCounts: Record<string, number> = {};

    for (const msg of messageActivity) {
      const userId = msg.sentByUserId || '_ai';
      if (!heatmapData[userId]) heatmapData[userId] = {};
      if (!memberMsgCounts[userId]) memberMsgCounts[userId] = 0;

      const date = new Date(msg.timestamp);
      const dayOfWeek = date.getDay(); // 0=Sun, 6=Sat
      const hour = date.getHours();
      const key = `${dayOfWeek}-${hour}`;

      heatmapData[userId][key] = (heatmapData[userId][key] || 0) + 1;
      memberMsgCounts[userId]++;
    }

    // Calculate per-member stats
    const memberStats = members.map((m) => {
      const msgCount = memberMsgCounts[m.id] || 0;

      return {
        id: m.id,
        name: m.name,
        role: m.role,
        avatarUrl: m.avatarUrl,
        leadsHandled: m.leadsHandled,
        callsBooked: m.callsBooked,
        closeRate: m.closeRate,
        commissionRate: m.commissionRate,
        totalCommission: m.totalCommission,
        avgResponseTime: m.avgResponseTime,
        messagesSent: msgCount,
        heatmap: heatmapData[m.id] || {}
      };
    });

    // Sort by messages sent (most active first)
    memberStats.sort((a, b) => b.messagesSent - a.messagesSent);

    // Overall team heatmap (aggregate all users)
    const teamHeatmap: Record<string, number> = {};
    for (const userId of Object.keys(heatmapData)) {
      for (const [key, count] of Object.entries(heatmapData[userId])) {
        teamHeatmap[key] = (teamHeatmap[key] || 0) + count;
      }
    }

    return NextResponse.json({
      members: memberStats,
      teamHeatmap,
      totalMessages: messageActivity.length
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/analytics/team error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch team analytics' },
      { status: 500 }
    );
  }
}
