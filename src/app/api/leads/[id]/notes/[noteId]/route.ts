import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// PUT /api/leads/[id]/notes/[noteId] — edit own note
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; noteId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: leadId, noteId } = await params;
    const body = await req.json();
    const { content } = body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return NextResponse.json(
        { error: 'Note content is required' },
        { status: 400 }
      );
    }

    // Find the note — must belong to same account and same author
    const existing = await prisma.teamNote.findFirst({
      where: { id: noteId, leadId, accountId: auth.accountId }
    });

    if (!existing) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 });
    }

    // Only the author or ADMIN can edit
    if (existing.authorId !== auth.userId && auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'You can only edit your own notes' },
        { status: 403 }
      );
    }

    const note = await prisma.teamNote.update({
      where: { id: noteId },
      data: { content: content.trim() },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true }
        }
      }
    });

    return NextResponse.json(note);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/leads/[id]/notes/[noteId] error:', error);
    return NextResponse.json(
      { error: 'Failed to update note' },
      { status: 500 }
    );
  }
}

// DELETE /api/leads/[id]/notes/[noteId] — delete own note
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; noteId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: leadId, noteId } = await params;

    const existing = await prisma.teamNote.findFirst({
      where: { id: noteId, leadId, accountId: auth.accountId }
    });

    if (!existing) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 });
    }

    if (existing.authorId !== auth.userId && auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'You can only delete your own notes' },
        { status: 403 }
      );
    }

    await prisma.teamNote.delete({ where: { id: noteId } });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/leads/[id]/notes/[noteId] error:', error);
    return NextResponse.json(
      { error: 'Failed to delete note' },
      { status: 500 }
    );
  }
}
