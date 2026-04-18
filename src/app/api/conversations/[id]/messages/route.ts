import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import {
  broadcastNewMessage,
  broadcastConversationUpdate,
  broadcastAIStatusChange
} from '@/lib/realtime';
import { sendMessage as sendFacebookMessage } from '@/lib/facebook';
import { sendDM as sendInstagramDM } from '@/lib/instagram';
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
      where: { id, lead: { accountId: auth.accountId } }
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
      take: limit
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
      where: { id, lead: { accountId: auth.accountId } }
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

    // Normalize sender to match Prisma enum (HUMAN, AI, LEAD)
    const sender = (rawSender as string).toUpperCase() as
      | 'HUMAN'
      | 'AI'
      | 'LEAD';

    if (!content) {
      return NextResponse.json(
        { error: 'Content is required' },
        { status: 400 }
      );
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
            where: { id: auth.accountId },
            select: { trainingPhase: true }
          });
          const isOnboarding = accountRow?.trainingPhase === 'ONBOARDING';

          // Jaccard similarity
          const sArr = recentSuggestion.responseText.toLowerCase().split(/\s+/);
          const hArr = (content as string).toLowerCase().split(/\s+/);
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
              finalSentText: content,
              similarityToFinalSent: sim
            }
          });

          // Always increment override count. Phase gates UI, not capture —
          // see comment in webhook-processor.ts for rationale. Mirror that
          // logic here so direct-API overrides (dashboard "send as human")
          // also accumulate training signal regardless of phase.
          await prisma.account.update({
            where: { id: auth.accountId },
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
        content,
        sender,
        timestamp: now,
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
    const updateData: { lastMessageAt: Date; aiActive?: boolean } = {
      lastMessageAt: now
    };
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
    }

    const updatedConvo = await prisma.conversation.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        leadId: true,
        aiActive: true,
        unreadCount: true,
        lastMessageAt: true
      }
    });

    // Broadcast real-time events
    broadcastNewMessage({
      id: message.id,
      conversationId: id,
      sender: message.sender,
      content: message.content,
      timestamp: message.timestamp.toISOString()
    });

    broadcastConversationUpdate({
      id: updatedConvo.id,
      leadId: updatedConvo.leadId,
      aiActive: updatedConvo.aiActive,
      unreadCount: updatedConvo.unreadCount,
      lastMessageAt: updatedConvo.lastMessageAt?.toISOString()
    });

    if (sender === 'HUMAN') {
      broadcastAIStatusChange({ conversationId: id, aiActive: false });
    }

    // Fire-and-forget: send the message to the platform (Facebook/Instagram)
    // Don't block the API response — deliver in background
    if (sender === 'HUMAN' || sender === 'AI') {
      prisma.lead
        .findUnique({
          where: { id: conversation.leadId },
          select: { platformUserId: true, platform: true, accountId: true }
        })
        .then(async (lead) => {
          if (!lead?.platformUserId) return;
          try {
            if (lead.platform === 'FACEBOOK') {
              await sendFacebookMessage(
                lead.accountId,
                lead.platformUserId,
                content
              );
              console.log(
                `[send] Facebook message sent to ${lead.platformUserId}`
              );
            } else if (lead.platform === 'INSTAGRAM') {
              await sendInstagramDM(
                lead.accountId,
                lead.platformUserId,
                content
              );
              console.log(`[send] Instagram DM sent to ${lead.platformUserId}`);
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
