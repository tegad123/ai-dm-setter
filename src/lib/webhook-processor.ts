import prisma from '@/lib/prisma';
import { generateReply } from '@/lib/ai-engine';
import type { LeadContext, BookingSlot } from '@/lib/ai-prompts';
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
import {
  runPostMessageScoring,
  getScoringContextForPrompt,
  runPostAIReplyScoring
} from '@/lib/scoring-integration';
import { getMessages as getInstagramMessages } from '@/lib/instagram';
import { getMessages as getFacebookMessages } from '@/lib/facebook';
import {
  getUnifiedAvailability,
  bookUnifiedAppointment
} from '@/lib/calendar-adapter';
import { getCredentials } from '@/lib/credential-store';

// ---------------------------------------------------------------------------
// URL hallucination guard
// ---------------------------------------------------------------------------

/**
 * Build the set of URLs the AI is allowed to send for a given account.
 * Pulls from the persona's promptConfig (assetLinks, bookingLink,
 * calendarLink, freeValueLink) and from the persona's freeValueLink column.
 *
 * Anything NOT in this set is considered hallucinated and will be stripped
 * from the AI's reply before delivery.
 */
async function getAllowedUrls(accountId: string): Promise<Set<string>> {
  const allowed = new Set<string>();
  try {
    const persona = await prisma.aIPersona.findFirst({
      where: { accountId, isActive: true },
      orderBy: { updatedAt: 'desc' }
    });
    if (!persona) return allowed;

    if (persona.freeValueLink && /^https?:\/\//i.test(persona.freeValueLink)) {
      allowed.add(persona.freeValueLink.trim());
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pc = (persona.promptConfig as any) || {};
    const candidates: unknown[] = [
      pc.bookingLink,
      pc.calendarLink,
      pc.freeValueLink,
      pc.courseLink,
      pc.assetLinks?.bookingLink,
      pc.assetLinks?.courseLink,
      pc.assetLinks?.freeValueLink
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && /^https?:\/\//i.test(c)) {
        allowed.add(c.trim());
      }
    }
    if (Array.isArray(pc.assetLinks?.videoLinks)) {
      for (const v of pc.assetLinks.videoLinks) {
        const url = (v &&
          typeof v === 'object' &&
          (v as { url?: unknown }).url) as unknown;
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          allowed.add(url.trim());
        }
      }
    }
    if (Array.isArray(pc.knowledgeAssets)) {
      for (const k of pc.knowledgeAssets) {
        const content =
          k && typeof k === 'object' && (k as { content?: unknown }).content;
        if (typeof content === 'string') {
          const matches = content.match(/https?:\/\/[^\s)]+/g);
          if (matches) for (const m of matches) allowed.add(m.trim());
        }
      }
    }
  } catch (err) {
    console.error('[webhook-processor] getAllowedUrls failed:', err);
  }
  return allowed;
}

/**
 * Strip any URL from `text` that is not in the allow-list. Returns the
 * sanitized text and a list of URLs that were removed (for logging).
 *
 * This is the last line of defense against URL hallucination (R16). The
 * AI is also instructed not to invent URLs, but this guard ensures a
 * fabricated `cal.com/...` link never reaches the lead even if the AI
 * ignores the rule.
 */
