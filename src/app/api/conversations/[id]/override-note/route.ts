import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// POST /api/conversations/:id/override-note — Save a human override note
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: conversationId } = await params;

    // Verify conversation belongs to this account
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, lead: { accountId: auth.accountId } }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const body = await req.json();
    const { messageId, note } = body;

    if (!messageId) {
      return NextResponse.json(
        { error: 'messageId is required' },
        { status: 400 }
      );
    }

    // Verify message belongs to this conversation and is a human override
    const message = await prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId,
        sender: 'HUMAN'
      }
    });

    if (!message) {
      return NextResponse.json(
        { error: 'Human message not found in this conversation' },
        { status: 404 }
      );
    }

    // Save the note (truncate to 140 chars)
    const trimmedNote =
      typeof note === 'string' ? note.trim().slice(0, 140) : null;

    await prisma.message.update({
      where: { id: messageId },
      data: { humanOverrideNote: trimmedNote || null }
    });

    return NextResponse.json({ success: true, note: trimmedNote });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/conversations/:id/override-note error:', error);
    return NextResponse.json(
      { error: 'Failed to save override note' },
      { status: 500 }
    );
  }
}
