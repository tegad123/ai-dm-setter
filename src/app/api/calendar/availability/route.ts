import prisma from '@/lib/prisma';
import { getUnifiedAvailability } from '@/lib/calendar-adapter';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

interface FormattedSlot {
  start: string;
  end: string;
  display: string;
}

interface GroupedDay {
  date: string;
  times: FormattedSlot[];
}

function formatTime(isoString: string, tz?: string | null): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    ...(tz ? { timeZone: tz } : {}),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

// Day-key in the CALENDAR's timezone (not UTC). Grouping by UTC previously
// shifted late-evening slots onto the wrong day for west-of-UTC calendars.
function formatDate(isoString: string, tz?: string | null): string {
  const date = new Date(isoString);
  if (tz) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }
  return date.toISOString().split('T')[0]; // YYYY-MM-DD (UTC fallback)
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const { searchParams } = req.nextUrl;

    // Default to next 7 days if not provided
    const now = new Date();
    const defaultEnd = new Date(now);
    defaultEnd.setDate(defaultEnd.getDate() + 7);

    const startDate =
      searchParams.get('startDate') ?? now.toISOString().split('T')[0];
    const endDate =
      searchParams.get('endDate') ?? defaultEnd.toISOString().split('T')[0];

    // Account.timezone is the single source of truth. When set, it drives both
    // the slot fetch (request tz) and the grouping/display. When unset, we let
    // the provider resolve it and AUTO-SEED Account.timezone so it's persisted
    // going forward (and shared with the conversation/booking + reminders).
    const account = await prisma.account.findUnique({
      where: { id: auth.accountId },
      select: { timezone: true }
    });
    const accountTz = account?.timezone ?? undefined;

    const {
      provider,
      slots: rawSlots,
      timezone: providerTz
    } = await getUnifiedAvailability(
      auth.accountId,
      startDate,
      endDate,
      accountTz
    );

    // Effective display tz: account setting wins, else provider-resolved tz.
    const timezone = accountTz ?? providerTz ?? null;

    // Auto-seed Account.timezone from the provider's location tz when unset, so
    // the whole app converges on one source of truth without manual config.
    if (!accountTz && providerTz) {
      await prisma.account
        .update({
          where: { id: auth.accountId },
          data: { timezone: providerTz }
        })
        .catch((err) =>
          console.error(
            '[api/calendar/availability] auto-seed account tz failed (non-fatal):',
            err
          )
        );
    }

    // Group slots by date and format for display — in the CALENDAR's tz so the
    // grid columns/labels line up with the provider's actual business hours.
    const dayMap = new Map<string, FormattedSlot[]>();

    for (const slot of rawSlots) {
      const dateKey = formatDate(slot.start, timezone);
      const formatted: FormattedSlot = {
        start: slot.start,
        end: slot.end,
        display: slot.end
          ? `${formatTime(slot.start, timezone)} - ${formatTime(slot.end, timezone)}`
          : formatTime(slot.start, timezone)
      };

      if (!dayMap.has(dateKey)) {
        dayMap.set(dateKey, []);
      }
      dayMap.get(dateKey)!.push(formatted);
    }

    // Convert to sorted array
    const slots: GroupedDay[] = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, times]) => ({
        date,
        times: times.sort((a, b) => a.start.localeCompare(b.start))
      }));

    return NextResponse.json({ provider, slots, timezone: timezone ?? null });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/calendar/availability error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch availability' },
      { status: 500 }
    );
  }
}
