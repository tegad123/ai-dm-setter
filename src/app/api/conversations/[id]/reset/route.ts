import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';

/**
 * POST /api/conversations/[id]/reset
 *
 * Reset a conversation to a clean step-1 slate for verification re-runs
 * (Tega, 2026-07-27: "I need a reset-to-step-1 I can trigger myself").
 *
 * Clears: message history, scheduled replies, AI suggestions, captured
 * variables, step/stage state, capital verification columns, distress and
 * hold flags, stage panel timestamps.
 * Keeps: the Conversation row, the Lead row, the persona binding, and the
 * verificationBaseline / archivedAt system flags (a reset baseline is still
 * a baseline; an archived conversation stays archived).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

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

    // System flags survive the reset — everything else in CDP is cleared.
    const oldCdp = (conversation.capturedDataPoints ?? {}) as Record<
      string,
      unknown
    >;
    const preservedCdp: Record<string, unknown> = {};
    for (const flag of ['verificationBaseline', 'archivedAt']) {
      if (oldCdp[flag] !== undefined) preservedCdp[flag] = oldCdp[flag];
    }

    // Step-1 systemStage from the account's active script, when one exists.
    const activeScript = await prisma.script.findFirst({
      where: { accountId: conversation.lead?.accountId, isActive: true },
      select: {
        steps: {
          where: { stepNumber: 1 },
          select: { title: true },
          take: 1
        }
      }
    });
    const stepOneTitle = activeScript?.steps?.[0]?.title ?? null;

    const delMsgs = await prisma.message.deleteMany({
      where: { conversationId: id }
    });
    await prisma.scheduledReply.deleteMany({ where: { conversationId: id } });
    await prisma.aISuggestion
      .deleteMany({ where: { conversationId: id } })
      .catch(() => {});

    await prisma.conversation.update({
      where: { id },
      data: {
        capturedDataPoints: preservedCdp as Prisma.InputJsonValue,
        systemStage: stepOneTitle,
        currentScriptStep: 1,
        llmEmittedStage: null,
        stageMismatchCount: 0,
        aiActive: true,
        awaitingAiResponse: false,
        awaitingSince: null,
        awaitingHumanReview: false,
        distressDetected: false,
        distressDetectedAt: null,
        distressMessageId: null,
        lastSilentStopAt: null,
        capitalVerificationStatus: 'UNVERIFIED',
        capitalVerifiedAt: null,
        capitalVerifiedAmount: null,
        capitalQAskedCount: 0,
        scheduledCallAt: null,
        stageOpeningAt: null,
        stageSituationDiscoveryAt: null,
        stageGoalEmotionalWhyAt: null,
        stageUrgencyAt: null,
        stageSoftPitchCommitmentAt: null,
        stageFinancialScreeningAt: null,
        stageBookingAt: null,
        outcome: 'ONGOING'
      }
    });

    // Audit the reset the same way deletions are audited — resets rewrite
    // evidence too, so they must be attributable.
    console.warn(
      `[audit] conversation RESET by ${auth.email} (${auth.role}): conv=${id} lead="${conversation.lead?.name}" clearedMessages=${delMsgs.count}`
    );
    await prisma.notification
      .create({
        data: {
          accountId: conversation.lead?.accountId ?? auth.accountId,
          type: 'SYSTEM',
          title: 'Conversation reset to step 1',
          body: `Conversation ${id} (lead "${conversation.lead?.name}") was reset to step 1 by ${auth.name} <${auth.email}> — ${delMsgs.count} messages cleared for a verification re-run.`
        }
      })
      .catch(() => {});

    return NextResponse.json({
      ok: true,
      clearedMessages: delMsgs.count,
      systemStage: stepOneTitle,
      preservedFlags: Object.keys(preservedCdp)
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/conversations/[id]/reset error:', error);
    return NextResponse.json(
      { error: 'Failed to reset conversation' },
      { status: 500 }
    );
  }
}
