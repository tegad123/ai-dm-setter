import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { broadcastAIStatusChange } from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(request);
    const { id } = await params;

    // Verify conversation belongs to this account
    const existing = await prisma.conversation.findFirst({
      where: {
        id,
        ...(isPlatformOperator(auth.role)
          ? {}
          : { lead: { accountId: auth.accountId } })
      },
      include: { lead: { select: { accountId: true } } }
    });
    if (!existing) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const body = await request.json();
    const { aiActive } = body;

    if (typeof aiActive !== 'boolean') {
      return NextResponse.json(
        { error: 'aiActive must be a boolean' },
        { status: 400 }
      );
    }

    const conversation = await prisma.conversation.update({
      where: { id },
      data: {
        aiActive,
        // Mirror autoSendOverride so operator-enabled conversations
        // auto-send even when account-level away-mode is off. This is
        // what distinguishes "operator explicitly turned on AI for this
        // chat" from "default aiActive=true from schema".
        autoSendOverride: aiActive
      }
    });

    // Broadcast real-time AI status change (scoped to the lead's tenant).
    broadcastAIStatusChange(existing.lead.accountId, {
      conversationId: id,
      aiActive: conversation.aiActive
    });

    // Booking-limbo re-engagement when flipping OFF→ON. Mirrors the
    // logic in /toggle-ai — if the convo had a Typeform URL sent and
    // is stuck at CALL_PROPOSED with no pending follow-up, schedule a
    // booking-aware FOLLOW_UP_1 for +5min. Non-blocking.
    if (aiActive && !existing.aiActive) {
      try {
        const { scheduleBookingFollowupOnAIReenable } = await import(
          '@/lib/follow-up-sequence'
        );
        await scheduleBookingFollowupOnAIReenable(id, existing.lead.accountId);
      } catch (err) {
        console.error(
          '[ai-toggle] booking-limbo re-enable hook failed (non-fatal):',
          err
        );
      }
    }

    return NextResponse.json({ aiActive: conversation.aiActive });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to toggle AI:', error);
    return NextResponse.json(
      { error: 'Failed to toggle AI status' },
      { status: 500 }
    );
  }
}
