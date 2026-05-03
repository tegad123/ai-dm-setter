import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// POST /api/dashboard/actions/dismiss
// ---------------------------------------------------------------------------
// Records the operator dismissing an action item on the Dashboard Overview
// Action Required section. Idempotent — a retry (network hiccup, double-
// click) upserts into the same (accountId, conversationId, actionType)
// row instead of erroring.
//
// Body: { conversationId: string, actionType: string }
// Returns: { ok: true, dismissedAt: ISO }
//
// Authorization: tenant admins can dismiss only their account's items.
// Platform operators can dismiss cross-account items from the global
// manager dashboard.
// ---------------------------------------------------------------------------

const ALLOWED_ACTION_TYPES = new Set([
  'distress',
  'stuck',
  'pending_auto_recovery',
  'ai_paused',
  'capital_verification',
  'upcoming_call',
  'unverified_sent',
  'keepalive_no_response',
  'keepalive_exhausted',
  'call_unconfirmed_past_due',
  'call_outcome_needed',
  'scheduling_conflict'
]);

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const body = (await request.json()) as {
      conversationId?: unknown;
      actionType?: unknown;
    };
    const conversationId =
      typeof body.conversationId === 'string' ? body.conversationId : null;
    const actionType =
      typeof body.actionType === 'string' ? body.actionType : null;
    if (!conversationId || !actionType) {
      return NextResponse.json(
        { error: 'conversationId and actionType are required' },
        { status: 400 }
      );
    }
    if (!ALLOWED_ACTION_TYPES.has(actionType)) {
      return NextResponse.json(
        { error: `unsupported actionType "${actionType}"` },
        { status: 400 }
      );
    }
    // Verify ownership — conversation must belong to caller's account.
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { lead: { select: { accountId: true } } }
    });
    if (
      !conv ||
      (!isPlatformOperator(auth.role) && conv.lead.accountId !== auth.accountId)
    ) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const accountId = conv.lead.accountId;
    // Upsert via unique constraint — bumps dismissedAt on re-dismiss.
    // The idempotency lets the client safely retry, and bumping the
    // timestamp means "dismiss again after lead messaged" works: the
    // new dismissedAt moves past the latest LEAD message, and the
    // resurface check will flip back to "dismissed" until the NEXT
    // new lead message.
    const row = await prisma.dismissedActionItem.upsert({
      where: {
        accountId_conversationId_actionType: {
          accountId,
          conversationId,
          actionType
        }
      },
      create: {
        accountId,
        conversationId,
        actionType,
        dismissedByUserId: auth.userId ?? null,
        dismissedAt: new Date()
      },
      update: {
        dismissedByUserId: auth.userId ?? null,
        dismissedAt: new Date()
      },
      select: { dismissedAt: true }
    });
    return NextResponse.json({ ok: true, dismissedAt: row.dismissedAt });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      console.error('[dashboard/actions/dismiss] prisma error:', err.code);
    } else {
      console.error('[dashboard/actions/dismiss] error:', err);
    }
    return NextResponse.json(
      { error: 'Failed to dismiss action item' },
      { status: 500 }
    );
  }
}
