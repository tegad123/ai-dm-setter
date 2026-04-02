import prisma from '@/lib/prisma';
import { generateReply } from '@/lib/ai-engine';
import type { LeadContext } from '@/lib/ai-prompts';
import { sendDM as sendInstagramDM } from '@/lib/instagram';
import { sendMessage as sendFacebookMessage } from '@/lib/facebook';
import {
  broadcastNewMessage,
  broadcastConversationUpdate,
  broadcastAIStatusChange,
  broadcastAISuggestion,
  broadcastNotification
} from '@/lib/realtime';
import {
  updateConversationOutcome,
  recordStageTimestamp,
  backfillEffectivenessTracking
} from '@/lib/conversation-state-machine';
import { getMessages as getInstagramMessages } from '@/lib/instagram';
import { getMessages as getFacebookMessages } from '@/lib/facebook';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IncomingMessageParams {
  accountId: string;
  platformUserId: string;
  platform: 'INSTAGRAM' | 'FACEBOOK';
  senderName: string;
  senderHandle: string;
  messageText: string;
  triggerType: 'DM' | 'COMMENT';
  triggerSource?: string;
  platformMessageId?: string; // Meta's event.message.mid for dedup
}

export interface ProcessResult {
  leadId: string;
  conversationId: string;
  messageId: string;
  isNewLead: boolean;
}

// ---------------------------------------------------------------------------
// Heuristic: does this message look like a mid-conversation reply?
// ---------------------------------------------------------------------------

const ONGOING_PHRASES = [
  // Short affirmatives
  'ok',
  'okay',
  'sounds good',
  'bet',
  'cool',
  'yeah',
  'yep',
  'got it',
  'for sure',
  'fasho',
  'facts',
  'alright',
  'sure',
  'word',
  'say less',
  'perfect',
  'less do it',
  'lets do it',
  'aight',
  'copy',
  'noted',
  // Continuations
  'also',
  'and another thing',
  'btw',
  'one more thing',
  'oh and',
  // References to prior context
  'as i mentioned',
  'like i said',
  'about what we discussed',
  'following up',
  'just checking in',
  'any update',
  'did you get',
  'sent you',
  'i sent',
  'you said',
  'we talked about',
  // Mid-conversation replies
  'thanks',
  'thank you',
  'appreciate it',
  'will do',
  'on it',
  'let me check',
  "i'll check",
  'give me a sec',
  'one sec',
  "i'm good",
  "nah i'm good",
  'not right now',
  'maybe later',
  "i'll let you know",
  "i'll think about it",
  'need to talk to'
];

const NEW_LEAD_OPENERS = [
  'hey',
  'yo',
  'hello',
  'hi',
  'sup',
  "what's up",
  'whats up',
  'interested',
  'how does this work',
  'how much',
  'tell me more',
  'i saw your',
  'i seen your',
  'i want to',
  'can you help',
  'is this legit',
  'what do you do',
  "what's this about"
];

function looksLikeOngoingConversation(messageText: string): boolean {
  const text = messageText.toLowerCase().trim();

  // If it matches a known new-lead opener, it's NOT ongoing
  for (const opener of NEW_LEAD_OPENERS) {
    if (
      text === opener ||
      text.startsWith(opener + ' ') ||
      text.startsWith(opener + ',')
    ) {
      return false;
    }
  }

  // If it matches a known ongoing phrase, it IS ongoing
  for (const phrase of ONGOING_PHRASES) {
    if (
      text === phrase ||
      text.startsWith(phrase + ' ') ||
      text.startsWith(phrase + ',') ||
      text.startsWith(phrase + '.')
    ) {
      return true;
    }
  }

  // Default: treat as a new lead (AI on). Only flag as ongoing if it
  // explicitly matches an ongoing phrase above. Better to have the AI
  // respond to an existing contact than to miss a real new lead.
  return false;
}

