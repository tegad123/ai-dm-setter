import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// GET — Get upload details with nested conversations and messages
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const upload = await prisma.trainingUpload.findFirst({
      where: { id, accountId: auth.accountId },
      select: {
        id: true,
        fileName: true,
        status: true,
        tokenEstimate: true,
        conversationCount: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
        conversations: {
          orderBy: { startedAt: 'asc' },
          select: {
            id: true,
            leadIdentifier: true,
            outcomeLabel: true,
            messageCount: true,
            closerMessageCount: true,
            leadMessageCount: true,
            voiceNoteCount: true,
            startedAt: true,
            endedAt: true,
            messages: {
              orderBy: { orderIndex: 'asc' },
              select: {
                id: true,
                sender: true,
                text: true,
                timestamp: true,
                messageType: true,
                orderIndex: true
              }
            }
          }
        }
      }
    });

    if (!upload) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
    }

    return NextResponse.json({ upload });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/training/upload/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch upload details' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE — Delete an upload and all its conversations/messages (cascade)
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const upload = await prisma.trainingUpload.findFirst({
      where: { id, accountId: auth.accountId },
      select: { id: true, conversationCount: true }
    });

    if (!upload) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
    }

    // Cascade deletes conversations → messages automatically
    await prisma.trainingUpload.delete({ where: { id } });

    return NextResponse.json({
      deleted: true,
      conversationsRemoved: upload.conversationCount ?? 0
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/settings/training/upload/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to delete upload' },
      { status: 500 }
    );
  }
}
