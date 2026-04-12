import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import { put } from '@vercel/blob';

// ---------------------------------------------------------------------------
// POST /api/settings/persona/voice-slots/upload
// Upload audio file for a voice note slot.
// Accepts base64-encoded audio in JSON body (for files < 4MB).
// For larger files, use the Vercel Blob client-side upload pattern.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { slotId, audioBase64, contentType, fileName } = body as {
      slotId: string;
      audioBase64: string;
      contentType?: string;
      fileName?: string;
    };

    if (!slotId || !audioBase64) {
      return NextResponse.json(
        { error: 'slotId and audioBase64 are required' },
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

    // Validate content type
    const mimeType = contentType || 'audio/mpeg';
    const allowedTypes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a',
      'audio/wav',
      'audio/wave',
      'audio/x-wav',
      'audio/ogg',
      'audio/webm'
    ];
    if (!allowedTypes.some((t) => mimeType.startsWith(t.split('/')[0]))) {
      return NextResponse.json(
        { error: 'Invalid audio format. Accepted: mp3, m4a, wav, ogg, webm' },
        { status: 400 }
      );
    }

    // Validate file size (10MB max = ~13.3MB in base64)
    const MAX_BASE64_SIZE = 13.3 * 1024 * 1024;
    if (audioBase64.length > MAX_BASE64_SIZE) {
      return NextResponse.json(
        { error: 'Audio file too large. Maximum size is 10MB.' },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(audioBase64, 'base64');

    // Estimate duration (rough: assume ~128kbps for mp3)
    const audioDurationSecs = (buffer.byteLength * 8) / 128000;

    // Determine file extension
    const ext =
      fileName?.split('.').pop()?.toLowerCase() ||
      mimeType.split('/').pop()?.replace('mpeg', 'mp3') ||
      'mp3';

    // Upload to Vercel Blob
    const blobPath = `voice-note-slots/${auth.accountId}/${slotId}/${Date.now()}.${ext}`;
    const blob = await put(blobPath, buffer, {
      access: 'public',
      contentType: mimeType
    });

    // Update slot record
    const updated = await prisma.voiceNoteSlot.update({
      where: { id: slotId },
      data: {
        audioFileUrl: blob.url,
        audioDurationSecs,
        uploadedAt: new Date(),
        status: 'UPLOADED'
      }
    });

    return NextResponse.json({
      slot: updated,
      audioUrl: blob.url,
      duration: audioDurationSecs
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(
      'POST /api/settings/persona/voice-slots/upload error:',
      errMsg
    );
    return NextResponse.json(
      { error: `Failed to upload audio: ${errMsg}` },
      { status: 500 }
    );
  }
}
