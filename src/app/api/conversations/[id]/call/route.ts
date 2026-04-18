import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import {
  scheduleCallReminders,
  cancelCallReminders
} from '@/lib/call-reminders';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET /api/conversations/:id/call
// Returns the scheduled call details + upcoming reminders for the convo.
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { accountId: auth.accountId } },
      select: {
        id: true,
        scheduledCallAt: true,
        scheduledCallTimezone: true,
        scheduledCallSource: true,
        scheduledCallConfirmed: true,
        scheduledCallNote: true,
        scheduledCallUpdatedAt: true,
        scheduledCallUpdatedBy: true,
        leadTimezone: true
      }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Active reminder rows (PENDING only — fired/cancelled aren't useful here)
    const reminders = await prisma.scheduledMessage.findMany({
      where: {
        conversationId: id,
        status: 'PENDING',
        messageType: { in: ['DAY_BEFORE_REMINDER', 'MORNING_OF_REMINDER'] }
      },
      orderBy: { scheduledFor: 'asc' },
      select: {
        id: true,
        messageType: true,
        scheduledFor: true,
        relatedCallAt: true
      }
    });

    return NextResponse.json({
      scheduledCallAt: conversation.scheduledCallAt?.toISOString() ?? null,
      scheduledCallTimezone: conversation.scheduledCallTimezone,
      scheduledCallSource: conversation.scheduledCallSource,
      scheduledCallConfirmed: conversation.scheduledCallConfirmed,
      scheduledCallNote: conversation.scheduledCallNote,
      scheduledCallUpdatedAt:
        conversation.scheduledCallUpdatedAt?.toISOString() ?? null,
      scheduledCallUpdatedBy: conversation.scheduledCallUpdatedBy,
      leadTimezone: conversation.leadTimezone,
      reminders: reminders.map((r) => ({
        id: r.id,
        messageType: r.messageType,
        scheduledFor: r.scheduledFor.toISOString(),
        relatedCallAt: r.relatedCallAt?.toISOString() ?? null
      }))
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/conversations/:id/call error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch call details' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// PUT /api/conversations/:id/call
// Set or update the scheduled call. Triggers reminder creation.
// Body: { scheduledCallAt: ISO string, scheduledCallTimezone?: string, note?: string }
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { accountId: auth.accountId } },
      include: { lead: true }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const body = await req.json();
    const {
      scheduledCallAt,
      scheduledCallTimezone,
      note
    }: {
      scheduledCallAt?: string;
      scheduledCallTimezone?: string;
      note?: string;
    } = body;

    if (!scheduledCallAt || typeof scheduledCallAt !== 'string') {
      return NextResponse.json(
        { error: 'scheduledCallAt (ISO 8601) is required' },
        { status: 400 }
      );
    }
    const scheduledDate = new Date(scheduledCallAt);
    if (Number.isNaN(scheduledDate.getTime())) {
      return NextResponse.json(
        { error: 'scheduledCallAt is not a valid ISO 8601 date' },
        { status: 400 }
      );
    }
    if (scheduledDate.getTime() <= Date.now()) {
      return NextResponse.json(
        { error: 'scheduledCallAt must be in the future' },
        { status: 400 }
      );
    }

    // Timezone fallback chain: explicit body value → conversation.leadTimezone → "UTC"
    const tz =
      (typeof scheduledCallTimezone === 'string' &&
        scheduledCallTimezone.trim()) ||
      conversation.leadTimezone ||
      'UTC';

    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        scheduledCallAt: scheduledDate,
        scheduledCallTimezone: tz,
        scheduledCallSource: 'HUMAN_ENTRY',
        scheduledCallConfirmed: true,
        scheduledCallNote:
          typeof note === 'string' ? note.slice(0, 140) || null : null,
        scheduledCallUpdatedAt: new Date(),
        scheduledCallUpdatedBy: auth.userId ?? null
      },
      select: {
        scheduledCallAt: true,
        scheduledCallTimezone: true,
        scheduledCallSource: true,
        scheduledCallConfirmed: true,
        scheduledCallNote: true,
        scheduledCallUpdatedAt: true,
        scheduledCallUpdatedBy: true,
        leadTimezone: true
      }
    });

    // Cancel any existing reminders tied to the previous call time and
    // create fresh ones for the new call.
    const reminders = await scheduleCallReminders({
      conversationId: id,
      accountId: auth.accountId,
      scheduledCallAt: scheduledDate,
      leadTimezone: tz,
      createdByUserId: auth.userId ?? null
    });

    console.log(
      `[api/call] Call set for ${id} at ${scheduledDate.toISOString()} (${tz}) by user ${auth.userId} — reminders: dayBefore=${reminders.dayBeforeId} morningOf=${reminders.morningOfId}`
    );

    return NextResponse.json({
      scheduledCallAt: updated.scheduledCallAt?.toISOString() ?? null,
      scheduledCallTimezone: updated.scheduledCallTimezone,
      scheduledCallSource: updated.scheduledCallSource,
      scheduledCallConfirmed: updated.scheduledCallConfirmed,
      scheduledCallNote: updated.scheduledCallNote,
      scheduledCallUpdatedAt:
        updated.scheduledCallUpdatedAt?.toISOString() ?? null,
      scheduledCallUpdatedBy: updated.scheduledCallUpdatedBy,
      leadTimezone: updated.leadTimezone,
      remindersCreated: {
        dayBeforeId: reminders.dayBeforeId,
        morningOfId: reminders.morningOfId
      }
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/conversations/:id/call error:', error);
    return NextResponse.json(
      { error: 'Failed to save call details' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/conversations/:id/call
// Clear the scheduled call and cancel any pending reminders.
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { accountId: auth.accountId } },
      select: { id: true }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    await prisma.conversation.update({
      where: { id },
      data: {
        scheduledCallAt: null,
        scheduledCallTimezone: null,
        scheduledCallSource: null,
        scheduledCallConfirmed: false,
        scheduledCallNote: null,
        scheduledCallUpdatedAt: new Date(),
        scheduledCallUpdatedBy: auth.userId ?? null
      }
    });
    const cancelled = await cancelCallReminders(id);

    console.log(
      `[api/call] Call cleared for ${id} by user ${auth.userId} — cancelled ${cancelled} pending reminder(s)`
    );

    return NextResponse.json({ ok: true, cancelledReminders: cancelled });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/conversations/:id/call error:', error);
    return NextResponse.json(
      { error: 'Failed to clear call details' },
      { status: 500 }
    );
  }
}