// ---------------------------------------------------------------------------
// 1. Process Incoming Message
// ---------------------------------------------------------------------------
// Saves every inbound message to the database on webhook receipt.
// Resolves or creates the lead + conversation automatically.
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

  console.log(
    `[webhook-processor] Processing ${platform} ${triggerType} from ${senderHandle}: "${messageText.slice(0, 80)}"`
  );

  // ── Step 1: Find or create the lead ────────────────────────────
  let lead = await prisma.lead.findFirst({
    where: {
      accountId,
      platformUserId,
      platform
    },
    include: {
      conversation: true
    }
  });

  let isNewLead = false;

  if (!lead) {
    // Check if this looks like a mid-conversation message (not a fresh opener)
    const isOngoing = looksLikeOngoingConversation(messageText);

    // Determine AI default based on away mode:
    // - Away mode ON → AI handles new leads (aiActive: true)
    // - Away mode OFF → Human handles new leads (aiActive: false), manually toggle AI on
    // - Ongoing conversations always start with AI off
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { awayMode: true }
    });
    const awayMode = account?.awayMode ?? false;
    const shouldEnableAI = isOngoing ? false : awayMode;

    // Create new lead + conversation
    lead = await prisma.lead.create({
      data: {
        accountId,
        name: senderName,
        handle: senderHandle,
        platform,
        platformUserId,
        triggerType,
        triggerSource: triggerSource || null,
        status: 'NEW_LEAD',
        conversation: {
          create: {
            aiActive: shouldEnableAI,
            unreadCount: 1
          }
        }
      },
      include: {
        conversation: true
      }
    });
    isNewLead = true;

    if (isOngoing) {
      console.log(
        `[webhook-processor] Created lead as EXISTING_CONTACT (AI off): ${lead.id} (${senderHandle}) — message: "${messageText.slice(0, 50)}"`
      );
    } else {
      console.log(
        `[webhook-processor] Created new lead: ${lead.id} (${senderHandle}) — AI=${shouldEnableAI ? 'ON' : 'OFF'} (awayMode=${awayMode})`
      );
    }
  }

  // ── Step 1a: Update name if lead was saved with a numeric ID and we now have a real name
  if (
    !isNewLead &&
    senderName !== lead.platformUserId &&
    /^\d+$/.test(lead.name)
  ) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { name: senderName, handle: senderHandle }
    });
    console.log(
      `[webhook-processor] Updated lead name: ${lead.name} → ${senderName} (@${senderHandle})`
    );
  }

  const conversationId = lead.conversation!.id;

  // ── Step 1b: Dedup — skip if we already processed this platform message
  if (params.platformMessageId) {
    const existing = await prisma.message.findFirst({
      where: {
        conversationId,
        platformMessageId: params.platformMessageId
      }
    });
    if (existing) {
      console.log(
        `[webhook-processor] Duplicate message skipped: ${params.platformMessageId}`
      );
      return {
        leadId: lead.id,
        conversationId,
        messageId: existing.id,
        isNewLead: false
      };
    }
  }

  // ── Step 2: Save the incoming message ──────────────────────────
  const now = new Date();
  let message;
  try {
    message = await prisma.message.create({
      data: {
        conversationId,
        sender: 'LEAD',
        content: messageText,
        timestamp: now,
        platformMessageId: params.platformMessageId || null
      }
    });
  } catch (err: any) {
    // DB-level unique constraint catch (race condition safety net)
    if (err?.code === 'P2002' && params.platformMessageId) {
      console.log(
        `[webhook-processor] Duplicate caught by DB constraint: ${params.platformMessageId}`
      );
      const existing = await prisma.message.findFirst({
        where: { conversationId, platformMessageId: params.platformMessageId }
      });
      return {
        leadId: lead.id,
        conversationId,
        messageId: existing?.id || '',
        isNewLead: false
      };
    }
    throw err;
  }

  // ── Step 3: Update conversation metadata ───────────────────────
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: now,
      unreadCount: { increment: 1 }
    }
  });

  // ── Step 4: Back-fill effectiveness tracking on previous AI messages
  await backfillEffectivenessTracking(conversationId).catch((err) =>
    console.error('[webhook-processor] Effectiveness tracking error:', err)
  );

  // ── Step 5: Re-engage LEFT_ON_READ conversations ───────────────
  const currentOutcome = lead.conversation?.outcome;
  if (currentOutcome === 'LEFT_ON_READ') {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { outcome: 'ONGOING' }
    });
    console.log(
      `[webhook-processor] Re-engaged LEFT_ON_READ conversation: ${conversationId}`
    );
  }

  // ── Step 6: Broadcast real-time events ─────────────────────────
  broadcastNewMessage({
    id: message.id,
    conversationId,
    sender: 'LEAD',
    content: messageText,
    timestamp: now.toISOString()
  });

  broadcastConversationUpdate({
    id: conversationId,
    leadId: lead.id,
    aiActive: lead.conversation!.aiActive,
    unreadCount: (lead.conversation!.unreadCount || 0) + 1,
    lastMessageAt: now.toISOString()
  });

  return {
    leadId: lead.id,
    conversationId,
    messageId: message.id,
    isNewLead
  };
}

