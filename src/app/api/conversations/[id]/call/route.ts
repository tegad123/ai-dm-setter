import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { cancelCallReminders } from '@/lib/call-reminders';
import {
  scheduleCallConfirmationSequence,
  sendImmediateCallConfirmation
} from '@/lib/call-confirmation-sequence';
import { transitionLeadStage } from '@/lib/lead-stage';
import type { LeadStage } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

const CALL_REMINDER_TYPES = [
  'DAY_BEFORE_REMINDER',
  'MORNING_OF_REMINDER',
  'PRE_CALL_HOMEWORK',
  'CALL_DAY_CONFIRMATION',
  'CALL_DAY_REMINDER'
] as const;

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
        callConfirmed: true,
        callConfirmedAt: true,
        callOutcome: true,
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

    // Active reminder rows, plus fired homework so the sidebar can show
    // whether the prep page already went out.
    const reminders = await prisma.scheduledMessage.findMany({
      where: {
        conversationId: id,
        OR: [
          { status: 'PENDING', messageType: { in: [...CALL_REMINDER_TYPES] } },
          { status: 'FIRED', messageType: 'PRE_CALL_HOMEWORK' }
        ]
      },
      orderBy: { scheduledFor: 'asc' },
      select: {
        id: true,
        messageType: true,
        scheduledFor: true,
        firedAt: true,
        relatedCallAt: true
      }
    });
    const homeworkSentAt =
      reminders
        .filter((r) => r.messageType === 'PRE_CALL_HOMEWORK' && r.firedAt)
        .sort((a, b) => b.firedAt!.getTime() - a.firedAt!.getTime())[0]
        ?.firedAt?.toISOString() ?? null;

    return NextResponse.json({
      scheduledCallAt: conversation.scheduledCallAt?.toISOString() ?? null,
      scheduledCallTimezone: conversation.scheduledCallTimezone,
      scheduledCallSource: conversation.scheduledCallSource,
      scheduledCallConfirmed: conversation.scheduledCallConfirmed,
      callConfirmed: conversation.callConfirmed,
      callConfirmedAt: conversation.callConfirmedAt?.toISOString() ?? null,
      callOutcome: conversation.callOutcome,
      homeworkSentAt,
      scheduledCallNote: conversation.scheduledCallNote,
      scheduledCallUpdatedAt:
        conversation.scheduledCallUpdatedAt?.toISOString() ?? null,
      scheduledCallUpdatedBy: conversation.scheduledCallUpdatedBy,
      leadTimezone: conversation.leadTimezone,
      reminders: reminders.map((r) => ({
        id: r.id,
        messageType: r.messageType,
        scheduledFor: r.scheduledFor.toISOString(),
        firedAt: r.firedAt?.toISOString() ?? null,
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
        callConfirmed: false,
        callConfirmedAt: null,
        callOutcome: null,
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
        callConfirmed: true,
        callConfirmedAt: true,
        callOutcome: true,
        scheduledCallNote: true,
        scheduledCallUpdatedAt: true,
        scheduledCallUpdatedBy: true,
        leadTimezone: true
      }
    });

    // Cancel any existing reminders tied to the previous call time and
    // create fresh confirmation-sequence rows for the new call.
    const remindersCreated = await scheduleCallConfirmationSequence({
      conversationId: id,
      accountId: auth.accountId,
      scheduledCallAt: scheduledDate,
      leadTimezone: tz,
      createdByUserId: auth.userId ?? null
    });

    console.log(
      `[api/call] Call set for ${id} at ${scheduledDate.toISOString()} (${tz}) by user ${auth.userId} — sequence: homework=${remindersCreated.homeworkId} confirmation=${remindersCreated.confirmationId} reminder=${remindersCreated.reminderId}`
    );

    if (
      conversation.lead.stage === 'QUALIFIED' ||
      conversation.lead.stage === 'CALL_PROPOSED' ||
      conversation.lead.stage === 'BOOKED'
    ) {
      await sendImmediateCallConfirmation(id).catch((err) =>
        console.error(
          '[api/call] immediate call confirmation failed (non-fatal):',
          err
        )
      );
    }

    // Re-fetch the newly-scheduled PENDING reminder rows so the
    // response shape matches GET exactly — the client stores this
    // response directly via setState and renders `state.reminders`
    // on the next paint. Previous shape mismatch (`remindersCreated`
    // vs `reminders`) crashed the UI with "Cannot read properties of
    // undefined (reading 'length')". Keep the shape identical here.
    const reminders = await prisma.scheduledMessage.findMany({
      where: {
        conversationId: id,
        status: 'PENDING',
        messageType: { in: [...CALL_REMINDER_TYPES] }
      },
      orderBy: { scheduledFor: 'asc' },
      select: {
        id: true,
        messageType: true,
        scheduledFor: true,
        firedAt: true,
        relatedCallAt: true
      }
    });

    return NextResponse.json({
      scheduledCallAt: updated.scheduledCallAt?.toISOString() ?? null,
      scheduledCallTimezone: updated.scheduledCallTimezone,
      scheduledCallSource: updated.scheduledCallSource,
      scheduledCallConfirmed: updated.scheduledCallConfirmed,
      callConfirmed: updated.callConfirmed,
      callConfirmedAt: updated.callConfirmedAt?.toISOString() ?? null,
      callOutcome: updated.callOutcome,
      homeworkSentAt: null,
      scheduledCallNote: updated.scheduledCallNote,
      scheduledCallUpdatedAt:
        updated.scheduledCallUpdatedAt?.toISOString() ?? null,
      scheduledCallUpdatedBy: updated.scheduledCallUpdatedBy,
      leadTimezone: updated.leadTimezone,
      reminders: reminders.map((r) => ({
        id: r.id,
        messageType: r.messageType,
        scheduledFor: r.scheduledFor.toISOString(),
        firedAt: r.firedAt?.toISOString() ?? null,
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
    console.error('PUT /api/conversations/:id/call error:', error);
    return NextResponse.json(
      { error: 'Failed to save call details' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/conversations/:id/call
// Operator marks post-call outcome.
// Body: { callOutcome: "SHOWED" | "NO_SHOWED" | "RESCHEDULED" | null }
// ---------------------------------------------------------------------------

export async function PATCH(
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

    const body = (await req.json()) as { callOutcome?: unknown };
    const rawOutcome = body.callOutcome;
    const callOutcome =
      typeof rawOutcome === 'string' && rawOutcome.trim()
        ? rawOutcome.trim().toUpperCase()
        : null;
    const allowed = new Set(['SHOWED', 'NO_SHOWED', 'RESCHEDULED']);
    if (callOutcome && !allowed.has(callOutcome)) {
      return NextResponse.json(
        { error: 'Unsupported callOutcome' },
        { status: 400 }
      );
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        callOutcome,
        scheduledCallUpdatedAt: new Date(),
        scheduledCallUpdatedBy: auth.userId ?? null
      },
      select: {
        scheduledCallAt: true,
        scheduledCallTimezone: true,
        scheduledCallSource: true,
        scheduledCallConfirmed: true,
        callConfirmed: true,
        callConfirmedAt: true,
        callOutcome: true,
        scheduledCallNote: true,
        scheduledCallUpdatedAt: true,
        scheduledCallUpdatedBy: true,
        leadTimezone: true
      }
    });

    if (callOutcome) {
      const nextStage: LeadStage =
        callOutcome === 'SHOWED'
          ? 'SHOWED'
          : callOutcome === 'NO_SHOWED'
            ? 'NO_SHOWED'
            : 'RESCHEDULED';
      await transitionLeadStage(
        conversation.lead.id,
        nextStage,
        'user',
        `operator marked call outcome ${callOutcome}`
      );
    }

    return NextResponse.json({
      scheduledCallAt: updated.scheduledCallAt?.toISOString() ?? null,
      scheduledCallTimezone: updated.scheduledCallTimezone,
      scheduledCallSource: updated.scheduledCallSource,
      scheduledCallConfirmed: updated.scheduledCallConfirmed,
      callConfirmed: updated.callConfirmed,
      callConfirmedAt: updated.callConfirmedAt?.toISOString() ?? null,
      callOutcome: updated.callOutcome,
      homeworkSentAt: null,
      scheduledCallNote: updated.scheduledCallNote,
      scheduledCallUpdatedAt:
        updated.scheduledCallUpdatedAt?.toISOString() ?? null,
      scheduledCallUpdatedBy: updated.scheduledCallUpdatedBy,
      leadTimezone: updated.leadTimezone,
      reminders: []
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PATCH /api/conversations/:id/call error:', error);
    return NextResponse.json(
      { error: 'Failed to update call outcome' },
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
        callConfirmed: false,
        callConfirmedAt: null,
        callOutcome: null,
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
