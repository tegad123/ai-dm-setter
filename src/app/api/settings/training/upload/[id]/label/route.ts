import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import { TrainingOutcome } from '@prisma/client';

const VALID_OUTCOMES: string[] = Object.values(TrainingOutcome);

// ---------------------------------------------------------------------------
// PUT — Label conversation outcomes for an upload
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();

    // ── Verify upload belongs to this account ───────────────
    const upload = await prisma.trainingUpload.findFirst({
      where: { id, accountId: auth.accountId },
      select: { id: true, status: true }
    });
    if (!upload) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
    }

    // ── Bulk-all: apply one label to every conversation in the upload ──
    if (body.outcomeLabel && !body.conversationId && !body.labels) {
      if (!VALID_OUTCOMES.includes(body.outcomeLabel)) {
        return NextResponse.json(
          {
            error: `Invalid outcomeLabel. Valid values: ${VALID_OUTCOMES.join(', ')}`
          },
          { status: 400 }
        );
      }

      const result = await prisma.trainingConversation.updateMany({
        where: { uploadId: id, accountId: auth.accountId },
        data: { outcomeLabel: body.outcomeLabel as TrainingOutcome }
      });

      return NextResponse.json({ updated: result.count });
    }

    // ── Single label ────────────────────────────────────────
    if (body.conversationId && body.outcomeLabel) {
      if (!VALID_OUTCOMES.includes(body.outcomeLabel)) {
        return NextResponse.json(
          {
            error: `Invalid outcomeLabel. Valid values: ${VALID_OUTCOMES.join(', ')}`
          },
          { status: 400 }
        );
      }

      // Verify conversation belongs to this upload
      const convo = await prisma.trainingConversation.findFirst({
        where: {
          id: body.conversationId,
          uploadId: id,
          accountId: auth.accountId
        }
      });
      if (!convo) {
        return NextResponse.json(
          { error: 'Conversation not found in this upload' },
          { status: 404 }
        );
      }

      const updated = await prisma.trainingConversation.update({
        where: { id: body.conversationId },
        data: { outcomeLabel: body.outcomeLabel as TrainingOutcome },
        select: {
          id: true,
          leadIdentifier: true,
          outcomeLabel: true
        }
      });

      return NextResponse.json({ updated: 1, conversation: updated });
    }

    // ── Batch labels ────────────────────────────────────────
    if (Array.isArray(body.labels)) {
      // Validate all labels first
      for (const item of body.labels) {
        if (!item.conversationId || !item.outcomeLabel) {
          return NextResponse.json(
            { error: 'Each label must have conversationId and outcomeLabel' },
            { status: 400 }
          );
        }
        if (!VALID_OUTCOMES.includes(item.outcomeLabel)) {
          return NextResponse.json(
            {
              error: `Invalid outcomeLabel "${item.outcomeLabel}". Valid values: ${VALID_OUTCOMES.join(', ')}`
            },
            { status: 400 }
          );
        }
      }

      // Verify all conversations belong to this upload
      const convoIds = body.labels.map(
        (l: { conversationId: string }) => l.conversationId
      );
      const convos = await prisma.trainingConversation.findMany({
        where: {
          id: { in: convoIds },
          uploadId: id,
          accountId: auth.accountId
        },
        select: { id: true }
      });
      const foundIds = new Set(convos.map((c) => c.id));
      const missing = convoIds.filter((cid: string) => !foundIds.has(cid));
      if (missing.length > 0) {
        return NextResponse.json(
          {
            error: `Conversations not found in this upload: ${missing.join(', ')}`
          },
          { status: 404 }
        );
      }

      // Apply labels in transaction
      await prisma.$transaction(
        body.labels.map(
          (item: { conversationId: string; outcomeLabel: string }) =>
            prisma.trainingConversation.update({
              where: { id: item.conversationId },
              data: {
                outcomeLabel: item.outcomeLabel as TrainingOutcome
              }
            })
        )
      );

      return NextResponse.json({ updated: body.labels.length });
    }

    return NextResponse.json(
      {
        error:
          'Provide either { outcomeLabel } (bulk-all), { conversationId, outcomeLabel } (single), or { labels: [...] } (batch)'
      },
      { status: 400 }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/settings/training/upload/[id]/label error:', error);
    return NextResponse.json(
      { error: 'Failed to update labels' },
      { status: 500 }
    );
  }
}
