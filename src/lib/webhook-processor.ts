import prisma from '@/lib/prisma';
import type { Platform, TriggerType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Shared webhook processing logic for Instagram & Facebook
// ---------------------------------------------------------------------------

interface IncomingMessageParams {
  accountId: string;
  platformUserId: string;
  platform: 'INSTAGRAM' | 'FACEBOOK';
  senderName: string;
  senderHandle: string;
  messageText: string;
  triggerType: 'DM' | 'COMMENT';
  triggerSource?: string;
}

interface ProcessResult {
  leadId: string;
  conversationId: string;
  messageId: string;
}

// ---------------------------------------------------------------------------
// Process an incoming DM — find or create lead, conversation, and message
// ---------------------------------------------------------------------------

export async function processIncomingMessage(
  params: IncomingMessageParams
): Promise<ProcessResult> {
  const {
    accountId,
    platformUserId,
    platform,
    senderName,
    senderHandle,
    messageText,
    triggerType,
    triggerSource
  } = params;

  // 1. Find or create the lead (scoped to account)
  let lead = await prisma.lead.findFirst({
    where: { platformUserId, platform: platform as Platform, accountId }
  });

  if (!lead) {
    lead = await prisma.lead.create({
      data: {
        accountId,
        name: senderName,
        handle: senderHandle,
        platform: platform as Platform,
        status: 'NEW_LEAD',
        triggerType: triggerType as TriggerType,
        triggerSource: triggerSource ?? null,
        platformUserId
      }
    });

    // Fire a NEW_LEAD notification (team-wide, userId = null)
    await prisma.notification.create({
      data: {
        accountId,
        type: 'NEW_LEAD',
        title: 'New Lead',
        body: `${senderName} (@${senderHandle}) on ${platform}`,
        leadId: lead.id
      }
    });
  }

  // 2. Find or create the conversation
  let conversation = await prisma.conversation.findUnique({
    where: { leadId: lead.id }
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        leadId: lead.id,
        aiActive: true,
        unreadCount: 1,
        lastMessageAt: new Date()
      }
    });
  } else {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        unreadCount: { increment: 1 },
        lastMessageAt: new Date()
      }
    });
  }

  // 3. Save the incoming message
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      sender: 'LEAD',
      content: messageText,
      timestamp: new Date()
    }
  });

  return {
    leadId: lead.id,
    conversationId: conversation.id,
    messageId: message.id
  };
}

// ---------------------------------------------------------------------------
// Schedule an AI reply with a random 5–10 minute delay
// ---------------------------------------------------------------------------

export async function scheduleAIReply(conversationId: string): Promise<void> {
  const delayMs = randomBetween(5 * 60 * 1000, 10 * 60 * 1000);

  // In production this would be a proper job queue (e.g. BullMQ, SQS).
  // For now we use setTimeout — the delay makes the AI feel more natural.
  setTimeout(async () => {
    try {
      // Check if AI is still active for this conversation
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { aiActive: true }
      });

      if (!conversation?.aiActive) return;

      // Call the internal generate-reply endpoint
      const baseUrl =
        process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
      await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '__AI_GENERATE__', // sentinel value the messages endpoint can detect
          sender: 'AI'
        })
      });
    } catch (err) {
      console.error(
        `[webhook-processor] Failed to schedule AI reply for conversation ${conversationId}:`,
        err
      );
    }
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Process a comment trigger — create lead and initiate DM
// ---------------------------------------------------------------------------

interface CommentTriggerParams {
  accountId: string;
  platformUserId: string;
  platform: 'INSTAGRAM' | 'FACEBOOK';
  commenterName: string;
  commenterHandle: string;
  commentText: string;
  postId: string;
}

export async function processCommentTrigger(
  params: CommentTriggerParams
): Promise<void> {
  const {
    platformUserId,
    platform,
    commenterName,
    commenterHandle,
    commentText,
    postId
  } = params;

  // Process as incoming message with COMMENT trigger
  const result = await processIncomingMessage({
    accountId: params.accountId,
    platformUserId,
    platform,
    senderName: commenterName,
    senderHandle: commenterHandle,
    messageText: commentText,
    triggerType: 'COMMENT',
    triggerSource: postId
  });

  // Schedule an AI-generated DM reply to the commenter
  await scheduleAIReply(result.conversationId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
