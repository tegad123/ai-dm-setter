import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { handleAIHandoff } from '@/lib/webhook-processor';
import { broadcastAIStatusChange } from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/conversations/:id/toggle-ai
 *
 * Toggle the AI active status on a conversation.
 * When toggling AI ON, triggers the handoff flow:
 *   - AI reads the full conversation history
 *   - If the last message is from the lead, generates a contextual reply
 *   - Respects response delay settings
 *
 * Body: { aiActive: boolean }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(request);
    const { id } = await params;

    // Verify conversation belongs to this account
    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        ...(isPlatformOperator(auth.role)
          ? {}
          : { lead: { accountId: auth.accountId } })
      },
      select: {
        id: true,
        aiActive: true,
        leadId: true,
        lead: { select: { accountId: true } }
      }
    });

    if (!conversation) {
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

    if (aiActive && !conversation.aiActive) {
      // Turning AI ON → the toggle is the operator's single control for
      // "AI takes over this conversation." It must override the account-
      // level platform awayMode so auto-send works even when awayMode
      // is off. Set autoSendOverride=true in lock-step with aiActive=true
      // so shouldAutoSend (= aiActive && (awayMode || override)) yields
      // true for this convo regardless of platform config. Trigger the
      // handoff flow which reads history + generates if the last msg is
      // from the lead.
      await prisma.conversation.update({
        where: { id },
        data: { autoSendOverride: true }
      });
      await handleAIHandoff(id, conversation.lead.accountId);

      // Booking-limbo re-engagement: if this convo had the Typeform URL
      // sent earlier, no scheduledCallAt, stage=CALL_PROPOSED, and no
      // pending follow-up, schedule a booking-aware FOLLOW_UP_1 for
      // +5min so the lead isn't left hanging another 12h while the
      // operator waits for a cascade to restart. Non-blocking — errors
      // don't break the handoff response.
      try {
        const { scheduleBookingFollowupOnAIReenable } = await import(
          '@/lib/follow-up-sequence'
        );
        const res = await scheduleBookingFollowupOnAIReenable(
          id,
          conversation.lead.accountId
        );
        if (res.scheduled) {
          console.log(
            `[toggle-ai] booking-limbo follow-up scheduled for ${id}`
          );
        }
      } catch (err) {
        console.error(
          '[toggle-ai] booking-limbo re-enable hook failed (non-fatal):',
          err
        );
      }

      return NextResponse.json({
        conversationId: id,
        aiActive: true,
        autoSendOverride: true,
        message: 'AI activated — reading history and generating reply if needed'
      });
    } else if (!aiActive && conversation.aiActive) {
      // Turning AI OFF → human takeover. Also drop the auto-send
      // override so the operator's next "AI ON" interaction re-grants
      // the override explicitly (no confusing residual state where
      // aiActive=false but autoSendOverride=true).
      await prisma.conversation.update({
        where: { id },
        data: { aiActive: false, autoSendOverride: false }
      });

      // Cancel any pending scheduled replies
      await prisma.scheduledReply.updateMany({
        where: { conversationId: id, status: 'PENDING' },
        data: { status: 'CANCELLED' }
      });

      broadcastAIStatusChange({ conversationId: id, aiActive: false });

      return NextResponse.json({
        conversationId: id,
        aiActive: false,
        autoSendOverride: false,
        message: 'AI paused — human override active'
      });
    }

    // No change needed
    return NextResponse.json({
      conversationId: id,
      aiActive: conversation.aiActive,
      message: 'No change'
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Toggle AI error:', error);
    return NextResponse.json({ error: 'Failed to toggle AI' }, { status: 500 });
  }
}
