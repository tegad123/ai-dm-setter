import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';

/**
 * PATCH /api/conversations/[id]/baseline   body: { baseline: boolean }
 *
 * Manually set or clear the verification-baseline flag on one conversation
 * (Tega, 2026-07-27: "Give me a manual flag clear on a specific
 * conversation"). Clearing the flag re-enables deletion for THAT
 * conversation only — the protection against automated deletion stays,
 * because the cleanup paths never clear flags, only humans do, and every
 * change is audited.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (typeof body.baseline !== 'boolean') {
      return NextResponse.json(
        { error: 'Body must be { baseline: boolean }' },
        { status: 400 }
      );
    }

    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        ...(isPlatformOperator(auth.role)
          ? {}
          : { lead: { accountId: auth.accountId } })
      },
      select: {
        id: true,
        capturedDataPoints: true,
        lead: { select: { accountId: true, name: true } }
      }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const cdp = (conversation.capturedDataPoints ?? {}) as Record<
      string,
      unknown
    >;
    if (body.baseline) {
      cdp.verificationBaseline = true;
    } else {
      delete cdp.verificationBaseline;
    }
    await prisma.conversation.update({
      where: { id },
      data: { capturedDataPoints: cdp as Prisma.InputJsonValue }
    });

    console.warn(
      `[audit] baseline flag ${body.baseline ? 'SET' : 'CLEARED'} by ${auth.email} (${auth.role}): conv=${id} lead="${conversation.lead?.name}"`
    );
    await prisma.notification
      .create({
        data: {
          accountId: conversation.lead?.accountId ?? auth.accountId,
          type: 'SYSTEM',
          title: `Verification baseline ${body.baseline ? 'set' : 'cleared'}`,
          body: `Baseline flag ${body.baseline ? 'set' : 'cleared'} on conversation ${id} (lead "${conversation.lead?.name}") by ${auth.name} <${auth.email}>.`
        }
      })
      .catch(() => {});

    return NextResponse.json({ ok: true, baseline: body.baseline });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PATCH /api/conversations/[id]/baseline error:', error);
    return NextResponse.json(
      { error: 'Failed to update baseline flag' },
      { status: 500 }
    );
  }
}
