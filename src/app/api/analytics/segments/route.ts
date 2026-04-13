import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { checkColdStart, DATA_THRESHOLDS } from '@/lib/cold-start';
import { NextRequest, NextResponse } from 'next/server';

interface SegmentMetric {
  segment: string;
  value: string;
  totalLeads: number;
  booked: number;
  bookingRate: number;
  showed: number;
  showRate: number;
  closed: number;
  closeRate: number;
  avgRevenue: number | null;
}

interface LeadRow {
  id: string;
  stage: string;
  showedUp: boolean;
  closedAt: Date | null;
  revenue: number | null;
  experience: string | null;
  incomeLevel: string | null;
  timezone: string | null;
  createdAt: Date;
  conversation: {
    leadSource: string | null;
    leadIntentTag: string;
    messages: { timestamp: Date }[];
  } | null;
}

function getTimeBucket(hour: number): string {
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 24) return 'evening';
  return 'night';
}

function getDayBucket(dayOfWeek: number): string {
  // 0 = Sunday, 6 = Saturday
  if (dayOfWeek === 0 || dayOfWeek === 6) return 'weekend';
  if (dayOfWeek === 5) return 'friday';
  return 'weekday';
}

function getTimezoneOffsetHours(tz: string): number {
  try {
    const now = new Date();
    const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
    const tzStr = now.toLocaleString('en-US', { timeZone: tz });
    const diffMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
    return diffMs / (1000 * 60 * 60);
  } catch {
    return 0;
  }
}

