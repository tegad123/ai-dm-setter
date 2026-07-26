import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(request);
    const { id } = await params;

    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        ...(isPlatformOperator(auth.role)
          ? {}
          : { lead: { accountId: auth.accountId } })
      },
      include: {
        lead: true,
        messages: {
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ conversation });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch conversation:', error);
    return NextResponse.json(
      { error: 'Failed to fetch conversation' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(request);
    const { id } = await params;

    // Verify the conversation exists and belongs to the authenticated workspace
    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        ...(isPlatformOperator(auth.role)
          ? {}
          : { lead: { accountId: auth.accountId } })
      },
      select: {
        id: true,
        leadId: true,
        capturedDataPoints: true,
        lead: { select: { name: true, accountId: true } },
        _count: { select: { messages: true } }
      }
    });

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Verification-baseline hold (2026-07-26, standing rule after four test
    // conversations — three SQA + one verification run — were deleted
    // mid-review with no audit trail): a conversation flagged as a
    // verification baseline must never be deleted. Replays happen on a copy.
    const cdpForDelete = conversation.capturedDataPoints as Record<
      string,
      unknown
    > | null;
    if (cdpForDelete?.verificationBaseline === true) {
      return NextResponse.json(
        {
          error:
            'This conversation is a verification baseline and cannot be deleted while the flag is set. Standing rule: replay on a copy, never delete evidence.'
        },
        { status: 409 }
      );
    }

    // ScheduledReply stores conversationId as a bare field (no Prisma-level
    // relation) so it does not cascade — delete it manually first.
    await prisma.scheduledReply.deleteMany({
      where: { conversationId: id }
    });

    // Deletion audit (2026-07-26): deletions were previously untraceable —
    // record WHO deleted WHAT, durably, before the cascade wipes it.
    console.warn(
      `[audit] conversation DELETE by ${auth.email} (${auth.role}): conv=${id} lead="${conversation.lead?.name}" messages=${conversation._count.messages}`
    );
    await prisma.notification
      .create({
        data: {
          accountId: conversation.lead?.accountId ?? auth.accountId,
          type: 'SYSTEM',
          title: 'Conversation deleted',
          body: `Conversation ${id} (lead "${conversation.lead?.name}", ${conversation._count.messages} messages) was permanently deleted by ${auth.name} <${auth.email}>.`
        }
      })
      .catch(() => {});

    // Deleting the Lead cascades to the Conversation and all its children
    // (Message, AISuggestion, ScheduledMessage, InboundQualification, etc.)
    // via Prisma onDelete: Cascade relations.
    await prisma.lead.delete({ where: { id: conversation.leadId } });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to delete conversation:', error);
    return NextResponse.json(
      { error: 'Failed to delete conversation' },
      { status: 500 }
    );
  }
}
