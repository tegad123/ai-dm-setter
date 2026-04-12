import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

export const maxDuration = 120;

// ---------------------------------------------------------------------------
// POST /api/voice-notes/:id/retry
// Reset a FAILED item to PROCESSING and re-trigger the pipeline
// ---------------------------------------------------------------------------

export async function POST(
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

    if (item.status !== 'FAILED') {
      return NextResponse.json(
        { error: `Cannot retry item with status ${item.status}` },
        { status: 400 }
      );
    }

    // Reset to PROCESSING
    await prisma.voiceNoteLibraryItem.update({
      where: { id },
      data: { status: 'PROCESSING', errorMessage: null }
    });

    // Trigger the process endpoint internally
    const processUrl = new URL(
      `/api/voice-notes/${id}/process`,
      req.nextUrl.origin
    );

    // Forward the auth header
    const authHeader = req.headers.get('authorization');
    const cookieHeader = req.headers.get('cookie');
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    // Fire and don't wait (to avoid double timeout)
    fetch(processUrl.toString(), {
      method: 'POST',
      headers
    }).catch((err) =>
      console.error(`[voice-note-retry] Process call failed for ${id}:`, err)
    );

    return NextResponse.json({ success: true, status: 'PROCESSING' });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('POST /api/voice-notes/[id]/retry error:', err);
    return NextResponse.json(
      { error: 'Failed to retry processing' },
      { status: 500 }
    );
  }
}
