import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';

/**
 * POST /api/conversations/archive   body: { ids: string[], archived: boolean }
 *
 * Bulk archive / unarchive (Tega, 2026-07-27: "a bulk archive so test
 * conversations get out of the dashboard without being deleted"). Archiving
 * stamps capturedDataPoints.archivedAt — nothing is deleted, traces and
 * messages stay intact, and the conversations list excludes archived rows
 * unless explicitly requested with ?archived=1.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json().catch(() => ({}));
    const ids: unknown = body.ids;
    const archived: unknown = body.archived;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 200 ||
      !ids.every((i) => typeof i === 'string') ||
      typeof archived !== 'boolean'
    ) {
      return NextResponse.json(
        { error: 'Body must be { ids: string[] (1-200), archived: boolean }' },
        { status: 400 }
      );
    }

    const conversations = await prisma.conversation.findMany({
      where: {
        id: { in: ids as string[] },
        ...(isPlatformOperator(auth.role)
          ? {}
          : { lead: { accountId: auth.accountId } })
      },
      select: { id: true, capturedDataPoints: true }
    });

    const stamp = new Date().toISOString();
    let updated = 0;
    for (const conv of conversations) {
      const cdp = (conv.capturedDataPoints ?? {}) as Record<string, unknown>;
      if (archived) {
        cdp.archivedAt = stamp;
      } else {
        delete cdp.archivedAt;
      }
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { capturedDataPoints: cdp as Prisma.InputJsonValue }
      });
      updated++;
    }

    console.warn(
      `[audit] bulk ${archived ? 'ARCHIVE' : 'UNARCHIVE'} by ${auth.email} (${auth.role}): ${updated}/${ids.length} conversations`
    );

    return NextResponse.json({
      ok: true,
      updated,
      notFound: ids.length - updated
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/conversations/archive error:', error);
    return NextResponse.json(
      { error: 'Failed to archive conversations' },
      { status: 500 }
    );
  }
}
