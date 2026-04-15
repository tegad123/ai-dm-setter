import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// GET /api/voice-notes/:id/suggestions — return auto-suggested triggers
// PUT /api/voice-notes/:id/suggestions — approve, edit, or reject suggestions
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const item = await prisma.voiceNoteLibraryItem.findFirst({
      where: { id, accountId: auth.accountId },
      select: {
        id: true,
        autoSuggestedTriggers: true,
        suggestionStatus: true,
        triggers: true,
        triggerDescription: true
      }
    });

    if (!item) {
      return NextResponse.json(
        { error: 'Voice note not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      id: item.id,
      autoSuggestedTriggers: item.autoSuggestedTriggers,
      suggestionStatus: item.suggestionStatus,
      triggers: item.triggers,
      triggerDescription: item.triggerDescription
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const item = await prisma.voiceNoteLibraryItem.findFirst({
      where: { id, accountId: auth.accountId },
      select: { id: true, autoSuggestedTriggers: true, suggestionStatus: true }
    });

    if (!item) {
      return NextResponse.json(
        { error: 'Voice note not found' },
        { status: 404 }
      );
    }

    const body = await req.json();
    const { action, triggers } = body as {
      action: 'approve' | 'edit' | 'reject';
      triggers?: unknown[];
    };

    if (!['approve', 'edit', 'reject'].includes(action)) {
      return NextResponse.json(
        { error: 'Invalid action. Must be approve, edit, or reject.' },
        { status: 400 }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let updateData: Record<string, any> = {};

    if (action === 'approve') {
      if (!item.autoSuggestedTriggers) {
        return NextResponse.json(
          { error: 'No suggestions to approve' },
          { status: 400 }
        );
      }
      const { validateTriggers, generateTriggerDescription } = await import(
        '@/lib/voice-note-triggers'
      );
      const validated = validateTriggers(
        item.autoSuggestedTriggers as unknown[]
      );
      updateData = {
        triggers: validated as unknown as any[],
        triggerDescription: generateTriggerDescription(validated),
        suggestionStatus: 'approved'
      };
    } else if (action === 'edit') {
      if (!triggers || !Array.isArray(triggers)) {
        return NextResponse.json(
          { error: 'triggers array required for edit action' },
          { status: 400 }
        );
      }
      const { validateTriggers, generateTriggerDescription } = await import(
        '@/lib/voice-note-triggers'
      );
      const validated = validateTriggers(triggers);
      updateData = {
        triggers: validated as unknown as any[],
        triggerDescription: generateTriggerDescription(validated),
        suggestionStatus: 'edited'
      };
    } else if (action === 'reject') {
      updateData = {
        suggestionStatus: 'rejected'
      };
    }

    const updated = await prisma.voiceNoteLibraryItem.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        autoSuggestedTriggers: true,
        suggestionStatus: true,
        triggers: true,
        triggerDescription: true
      }
    });

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }
}
