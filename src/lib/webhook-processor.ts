import prisma from '@/lib/prisma';
import type { Platform, TriggerType, ContentType } from '@prisma/client';
import {
  updateConversationOutcome,
  recordStageTimestamp
} from '@/lib/conversation-state-machine';

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

  // 5. Back-fill effectiveness tracking on the most recent AI message
  const lastAIMessage = await prisma.message.findFirst({
    where: { conversationId: conversation.id, sender: 'AI' },
    orderBy: { timestamp: 'desc' }
  });

  if (lastAIMessage && lastAIMessage.gotResponse === null) {
    const responseTimeSec = Math.round(
      (Date.now() - lastAIMessage.timestamp.getTime()) / 1000
    );
    await prisma.message.update({
      where: { id: lastAIMessage.id },
      data: {
        gotResponse: true,
        responseTimeSeconds: responseTimeSec
      }
    });
  }

  // 6. Mark older AI messages as leadContinuedConversation
  const olderAIMessages = await prisma.message.findMany({
    where: {
      conversationId: conversation.id,
      sender: 'AI',
      gotResponse: true,
      leadContinuedConversation: null
    },
    orderBy: { timestamp: 'desc' },
    take: 5
  });

  if (olderAIMessages.length > 0) {
    await prisma.message.updateMany({
      where: { id: { in: olderAIMessages.map((m) => m.id) } },
      data: { leadContinuedConversation: true }
    });
  }

  // 7. Re-engagement: if conversation was LEFT_ON_READ, reopen it
  if (conversation.outcome === 'LEFT_ON_READ') {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { outcome: 'ONGOING' }
    });
  }

  // 8. Run state machine to evaluate outcome transitions
  await updateConversationOutcome(conversation.id);

  return {
    leadId: lead.id,
    conversationId: conversation.id,
    messageId: message.id
  };
}

// ---------------------------------------------------------------------------
// Schedule an AI reply with a random 5–10 minute delay
// ---------------------------------------------------------------------------

// Track pending AI replies to prevent duplicates
const pendingAIReplies = new Set<string>();

export async function scheduleAIReply(
  conversationId: string,
  accountId?: string
): Promise<void> {
  // Deduplication: if we already have a pending reply for this conversation, skip
  if (pendingAIReplies.has(conversationId)) {
    console.log(
      `[ai-reply] Skipping duplicate — reply already pending for ${conversationId}`
    );
    return;
  }
  pendingAIReplies.add(conversationId);

  // Run AI reply inline (no setTimeout — Vercel serverless kills the context after response).
  // In production with a proper server, use a job queue (e.g. BullMQ, SQS) for delayed replies.
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

    // Generate AI reply directly (no HTTP call needed — we're in the same process)
    // Load ALL messages so AI has full conversation history & memory
    const conversation2 = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        lead: true,
        messages: {
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!conversation2) return;

    // Full conversation history (already ordered asc)
    const recentMessages = conversation2.messages;
    const lastLeadMessage = recentMessages
      .filter((m) => m.sender === 'LEAD')
      .pop();

    // Generate AI reply using the AI engine (Anthropic/OpenAI)
    let aiReply: string;
    const acctId = accountId || conversation2.lead.accountId;

    console.log(`[ai-reply] Starting AI generation for account: ${acctId}`);
    console.log(
      `[ai-reply] ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}`
    );
    console.log(`[ai-reply] AI_PROVIDER: ${process.env.AI_PROVIDER}`);
    console.log(`[ai-reply] Message count: ${recentMessages.length}`);

    try {
      const aiEngine = await import('@/lib/ai-engine');
      const lead = conversation2.lead;
      console.log(`[ai-reply] Calling generateReply for lead: ${lead.name}`);
      const result = await aiEngine.generateReply(
        acctId,
        recentMessages as any,
        {
          leadName: lead.name ?? 'Unknown',
          handle: lead.handle ?? '',
          platform: lead.platform,
          status: lead.status,
          triggerType: lead.triggerType,
          triggerSource: lead.triggerSource ?? null,
          qualityScore: lead.qualityScore ?? 0,
          leadId: lead.id
        }
      );
      aiReply = result.reply;
      console.log(
        `[ai-reply] AI engine generated reply: "${aiReply.slice(0, 100)}"`
      );

      // Apply auto-tags from AI analysis (use array or fall back to single tag)
      const tagsToApply =
        result.suggestedTags && result.suggestedTags.length > 0
          ? result.suggestedTags
          : result.suggestedTag
            ? [result.suggestedTag.toUpperCase().replace(/\s+/g, '_')]
            : [];
      if (tagsToApply.length > 0) {
        console.log(`[ai-reply] Applying auto-tags: ${tagsToApply.join(', ')}`);
        await applyAutoTags(acctId, lead.id, tagsToApply);
      }

      // Update lead quality score
      if (result.qualityScore !== undefined) {
        await prisma.lead.update({
          where: { id: lead.id },
          data: { qualityScore: result.qualityScore }
        });
        console.log(`[ai-reply] Updated quality score: ${result.qualityScore}`);
      }

      // Update lead status if AI suggests a stage change
      if (result.stage) {
        const stageToStatus: Record<string, string> = {
          opening: 'NEW_LEAD',
          qualifying: 'IN_QUALIFICATION',
          building_rapport: 'IN_QUALIFICATION',
          pitching: 'HOT_LEAD',
          handling_objection: 'TRUST_OBJECTION',
          booking: 'BOOKED',
          booked: 'BOOKED',
          closed: 'CLOSED',
          lost: 'UNQUALIFIED',
          ghosted: 'GHOSTED'
        };
        const newStatus = stageToStatus[result.stage.toLowerCase()];
        if (newStatus && newStatus !== lead.status) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: { status: newStatus as any }
          });
          console.log(
            `[ai-reply] Updated lead status: ${lead.status} → ${newStatus}`
          );
        }
      }
    } catch (aiError: any) {
      const errMsg = aiError?.message || String(aiError);
      const errStack =
        aiError?.stack?.split('\n').slice(0, 3).join(' | ') || '';
      console.error(
        `[ai-reply] AI ENGINE FAILED — Error: ${errMsg} — Stack: ${errStack}`
      );

      // Detect missing API key and notify user
      const isApiKeyError =
        /no ai.*key|api key not configured|api.*key.*missing|no ai provider/i.test(
          errMsg
        ) || /invalid.*api.*key|authentication|unauthorized|401/i.test(errMsg);

      if (isApiKeyError) {
        try {
          const { createNotification } = await import('@/lib/notifications');
          await createNotification({
            accountId: acctId,
            type: 'SYSTEM',
            title: 'AI Replies Paused — API Key Missing',
            body: 'Your AI cannot respond to leads because no API key is configured. Go to Settings → Integrations to add your OpenAI or Anthropic API key.'
          });
          console.error('[ai-reply] Notified user about missing API key.');
        } catch (notifErr) {
          console.error(
            '[ai-reply] Failed to create API key notification:',
            notifErr
          );
        }
      }

      // NEVER send a generic fallback — it confuses the lead.
      console.error('[ai-reply] Skipping reply to avoid generic message.');
      return;
    }

    // Save AI message to DB
    const aiMessage = await prisma.message.create({
      data: {
        conversationId,
        sender: 'AI',
        content: aiReply,
        timestamp: new Date()
      }
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() }
    });

    // Send the AI reply to the platform
    const lead = conversation2.lead;
    if (lead.platformUserId) {
      try {
        if (lead.platform === 'FACEBOOK') {
          const { sendMessage } = await import('@/lib/facebook');
          await sendMessage(lead.accountId, lead.platformUserId, aiReply);
          console.log(
            `[ai-reply] Facebook message sent to ${lead.platformUserId}: "${aiReply.slice(0, 50)}..."`
          );
        } else if (lead.platform === 'INSTAGRAM') {
          const { sendDM } = await import('@/lib/instagram');
          await sendDM(lead.accountId, lead.platformUserId, aiReply);
          console.log(
            `[ai-reply] Instagram DM sent to ${lead.platformUserId}: "${aiReply.slice(0, 50)}..."`
          );
        }
      } catch (sendErr) {
        console.error('[ai-reply] Failed to send to platform:', sendErr);
      }
    }

    console.log(
      `[ai-reply] Generated reply for conversation ${conversationId}: "${aiReply.slice(0, 80)}..."`
    );
  } catch (err) {
    console.error(
      `[webhook-processor] Failed to schedule AI reply for conversation ${conversationId}:`,
      err
    );
  } finally {
    // Clear dedup guard so future messages can trigger new replies
    pendingAIReplies.delete(conversationId);
  }
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

