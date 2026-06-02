import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET /api/calendar/scheduled-calls?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
//
// Returns the account's booked calls in the given range so the Calendar week
// grid can overlay them on top of provider availability. A "booked call" is a
// Conversation with a scheduledCallAt timestamp inside the window.
// ---------------------------------------------------------------------------

interface ScheduledCall {
  conversationId: string;
  leadName: string;
  start: string; // ISO
  timezone: string | null;
  outcome: string | null;
  confirmed: boolean;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const { searchParams } = req.nextUrl;

    const now = new Date();
    const defaultEnd = new Date(now);
    defaultEnd.setDate(defaultEnd.getDate() + 7);

    const startDate =
      searchParams.get('startDate') ?? now.toISOString().split('T')[0];
    const endDate =
      searchParams.get('endDate') ?? defaultEnd.toISOString().split('T')[0];

    // Inclusive of the whole end day.
    const rangeStart = new Date(`${startDate}T00:00:00.000Z`);
    const rangeEnd = new Date(`${endDate}T23:59:59.999Z`);

    const conversations = await prisma.conversation.findMany({
      where: {
        lead: { accountId: auth.accountId },
        scheduledCallAt: { gte: rangeStart, lte: rangeEnd }
      },
      select: {
        id: true,
        scheduledCallAt: true,
        scheduledCallTimezone: true,
        callOutcome: true,
        callConfirmed: true,
        lead: { select: { name: true } }
      },
      orderBy: { scheduledCallAt: 'asc' }
    });

    const calls: ScheduledCall[] = conversations
      .filter((c) => c.scheduledCallAt)
      .map((c) => ({
        conversationId: c.id,
        leadName: c.lead?.name || 'Lead',
        start: c.scheduledCallAt!.toISOString(),
        timezone: c.scheduledCallTimezone,
        outcome: c.callOutcome,
        confirmed: c.callConfirmed
      }));

    return NextResponse.json({ calls });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/calendar/scheduled-calls error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch scheduled calls' },
      { status: 500 }
    );
  }
}