function stripHallucinatedUrls(
  text: string,
  allowed: Set<string>
): { sanitized: string; removed: string[] } {
  const removed: string[] = [];
  const urlRegex = /https?:\/\/[^\s<>"')]+/g;
  const sanitized = text.replace(urlRegex, (match) => {
    // Trim trailing punctuation that the regex might have included
    const trimmed = match.replace(/[.,;:!?]+$/, '');
    if (allowed.has(trimmed) || allowed.has(match)) {
      return match;
    }
    removed.push(trimmed);
    return '[link removed]';
  });
  return { sanitized, removed };
}

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
  /**
   * True when this call did not actually save a new inbound message —
   * either because we deduped it (same platformMessageId already saved),
   * or because the message was a control command like "clear conversation"
   * that we explicitly handle and discard. Webhook routes MUST skip
   * scheduleAIReply when this is true, otherwise Meta's webhook retries
   * (or duplicate deliveries) cause two ScheduledReply rows to be created
   * for one inbound message — which is exactly what fired two AI replies
   * to tegaumukoro_'s "Hey" on 2026-04-08.
   */
  skipReply?: boolean;
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
        isNewLead: false,
        skipReply: true
      };
    }
  }

  // ── Step 1c: "clear conversation" reset command ────────────────
  // The user uses a literal DM of "clear conversation" as a debug
  // command to fully reset a test conversation back to a blank slate
  // before re-running a flow. We wipe all messages, reset conversation
  // and lead state, cancel any pending scheduled replies, and return
  // without saving the command message itself or triggering an AI reply.
  // The next inbound message will be treated like a fresh opener.
  if (messageText.trim().toLowerCase() === 'clear conversation') {
    console.log(
      `[webhook-processor] CLEAR CONVERSATION command from ${senderHandle} on ${conversationId} — resetting all state`
    );
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.scheduledReply.updateMany({
      where: {
        conversationId,
        status: { in: ['PENDING', 'PROCESSING'] }
      },
      data: { status: 'CANCELLED' }
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        aiActive: true,
        unreadCount: 0,
        lastMessageAt: null,
        outcome: 'ONGOING',
        leadIntentTag: 'NEUTRAL',
        // Current 7-stage timestamps
        stageOpeningAt: null,
        stageSituationDiscoveryAt: null,
        stageGoalEmotionalWhyAt: null,
        stageUrgencyAt: null,
        stageSoftPitchCommitmentAt: null,
        stageFinancialScreeningAt: null,
        stageBookingAt: null,
        // Legacy stages
        stageQualificationAt: null,
        stageVisionBuildingAt: null,
        stagePainIdentificationAt: null,
        stageSolutionOfferAt: null,
        stageCapitalQualificationAt: null,
        // Booking state
        leadTimezone: null,
        leadEmail: null,
        leadPhone: null,
        proposedSlots: undefined,
        selectedSlot: undefined,
        bookingId: null,
        bookingUrl: null
      }
    });
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        status: 'NEW_LEAD',
        qualityScore: 0,
        bookedAt: null,
        showedUp: false,
        closedAt: null,
        revenue: null,
        experience: null,
        incomeLevel: null,
        geography: null
      }
    });
    console.log(
      `[webhook-processor] Conversation ${conversationId} fully reset`
    );
    return {
      leadId: lead.id,
      conversationId,
      messageId: '',
      isNewLead: false,
      skipReply: true
    };
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
        isNewLead: false,
        skipReply: true
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

  // ── Step 7: Run lead scoring after every incoming lead message ──
  runPostMessageScoring(conversationId, lead.id, accountId, now).catch((err) =>
    console.error('[webhook-processor] Post-message scoring error:', err)
  );

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
  accountId: string,
  options?: { skipDelayQueue?: boolean }
): Promise<void> {
  // Diagnostic checkpoint logging — every step prints a tag with the convo id
  // so we can see exactly where the function silently exits in production logs.
  const log = (tag: string, extra?: string) =>
    console.log(
      `[webhook-processor][${conversationId}] ${tag}${extra ? ' ' + extra : ''}`
    );

  log(
    'sched.start',
    options?.skipDelayQueue ? '(cron picked up)' : '(realtime)'
  );

  // ── Step 1: Check AI active + away mode ────────────────────────
  log('sched.step1.findConversation');
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
  log(
    'sched.step1.foundConversation',
    `messages=${conversation.messages.length}`
  );

  const { lead } = conversation;

  // Check account-level away mode
  log('sched.step1.findAccount');
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { awayMode: true }
  });

  // If AI is not active AND away mode is off, generate suggestion only
  const aiActive = conversation.aiActive;
  const awayMode = account?.awayMode ?? false;
  const shouldAutoSend = aiActive || awayMode;
  log(
    'sched.step1.aiActive',
    `aiActive=${aiActive} awayMode=${awayMode} shouldAutoSend=${shouldAutoSend}`
  );

  if (!shouldAutoSend) {
    console.log(
      `[webhook-processor] AI paused for ${conversationId} (human override). Generating suggestion only.`
    );
  }

  // ── Step 2: Build conversation history ─────────────────────────
  // Local DB is primary source. If history seems incomplete, try Meta API fallback.
  log('sched.step2.history');
  let messages = conversation.messages;

  if (messages.length <= 1 && lead.platformUserId) {
    // Only 1 message — might be missing history. Try Meta API backfill.
    log('sched.step2.backfillStart');
    try {
      const backfilledMessages = await backfillFromMetaAPI(
        accountId,
        conversationId,
        lead.platform,
        lead.platformUserId
      );
      if (backfilledMessages.length > messages.length) {
        messages = backfilledMessages;
        log('sched.step2.backfillDone', `count=${backfilledMessages.length}`);
      } else {
        log('sched.step2.backfillNoop');
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

  // ── Step 3-test: "september 2002" backdoor for booking flow tests ──
  // To avoid burning AI credits while testing the booking flow, the
  // developer can send "september 2002" in any DM. When detected:
  //   1. testModeSkipToBooking flag is set on leadContext, which makes
  //      the system prompt jump straight to STAGE 7 (BOOKING).
  //   2. All prior stage timestamps are recorded (so analytics + the
  //      stageToStatus map promote the lead to QUALIFIED).
  //   3. The trigger phrase is rewritten in the AI's view of the
  //      conversation history so the AI doesn't echo "september 2002"
  //      back to the lead — it just sees "ready to book a call".
  // Idempotent: if "september 2002" is already in the history, the
  // backdoor stays active for the rest of the conversation.
  const TEST_TRIGGER = 'september 2002';
  const TEST_REPLACEMENT = 'ready to book a call';
  const hasTestTrigger = messages.some(
    (m) =>
      m.sender === 'LEAD' &&
      typeof m.content === 'string' &&
      m.content.toLowerCase().includes(TEST_TRIGGER)
  );

  if (hasTestTrigger) {
    console.warn(
      `[webhook-processor] [TEST MODE] "${TEST_TRIGGER}" detected in ${conversationId} — fast-forwarding to BOOKING stage and skipping qualification.`
    );

    leadContext.testModeSkipToBooking = true;

    // Fast-forward all qualification stage timestamps so analytics +
    // updateLeadStatusFromStage see the conversation as fully qualified.
    // recordStageTimestamp is idempotent — only writes the first time.
    const stagesToRecord = [
      'OPENING',
      'SITUATION_DISCOVERY',
      'GOAL_EMOTIONAL_WHY',
      'URGENCY',
      'SOFT_PITCH_COMMITMENT',
      'FINANCIAL_SCREENING',
      'BOOKING'
    ];
    for (const s of stagesToRecord) {
      await recordStageTimestamp(conversationId, s).catch((err) =>
        console.error(
          `[webhook-processor] [TEST MODE] failed to record stage ${s}:`,
          err
        )
      );
    }

    // Rewrite the trigger phrase in the conversation history that the AI
    // sees, so it doesn't get confused or echo "september 2002" back.
    messages = messages.map((m) => {
      if (
        m.sender === 'LEAD' &&
        typeof m.content === 'string' &&
        m.content.toLowerCase().includes(TEST_TRIGGER)
      ) {
        const cleaned = m.content
          .replace(new RegExp(TEST_TRIGGER, 'gi'), TEST_REPLACEMENT)
          .trim();
        return { ...m, content: cleaned || TEST_REPLACEMENT };
      }
      return m;
    });
  }

  // ── Step 3.5: Delayed-send queue check ──────────────────────────
  // If the persona has a response delay configured, AND we're not in
  // test mode, AND the cron hasn't already picked this up (skipDelayQueue
  // flag), queue a ScheduledReply row and bail. The cron handler will
  // re-run scheduleAIReply later with skipDelayQueue=true to actually
  // generate and deliver the reply on the freshest conversation state.
  //
  // Bailing here (instead of generating now and delaying the send) means:
  //   - We don't burn AI tokens on a reply we might throw away if the
  //     lead sends another message during the delay window.
  //   - The reply is generated against the most up-to-date conversation
  //     state at delivery time, not at trigger time.
  // Voice-note-aware delay path state: when voice notes are enabled,
  // we generate first (to know the message type), then apply the
  // appropriate delay system. These variables carry state from step 3.5
  // into step 4d.
  let vnAwarePath = false;
  let vnTextMinDelay = 0;
  let vnTextMaxDelay = 0;

  if (
    !options?.skipDelayQueue &&
    !leadContext.testModeSkipToBooking &&
    shouldAutoSend
  ) {
    try {
      // Read the ACTIVE persona — same convention used by ai-prompts.ts and
      // the allow-list lookup at line 46. Without the isActive filter we'd
      // pick the oldest persona by row order, which on this account was a
      // stale row with the schema defaults of 300/600s, ignoring whatever
      // the user actually saved in the dashboard. Fall back to "any persona"
      // only if nothing is active, to keep working on accounts that haven't
      // gone through activation yet.
      const persona =
        (await prisma.aIPersona.findFirst({
          where: { accountId, isActive: true },
          orderBy: { updatedAt: 'desc' },
          select: {
            responseDelayMin: true,
            responseDelayMax: true,
            voiceNotesEnabled: true
          }
        })) ??
        (await prisma.aIPersona.findFirst({
          where: { accountId },
          orderBy: { updatedAt: 'desc' },
          select: {
            responseDelayMin: true,
            responseDelayMax: true,
            voiceNotesEnabled: true
          }
        }));
      const minDelay = Math.max(0, persona?.responseDelayMin ?? 0);
      const maxDelay = Math.max(minDelay, persona?.responseDelayMax ?? 0);

      // If voice notes are enabled, generate the reply FIRST so we can
      // apply the correct delay system per message type. Fall through to
      // Step 4 generation — delay will be applied in Step 4d.
      if (persona?.voiceNotesEnabled) {
        vnAwarePath = true;
        vnTextMinDelay = minDelay;
        vnTextMaxDelay = maxDelay;
        log(
          'sched.step3.5.vnAwarePath',
          'voice notes enabled — generating first to determine message type'
        );
      } else if (maxDelay > 0) {
        // EXISTING TEXT-ONLY PATH: delay before generation (unchanged)
        const { humanResponseDelay } = await import('@/lib/delay-utils');
        const delaySeconds = humanResponseDelay(minDelay, maxDelay);
        const scheduledFor = new Date(Date.now() + delaySeconds * 1000);
        await prisma.scheduledReply.create({
          data: {
            conversationId,
            accountId,
            scheduledFor,
            status: 'PENDING'
          }
        });
        console.log(
          `[webhook-processor] AI reply queued for ${conversationId} ` +
            `(delay: ${delaySeconds}s, range: ${minDelay}-${maxDelay}s, scheduledFor: ${scheduledFor.toISOString()})`
        );
        return;
      }
    } catch (err) {
      console.error(
        '[webhook-processor] Delay-queue check failed (proceeding immediately):',
        err
      );
    }
  } else if (leadContext.testModeSkipToBooking) {
    console.log(
      `[webhook-processor] [TEST MODE] Bypassing response-delay queue for ${conversationId}`
    );
  }

  log('sched.step3.contextBuilt');

  // ── Step 3a: Inject booking state ───────────────────────────────
  // Fetch real calendar slots when ANY calendar integration is configured
  // AND we already know the lead's timezone. We deliberately skip the slot
  // fetch when leadTimezone is null because:
  //   1. We can't filter to business-hours-in-lead-local without a tz.
  //   2. Slot labels in the prompt would be UTC-based and the AI would
  //      misread them as lead-local — exactly the hallucination bug that
  //      caused real bookings to fail (AI quoted "5pm CT" thinking it was
  //      Central Time when it was actually a UTC label).
  // The prompt's "tz unknown" branch instructs the AI to ASK for the
  // timezone first; only after the next inbound message (with leadTimezone
  // persisted) do we start proposing real slots.
  log('sched.step3a.bookingStart');
  try {
    // Check ALL providers, not just LeadConnector — any one of them
    // counts as a calendar integration.
    log('sched.step3a.fetchCreds');
    const [lcCreds, calendlyCreds, calcomCreds] = await Promise.all([
      getCredentials(accountId, 'LEADCONNECTOR'),
      getCredentials(accountId, 'CALENDLY'),
      getCredentials(accountId, 'CALCOM')
    ]);
    log('sched.step3a.credsDone');
    const hasCalendarIntegration = Boolean(
      (lcCreds?.apiKey && lcCreds?.calendarId) ||
        calendlyCreds?.apiKey ||
        calcomCreds?.apiKey
    );

    log(
      'sched.step3a.calendarCheck',
      `hasIntegration=${hasCalendarIntegration} leadTz=${conversation.leadTimezone || 'null'}`
    );
    let availableSlots: BookingSlot[] = [];
    if (hasCalendarIntegration && conversation.leadTimezone) {
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 7);
      const avail = await getUnifiedAvailability(
        accountId,
        now.toISOString(),
        end.toISOString(),
        conversation.leadTimezone
      );
      // Filter to business hours 9am-7pm in the lead's tz
      availableSlots = (avail.slots || [])
        .filter((s) => {
          const d = new Date(s.start);
          const hour = Number(
            new Intl.DateTimeFormat('en-US', {
              hour: 'numeric',
              hour12: false,
              timeZone: conversation.leadTimezone!
            }).format(d)
          );
          return hour >= 9 && hour <= 19;
        })
        .slice(0, 12);

      console.log(
        `[webhook-processor] Fetched ${avail.slots?.length || 0} raw slots from ${avail.provider}, ${availableSlots.length} after business-hours filter (lead tz: ${conversation.leadTimezone})`
      );
    } else if (hasCalendarIntegration) {
      console.log(
        `[webhook-processor] Skipping slot fetch for ${conversationId} — leadTimezone not yet known. AI will be told to ask for tz first.`
      );
    }

    leadContext.booking = {
      leadTimezone: conversation.leadTimezone,
      leadEmail: conversation.leadEmail,
      leadPhone: conversation.leadPhone,
      availableSlots,
      hasCalendarIntegration
    };

    // Persist the proposed slots so we can verify what the lead picks
    if (availableSlots.length) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { proposedSlots: availableSlots as any }
      });
    }
  } catch (err) {
    console.error(
      '[webhook-processor] Booking state injection failed (non-fatal):',
      err
    );
  }

  // ── Step 3b: Get scoring context to inject into AI prompt ──────
  log('sched.step3b.scoringStart');
  let scoringContext = '';
  try {
    scoringContext = await getScoringContextForPrompt(
      conversationId,
      lead.id,
      accountId
    );
    log('sched.step3b.scoringDone');
  } catch (err) {
    console.error(
      '[webhook-processor] Scoring context generation failed (non-fatal):',
      err
    );
  }

  // ── Step 4: Generate AI reply ──────────────────────────────────
  log('sched.step4.generateStart');
  const formattedMessages = messages.map((m) => ({
    id: m.id,
    sender: m.sender,
    content: m.content,
    timestamp: m.timestamp,
    isVoiceNote: m.isVoiceNote
  }));

  let result;
  try {
    result = await generateReply(
      accountId,
      formattedMessages,
      leadContext,
      scoringContext
    );
    log('sched.step4.generateDone', `stage=${result.stage}`);
  } catch (err) {
    console.error(
      `[webhook-processor] AI generation failed for ${conversationId}:`,
      err
    );
    return;
  }

  // ── Step 4b: Strip hallucinated URLs (R16 enforcement) ─────────
  // Last line of defense: even if the AI ignores R16 and fabricates a
  // booking URL like "cal.com/foo/30min", strip it before delivery so
  // the lead never receives a broken link. This was the root cause of
  // the "AI dropped a fake calendar URL" bug.
  try {
    const allowedUrls = await getAllowedUrls(accountId);
    const { sanitized, removed } = stripHallucinatedUrls(
      result.reply,
      allowedUrls
    );
    if (removed.length) {
      console.warn(
        `[webhook-processor] R16 violation for ${conversationId}: AI tried to send ${removed.length} unauthorized URL(s):`,
        removed
      );
      result.reply = sanitized;
    }
  } catch (err) {
    console.error(
      '[webhook-processor] URL sanitization failed (non-fatal):',
      err
    );
  }

  // ── Step 4c: Strip dashes (R17 enforcement) ─────────────────────
  // Em-dashes (—) and en-dashes (–) are dead giveaways that text was
  // written by an AI. The system prompt rule R17 tells the AI not to
  // use them, but as a last line of defense we sanitize the reply
  // before delivery:
  //   - em-dash (—, U+2014)  → ", "  (parenthetical break becomes a comma)
  //   - en-dash (–, U+2013)  → "-"   (range becomes a normal hyphen)
  //   - " - " connector      → ", "  (hyphen-as-clause-connector becomes a comma)
  // Hyphens inside compound words ("well-known", "9-5") are preserved.
  try {
    const before = result.reply;
    const after = before
      // Em-dash → comma + space (collapse any surrounding whitespace)
      .replace(/\s*—\s*/g, ', ')
      // En-dash → hyphen (preserves ranges like "9–5" → "9-5")
      .replace(/–/g, '-')
      // " - " used as a clause connector → ", " (must have spaces on both
      // sides — this is the AI tell, not the legitimate compound-word use)
      .replace(/\s+-\s+/g, ', ')
      // Collapse any double-comma artifacts the replacements may create
      .replace(/,\s*,/g, ',')
      // Tidy double spaces
      .replace(/ {2,}/g, ' ');

    if (after !== before) {
      console.warn(
        `[webhook-processor] R17 violation for ${conversationId}: AI used em/en-dashes — sanitized before delivery.`
      );
      result.reply = after;
    }
  } catch (err) {
    console.error(
      '[webhook-processor] Dash sanitization failed (non-fatal):',
      err
    );
  }

  // ── Step 4d: Voice-note-aware delay ──────────────────────────────
  // If we're in the VN-aware path (generated first, delay not yet applied),
  // now we know the message type. Apply the appropriate delay system.
  if (vnAwarePath && shouldAutoSend) {
    const {
      calculateVoiceNoteDelay,
      getVoiceNoteTimingSettings,
      serializeResult
    } = await import('@/lib/voice-note-timing');

    const isVoiceNote = !!(
      result.shouldVoiceNote || result.voiceNoteAction?.slot_id
    );

    if (isVoiceNote) {
      // Voice note: pick random delay between min and max
      const vnSettings = await getVoiceNoteTimingSettings(accountId);
      const delaySeconds = calculateVoiceNoteDelay(vnSettings);
      const scheduledFor = new Date(Date.now() + delaySeconds * 1000);

      await prisma.scheduledReply.create({
        data: {
          conversationId,
          accountId,
          scheduledFor,
          status: 'PENDING',
          messageType: 'voice_note',
          generatedResult: serializeResult(result) as object
        }
      });
      log(
        'sched.step4d.vnDelay',
        `voice note queued (delay: ${delaySeconds}s, scheduledFor: ${scheduledFor.toISOString()})`
      );
      return;
    } else if (vnTextMaxDelay > 0) {
      // Text from VN-enabled account: use existing persona text delay
      const { humanResponseDelay } = await import('@/lib/delay-utils');
      const delaySeconds = humanResponseDelay(vnTextMinDelay, vnTextMaxDelay);
      const scheduledFor = new Date(Date.now() + delaySeconds * 1000);

      await prisma.scheduledReply.create({
        data: {
          conversationId,
          accountId,
          scheduledFor,
          status: 'PENDING',
          messageType: 'text',
          generatedResult: serializeResult(result) as object
        }
      });
      log(
        'sched.step4d.textDelay',
        `text reply queued from VN-aware path (delay: ${delaySeconds}s, range: ${vnTextMinDelay}-${vnTextMaxDelay}s)`
      );
      return;
    }
    // No delay configured — fall through to immediate send
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

  // ── Step 6: Send reply ─────────────────────────────────────────
  // By the time we reach this point either:
  //   - the persona has no response delay configured (Step 3.5 noop), or
  //   - the cron handler picked up a queued reply and called us with
  //     skipDelayQueue=true so the delay window has already elapsed, or
  //   - we're in test mode and bypassing the delay queue.
  // Either way, the reply ships now.
  console.log(
    `[webhook-processor] Sending AI reply for ${conversationId}` +
      (options?.skipDelayQueue ? ' (delivered after scheduled delay)' : '')
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
    name: string;
    handle: string;
    platform: string;
    platformUserId: string | null;
    accountId: string;
    status: string;
  },
  result: {
    reply: string;
    stage: string;
    subStage?: string | null;
    stageConfidence: number;
    sentimentScore: number;
    experiencePath?: string | null;
    objectionDetected?: string | null;
    stallType?: string | null;
    affirmationDetected?: boolean;
    followUpNumber?: number | null;
    softExit?: boolean;
    // Booking fields (Stage 7)
    leadTimezone?: string | null;
    selectedSlotIso?: string | null;
    leadEmail?: string | null;
    shouldVoiceNote?: boolean;
    voiceNoteAction?: { slot_id: string } | null;
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

  // ── Check for human message conflict (human sent while AI was generating) ──
  const humanMessageDuringGeneration = await prisma.message.findFirst({
    where: {
      conversationId,
      sender: 'HUMAN',
      timestamp: { gte: new Date(Date.now() - 30000) }
    }
  });
  if (humanMessageDuringGeneration) {
    console.log(
      `[webhook-processor] Human message detected during AI generation, discarding AI reply for ${conversationId}`
    );
    return;
  }

  // ── Save AI message to database ────────────────────────────────
  const aiMessage = await prisma.message.create({
    data: {
      conversationId,
      sender: 'AI',
      content: result.reply,
      timestamp: now,
      stage: result.stage || null,
      subStage: result.subStage || null,
      stageConfidence: result.stageConfidence,
      sentimentScore: result.sentimentScore,
      experiencePath: result.experiencePath || null,
      objectionType: result.objectionDetected || null,
      stallType: result.stallType || null,
      followUpAttemptNumber: result.followUpNumber ?? null,
      systemPromptVersion: result.systemPromptVersion
    }
  });

  // Update conversation
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: now }
  });

  // ── Persist any booking-stage fields the AI extracted ──────────
  const bookingUpdates: Record<string, any> = {};
  if (result.leadTimezone) bookingUpdates.leadTimezone = result.leadTimezone;
  if (result.leadEmail) bookingUpdates.leadEmail = result.leadEmail;
  if (Object.keys(bookingUpdates).length) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: bookingUpdates
    });
  }

  // ── Trigger real booking when the AI confirms a slot selection ──
  // This fires when sub_stage is BOOKING_CONFIRM AND we have the minimum
  // data needed to book via LeadConnector (slot + email).
  //
  // FAILURE PHILOSOPHY: every failure path below MUST do two things:
  //   1. Flip conversation.aiActive = false (so AI stops generating)
  //   2. Create a SYSTEM notification (so a human is alerted in the dashboard)
  // Otherwise we end up with a phantom "BOOKED" stage with no calendar entry,
  // which is the bug we hit on 2026-04-08 with conversation cmngzdbbu0002if04jjxlm35i.
  if (
    result.subStage === 'BOOKING_CONFIRM' &&
    result.selectedSlotIso &&
    result.leadEmail
  ) {
    // Validate the selected slot matches one we actually proposed (prevents
    // the AI from hallucinating times despite R14).
    const convoForBooking = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        proposedSlots: true,
        leadTimezone: true,
        bookingId: true,
        outcome: true
      }
    });

    // If this conversation is already in BOOKED outcome, the AI is just
    // acknowledging the existing booking in chat (not re-booking). Skip the
    // validator and the booking call entirely so we don't trip the R14 guard
    // against the already-confirmed slot when proposedSlots has been cleared
    // or rotated. This was the cause of the 2026-04-08 stuck-conversation bug
    // on cmngzdbbu0002if04jjxlm35i where every follow-up message tripped the
    // guard and flipped aiActive=false. We accept BOOKED outcome (not just
    // bookingId) because some providers return without an appointmentId but
    // the conversation is still legitimately booked.
    if (convoForBooking?.outcome === 'BOOKED' || convoForBooking?.bookingId) {
      console.log(
        `[webhook-processor] BOOKING_CONFIRM substage but conversation ${conversationId} already BOOKED (outcome=${convoForBooking?.outcome}, bookingId=${convoForBooking?.bookingId ?? 'null'}) — skipping re-book validator.`
      );
    } else {
      const proposed =
        (convoForBooking?.proposedSlots as BookingSlot[] | null) || [];
      const matchedSlot = proposed.find(
        (s) => s.start === result.selectedSlotIso
      );

      if (!matchedSlot) {
        // R14 hallucination guard tripped — AI picked a slot we never proposed.
        // Pause AI and surface to the team instead of silently dropping the book.
        console.warn(
          `[webhook-processor] AI confirmed a slot (${result.selectedSlotIso}) not in proposed list for ${conversationId} — pausing AI and notifying team.`
        );
        try {
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { aiActive: false }
          });
          await prisma.notification.create({
            data: {
              accountId: lead.accountId,
              type: 'SYSTEM',
              title: 'AI hallucinated booking slot — needs human',
              body: `${lead.name} (@${lead.handle}): AI tried to book a time (${result.selectedSlotIso}) that was not in the proposed slot list. AI is now paused. Please review the conversation and book manually. Proposed slots: ${proposed.map((s) => s.start).join(', ') || '(none)'}.`,
              leadId: lead.id
            }
          });
        } catch (notifErr) {
          console.error(
            '[webhook-processor] Failed to flag hallucinated-slot failure:',
            notifErr
          );
        }
      } else {
        try {
          const bookingResult = await bookUnifiedAppointment(accountId, {
            leadName: lead.name,
            leadHandle: lead.handle,
            leadEmail: result.leadEmail,
            platform: lead.platform,
            slotStart: matchedSlot.start,
            slotEnd: matchedSlot.end,
            timezone: convoForBooking?.leadTimezone || undefined,
            notes: `Auto-booked via DMsetter AI. Platform: ${lead.platform}, handle: @${lead.handle}.`
          });

          if (bookingResult.success) {
            await prisma.conversation.update({
              where: { id: conversationId },
              data: {
                selectedSlot: matchedSlot as any,
                bookingId: bookingResult.appointmentId || null,
                bookingUrl: bookingResult.meetingUrl || null,
                outcome: 'BOOKED'
              }
            });
            await prisma.lead.update({
              where: { id: lead.id },
              data: { status: 'BOOKED', bookedAt: new Date() }
            });
            await prisma.notification.create({
              data: {
                accountId: lead.accountId,
                type: 'CALL_BOOKED',
                title: 'New Call Booked (AI)',
                body: `${lead.name} (@${lead.handle}) booked a call for ${new Date(
                  matchedSlot.start
                ).toLocaleString('en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'short'
                })} via ${bookingResult.provider}.`,
                leadId: lead.id,
                userId: null
              }
            });
            console.log(
              `[webhook-processor] Call booked for ${conversationId} via ${bookingResult.provider} (apt: ${bookingResult.appointmentId})`
            );
          } else {
            // Provider returned a structured failure — pause AI + notify team.
            console.error(
              `[webhook-processor] Booking failed for ${conversationId}:`,
              bookingResult.error
            );
            try {
              await prisma.conversation.update({
                where: { id: conversationId },
                data: { aiActive: false }
              });
              await prisma.notification.create({
                data: {
                  accountId: lead.accountId,
                  type: 'SYSTEM',
                  title: 'Booking failed — needs human',
                  body: `${lead.name} (@${lead.handle}): AI tried to book but ${bookingResult.provider} returned: ${(bookingResult.error || 'Unknown error').slice(0, 200)}. AI is now paused.`,
                  leadId: lead.id
                }
              });
            } catch (notifErr) {
              console.error(
                '[webhook-processor] Failed to flag provider booking failure:',
                notifErr
              );
            }
          }
        } catch (bookErr: any) {
          // Unhandled exception in the booking call — pause AI + notify team.
          console.error(
            '[webhook-processor] Unhandled booking error:',
            bookErr
          );
          try {
            await prisma.conversation.update({
              where: { id: conversationId },
              data: { aiActive: false }
            });
            await prisma.notification.create({
              data: {
                accountId: lead.accountId,
                type: 'SYSTEM',
                title: 'Booking crashed — needs human',
                body: `${lead.name} (@${lead.handle}): unhandled error while booking. AI is now paused. Error: ${(bookErr?.message || String(bookErr)).slice(0, 200)}`,
                leadId: lead.id
              }
            });
          } catch (notifErr) {
            console.error(
              '[webhook-processor] Failed to flag unhandled booking error:',
              notifErr
            );
          }
        }
      }
    } // close: !alreadyBooked branch
  } else if (result.subStage === 'BOOKING_CONFIRM') {
    // The AI advanced to BOOKING_CONFIRM but is missing critical data
    // (slot or email). This shouldn't happen with a correct prompt, but if
    // it does we surface it loudly so we don't end up with a phantom
    // BOOKED stage and no real booking.
    const missing: string[] = [];
    if (!result.selectedSlotIso) missing.push('slot');
    if (!result.leadEmail) missing.push('email');
    console.warn(
      `[webhook-processor] BOOKING_CONFIRM sub-stage but missing ${missing.join(', ')} for ${conversationId} — pausing AI and notifying team.`
    );
    try {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { aiActive: false }
      });
      await prisma.notification.create({
        data: {
          accountId: lead.accountId,
          type: 'SYSTEM',
          title: 'Booking incomplete — needs human',
          body: `${lead.name} (@${lead.handle}): AI advanced to booking confirmation but is missing ${missing.join(' + ')}. AI is now paused. Please review and book manually.`,
          leadId: lead.id
        }
      });
    } catch (notifErr) {
      console.error(
        '[webhook-processor] Failed to flag missing-data booking failure:',
        notifErr
      );
    }
  }

  // ── Handle soft exit ──────────────────────────────────────────
  if (result.softExit) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { outcome: 'SOFT_EXIT', aiActive: false }
    });
    console.log(
      `[webhook-processor] Soft exit triggered for ${conversationId}`
    );
  }

  // ── Record stage timestamp ─────────────────────────────────────
  if (result.stage) {
    await recordStageTimestamp(conversationId, result.stage).catch((err) =>
      console.error('[webhook-processor] Stage timestamp error:', err)
    );
  }

  // ── Post-AI-reply scoring (record stage progression for velocity) ──
  runPostAIReplyScoring(conversationId, result.stage).catch((err) =>
    console.error('[webhook-processor] Post-AI-reply scoring error:', err)
  );

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

  // ── Send to platform ────────────────────────────────────────────
  if (lead.platformUserId) {
    let voiceNoteSent = false;

    // ── Pre-recorded voice note (VoiceNoteSlot system) ────────────
    if (result.voiceNoteAction?.slot_id) {
      try {
        const slot = await prisma.voiceNoteSlot.findFirst({
          where: { id: result.voiceNoteAction.slot_id, accountId }
        });

        if (
          slot?.audioFileUrl &&
          (slot.status === 'UPLOADED' || slot.status === 'APPROVED')
        ) {
          // Send pre-recorded audio
          await prisma.message.update({
            where: { id: aiMessage.id },
            data: { isVoiceNote: true, voiceNoteUrl: slot.audioFileUrl }
          });

          if (lead.platform === 'INSTAGRAM') {
            const { sendAudioDM } = await import('@/lib/instagram');
            await sendAudioDM(
              lead.accountId,
              lead.platformUserId,
              slot.audioFileUrl
            );
          } else if (lead.platform === 'FACEBOOK') {
            const { sendAudioMessage } = await import('@/lib/facebook');
            await sendAudioMessage(
              lead.accountId,
              lead.platformUserId,
              slot.audioFileUrl
            );
          }

          voiceNoteSent = true;
          console.log(
            `[webhook-processor] Pre-recorded voice note (slot: ${slot.slotName}) sent to ${lead.platformUserId}`
          );
        } else if (
          slot &&
          slot.fallbackBehavior === 'SEND_TEXT_EQUIVALENT' &&
          slot.fallbackText
        ) {
          // Use fallback text instead of audio
          result.reply = slot.fallbackText;
          console.log(
            `[webhook-processor] Voice note slot "${slot.slotName}" empty — using fallback text`
          );
        } else if (slot && slot.fallbackBehavior === 'BLOCK_UNTIL_FILLED') {
          // Halt: create notification and pause AI
          console.warn(
            `[webhook-processor] Voice note slot "${slot.slotName}" blocked — halting conversation`
          );
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { aiActive: false }
          });
          await prisma.notification.create({
            data: {
              accountId,
              type: 'SYSTEM',
              title: 'Voice note required',
              body: `AI paused: voice note slot "${slot.slotName}" needs an audio upload before the conversation can continue.`,
              leadId: lead.id
            }
          });
          return; // Do not send anything
        }
        // SKIP_ACTION: fall through, send AI's generated text as normal
      } catch (slotErr: unknown) {
        const errMsg =
          slotErr instanceof Error ? slotErr.message : String(slotErr);
        console.error(
          '[webhook-processor] Pre-recorded voice note error:',
          errMsg
        );
        // Fall through to ElevenLabs or text
      }
    }

    // ── Voice note generation via ElevenLabs (if AI recommends it) ──
    if (!voiceNoteSent && result.shouldVoiceNote) {
      try {
        const { generateVoiceNote } = await import('@/lib/elevenlabs');
        const { audioUrl } = await generateVoiceNote(accountId, result.reply);

        // Update the message record with voice note data
        await prisma.message.update({
          where: { id: aiMessage.id },
          data: { isVoiceNote: true, voiceNoteUrl: audioUrl }
        });

        // Send audio to platform
        if (lead.platform === 'INSTAGRAM') {
          const { sendAudioDM } = await import('@/lib/instagram');
          await sendAudioDM(lead.accountId, lead.platformUserId, audioUrl);
        } else if (lead.platform === 'FACEBOOK') {
          const { sendAudioMessage } = await import('@/lib/facebook');
          await sendAudioMessage(lead.accountId, lead.platformUserId, audioUrl);
        }

        voiceNoteSent = true;
        console.log(
          `[webhook-processor] Voice note sent to ${lead.platformUserId} on ${lead.platform}`
        );
      } catch (voiceErr: any) {
        console.error(
          '[webhook-processor] Voice note failed, falling back to text:',
          voiceErr?.message || voiceErr
        );
        // Fall through to text send below
      }
    }

    // ── Text message send (default, or fallback if voice failed) ──
    if (!voiceNoteSent) {
      try {
        if (lead.platform === 'INSTAGRAM') {
          await sendInstagramDM(
            lead.accountId,
            lead.platformUserId,
            result.reply
          );
          console.log(
            `[webhook-processor] IG DM sent to ${lead.platformUserId}`
          );
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
  }

  console.log(
    `[webhook-processor] AI reply sent for conversation ${conversationId} | stage: ${result.stage}`
  );
}

// ---------------------------------------------------------------------------
// 4. Process Admin/Human Message (from webhook echo or page-sent message)
// ---------------------------------------------------------------------------

export interface AdminMessageParams {
  accountId: string;
  platformUserId: string; // The lead's platform user ID (recipient of admin message)
  platform: 'INSTAGRAM' | 'FACEBOOK';
  messageText: string;
  platformMessageId?: string;
}

/**
 * Process a message sent by the business/admin (not the lead).
 * Saves it as a HUMAN message, pauses AI, and cancels pending scheduled replies.
 */
export async function processAdminMessage(
  params: AdminMessageParams
): Promise<void> {
  const {
    accountId,
    platformUserId,
    platform,
    messageText,
    platformMessageId
  } = params;

  // Find existing lead by platformUserId
  const lead = await prisma.lead.findFirst({
    where: { accountId, platformUserId, platform: platform as any },
    include: { conversation: true }
  });

  if (!lead?.conversation) {
    console.log(
      `[webhook-processor] Admin message for unknown lead ${platformUserId} — skipping`
    );
    return;
  }

  const conversationId = lead.conversation.id;

  // Dedup check — by platformMessageId
  if (platformMessageId) {
    const existing = await prisma.message.findFirst({
      where: { conversationId, platformMessageId }
    });
    if (existing) {
      console.log(
        `[webhook-processor] Admin message ${platformMessageId} already exists — skipping`
      );
      return;
    }
  }

  // ── AI echo detection ─────────────────────────────────────────────
  // When AI sends a reply via the Instagram API, Instagram echoes it back
  // as an admin message (is_echo=true). The AI-saved message won't have a
  // platformMessageId, so the dedup above won't catch it. Instead, check
  // if a recent AI message with the same content exists — if so, this is
  // just the echo of the AI's own message. Link the platformMessageId to
  // the existing AI message and skip the "human took over" logic.
  const recentAIMessage = await prisma.message.findFirst({
    where: {
      conversationId,
      sender: 'AI',
      content: messageText,
      timestamp: { gte: new Date(Date.now() - 60000) } // within last 60s
    },
    orderBy: { timestamp: 'desc' }
  });

  if (recentAIMessage) {
    // Link the platform message ID to the existing AI message for future dedup
    if (platformMessageId && !recentAIMessage.platformMessageId) {
      await prisma.message.update({
        where: { id: recentAIMessage.id },
        data: { platformMessageId }
      });
    }
    console.log(
      `[webhook-processor] Admin message is echo of AI message ${recentAIMessage.id} — skipping, AI stays active`
    );
    return;
  }

  // Save as HUMAN message (genuinely sent by a human admin)
  const message = await prisma.message.create({
    data: {
      conversationId,
      sender: 'HUMAN',
      content: messageText,
      timestamp: new Date(),
      platformMessageId: platformMessageId || null
    }
  });

  // Pause AI (human took over)
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { aiActive: false, lastMessageAt: new Date() }
  });

  // Cancel any pending scheduled replies for this conversation
  await prisma.scheduledReply.updateMany({
    where: { conversationId, status: 'PENDING' },
    data: { status: 'CANCELLED' }
  });

  // Broadcast real-time events
  broadcastNewMessage({
    id: message.id,
    conversationId,
    sender: 'HUMAN',
    content: messageText,
    timestamp: new Date().toISOString()
  });
  broadcastAIStatusChange({ conversationId, aiActive: false });

  console.log(
    `[webhook-processor] Admin message saved for conversation ${conversationId}, AI paused`
  );
}