// Tag color palette for auto-created tags
const AUTO_TAG_COLORS: Record<string, string> = {
  HIGH_INTENT: '#22c55e',
  MONEY_OBJECTION: '#f59e0b',
  GHOST_RISK: '#ef4444',
  COLD: '#6b7280',
  WARM: '#f97316',
  HOT: '#ef4444',
  BOOKED: '#3b82f6',
  QUALIFIED: '#8b5cf6',
  REACTIVATED: '#06b6d4',
  OUTBOUND: '#6366f1',
  TRUST_OBJECTION: '#eab308',
  TIME_OBJECTION: '#a855f7',
  INTERESTED: '#10b981',
  NOT_INTERESTED: '#6b7280',
  FOLLOW_UP: '#f59e0b'
};

export async function applyAutoTags(
  accountId: string,
  leadId: string,
  suggestedTags: string[]
): Promise<void> {
  if (!suggestedTags.length) return;

  try {
    // Get ALL tags for this account (not just auto ones)
    const accountTags = await prisma.tag.findMany({
      where: { accountId },
      select: { id: true, name: true }
    });

    const tagMap = new Map(accountTags.map((t) => [t.name, t.id]));

    for (const tagName of suggestedTags) {
      const normalizedName = tagName.trim().toUpperCase().replace(/\s+/g, '_');
      let tagId = tagMap.get(normalizedName);

      // Auto-create the tag if it doesn't exist
      if (!tagId) {
        const color = AUTO_TAG_COLORS[normalizedName] || '#6366f1';
        const newTag = await prisma.tag.create({
          data: {
            accountId,
            name: normalizedName,
            color,
            isAuto: true
          }
        });
        tagId = newTag.id;
        tagMap.set(normalizedName, tagId);
        console.log(`[auto-tag] Created new tag: ${normalizedName} (${color})`);
      }

      // Upsert to avoid duplicate errors
      await prisma.leadTag.upsert({
        where: { leadId_tagId: { leadId, tagId } },
        update: { appliedBy: 'AI', confidence: 0.85 },
        create: { leadId, tagId, appliedBy: 'AI', confidence: 0.85 }
      });
    }

    console.log(
      `[auto-tag] Tagged lead ${leadId} with: ${suggestedTags.join(', ')}`
    );
  } catch (err) {
    console.error(`[auto-tag] Failed to tag lead ${leadId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
