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

    const {
      recordingSpeedMin,
      recordingSpeedMax,
      thinkingBufferMin,
      thinkingBufferMax
    } = body as {
      recordingSpeedMin?: number;
      recordingSpeedMax?: number;
      thinkingBufferMin?: number;
      thinkingBufferMax?: number;
    };

    // Validate
    const errors: string[] = [];
    if (recordingSpeedMin !== undefined && recordingSpeedMin <= 0)
      errors.push('recordingSpeedMin must be > 0');
    if (recordingSpeedMax !== undefined && recordingSpeedMax <= 0)
      errors.push('recordingSpeedMax must be > 0');
    if (recordingSpeedMax !== undefined && recordingSpeedMax > 2.0)
      errors.push('recordingSpeedMax must be <= 2.0');
    if (thinkingBufferMin !== undefined && thinkingBufferMin < 0)
      errors.push('thinkingBufferMin must be >= 0');
    if (thinkingBufferMax !== undefined && thinkingBufferMax < 0)
      errors.push('thinkingBufferMax must be >= 0');

    // Cross-field validation (use incoming values or existing defaults)
    const current = await getVoiceNoteTimingSettings(auth.accountId);
    const sMin = recordingSpeedMin ?? current.recordingSpeedMin;
    const sMax = recordingSpeedMax ?? current.recordingSpeedMax;
    const tMin = thinkingBufferMin ?? current.thinkingBufferMin;
    const tMax = thinkingBufferMax ?? current.thinkingBufferMax;

    if (sMin > sMax)
      errors.push('recordingSpeedMin must be <= recordingSpeedMax');
    if (tMin > tMax)
      errors.push('thinkingBufferMin must be <= thinkingBufferMax');

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    }

    const data = {
      recordingSpeedMin: sMin,
      recordingSpeedMax: sMax,
      thinkingBufferMin: tMin,
      thinkingBufferMax: tMax
    };

    const updated = await prisma.voiceNoteTimingSettings.upsert({
      where: { accountId: auth.accountId },
      create: { accountId: auth.accountId, ...data },
      update: data
    });

    return NextResponse.json({
      recordingSpeedMin: updated.recordingSpeedMin,
      recordingSpeedMax: updated.recordingSpeedMax,
      thinkingBufferMin: updated.thinkingBufferMin,
      thinkingBufferMax: updated.thinkingBufferMax
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
