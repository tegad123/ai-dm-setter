import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
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
      where: { id, lead: { accountId: auth.accountId } }
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
      data: { aiActive }
    });

    // Broadcast real-time AI status change
    broadcastAIStatusChange({
      conversationId: id,
      aiActive: conversation.aiActive
    });

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
