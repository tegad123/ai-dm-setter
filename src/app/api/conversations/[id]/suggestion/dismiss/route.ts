// ---------------------------------------------------------------------------
// POST /api/conversations/[id]/suggestion/dismiss
// ---------------------------------------------------------------------------
// Operator explicitly rejected a pending suggestion. Marks the
// AISuggestion as dismissed, records a REJECTED TrainingEvent, and
// returns — no Meta send, no Message row.
//
// The dashboard's "ready for auto-send" readiness metric reads these
// REJECTED events against APPROVED / EDITED to compute approval-rate.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: conversationId } = await params;
    const body = (await req.json()) as { suggestionId?: string };

    if (!body.suggestionId) {
      return NextResponse.json(
        { error: 'suggestionId is required' },
        { status: 400 }
      );
    }

    // Ownership-verify the suggestion + fetch platform for the event row.
    const suggestion = await prisma.aISuggestion.findFirst({
      where: {
        id: body.suggestionId,
        conversationId,
        ...(isPlatformOperator(auth.role) ? {} : { accountId: auth.accountId })
      },
      include: {
        conversation: {
          select: { lead: { select: { platform: true, accountId: true } } }
        }
      }
    });
    if (!suggestion) {
      return NextResponse.json(
        { error: 'Suggestion not found' },
        { status: 404 }
      );
    }
    if (
      suggestion.actionedAt ||
      suggestion.dismissed ||
      suggestion.wasSelected
    ) {
      return NextResponse.json(
        { error: 'Suggestion already actioned' },
        { status: 409 }
      );
    }

    const now = new Date();
    await prisma.aISuggestion.update({
      where: { id: suggestion.id },
      data: {
        dismissed: true,
        wasRejected: true,
        actionedAt: now,
        finalSentText: null
      }
    });

    await prisma.trainingEvent
      .create({
        data: {
          accountId: suggestion.conversation.lead.accountId,
          conversationId,
          suggestionId: suggestion.id,
          type: 'REJECTED',
          platform: suggestion.conversation.lead.platform,
          originalContent: suggestion.responseText,
          editedContent: null
        }
      })
      .catch((err) =>
        console.error(
          '[suggestion/dismiss] TrainingEvent create failed (non-fatal):',
          err
        )
      );

    return NextResponse.json({
      dismissed: true,
      actionedAt: now.toISOString()
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(
      'POST /api/conversations/[id]/suggestion/dismiss error:',
      err
    );
    return NextResponse.json(
      { error: 'Failed to dismiss suggestion' },
      { status: 500 }
    );
  }
}
