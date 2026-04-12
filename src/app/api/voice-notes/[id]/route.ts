import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import { del } from '@vercel/blob';

// ---------------------------------------------------------------------------
// GET /api/voice-notes/:id — single item
// PUT /api/voice-notes/:id — update fields
// DELETE /api/voice-notes/:id — delete item + blob
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const item = await prisma.voiceNoteLibraryItem.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!item) {
      return NextResponse.json(
        { error: 'Voice note not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ item });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: 'Failed to fetch voice note' },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();

    // Verify ownership
    const existing = await prisma.voiceNoteLibraryItem.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!existing) {
      return NextResponse.json(
        { error: 'Voice note not found' },
        { status: 404 }
      );
    }

    // Allowed update fields
    const {
      transcript,
      summary,
      useCases,
      leadTypes,
      conversationStages,
      emotionalTone,
      triggerConditionsNatural,
      userLabel,
      userNotes,
      priority,
      active,
      boundToScriptStep
    } = body;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {};
    if (transcript !== undefined) data.transcript = transcript;
    if (summary !== undefined) data.summary = summary;
    if (useCases !== undefined) data.useCases = useCases;
    if (leadTypes !== undefined) data.leadTypes = leadTypes;
    if (conversationStages !== undefined)
      data.conversationStages = conversationStages;
    if (emotionalTone !== undefined) data.emotionalTone = emotionalTone;
    if (triggerConditionsNatural !== undefined)
      data.triggerConditionsNatural = triggerConditionsNatural;
    if (userLabel !== undefined) data.userLabel = userLabel;
    if (userNotes !== undefined) data.userNotes = userNotes;
    if (priority !== undefined) data.priority = priority;
    if (boundToScriptStep !== undefined)
      data.boundToScriptStep = boundToScriptStep;

    // active toggle also updates status
    if (active !== undefined) {
      data.active = active;
      data.status = active ? 'ACTIVE' : 'DISABLED';
    }

    const item = await prisma.voiceNoteLibraryItem.update({
      where: { id },
      data
    });

    return NextResponse.json({ item });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('PUT /api/voice-notes/[id] error:', err);
    return NextResponse.json(
      { error: 'Failed to update voice note' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const existing = await prisma.voiceNoteLibraryItem.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!existing) {
      return NextResponse.json(
        { error: 'Voice note not found' },
        { status: 404 }
      );
    }

    // Delete blob file
    if (existing.audioFileUrl) {
      try {
        await del(existing.audioFileUrl);
      } catch (blobErr) {
        console.warn('Failed to delete blob:', blobErr);
      }
    }

    await prisma.voiceNoteLibraryItem.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('DELETE /api/voice-notes/[id] error:', err);
    return NextResponse.json(
      { error: 'Failed to delete voice note' },
      { status: 500 }
    );
  }
}
