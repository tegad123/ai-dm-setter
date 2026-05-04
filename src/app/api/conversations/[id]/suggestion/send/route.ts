// ---------------------------------------------------------------------------
// POST /api/conversations/[id]/suggestion/send
// ---------------------------------------------------------------------------
// Approve (or edit-then-approve) a pending AISuggestion. Ships to the
// platform (Instagram / Facebook), saves the Message row, marks the
// suggestion actioned, and logs a TrainingEvent so approval-rate
// metrics can surface "ready for auto-send" on the dashboard.
//
// Two modes:
//   1. Verbatim approval: body has no `editedContent`. Ships the
//      suggestion's text unchanged as an AI-sender Message with
//      `manuallyApproved=true`. AISuggestion.wasSelected=true.
//      TrainingEvent.type=APPROVED.
//
//   2. Edit-then-send: body has `editedContent`. Ships the edited
//      string as a HUMAN-sender Message with `isHumanOverride=true`
//      (feeds into the existing override-detection training signal).
//      AISuggestion.editedByHuman=true, humanEditedContent stored,
//      wasSelected=false. TrainingEvent.type=EDITED.
//
// Multi-bubble suggestions: if no edits AND bubbleCount>1, ships each
// bubble as its own Message row with a typing-time delay between. An
// edited send always ships as a single-string (the operator's edit
// collapses the bubble split).
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { sendDM as sendInstagramDM } from '@/lib/instagram';
import { sendMessage as sendFacebookMessage } from '@/lib/facebook';
import {
  broadcastNewMessage,
  broadcastConversationUpdate
} from '@/lib/realtime';
import { recordStageTimestamp } from '@/lib/conversation-state-machine';
import {
  updateLeadStageFromConversation,
  type CapitalOutcome
} from '@/lib/stage-progression';
import {
  detectMetadataLeak,
  sanitizeDashCharacters
} from '@/lib/voice-quality-gate';
import { NextRequest, NextResponse } from 'next/server';

const CAPITAL_OUTCOMES: ReadonlySet<string> = new Set([
  'passed',
  'failed',
  'hedging',
  'ambiguous',
  'not_asked',
  'not_evaluated'
]);

