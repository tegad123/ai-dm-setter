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

    // Create the library item record first (so we have an ID for the blob path)
    const item = await prisma.voiceNoteLibraryItem.create({
      data: {
        accountId: auth.accountId,
        audioFileUrl: '', // placeholder, updated after blob upload
        durationSeconds,
        status: 'PROCESSING'
      }
    });

    // Upload to Vercel Blob
    const ext = audioExtFromMime(file.type);
    const blobPath = `voice-note-library/${auth.accountId}/${item.id}/${Date.now()}.${ext}`;
    const blob = await put(blobPath, buffer, { access: 'public' });

    // Update item with the real URL
    const updated = await prisma.voiceNoteLibraryItem.update({
      where: { id: item.id },
      data: { audioFileUrl: blob.url }
    });

    return NextResponse.json({
      item: {
        id: updated.id,
        audioFileUrl: updated.audioFileUrl,
        durationSeconds: updated.durationSeconds,
        status: updated.status
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
