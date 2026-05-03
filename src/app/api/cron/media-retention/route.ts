import prisma from '@/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

const RETENTION_DAYS = 90;
const BATCH_SIZE = 500;
const SUPABASE_MEDIA_BUCKET =
  process.env.MEDIA_ATTACHMENTS_BUCKET || 'media-attachments';

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const messages = await prisma.message.findMany({
      where: {
        mediaProcessedAt: { lt: cutoff },
        mediaUrl: { not: null }
      },
      select: {
        id: true,
        mediaUrl: true
      },
      take: BATCH_SIZE
    });

    const mediaUrls = messages
      .map((message) => message.mediaUrl)
      .filter((url): url is string => Boolean(url));
    const supabasePaths = mediaUrls.filter((url) => !/^https?:\/\//i.test(url));
    const blobUrls = mediaUrls.filter((url) => /^https?:\/\//i.test(url));

    const [supabaseDeleted, blobDeleted] = await Promise.all([
      deleteSupabaseObjects(supabasePaths),
      deleteVercelBlobObjects(blobUrls)
    ]);

    if (messages.length > 0) {
      await prisma.message.updateMany({
        where: { id: { in: messages.map((message) => message.id) } },
        data: {
          mediaUrl: null,
          imageUrl: null,
          voiceNoteUrl: null
        }
      });
    }

    return NextResponse.json({
      cutoff: cutoff.toISOString(),
      scanned: messages.length,
      supabaseDeleted,
      blobDeleted,
      clearedRows: messages.length
    });
  } catch (error) {
    console.error('[cron/media-retention] failed:', error);
    return NextResponse.json(
      { error: 'media retention failed' },
      { status: 500 }
    );
  }
}

async function deleteSupabaseObjects(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;

  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.warn(
      '[cron/media-retention] Supabase credentials missing; skipped Supabase object deletion'
    );
    return 0;
  }

  const response = await fetch(
    `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${SUPABASE_MEDIA_BUCKET}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        apikey: supabaseKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prefixes: paths })
    }
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Supabase object deletion failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 160)}` : ''}`
    );
  }
  return paths.length;
}

async function deleteVercelBlobObjects(urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;

  try {
    const { del } = await import('@vercel/blob');
    await del(urls);
    return urls.length;
  } catch (error) {
    console.warn(
      '[cron/media-retention] Vercel Blob deletion failed:',
      error instanceof Error ? error.message : error
    );
    return 0;
  }
}