function calcTypingDelayMs(nextChars: number): number {
  const base = 200 + Math.random() * 600; // 200–800ms
  const perChar = 30 + Math.random() * 20; // 30–50ms / char
  return Math.min(Math.round(base + nextChars * perChar), 4000);
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalizeCapitalOutcome(value: string | null): CapitalOutcome {
  return CAPITAL_OUTCOMES.has(value ?? '')
    ? (value as CapitalOutcome)
    : 'not_evaluated';
}

function isInternalNoteContent(text: string): boolean {
  return text.trimStart().startsWith('OPERATOR NOTE:');
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: conversationId } = await params;
    const body = (await req.json()) as {
      suggestionId?: string;
      editedContent?: string | null;
    };

    if (!body.suggestionId) {
      return NextResponse.json(
        { error: 'suggestionId is required' },
        { status: 400 }
      );
    }

    // Load conversation + lead. Platform operators can act across accounts.
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        ...(isPlatformOperator(auth.role)
          ? {}
          : { lead: { accountId: auth.accountId } })
      },
      select: {
        id: true,
        leadId: true,
        lead: {
          select: {
            id: true,
            name: true,
            handle: true,
            platform: true,
            platformUserId: true,
            accountId: true,
            stage: true
          }
        }
      }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Load + ownership-verify the suggestion.
    const suggestion = await prisma.aISuggestion.findFirst({
      where: {
        id: body.suggestionId,
        conversationId,
        accountId: conversation.lead.accountId
      }
    });
    if (!suggestion) {
      return NextResponse.json(
        { error: 'Suggestion not found or not eligible' },
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

    const editedRaw =
      typeof body.editedContent === 'string' ? body.editedContent.trim() : '';
    const isEdited =
      editedRaw.length > 0 && editedRaw !== suggestion.responseText;

    // Decide what to ship. Edited send collapses to a single string
    // (operator typed one message); verbatim approval of a multi-bubble
    // suggestion ships each bubble separately.
    const bubblesRaw = suggestion.messageBubbles;
    const unsanitizedBubbles: string[] =
      !isEdited && Array.isArray(bubblesRaw) && bubblesRaw.length > 1
        ? (bubblesRaw as unknown as string[]).filter(
            (s) => typeof s === 'string' && s.trim().length > 0
          )
        : [isEdited ? editedRaw : suggestion.responseText];
    const bubbles = isEdited
      ? unsanitizedBubbles
      : unsanitizedBubbles.map((bubble) => sanitizeDashCharacters(bubble));

    if (bubbles.length === 0 || bubbles.every((b) => !b.trim())) {
      return NextResponse.json(
        { error: 'Empty content cannot be sent' },
        { status: 400 }
      );
    }

    if (bubbles.some(isInternalNoteContent)) {
      return NextResponse.json(
        { error: 'Internal notes cannot be sent to the lead' },
        { status: 400 }
      );
    }

    const metadataLeakBubble = bubbles.find(
      (bubble) => detectMetadataLeak(bubble).leak
    );
    if (metadataLeakBubble) {
      const metadataLeak = detectMetadataLeak(metadataLeakBubble);
      return NextResponse.json(
        {
          error:
            'Lead-facing messages cannot contain internal metadata or placeholders',
          matchedText: metadataLeak.matchedText
        },
        { status: 400 }
      );
    }

    const { lead } = conversation;
    if (!lead.platformUserId) {
      return NextResponse.json(
        { error: 'Lead has no platformUserId — cannot deliver' },
        { status: 400 }
      );
    }

    const nowForAction = new Date();
    const messageIds: string[] = [];

    // Ship each bubble. Send-first → save Message row only on success,
    // same pattern as fireScheduledMessage (send-first-then-save fix
    // from the Tahir Khan commit). If a bubble send fails we throw —
    // already-delivered bubbles stay on Meta (can't be un-sent) and the
    // suggestion remains in its pre-action state so the operator can
    // retry without hitting the "already actioned" guard.
    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i];
      try {
        let sendResult: { messageId: string } | undefined;
        if (lead.platform === 'INSTAGRAM') {
          sendResult = await sendInstagramDM(
            lead.accountId,
            lead.platformUserId,
            bubble
          );
        } else if (lead.platform === 'FACEBOOK') {
          sendResult = await sendFacebookMessage(
            lead.accountId,
            lead.platformUserId,
            bubble
          );
        } else {
          throw new Error(`unsupported platform: ${lead.platform}`);
        }

        // Save Message row AFTER the send succeeds. sender differs by
        // mode: verbatim → AI (+ manuallyApproved); edited → HUMAN with
        // isHumanOverride + rejectedAISuggestionId.
        const msg = await prisma.message.create({
          data: {
            conversationId,
            sender: isEdited ? 'HUMAN' : 'AI',
            content: bubble,
            timestamp: new Date(),
            platformMessageId: sendResult?.messageId ?? null,
            // Attribute the operator for edited sends (same as manual
            // HUMAN sends through the thread input).
            ...(isEdited
              ? {
                  sentByUserId: auth.userId,
                  humanSource: 'DASHBOARD',
                  isHumanOverride: true,
                  rejectedAISuggestionId: suggestion.id,
                  editedFromSuggestion: true
                }
              : {}),
            stage:
              i === 0
                ? (suggestion.aiStageReported ??
                  suggestion.leadStageSnapshot ??
                  null)
                : null,
            suggestionId: i === 0 && !isEdited ? suggestion.id : null
          }
        });
        messageIds.push(msg.id);

        const humanSource =
          msg.humanSource === 'DASHBOARD' || msg.humanSource === 'PHONE'
            ? msg.humanSource
            : null;

        broadcastNewMessage(auth.accountId, {
          id: msg.id,
          conversationId,
          sender: msg.sender,
          content: bubble,
          humanSource,
          sentByUser: isEdited
            ? { id: auth.userId, name: auth.name, email: auth.email }
            : null,
          platformMessageId: msg.platformMessageId,
          timestamp: msg.timestamp.toISOString()
        });

        // Typing-time pause between bubbles.
        if (i < bubbles.length - 1) {
          await sleep(calcTypingDelayMs(bubbles[i + 1].length));
        }
      } catch (sendErr) {
        console.error(
          `[suggestion/send] delivery failed for bubble ${i}/${bubbles.length} conv=${conversationId}:`,
          sendErr
        );
        return NextResponse.json(
          {
            error: 'Platform delivery failed',
            detail: String(sendErr).slice(0, 400),
            deliveredBubbles: messageIds.length
          },
          { status: 502 }
        );
      }
    }

    const stageForProgression =
      suggestion.aiStageReported ?? suggestion.leadStageSnapshot ?? null;
    const subStageForProgression = suggestion.aiSubStageReported ?? null;
    const capitalOutcome = normalizeCapitalOutcome(suggestion.capitalOutcome);

    if (stageForProgression) {
      await recordStageTimestamp(conversationId, stageForProgression).catch(
        (err) => console.error('[suggestion/send] Stage timestamp error:', err)
      );

      await updateLeadStageFromConversation(
        lead.id,
        lead.stage,
        stageForProgression,
        subStageForProgression,
        capitalOutcome,
        {
          transitionedBy: 'ai',
          reasonPrefix: `suggestion_approval:${isEdited ? 'edited' : 'approved'}`
        }
      ).catch((err) =>
        console.error('[suggestion/send] Lead stage update failed:', err)
      );
    }

    // Mark the suggestion actioned + record training signal. Best-effort
    // — if these writes fail the messages are already on the platform.
    await prisma.aISuggestion
      .update({
        where: { id: suggestion.id },
        data: {
          actionedAt: nowForAction,
          ...(isEdited
            ? {
                editedByHuman: true,
                humanEditedContent: editedRaw,
                wasEdited: true,
                wasRejected: false,
                wasSelected: false,
                finalSentText: editedRaw
              }
            : {
                manuallyApproved: true,
                wasSelected: true,
                finalSentText: bubbles.join('\n')
              })
        }
      })
      .catch((err) =>
        console.error('[suggestion/send] AISuggestion update failed:', err)
      );

    await prisma.trainingEvent
      .create({
        data: {
          accountId: lead.accountId,
          conversationId,
          suggestionId: suggestion.id,
          type: isEdited ? 'EDITED' : 'APPROVED',
          platform: lead.platform,
          originalContent: suggestion.responseText,
          editedContent: isEdited ? editedRaw : null
        }
      })
      .catch((err) =>
        console.error('[suggestion/send] TrainingEvent create failed:', err)
      );

    // Bump conversation + broadcast.
    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: nowForAction,
        awaitingAiResponse: false,
        awaitingSince: null
      },
      select: {
        id: true,
        leadId: true,
        aiActive: true,
        unreadCount: true,
        lastMessageAt: true
      }
    });
    broadcastConversationUpdate(auth.accountId, {
      id: updated.id,
      leadId: updated.leadId,
      aiActive: updated.aiActive,
      unreadCount: updated.unreadCount,
      lastMessageAt: updated.lastMessageAt?.toISOString()
    });

    return NextResponse.json({
      messageIds,
      sentAt: nowForAction.toISOString(),
      mode: isEdited ? 'edited' : 'approved'
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('POST /api/conversations/[id]/suggestion/send error:', err);
    return NextResponse.json(
      { error: 'Failed to send suggestion' },
      { status: 500 }
    );
  }
}
