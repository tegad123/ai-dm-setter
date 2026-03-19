import prisma from '@/lib/prisma';
import type { Platform, TriggerType, ContentType } from '@prisma/client';

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
  contentSource?: {
    contentType: ContentType;
    contentId?: string;
    contentUrl?: string;
    caption?: string;
  };
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
    triggerSource,
    contentSource
  } = params;

  // 1. Resolve content attribution (if content source provided)
  let contentAttributionId: string | null = null;

  if (contentSource) {
    const existingAttribution = contentSource.contentId
      ? await prisma.contentAttribution.findUnique({
          where: {
            accountId_contentId_platform: {
              accountId,
              contentId: contentSource.contentId,
              platform: platform as Platform
            }
          }
        })
      : null;

    if (existingAttribution) {
      contentAttributionId = existingAttribution.id;
      await prisma.contentAttribution.update({
        where: { id: existingAttribution.id },
        data: { leadsCount: { increment: 1 } }
      });
    } else {
      const attribution = await prisma.contentAttribution.create({
        data: {
          accountId,
          contentType: contentSource.contentType,
          contentId: contentSource.contentId ?? null,
          contentUrl: contentSource.contentUrl ?? null,
          caption: contentSource.caption ?? null,
          platform: platform as Platform,
          leadsCount: 1
        }
      });
      contentAttributionId = attribution.id;
    }
  }

  // 2. Find or create the lead (scoped to account)
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
        platformUserId,
        contentAttributionId
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
  } else if (contentAttributionId && !lead.contentAttributionId) {
    // Link existing lead to content if not already linked
    await prisma.lead.update({
      where: { id: lead.id },
      data: { contentAttributionId }
    });
  }

  // 3. Find or create the conversation
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

  // 4. Save the incoming message
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

export async function scheduleAIReply(
  conversationId: string,
  accountId?: string
): Promise<void> {
  const delayMs = randomBetween(5 * 60 * 1000, 10 * 60 * 1000);

  // In production this would be a proper job queue (e.g. BullMQ, SQS).
  // For now we use setTimeout — the delay makes the AI feel more natural.
  setTimeout(async () => {
    try {
      // Check if AI is still active for this conversation
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { aiActive: true, lead: { select: { accountId: true } } }
      });

      // Check per-conversation AI toggle
      const aiActive = conversation?.aiActive ?? false;

      // Check global away mode — if enabled, AI responds even if per-convo AI is off
      // UNLESS the user explicitly turned AI off on this specific conversation
      let awayModeActive = false;
      if (accountId || conversation?.lead?.accountId) {
        const resolvedAccountId = accountId || conversation!.lead.accountId;
        const account = await prisma.account.findUnique({
          where: { id: resolvedAccountId },
          select: { awayMode: true }
        });
        awayModeActive = account?.awayMode ?? false;
      }

      // If neither per-convo AI nor away mode is active, skip
      if (!aiActive && !awayModeActive) return;

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
// Auto-Tagging — apply AI-suggested tags to leads after reply generation
// ---------------------------------------------------------------------------

export async function applyAutoTags(
  accountId: string,
  leadId: string,
  suggestedTags: string[]
): Promise<void> {
  if (!suggestedTags.length) return;

  try {
    // Get all auto-tags for this account
    const accountTags = await prisma.tag.findMany({
      where: { accountId, isAuto: true },
      select: { id: true, name: true }
    });

    const tagMap = new Map(accountTags.map((t) => [t.name, t.id]));

    for (const tagName of suggestedTags) {
      const normalizedName = tagName.trim().toUpperCase().replace(/\s+/g, '_');
      const tagId = tagMap.get(normalizedName);

      if (tagId) {
        // Upsert to avoid duplicate errors
        await prisma.leadTag.upsert({
          where: { leadId_tagId: { leadId, tagId } },
          update: { appliedBy: 'AI', confidence: 0.8 },
          create: { leadId, tagId, appliedBy: 'AI', confidence: 0.8 }
        });
      }
    }

    console.log(
      `[webhook-processor] Auto-tagged lead ${leadId} with: ${suggestedTags.join(', ')}`
    );
  } catch (err) {
    console.error(
      `[webhook-processor] Failed to auto-tag lead ${leadId}:`,
      err
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
