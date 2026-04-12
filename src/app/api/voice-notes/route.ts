import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// GET /api/voice-notes
// List all voice note library items for the account
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const search = req.nextUrl.searchParams.get('search')?.trim();

    const items = await prisma.voiceNoteLibraryItem.findMany({
      where: {
        accountId: auth.accountId,
        ...(search
          ? {
              OR: [
                { userLabel: { contains: search, mode: 'insensitive' } },
                { transcript: { contains: search, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      orderBy: { uploadedAt: 'desc' }
    });

    return NextResponse.json({ items });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('GET /api/voice-notes error:', err);
    return NextResponse.json(
      { error: 'Failed to list voice notes' },
      { status: 500 }
    );
  }
}
