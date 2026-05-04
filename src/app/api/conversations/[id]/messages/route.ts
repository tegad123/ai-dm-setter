import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import {
  broadcastNewMessage,
  broadcastConversationUpdate,
  broadcastAIStatusChange
} from '@/lib/realtime';
import { sendMessage as sendFacebookMessage } from '@/lib/facebook';
import { sendDM as sendInstagramDM } from '@/lib/instagram';
import {
  detectMetadataLeak,
  sanitizeDashCharacters
} from '@/lib/voice-quality-gate';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(request);
    const { id } = await params;

    // Verify conversation belongs to this account
    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        ...(isPlatformOperator(auth.role)
          ? {}
          : { lead: { accountId: auth.accountId } })
      }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const { searchParams } = new URL(request.url);
    // Default bumped 50 → 200 so normal conversations load their full
    // history. The UI can still paginate via `before` for conversations
    // that run past 200 turns.
    const limit = parseInt(searchParams.get('limit') || '200', 10);
    const before = searchParams.get('before');

    // CRITICAL: fetch the most RECENT N messages (DESC + take), then
    // reverse to ASC for rendering. The previous `orderBy: asc, take: N`
    // returned the OLDEST N messages — once a conversation passed the
    // limit, every new message was silently dropped from the chat view
    // (while the sidebar preview, which correctly uses DESC take 1,
    // still showed them). Idris's 73-message conversation with
    // limit=50 reproduced this exactly.
    const messages = await prisma.message.findMany({
      where: {
        conversationId: id,
        ...(before ? { timestamp: { lt: new Date(before) } } : {})
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
      // Pull the sending user's name for HUMAN messages so the UI can
      // show "Daniel" (vs another team member) instead of a generic
      // "Human Setter" label. Only populated when `sentByUserId` is
      // set — NULL for legacy HUMAN rows and for webhook-originated
      // admin messages (the operator sent from Meta Inbox directly,
      // not from the app, so we don't have their userId).
      include: {
        sentByUser: { select: { id: true, name: true, email: true } }
      }
    });
    // Reverse in-place to ASC so the client renders oldest→newest
    // without any UI-side changes needed.
    messages.reverse();

    return NextResponse.json({ messages });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch messages:', error);
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(request);
    const { id } = await params;

    // Verify conversation belongs to this account
    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        ...(isPlatformOperator(auth.role)
          ? {}
          : { lead: { accountId: auth.accountId } })
      },
      include: { lead: { select: { accountId: true } } }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const body = await request.json();
    const {
      content,
      sender: rawSender = 'HUMAN',
      stage,
      stageConfidence,
      sentimentScore,
      systemPromptVersion,
      followUpAttemptNumber
    } = body;

    if (!content) {
      return NextResponse.json(
        { error: 'Content is required' },
        { status: 400 }
      );
    }
    const contentText = typeof content === 'string' ? content : String(content);

    const requestedSender = String(rawSender).toUpperCase();
    if (!['HUMAN', 'AI', 'LEAD', 'SYSTEM'].includes(requestedSender)) {
      return NextResponse.json({ error: 'Invalid sender' }, { status: 400 });
    }

    // Normalize sender to match Prisma enum. OPERATOR NOTE payloads are
    // internal context even when callers accidentally/default-send them as
    // HUMAN, so fail closed into SYSTEM.
    const sender = (
      contentText.trimStart().startsWith('OPERATOR NOTE:')
        ? 'SYSTEM'
        : requestedSender
    ) as 'HUMAN' | 'AI' | 'LEAD' | 'SYSTEM';

    const messageContent =
      sender === 'AI' ? sanitizeDashCharacters(contentText) : contentText;

    if (sender === 'AI' || sender === 'HUMAN') {
      const metadataLeak = detectMetadataLeak(messageContent);
      if (metadataLeak.leak) {
        return NextResponse.json(
          {
            error:
              'Lead-facing messages cannot contain internal metadata or placeholders',
            matchedText: metadataLeak.matchedText
          },
          { status: 400 }
        );
      }
    }

    const now = new Date();

    // ── Closed-loop training: detect human override of AI suggestion ──
    let overrideFields: Record<string, unknown> = {};
    if (sender === 'HUMAN') {
      try {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const recentSuggestion = await prisma.aISuggestion.findFirst({
          where: {
            conversationId: id,
            wasSelected: false,
            wasRejected: false,
            generatedAt: { gte: twoHoursAgo }
          },
          orderBy: { generatedAt: 'desc' }
        });

        if (recentSuggestion) {
          const accountRow = await prisma.account.findUnique({
            where: { id: conversation.lead.accountId },
            select: { trainingPhase: true }
          });
          const isOnboarding = accountRow?.trainingPhase === 'ONBOARDING';

          // Jaccard similarity
          const sArr = recentSuggestion.responseText.toLowerCase().split(/\s+/);
          const hArr = messageContent.toLowerCase().split(/\s+/);
          const sWords = new Set(sArr);
          const hWords = new Set(hArr);
          const inter = sArr.filter((w) => hWords.has(w)).length;
          const allWords = new Set(sArr.concat(hArr));
          const sim = allWords.size > 0 ? inter / allWords.size : 0;

          overrideFields = {
            isHumanOverride: true,
            rejectedAISuggestionId: recentSuggestion.id,
            editedFromSuggestion: sim > 0.7,
            loggedDuringTrainingPhase: isOnboarding
          };

          // Update the suggestion
          await prisma.aISuggestion.update({
            where: { id: recentSuggestion.id },
            data: {
              wasRejected: true,
              wasEdited: sim > 0.7,
              finalSentText: messageContent,
              similarityToFinalSent: sim
            }
          });

          // Always increment override count. Phase gates UI, not capture —
          // see comment in webhook-processor.ts for rationale. Mirror that
          // logic here so direct-API overrides (dashboard "send as human")
          // also accumulate training signal regardless of phase.
          await prisma.account.update({
            where: { id: conversation.lead.accountId },
            data: { trainingOverrideCount: { increment: 1 } }
          });
        }
      } catch (err) {
        console.error('[messages] Override detection failed (non-fatal):', err);
      }
    }

    const message = await prisma.message.create({
      data: {
        conversationId: id,
        content: messageContent,
        sender,
        timestamp: now,
        // Populate sentByUserId for HUMAN messages so the UI can show
        // WHICH operator sent it (Daniel vs another setter on the
        // team) instead of the generic "Human Setter" label. Prior to
        // this, every HUMAN message had sentByUserId: null.
        // humanSource='DASHBOARD' — this message was typed into the
        // QualifyDMs UI rather than the native Meta app (the echo
        // path sets 'PHONE').
        ...(sender === 'HUMAN'
          ? { sentByUserId: auth.userId, humanSource: 'DASHBOARD' }
          : {}),
        ...overrideFields,
        // Self-optimizing layer tracking fields (only set for AI messages)
        ...(sender === 'AI'
          ? {
              stage: stage ?? null,
              stageConfidence:
                typeof stageConfidence === 'number'
                  ? Math.max(0, Math.min(1, stageConfidence))
                  : null,
              sentimentScore:
                typeof sentimentScore === 'number'
                  ? Math.max(-1, Math.min(1, sentimentScore))
                  : null,
              systemPromptVersion: systemPromptVersion ?? null,
              followUpAttemptNumber: followUpAttemptNumber ?? null
            }
          : {})
      }
    });

    // If human override, pause AI and update lastMessageAt
    const updateData: { lastMessageAt?: Date; aiActive?: boolean } = {};
    if (sender !== 'SYSTEM') {
      updateData.lastMessageAt = now;
    }
    if (sender === 'HUMAN') {
      updateData.aiActive = false;
      // Cancel any pending debounced AI reply — the human just took over.
      // Otherwise the queued AI reply would fire a minute later and talk
      // over the human's message.
      await prisma.scheduledReply
        .updateMany({
          where: { conversationId: id, status: 'PENDING' },
          data: { status: 'CANCELLED' }
        })
        .catch((err) => {
          console.error(
            '[messages] Failed to cancel pending replies on human takeover (non-fatal):',
            err
          );
        });
      // ALSO cancel any pending BOOKING_LINK_FOLLOWUP / FOLLOW_UP_*
      // cascade row. The scheduledReply table is the debounced reply
      // queue; the scheduledMessage table holds the 30-min booking
      // check-in + 12h follow-up cascade. Before this fix, a human
      // manual send cancelled the former but left the latter PENDING,
      // producing duplicate "did you book that call?" sends (daetradez
      // 2026-04-24 — Daniel's 7:58 PM manual message followed by the
      // AI's booking-cascade follow-up with identical content).
      try {
        const { cancelAllPendingFollowUps } = await import(
          '@/lib/follow-up-sequence'
        );
        await cancelAllPendingFollowUps(id);
      } catch (err) {
        console.error(
          '[messages] Failed to cancel pending follow-ups on human send (non-fatal):',
          err
        );
      }
    }

    const updatedConvo =
      Object.keys(updateData).length > 0
        ? await prisma.conversation.update({
            where: { id },
            data: updateData,
            select: {
              id: true,
              leadId: true,
              aiActive: true,
              unreadCount: true,
              lastMessageAt: true
            }
          })
        : await prisma.conversation.findUniqueOrThrow({
            where: { id },
            select: {
              id: true,
              leadId: true,
              aiActive: true,
              unreadCount: true,
              lastMessageAt: true
            }
          });

    // Broadcast real-time events
    const humanSource =
      message.humanSource === 'DASHBOARD' || message.humanSource === 'PHONE'
        ? message.humanSource
        : null;
    broadcastNewMessage(auth.accountId, {
      id: message.id,
      conversationId: id,
      sender: message.sender,
      content: message.content,
      humanSource,
      sentByUser:
        sender === 'HUMAN'
          ? { id: auth.userId, name: auth.name, email: auth.email }
          : null,
      platformMessageId: message.platformMessageId,
      timestamp: message.timestamp.toISOString()
    });

    if (sender !== 'SYSTEM') {
      broadcastConversationUpdate(auth.accountId, {
        id: updatedConvo.id,
        leadId: updatedConvo.leadId,
        aiActive: updatedConvo.aiActive,
        unreadCount: updatedConvo.unreadCount,
        lastMessageAt: updatedConvo.lastMessageAt?.toISOString()
      });
    }

    if (sender === 'HUMAN') {
      broadcastAIStatusChange(auth.accountId, {
        conversationId: id,
        aiActive: false
      });
    }

    // Fire-and-forget: send the message to the platform (Facebook/Instagram)
    // Don't block the API response — deliver in background.
    //
    // IMPORTANT: capture Meta's returned messageId and patch it onto
    // the Message row we already created. When Meta echoes our send
    // back via webhook (`processAdminMessage`), it arrives with the
    // same platformMessageId — the webhook's primary dedup is a
    // "already exists with this platformMessageId" check. Without
    // patching, the echo doesn't find a match and saves as a DUPLICATE
    // HUMAN message (Daniel reported seeing his manual sends with
    // incorrect/missing attribution — the dup was part of this).
    if (sender === 'SYSTEM') {
      // Internal notes are dashboard-only context. Never deliver them
      // to Instagram/Facebook, even if a caller tries to create one via
      // the normal message endpoint.
      return NextResponse.json(message, { status: 201 });
    }

    if (sender === 'HUMAN' || sender === 'AI') {
      prisma.lead
        .findUnique({
          where: { id: conversation.leadId },
          select: { platformUserId: true, platform: true, accountId: true }
        })
        .then(async (lead) => {
          if (!lead?.platformUserId) return;
          try {
            let sendResult: { messageId: string } | undefined;
            if (lead.platform === 'FACEBOOK') {
              sendResult = await sendFacebookMessage(
                lead.accountId,
                lead.platformUserId,
                messageContent
              );
              console.log(
                `[send] Facebook message sent to ${lead.platformUserId} (mid=${sendResult?.messageId ?? 'none'})`
              );
            } else if (lead.platform === 'INSTAGRAM') {
              sendResult = await sendInstagramDM(
                lead.accountId,
                lead.platformUserId,
                messageContent
              );
              console.log(
                `[send] Instagram DM sent to ${lead.platformUserId} (mid=${sendResult?.messageId ?? 'none'})`
              );
            }
            // Patch platformMessageId for echo dedup. Best-effort —
            // a failure here just means the echo might save a duplicate
            // HUMAN row (which the widened echo-detection in
            // processAdminMessage also catches as a belt-and-suspenders
            // fallback).
            if (sendResult?.messageId) {
              await prisma.message
                .update({
                  where: { id: message.id },
                  data: { platformMessageId: sendResult.messageId }
                })
                .catch((err) => {
                  console.error(
                    '[send] Failed to patch platformMessageId (non-fatal):',
                    err
                  );
                });
            }
          } catch (sendErr) {
            console.error(
              '[send] Failed to deliver message to platform:',
              sendErr
            );
          }
        })
        .catch((err) => {
          console.error('[send] Failed to lookup lead:', err);
        });
    }

    return NextResponse.json(message, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to send message:', error);
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}