// ---------------------------------------------------------------------------
// 2. Schedule AI Reply (The Core Handoff Logic)
// ---------------------------------------------------------------------------
// This is the heart of the AI Conversation Handoff feature:
// - Reads full conversation history (local DB first, Meta API fallback)
// - Builds AI context with lead metadata + enrichment
// - Generates reply continuing naturally from the last message
// - Respects Human/AI toggle (auto-send vs suggestion only)
// - Stores every AI message in the database
// ---------------------------------------------------------------------------

export async function scheduleAIReply(
  conversationId: string,
  accountId: string
): Promise<void> {
  console.log(
    `[webhook-processor] Scheduling AI reply for conversation: ${conversationId}`
  );

  // ── Step 1: Check AI active + away mode ────────────────────────
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      lead: {
        include: {
          tags: {
            include: {
              tag: { select: { name: true } }
            }
          }
        }
      },
      messages: {
        orderBy: { timestamp: 'asc' }
      }
    }
  });

  if (!conversation) {
    console.warn(
      `[webhook-processor] Conversation ${conversationId} not found`
    );
    return;
  }

  const { lead } = conversation;

  // Check account-level away mode
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { awayMode: true }
  });

  // If AI is not active AND away mode is off, generate suggestion only
  const aiActive = conversation.aiActive;
  const awayMode = account?.awayMode ?? false;
  const shouldAutoSend = aiActive || awayMode;

  if (!shouldAutoSend) {
    console.log(
      `[webhook-processor] AI paused for ${conversationId} (human override). Generating suggestion only.`
    );
  }

  // ── Step 2: Build conversation history ─────────────────────────
  // Local DB is primary source. If history seems incomplete, try Meta API fallback.
  let messages = conversation.messages;

  if (messages.length <= 1 && lead.platformUserId) {
    // Only 1 message — might be missing history. Try Meta API backfill.
    try {
      const backfilledMessages = await backfillFromMetaAPI(
        accountId,
        conversationId,
        lead.platform,
        lead.platformUserId
      );
      if (backfilledMessages.length > messages.length) {
        messages = backfilledMessages;
        console.log(
          `[webhook-processor] Back-filled ${backfilledMessages.length} messages from Meta API`
        );
      }
    } catch (err) {
      console.warn(
        '[webhook-processor] Meta API backfill failed (using local only):',
        err
      );
    }
  }

  // ── Step 3: Build lead context with enrichment ─────────────────
  const leadContext: LeadContext = {
    leadName: lead.name,
    handle: lead.handle,
    platform: lead.platform,
    status: lead.status,
    triggerType: lead.triggerType,
    triggerSource: lead.triggerSource,
    qualityScore: lead.qualityScore,
    // Enrichment from conversation + lead metadata
    intentTag: conversation.leadIntentTag || undefined,
    tags: lead.tags.map((lt) => lt.tag.name),
    leadScore: conversation.priorityScore || undefined,
    source: conversation.leadSource || undefined,
    experience: lead.experience || undefined,
    incomeLevel: lead.incomeLevel || undefined,
    geography: lead.geography || undefined,
    timezone: lead.timezone || undefined
  };

  // ── Step 4: Generate AI reply ──────────────────────────────────
  const formattedMessages = messages.map((m) => ({
    id: m.id,
    sender: m.sender,
    content: m.content,
    timestamp: m.timestamp,
    isVoiceNote: m.isVoiceNote
  }));

  let result;
  try {
    result = await generateReply(accountId, formattedMessages, leadContext);
  } catch (err) {
    console.error(
      `[webhook-processor] AI generation failed for ${conversationId}:`,
      err
    );
    return;
  }

  // ── Step 5: Handle auto-send vs suggestion mode ────────────────
  if (!shouldAutoSend) {
    // AI is paused — broadcast as a suggestion only, don't save or send
    broadcastAISuggestion({
      conversationId,
      suggestedReply: result.reply,
      stage: result.stage,
      confidence: result.stageConfidence
    });
    console.log(
      `[webhook-processor] AI suggestion generated for ${conversationId} (not auto-sending)`
    );
    return;
  }

  // ── Step 6: Send reply immediately (no delay for now) ──────────
  // TODO: Re-enable scheduled delays for production (use ScheduledReply table + cron)
  console.log(
    `[webhook-processor] Sending AI reply immediately for ${conversationId}`
  );
  await sendAIReply(conversationId, accountId, lead, result);
}

