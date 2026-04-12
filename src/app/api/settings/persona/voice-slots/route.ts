import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// GET /api/settings/persona/voice-slots
// List all voice note slots for the current account.
// Optional query param: ?breakdownId=<id> to filter by breakdown.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const { searchParams } = new URL(req.url);
    const breakdownId = searchParams.get('breakdownId');

    const where: Record<string, unknown> = { accountId: auth.accountId };
    if (breakdownId) where.breakdownId = breakdownId;

    const slots = await prisma.voiceNoteSlot.findMany({
      where,
      orderBy: { createdAt: 'asc' }
    });

    return NextResponse.json({ slots });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/persona/voice-slots error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch voice note slots' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// PUT /api/settings/persona/voice-slots
// Update a voice note slot's config (fallback, approval, etc).
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { slotId, fallbackBehavior, fallbackText, userApproved } = body as {
      slotId: string;
      fallbackBehavior?:
        | 'BLOCK_UNTIL_FILLED'
        | 'SEND_TEXT_EQUIVALENT'
        | 'SKIP_ACTION';
      fallbackText?: string;
      userApproved?: boolean;
    };

    if (!slotId) {
      return NextResponse.json(
        { error: 'slotId is required' },
        { status: 400 }
      );
    }

    // Verify ownership
    const slot = await prisma.voiceNoteSlot.findFirst({
      where: { id: slotId, accountId: auth.accountId }
    });

    if (!slot) {
      return NextResponse.json(
        { error: 'Voice note slot not found' },
        { status: 404 }
      );
    }

    const data: Record<string, unknown> = {};
    if (fallbackBehavior !== undefined)
      data.fallbackBehavior = fallbackBehavior;
    if (fallbackText !== undefined) data.fallbackText = fallbackText;
    if (userApproved !== undefined) data.userApproved = userApproved;

    const updated = await prisma.voiceNoteSlot.update({
      where: { id: slotId },
      data
    });

    return NextResponse.json({ slot: updated });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/settings/persona/voice-slots error:', error);
    return NextResponse.json(
      { error: 'Failed to update voice note slot' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/settings/persona/voice-slots
// Remove a voice note slot.
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const { searchParams } = new URL(req.url);
    const slotId = searchParams.get('slotId');

    if (!slotId) {
      return NextResponse.json(
        { error: 'slotId query param is required' },
        { status: 400 }
      );
    }

    // Verify ownership
    const slot = await prisma.voiceNoteSlot.findFirst({
      where: { id: slotId, accountId: auth.accountId }
    });

    if (!slot) {
      return NextResponse.json(
        { error: 'Voice note slot not found' },
        { status: 404 }
      );
    }

    await prisma.voiceNoteSlot.delete({ where: { id: slotId } });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/settings/persona/voice-slots error:', error);
    return NextResponse.json(
      { error: 'Failed to delete voice note slot' },
      { status: 500 }
    );
  }
}