// ---------------------------------------------------------------------------
// 5. Process Comment Trigger (auto-DM from comment)
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
  // Map AI stages to lead statuses (only upgrade, never downgrade).
  //
  // CRITICAL: BOOKING stage caps at QUALIFIED, NOT 'BOOKED'.
  // The 'BOOKED' status must ONLY be set inside the success branch of
  // bookUnifiedAppointment() in sendAIReply (search for `lead.status: 'BOOKED'`).
  // Setting it here would create a phantom "BOOKED" lead even when the
  // calendar booking silently failed (e.g. R14 anti-hallucination guard
  // rejected the AI's slot pick), which is exactly the bug we hit on
  // 2026-04-08 with conversation cmngzdbbu0002if04jjxlm35i.
  const stageToStatus: Record<string, string> = {
    // New 7-stage SOP sequence
    OPENING: 'NEW_LEAD',
    SITUATION_DISCOVERY: 'IN_QUALIFICATION',
    GOAL_EMOTIONAL_WHY: 'IN_QUALIFICATION',
    URGENCY: 'HOT_LEAD',
    SOFT_PITCH_COMMITMENT: 'QUALIFIED',
    FINANCIAL_SCREENING: 'QUALIFIED',
    BOOKING: 'QUALIFIED', // ← capped at QUALIFIED — only real booking promotes to BOOKED
    // Legacy stage names (backward compat)
    GREETING: 'NEW_LEAD',
    QUALIFICATION: 'IN_QUALIFICATION',
    VISION_BUILDING: 'IN_QUALIFICATION',
    PAIN_IDENTIFICATION: 'IN_QUALIFICATION',
    SOLUTION_OFFER: 'HOT_LEAD',
    CAPITAL_QUALIFICATION: 'QUALIFIED'
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
// Called by /api/cron/process-scheduled-replies when a queued ScheduledReply
// row becomes due. Delegates straight back to scheduleAIReply with the
// skipDelayQueue flag set, so the entire pipeline (Meta backfill, scoring
// context, booking state injection, R16/R17 sanitization, booking trigger,
// failure signaling) runs against the freshest conversation state — without
// re-queueing into the delay buffer.
// ---------------------------------------------------------------------------

export async function processScheduledReply(
  conversationId: string,
  accountId: string,
  storedResult?: {
    messageType?: string | null;
    generatedResult?: unknown;
    createdAt?: Date | null;
  }
): Promise<void> {
  if (storedResult?.generatedResult) {
    // Staleness check: if the lead sent new messages after the scheduled
    // reply was created, the pre-generated result may be outdated. In that
    // case, discard and regenerate fresh.
    if (storedResult.createdAt) {
      const newerLeadMsg = await prisma.message.findFirst({
        where: {
          conversation: { id: conversationId },
          sender: 'LEAD',
          timestamp: { gt: storedResult.createdAt }
        },
        select: { id: true }
      });
      if (newerLeadMsg) {
        console.log(
          `[webhook-processor] Stale pre-generated result for ${conversationId} — lead sent new message, regenerating`
        );
        await scheduleAIReply(conversationId, accountId, {
          skipDelayQueue: true
        });
        return;
      }
    }

    // Deliver the pre-generated result directly
    await deliverStoredReply(
      conversationId,
      accountId,
      storedResult.generatedResult
    );
    return;
  }

  // Legacy path: no stored result, generate fresh (existing behavior)
  await scheduleAIReply(conversationId, accountId, { skipDelayQueue: true });
}

/**
 * Deliver a pre-generated AI reply stored in ScheduledReply.generatedResult.
 * Re-fetches the conversation/lead and calls sendAIReply directly.
 */
async function deliverStoredReply(
  conversationId: string,
  accountId: string,
  generatedResult: unknown
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { lead: true }
  });

  if (!conversation?.lead) {
    console.warn(
      `[webhook-processor] deliverStoredReply: conversation ${conversationId} not found`
    );
    return;
  }

  // Check AI is still active and conversation not manually taken over
  if (!conversation.aiActive) {
    console.log(
      `[webhook-processor] deliverStoredReply: AI paused for ${conversationId} — skipping`
    );
    return;
  }

  const { lead } = conversation;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = generatedResult as any;

  console.log(
    `[webhook-processor] Delivering pre-generated ${result.shouldVoiceNote || result.voiceNoteAction?.slot_id ? 'voice note' : 'text'} reply for ${conversationId}`
  );
  await sendAIReply(conversationId, accountId, lead, result);
}

// ---------------------------------------------------------------------------
// 9. Compute reply delay seconds for the active persona
// ---------------------------------------------------------------------------
// Used by webhook routes to decide whether to handle the delay inline (via
// Next.js after()) or fall back to the cron queue. Reads the SAME active
// persona that scheduleAIReply uses, picks a random value in the configured
// range, and returns it. Returns 0 if no persona / no delay configured.
// ---------------------------------------------------------------------------
export async function computeReplyDelaySeconds(
  accountId: string
): Promise<number> {
  const persona =
    (await prisma.aIPersona.findFirst({
      where: { accountId, isActive: true },
      orderBy: { updatedAt: 'desc' },
      select: { responseDelayMin: true, responseDelayMax: true }
    })) ??
    (await prisma.aIPersona.findFirst({
      where: { accountId },
      orderBy: { updatedAt: 'desc' },
      select: { responseDelayMin: true, responseDelayMax: true }
    }));
  const minDelay = Math.max(0, persona?.responseDelayMin ?? 0);
  const maxDelay = Math.max(minDelay, persona?.responseDelayMax ?? 0);
  if (maxDelay <= 0) return 0;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}
