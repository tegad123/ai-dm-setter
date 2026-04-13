import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import { getVoiceNoteTimingSettings } from '@/lib/voice-note-timing';

// ---------------------------------------------------------------------------
// GET /api/voice-notes/timing-settings
// Returns the current timing settings (or defaults if no row exists)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const settings = await getVoiceNoteTimingSettings(auth.accountId);
    return NextResponse.json(settings);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('GET /api/voice-notes/timing-settings error:', err);
    return NextResponse.json(
      { error: 'Failed to load timing settings' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// PUT /api/voice-notes/timing-settings
// Upsert timing settings for the account
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();

    const { minDelay, maxDelay } = body as {
      minDelay?: number;
      maxDelay?: number;
    };

    // Merge with existing
    const current = await getVoiceNoteTimingSettings(auth.accountId);
    const min = minDelay ?? current.minDelay;
    const max = maxDelay ?? current.maxDelay;

    // Validate
    const errors: string[] = [];
    if (min < 0) errors.push('minDelay must be >= 0');
    if (max < 0) errors.push('maxDelay must be >= 0');
    if (min > max) errors.push('minDelay must be <= maxDelay');
    if (max > 600) errors.push('maxDelay must be <= 600 seconds');

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    }

    const data = { minDelay: min, maxDelay: max };

    const updated = await prisma.voiceNoteTimingSettings.upsert({
      where: { accountId: auth.accountId },
      create: { accountId: auth.accountId, ...data },
      update: data
    });

    return NextResponse.json({
      minDelay: updated.minDelay,
      maxDelay: updated.maxDelay
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('PUT /api/voice-notes/timing-settings error:', err);
    return NextResponse.json(
      { error: 'Failed to save timing settings' },
      { status: 500 }
    );
  }
}