function computeMetrics(
  segment: string,
  value: string,
  leads: LeadRow[]
): SegmentMetric {
  const totalLeads = leads.length;
  const booked = leads.filter(
    (l) =>
      l.stage === 'BOOKED' ||
      l.stage === 'SHOWED' ||
      l.stage === 'NO_SHOWED' ||
      l.stage === 'CLOSED_WON'
  ).length;
  const showed = leads.filter(
    (l) => l.showedUp || l.stage === 'SHOWED' || l.stage === 'CLOSED_WON'
  ).length;
  const closed = leads.filter(
    (l) => l.stage === 'CLOSED_WON' && l.closedAt !== null
  ).length;
  const revenues = leads
    .filter((l) => l.revenue !== null && l.revenue !== undefined)
    .map((l) => l.revenue!);
  const avgRevenue =
    revenues.length > 0
      ? parseFloat(
          (revenues.reduce((a, b) => a + b, 0) / revenues.length).toFixed(2)
        )
      : null;

  return {
    segment,
    value,
    totalLeads,
    booked,
    bookingRate:
      totalLeads > 0 ? parseFloat((booked / totalLeads).toFixed(4)) : 0,
    showed,
    showRate: booked > 0 ? parseFloat((showed / booked).toFixed(4)) : 0,
    closed,
    closeRate: showed > 0 ? parseFloat((closed / showed).toFixed(4)) : 0,
    avgRevenue
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const coldStart = await checkColdStart(
      auth.accountId,
      DATA_THRESHOLDS.SEGMENT_ANALYSIS
    );

    // Fetch all leads with conversation and first message data
    const leads = (await prisma.lead.findMany({
      where: { accountId: auth.accountId },
      select: {
        id: true,
        stage: true,
        showedUp: true,
        closedAt: true,
        revenue: true,
        experience: true,
        incomeLevel: true,
        timezone: true,
        createdAt: true,
        conversation: {
          select: {
            leadSource: true,
            leadIntentTag: true,
            messages: {
              where: { sender: 'LEAD' },
              orderBy: { timestamp: 'asc' },
              take: 1,
              select: { timestamp: true }
            }
          }
        }
      }
    })) as LeadRow[];

    // ─── bySource ─────────────────────────────────────────
    const bySourceMap = new Map<string, LeadRow[]>();
    for (const lead of leads) {
      const source = lead.conversation?.leadSource;
      if (!source) continue;
      if (!bySourceMap.has(source)) bySourceMap.set(source, []);
      bySourceMap.get(source)!.push(lead);
    }
    const bySource = Array.from(bySourceMap.entries()).map(([value, group]) =>
      computeMetrics('bySource', value, group)
    );

    // ─── byIntent ─────────────────────────────────────────
    const byIntentMap = new Map<string, LeadRow[]>();
    for (const lead of leads) {
      const intent = lead.conversation?.leadIntentTag;
      if (!intent) continue;
      if (!byIntentMap.has(intent)) byIntentMap.set(intent, []);
      byIntentMap.get(intent)!.push(lead);
    }
    const byIntent = Array.from(byIntentMap.entries()).map(([value, group]) =>
      computeMetrics('byIntent', value, group)
    );

    // ─── byExperience ─────────────────────────────────────
    const byExperienceMap = new Map<string, LeadRow[]>();
    for (const lead of leads) {
      if (!lead.experience) continue;
      if (!byExperienceMap.has(lead.experience))
        byExperienceMap.set(lead.experience, []);
      byExperienceMap.get(lead.experience)!.push(lead);
    }
    const byExperience = Array.from(byExperienceMap.entries()).map(
      ([value, group]) => computeMetrics('byExperience', value, group)
    );

    // ─── byIncome ─────────────────────────────────────────
    const byIncomeMap = new Map<string, LeadRow[]>();
    for (const lead of leads) {
      if (!lead.incomeLevel) continue;
      if (!byIncomeMap.has(lead.incomeLevel))
        byIncomeMap.set(lead.incomeLevel, []);
      byIncomeMap.get(lead.incomeLevel)!.push(lead);
    }
    const byIncome = Array.from(byIncomeMap.entries()).map(([value, group]) =>
      computeMetrics('byIncome', value, group)
    );

    // ─── byTimeOfDay ──────────────────────────────────────
    const byTimeOfDayMap = new Map<string, LeadRow[]>();
    for (const lead of leads) {
      const firstMsg = lead.conversation?.messages?.[0];
      if (!firstMsg) continue;
      const msgDate = new Date(firstMsg.timestamp);
      let hour = msgDate.getUTCHours();
      if (lead.timezone) {
        const offset = getTimezoneOffsetHours(lead.timezone);
        hour = (hour + Math.round(offset) + 24) % 24;
      }
      const bucket = getTimeBucket(hour);
      if (!byTimeOfDayMap.has(bucket)) byTimeOfDayMap.set(bucket, []);
      byTimeOfDayMap.get(bucket)!.push(lead);
    }
    const byTimeOfDay = Array.from(byTimeOfDayMap.entries()).map(
      ([value, group]) => computeMetrics('byTimeOfDay', value, group)
    );

    // ─── byDayOfWeek ──────────────────────────────────────
    const byDayOfWeekMap = new Map<string, LeadRow[]>();
    for (const lead of leads) {
      const firstMsg = lead.conversation?.messages?.[0];
      if (!firstMsg) continue;
      const msgDate = new Date(firstMsg.timestamp);
      let adjustedDate = msgDate;
      if (lead.timezone) {
        const offset = getTimezoneOffsetHours(lead.timezone);
        adjustedDate = new Date(msgDate.getTime() + offset * 60 * 60 * 1000);
      }
      const dayOfWeek = adjustedDate.getUTCDay();
      const bucket = getDayBucket(dayOfWeek);
      if (!byDayOfWeekMap.has(bucket)) byDayOfWeekMap.set(bucket, []);
      byDayOfWeekMap.get(bucket)!.push(lead);
    }
    const byDayOfWeek = Array.from(byDayOfWeekMap.entries()).map(
      ([value, group]) => computeMetrics('byDayOfWeek', value, group)
    );

    return NextResponse.json({
      bySource,
      byIntent,
      byExperience,
      byIncome,
      byTimeOfDay,
      byDayOfWeek,
      coldStart: {
        hasEnoughData: coldStart.hasEnoughData,
        liveCount: coldStart.liveCount,
        seedCount: coldStart.seedCount
      }
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch segment analysis:', error);
    return NextResponse.json(
      { error: 'Failed to fetch segment analysis data' },
      { status: 500 }
    );
  }
}