// ---------------------------------------------------------------------------
// 3. Send AI Reply (save to DB + deliver to platform)
// ---------------------------------------------------------------------------

async function sendAIReply(
  conversationId: string,
  accountId: string,
  lead: {
    id: string;
    platform: string;
    platformUserId: string | null;
    accountId: string;
    status: string;
  },
  result: {
    reply: string;
    stage: string;
    stageConfidence: number;
    sentimentScore: number;
    suggestedTag: string;
    suggestedTags: string[];
    suggestedDelay: number;
    systemPromptVersion: string;
  }
): Promise<void> {
  // Re-check that AI is still active (human might have taken over during delay)
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { aiActive: true }
  });

  if (!convo?.aiActive) {
    console.log(
      `[webhook-processor] AI deactivated during delay for ${conversationId}, skipping send`
    );
    // Still broadcast as suggestion
    broadcastAISuggestion({
      conversationId,
      suggestedReply: result.reply,
      stage: result.stage,
      confidence: result.stageConfidence
    });
    return;
  }

  const now = new Date();

  // ── Save AI message to database ────────────────────────────────
  const aiMessage = await prisma.message.create({
    data: {
      conversationId,
      sender: 'AI',
      content: result.reply,
      timestamp: now,
      stage: result.stage || null,
      stageConfidence: result.stageConfidence,
      sentimentScore: result.sentimentScore,
      systemPromptVersion: result.systemPromptVersion
    }
  });

  // Update conversation
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: now }
  });

  // ── Record stage timestamp ─────────────────────────────────────
  if (result.stage) {
    await recordStageTimestamp(conversationId, result.stage).catch((err) =>
      console.error('[webhook-processor] Stage timestamp error:', err)
    );
  }

  // ── Update conversation outcome ────────────────────────────────
  await updateConversationOutcome(conversationId).catch((err) =>
    console.error('[webhook-processor] Outcome update error:', err)
  );

  // ── Auto-apply suggested tags ──────────────────────────────────
  if (result.suggestedTags?.length > 0) {
    await applyAutoTags(
      lead.accountId,
      lead.id,
      result.suggestedTags,
      result.stageConfidence
    ).catch((err) => console.error('[webhook-processor] Auto-tag error:', err));
  }

  // ── Update lead status based on stage ──────────────────────────
  await updateLeadStatusFromStage(lead.id, lead.status, result.stage).catch(
    (err) => console.error('[webhook-processor] Lead status update error:', err)
  );

  // ── Broadcast real-time events ─────────────────────────────────
  broadcastNewMessage({
    id: aiMessage.id,
    conversationId,
    sender: 'AI',
    content: result.reply,
    timestamp: now.toISOString()
  });

  // ── Send to platform (fire-and-forget) ─────────────────────────
  if (lead.platformUserId) {
    try {
      if (lead.platform === 'INSTAGRAM') {
        await sendInstagramDM(
          lead.accountId,
          lead.platformUserId,
          result.reply
        );
        console.log(`[webhook-processor] IG DM sent to ${lead.platformUserId}`);
      } else if (lead.platform === 'FACEBOOK') {
        await sendFacebookMessage(
          lead.accountId,
          lead.platformUserId,
          result.reply
        );
        console.log(
          `[webhook-processor] FB message sent to ${lead.platformUserId}`
        );
      }
    } catch (err: any) {
      console.error(
        `[webhook-processor] Failed to deliver to ${lead.platform} after retries:`,
        err
      );
      // Create a notification so the account owner knows the message wasn't delivered
      try {
        await prisma.notification.create({
          data: {
            accountId: lead.accountId,
            type: 'SYSTEM',
            title: 'Message delivery failed',
            body: `AI reply to ${lead.platformUserId} on ${lead.platform} failed to send: ${(err?.message || 'Unknown error').slice(0, 200)}`,
            leadId: lead.id
          }
        });
        broadcastNotification({
          accountId: lead.accountId,
          type: 'SYSTEM',
          title: 'Message delivery failed'
        });
      } catch (notifyErr) {
        console.error(
          '[webhook-processor] Failed to create failure notification:',
          notifyErr
        );
      }
    }
  }

  console.log(
    `[webhook-processor] AI reply sent for conversation ${conversationId} | stage: ${result.stage}`
  );
}

