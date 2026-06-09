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

function formatTime(isoString: string, tz?: string): string {
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
function formatDate(isoString: string, tz?: string): string {
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

    const {
      provider,
      slots: rawSlots,
      timezone
    } = await getUnifiedAvailability(auth.accountId, startDate, endDate);

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
