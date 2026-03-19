import { getAvailability } from '@/lib/leadconnector';
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

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
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

    const rawSlots = await getAvailability(auth.accountId, startDate, endDate);

    // Group slots by date and format for display
    const dayMap = new Map<string, FormattedSlot[]>();

    for (const slot of rawSlots) {
      const dateKey = formatDate(slot.start);
      const formatted: FormattedSlot = {
        start: slot.start,
        end: slot.end,
        display: `${formatTime(slot.start)} - ${formatTime(slot.end)}`
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

    return NextResponse.json({ slots });
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
