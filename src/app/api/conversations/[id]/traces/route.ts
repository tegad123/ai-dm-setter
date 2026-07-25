// GET /api/conversations/[id]/traces — per-turn generation trace for a
// conversation. The self-serve trace access Tega required for verification
// (2026-07-25): branch_selected, stage_emitted, variables_state, hard fails,
// and (on demand) the full prompt_sent per turn.
//
// Access: any authenticated member of the conversation's account, or a
// platform operator. Same scoping rule as /api/conversations/[id].
//
// Query params:
//   ?prompts=1   include full promptSent for every turn (large)
//   ?prompt=N    include promptSent for turn index N only

import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
      select: {
        id: true,
        systemStage: true,
        currentScriptStep: true,
        awaitingHumanReview: true,
        distressDetected: true,
        capturedDataPoints: true,
        lead: { select: { name: true, accountId: true } }
      }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const url = new URL(request.url);
    const includeAllPrompts = url.searchParams.get('prompts') === '1';
    const promptIndexRaw = url.searchParams.get('prompt');
    const promptIndex =
      promptIndexRaw !== null ? Number.parseInt(promptIndexRaw, 10) : null;

    const traces = await prisma.generationTurnTrace.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        leadMessageId: true,
        stepNumber: true,
        systemStage: true,
        stageEmitted: true,
        subStageEmitted: true,
        branchSelected: true,
        variablesState: true,
        replyPreview: true,
        qualityHardFails: true,
        promptChars: true,
        promptSent: true
      }
    });

    // Strip prompts unless requested — they are 100k+ chars each.
    const turns = traces.map((t, i) => ({
      turn: i,
      createdAt: t.createdAt,
      leadMessageId: t.leadMessageId,
      step: t.stepNumber,
      system_stage: t.systemStage,
      stage_emitted: t.stageEmitted,
      sub_stage_emitted: t.subStageEmitted,
      branch_selected: t.branchSelected,
      variables_state: t.variablesState,
      reply_preview: t.replyPreview,
      quality_hard_fails: t.qualityHardFails,
      prompt_chars: t.promptChars,
      prompt_sent:
        includeAllPrompts || promptIndex === i ? t.promptSent : undefined
    }));

    // Final captured variables, bookkeeping keys stripped.
    const skip = new Set([
      'branchHistory',
      'generateReplyTrace',
      'lastClassifierTrace',
      'lastStepCompletionTrace',
      'stepCompletionTrace'
    ]);
    const cdp = (conversation.capturedDataPoints ?? {}) as Record<
      string,
      { value?: unknown; extractionMethod?: string; confidence?: string }
    >;
    const captured = Object.fromEntries(
      Object.entries(cdp)
        .filter(([k]) => !skip.has(k))
        .map(([k, v]) => [
          k,
          {
            value: v?.value !== undefined ? v.value : v,
            method: v?.extractionMethod ?? null,
            confidence: v?.confidence ?? null
          }
        ])
    );

    return NextResponse.json({
      conversationId: conversation.id,
      lead: conversation.lead?.name ?? null,
      finalState: {
        step: conversation.currentScriptStep,
        systemStage: conversation.systemStage,
        awaitingHumanReview: conversation.awaitingHumanReview,
        distressDetected: conversation.distressDetected
      },
      capturedVariables: captured,
      turnCount: turns.length,
      turns
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('[api/conversations/traces] error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