// ---------------------------------------------------------------------------
// 4. Process Comment Trigger (auto-DM from comment)
// ---------------------------------------------------------------------------

export interface CommentTriggerParams {
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
    accountId,
    platformUserId,
    platform,
    commenterName,
    commenterHandle,
    commentText,
    postId
  } = params;

  console.log(
    `[webhook-processor] Comment trigger from ${commenterHandle} on ${postId}: "${commentText.slice(0, 80)}"`
  );

  // Check if lead already exists
  const existingLead = await prisma.lead.findFirst({
    where: { accountId, platformUserId, platform }
  });

  if (existingLead) {
    console.log(
      `[webhook-processor] Lead already exists for ${commenterHandle}, skipping comment trigger`
    );
    return;
  }

  // Check for content attribution
  let contentAttributionId: string | undefined;
  const attribution = await prisma.contentAttribution.findFirst({
    where: { accountId, contentId: postId, platform }
  });
  if (attribution) {
    contentAttributionId = attribution.id;
    // Increment lead count
    await prisma.contentAttribution.update({
      where: { id: attribution.id },
      data: { leadsCount: { increment: 1 } }
    });
  }

  // Create lead + conversation with comment context
  const result = await processIncomingMessage({
    accountId,
    platformUserId,
    platform,
    senderName: commenterName,
    senderHandle: commenterHandle,
    messageText: `[Commented on post: "${commentText}"]`,
    triggerType: 'COMMENT',
    triggerSource: postId
  });

  // Update content attribution if found
  if (contentAttributionId) {
    await prisma.lead.update({
      where: { id: result.leadId },
      data: { contentAttributionId }
    });
  }

  // Schedule AI to send the first DM
  await scheduleAIReply(result.conversationId, accountId);
}

// ---------------------------------------------------------------------------
// 5. Human → AI Handoff (toggle AI back on)
// ---------------------------------------------------------------------------
// When a human operator re-enables AI on a conversation, the AI reads
// the full history and generates a contextual continuation reply.
// ---------------------------------------------------------------------------

export async function handleAIHandoff(
  conversationId: string,
  accountId: string
): Promise<void> {
  console.log(
    `[webhook-processor] AI handoff activated for conversation: ${conversationId}`
  );

  // Enable AI on the conversation
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { aiActive: true }
  });

  // Broadcast the status change
  broadcastAIStatusChange({ conversationId, aiActive: true });

  // Check if the last message was from the lead (needs a reply)
  const lastMessage = await prisma.message.findFirst({
    where: { conversationId },
    orderBy: { timestamp: 'desc' },
    select: { sender: true }
  });

  if (lastMessage?.sender === 'LEAD') {
    // Lead is waiting for a reply — generate one immediately
    await scheduleAIReply(conversationId, accountId);
  } else {
    console.log(
      `[webhook-processor] AI handoff: last message is from our side, waiting for lead reply`
    );
  }
}

// ---------------------------------------------------------------------------
// Helper: Back-fill messages from Meta Graph API
// ---------------------------------------------------------------------------

