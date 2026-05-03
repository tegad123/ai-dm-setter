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
      revenueResult,
      mediaLogsToday,
      mediaLogsLastHour
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
      }),
      prisma.mediaProcessingLog.findMany({
        where: { accountId: auth.accountId, createdAt: { gte: todayStart } },
        select: { latencyMs: true, success: true, costUsd: true }
      }),
      prisma.mediaProcessingLog.findMany({
        where: {
          accountId: auth.accountId,
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }
        },
        select: { success: true }
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
    const successfulMediaToday = mediaLogsToday.filter((log) => log.success);
    const mediaLatencies = mediaLogsToday
      .map((log) => log.latencyMs)
      .sort((a, b) => a - b);
    const mediaSuccessRate =
      mediaLogsToday.length > 0
        ? (successfulMediaToday.length / mediaLogsToday.length) * 100
        : 100;
    const lastHourSuccessRate =
      mediaLogsLastHour.length > 0
        ? (mediaLogsLastHour.filter((log) => log.success).length /
            mediaLogsLastHour.length) *
          100
        : 100;
    const percentile = (values: number[], p: number) => {
      if (values.length === 0) return 0;
      const index = Math.min(
        values.length - 1,
        Math.max(0, Math.ceil((p / 100) * values.length) - 1)
      );
      return values[index];
    };
    const mediaCostUsd = mediaLogsToday.reduce(
      (sum, log) => sum + Number(log.costUsd ?? 0),
      0
    );

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
      revenue,
      mediaProcessing: {
        dailyVolume: mediaLogsToday.length,
        successRate: Math.round(mediaSuccessRate * 100) / 100,
        p50LatencyMs: percentile(mediaLatencies, 50),
        p95LatencyMs: percentile(mediaLatencies, 95),
        totalCostUsd: Math.round(mediaCostUsd * 1_000_000) / 1_000_000,
        lastHourSuccessRate: Math.round(lastHourSuccessRate * 100) / 100,
        alert: mediaLogsLastHour.length > 0 && lastHourSuccessRate < 95
      }
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
