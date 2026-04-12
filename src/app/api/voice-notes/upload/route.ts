import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import { put } from '@vercel/blob';
import {
  ALLOWED_AUDIO_TYPES,
  MAX_FILE_SIZE,
  estimateAudioDuration,
  audioExtFromMime
} from '@/lib/voice-note-library';

export const maxDuration = 30;

// ---------------------------------------------------------------------------
// POST /api/voice-notes/upload
// Upload a single audio file → create VoiceNoteLibraryItem with PROCESSING status
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const formData = await req.formData();
    const file = formData.get('audio') as File | null;

    if (!file) {
      return NextResponse.json(
        { error: 'No audio file provided' },
        { status: 400 }
      );
    }

    // Validate MIME type
    if (!ALLOWED_AUDIO_TYPES.includes(file.type)) {
      return NextResponse.json(
        {
          error: `Unsupported audio format: ${file.type}. Accepted: mp3, m4a, wav, ogg, webm`
        },
        { status: 400 }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 10 MB.' },
        { status: 413 }
      );
    }

    // Read file into buffer
    const buffer = Buffer.from(await file.arrayBuffer());
    const durationSeconds = estimateAudioDuration(buffer.byteLength);

    // Upload to Vercel Blob FIRST (most likely failure point — no orphaned DB records)
    const ext = audioExtFromMime(file.type);
    const tempId = Date.now().toString(36);
    const blobPath = `voice-note-library/${auth.accountId}/${tempId}/${Date.now()}.${ext}`;

    let blob;
    try {
      blob = await put(blobPath, buffer, {
        access: 'public',
        contentType: file.type
      });
    } catch (blobErr) {
      console.error('Vercel Blob upload failed:', blobErr);
      return NextResponse.json(
        {
          error:
            'Failed to upload audio file. Blob storage may not be configured.'
        },
        { status: 500 }
      );
    }

    // Create the library item record with the real URL
    const item = await prisma.voiceNoteLibraryItem.create({
      data: {
        accountId: auth.accountId,
        audioFileUrl: blob.url,
        durationSeconds,
        status: 'PROCESSING'
      }
    });

    return NextResponse.json({
      item: {
        id: item.id,
        audioFileUrl: item.audioFileUrl,
        durationSeconds: item.durationSeconds,
        status: item.status
      }
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('POST /api/voice-notes/upload error:', err);
    return NextResponse.json(
      { error: 'Failed to upload voice note' },
      { status: 500 }
    );
  }
}