async function backfillFromMetaAPI(
  accountId: string,
  conversationId: string,
  platform: string,
  platformUserId: string
): Promise<any[]> {
  // Try to find the Meta conversation ID
  // For now, we'll fetch messages using the platform-specific API
  // and merge with our local database

  let apiMessages: Array<{
    id: string;
    message: string;
    from: { id: string; name?: string };
    createdTime: string;
  }> = [];

  try {
    if (platform === 'INSTAGRAM') {
      // Instagram conversations use a different ID format
      // We need to find the conversation by participant
      const igConvos = await (
        await import('@/lib/instagram')
      ).getConversations(accountId, 50);
      const matchedConvo = igConvos.find((c) =>
        c.participants.some((p) => p.id === platformUserId)
      );

      if (matchedConvo) {
        apiMessages = await getInstagramMessages(
          accountId,
          matchedConvo.id,
          50
        );
      }
    } else if (platform === 'FACEBOOK') {
      const fbConvos = await (
        await import('@/lib/facebook')
      ).getConversations(accountId, 50);
      const matchedConvo = fbConvos.find((c) =>
        c.participants.some((p) => p.id === platformUserId)
      );

      if (matchedConvo) {
        apiMessages = await getFacebookMessages(accountId, matchedConvo.id, 50);
      }
    }
  } catch (err) {
    console.warn(`[webhook-processor] Meta API message fetch failed:`, err);
    // Return local messages as fallback
    return prisma.message.findMany({
      where: { conversationId },
      orderBy: { timestamp: 'asc' }
    });
  }

  if (apiMessages.length === 0) {
    return prisma.message.findMany({
      where: { conversationId },
      orderBy: { timestamp: 'asc' }
    });
  }

  // Get the page ID to determine which messages are "ours" vs "theirs"
  const { getMetaPageId } = await import('@/lib/credential-store');
  const pageId = await getMetaPageId(accountId);

  // Merge API messages with local DB (avoid duplicates)
  const existingMessages = await prisma.message.findMany({
    where: { conversationId },
    select: { content: true, timestamp: true }
  });

  const existingSet = new Set(
    existingMessages.map((m) => `${m.content}|${m.timestamp.getTime()}`)
  );

  const newMessages = [];
  for (const apiMsg of apiMessages.reverse()) {
    // Reverse to get chronological order
    const timestamp = new Date(apiMsg.createdTime);
    const key = `${apiMsg.message}|${timestamp.getTime()}`;

    if (existingSet.has(key)) continue;
    if (!apiMsg.message) continue;

    const isOurMessage = apiMsg.from?.id === pageId;
    const sender = isOurMessage ? 'AI' : 'LEAD';

    const msg = await prisma.message.create({
      data: {
        conversationId,
        sender: sender as any,
        content: apiMsg.message,
        timestamp
      }
    });
    newMessages.push(msg);
  }

  // Return all messages in chronological order
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { timestamp: 'asc' }
  });
}

// ---------------------------------------------------------------------------
// Helper: Apply Auto Tags
// ---------------------------------------------------------------------------

async function applyAutoTags(
  accountId: string,
  leadId: string,
  tagNames: string[],
  confidence: number
): Promise<void> {
  for (const tagName of tagNames) {
    if (!tagName) continue;

    // Find or create the tag
    let tag = await prisma.tag.findUnique({
      where: { accountId_name: { accountId, name: tagName } }
    });

    if (!tag) {
      tag = await prisma.tag.create({
        data: {
          accountId,
          name: tagName,
          isAuto: true,
          color: getTagColor(tagName)
        }
      });
    }

    // Apply to lead (idempotent via unique constraint)
    await prisma.leadTag
      .create({
        data: {
          leadId,
          tagId: tag.id,
          appliedBy: 'AI',
          confidence
        }
      })
      .catch(() => {
        // Already exists — ignore duplicate
      });
  }
}

function getTagColor(tagName: string): string {
  const colorMap: Record<string, string> = {
    HIGH_INTENT: '#22C55E',
    RESISTANT: '#EF4444',
    UNQUALIFIED: '#6B7280',
    NEUTRAL: '#3B82F6',
    GHOST_RISK: '#F59E0B',
    PRICE_SENSITIVE: '#F97316',
    READY_TO_BOOK: '#10B981',
    NEEDS_NURTURE: '#8B5CF6'
  };
  return colorMap[tagName] || '#6B7280';
}

