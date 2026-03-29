import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
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
      where: { id, lead: { accountId: auth.accountId } },
      select: { id: true, aiActive: true, leadId: true }
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
      // Turning AI ON → trigger handoff flow
      await handleAIHandoff(id, auth.accountId);

      return NextResponse.json({
        conversationId: id,
        aiActive: true,
        message: 'AI activated — reading history and generating reply if needed'
      });
    } else if (!aiActive && conversation.aiActive) {
      // Turning AI OFF → human takeover
      await prisma.conversation.update({
        where: { id },
        data: { aiActive: false }
      });

      broadcastAIStatusChange({ conversationId: id, aiActive: false });

      return NextResponse.json({
        conversationId: id,
        aiActive: false,
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
    return NextResponse.json(
      { error: 'Failed to toggle AI' },
      { status: 500 }
    );
  }
}