// ---------------------------------------------------------------------------
// Helper: Update Lead Status from AI Stage
// ---------------------------------------------------------------------------

async function updateLeadStatusFromStage(
  leadId: string,
  currentStatus: string,
  stage: string
): Promise<void> {
  // Map AI stages to lead statuses (only upgrade, never downgrade)
  const stageToStatus: Record<string, string> = {
    QUALIFICATION: 'IN_QUALIFICATION',
    VISION_BUILDING: 'IN_QUALIFICATION',
    PAIN_IDENTIFICATION: 'IN_QUALIFICATION',
    URGENCY: 'HOT_LEAD',
    SOLUTION_OFFER: 'HOT_LEAD',
    CAPITAL_QUALIFICATION: 'QUALIFIED',
    GOAL_EMOTIONAL_WHY: 'QUALIFIED',
    SOFT_PITCH_COMMITMENT: 'QUALIFIED',
    FINANCIAL_SCREENING: 'QUALIFIED',
    BOOKING: 'BOOKED'
  };

  const newStatus = stageToStatus[stage];
  if (!newStatus) return;

  // Status priority order (only upgrade)
  const statusPriority: Record<string, number> = {
    NEW_LEAD: 0,
    IN_QUALIFICATION: 1,
    HOT_LEAD: 2,
    QUALIFIED: 3,
    BOOKED: 4,
    SHOWED_UP: 5,
    CLOSED: 6,
    // These are terminal/side statuses — don't override
    SERIOUS_NOT_READY: 10,
    MONEY_OBJECTION: 10,
    TRUST_OBJECTION: 10,
    GHOSTED: 10,
    UNQUALIFIED: 10,
    NO_SHOW: 10
  };

  const currentPriority = statusPriority[currentStatus] ?? 0;
  const newPriority = statusPriority[newStatus] ?? 0;

  if (newPriority > currentPriority && currentPriority < 10) {
    await prisma.lead.update({
      where: { id: leadId },
      data: { status: newStatus as any }
    });
    console.log(
      `[webhook-processor] Lead ${leadId} status: ${currentStatus} → ${newStatus}`
    );
  }
}

// ---------------------------------------------------------------------------
// 8. Process Scheduled Reply (called by cron handler)
// ---------------------------------------------------------------------------
// Re-runs the full AI generation pipeline for a conversation that was
// previously queued with a delay. Re-checks aiActive before sending.
// ---------------------------------------------------------------------------

export async function processScheduledReply(
  conversationId: string,
  accountId: string
): Promise<void> {
  // Re-check that AI is still active
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      lead: { include: { tags: { include: { tag: true } } } },
      messages: { orderBy: { timestamp: 'asc' } }
    }
  });

  if (!conversation) {
    console.warn(`[scheduled-reply] Conversation ${conversationId} not found`);
    return;
  }

  if (!conversation.aiActive) {
    console.log(
      `[scheduled-reply] AI deactivated for ${conversationId}, skipping`
    );
    return;
  }

  const lead = conversation.lead;
  if (!lead) {
    console.warn(
      `[scheduled-reply] No lead for conversation ${conversationId}`
    );
    return;
  }

  // Build lead context
  const leadContext: LeadContext = {
    leadName: lead.name,
    handle: lead.handle,
    platform: lead.platform,
    status: lead.status,
    triggerType: lead.triggerType,
    triggerSource: lead.triggerSource,
    qualityScore: lead.qualityScore,
    intentTag: conversation.leadIntentTag || undefined,
    tags: lead.tags.map((lt) => lt.tag.name),
    leadScore: conversation.priorityScore || undefined,
    source: conversation.leadSource || undefined,
    experience: lead.experience || undefined,
    incomeLevel: lead.incomeLevel || undefined,
    geography: lead.geography || undefined,
    timezone: lead.timezone || undefined
  };

  const formattedMessages = conversation.messages.map((m) => ({
    id: m.id,
    sender: m.sender,
    content: m.content,
    timestamp: m.timestamp,
    isVoiceNote: m.isVoiceNote
  }));

  const result = await generateReply(accountId, formattedMessages, leadContext);

  await sendAIReply(conversationId, accountId, lead, result);
}
