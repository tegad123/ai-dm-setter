import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
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
import { getUnifiedAvailability } from '@/lib/calendar-adapter';
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

    // Sprint 3: Add link slot URLs from ScriptSlots (legacy)
    const linkSlots = await prisma.scriptSlot.findMany({
      where: {
        accountId,
        slotType: 'link',
        status: 'filled',
        url: { not: null }
      },
      select: { url: true }
    });
    for (const slot of linkSlots) {
      if (slot.url && /^https?:\/\//i.test(slot.url)) {
        allowed.add(slot.url.trim());
      }
    }

    // Sprint 3 Revised: Add link URLs from Script template actions
    const scriptLinkActions = await prisma.scriptAction.findMany({
      where: {
        step: { script: { accountId, isActive: true } },
        actionType: { in: ['send_link', 'send_video'] },
        linkUrl: { not: null }
      },
      select: { linkUrl: true }
    });
    for (const action of scriptLinkActions) {
      if (action.linkUrl && /^https?:\/\//i.test(action.linkUrl)) {
        allowed.add(action.linkUrl.trim());
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

    // Determine AI default based on PER-PLATFORM away mode:
    // - Away mode ON for this lead's platform → AI handles new leads
    // - Away mode OFF for this lead's platform → Human handles new leads
    // - Ongoing conversations always start with AI off
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { awayModeInstagram: true, awayModeFacebook: true }
    });
    const awayModeForPlatform =
      platform === 'INSTAGRAM'
        ? (account?.awayModeInstagram ?? false)
        : platform === 'FACEBOOK'
          ? (account?.awayModeFacebook ?? false)
          : false;
    const shouldEnableAI = isOngoing ? false : awayModeForPlatform;

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
        stage: 'NEW_LEAD',
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
        `[webhook-processor] Created new lead: ${lead.id} (${senderHandle}) — AI=${shouldEnableAI ? 'ON' : 'OFF'} (platform=${platform} awayMode=${awayModeForPlatform})`
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
        stage: 'NEW_LEAD',
        previousStage: null,
        stageEnteredAt: new Date(),
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

  // ── Step 3b: Distress / crisis detection (SAFETY GATE) ─────────
  // Scan the inbound message for suicidal ideation, self-harm, and
  // giving-up-on-life language. When ANY pattern matches:
  //   1. Flip conversation.aiActive=false and set the distress fields
  //   2. Cancel any PENDING ScheduledReply rows so the normal pipeline
  //      can't fire after this point
  //   3. Create an URGENT SYSTEM notification for the operator
  //   4. Generate a dedicated supportive (non-sales) response via Haiku
  //   5. Save + ship + broadcast the supportive response
  //   6. Return { skipReply: true } so the caller doesn't schedule a
  //      normal AI reply for this turn
  // This gate runs BEFORE backfill / re-engagement / broadcast / scoring
  // so no downstream logic touches a conversation that's been flagged.
  // Incident: daetradez 2026-04-18 — AI pitched trading at a lead who
  // said "i want to give up on life itself". This code is the code-
  // level enforcement that prevents a repeat.
  try {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { distressDetectionEnabled: true }
    });
    if (account?.distressDetectionEnabled) {
      const { detectDistress } = await import('@/lib/distress-detector');
      const distress = detectDistress(messageText);
      if (distress.detected) {
        console.warn(
          `[webhook-processor] DISTRESS DETECTED on conv ${conversationId} — label=${distress.label} match="${distress.match}" lead=@${senderHandle}`
        );
        // Pause AI + mark distress atomically. These fields are permanent
        // — the flag stays true even if an operator re-enables AI later,
        // so the prompt override can check-in instead of pitching.
        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            aiActive: false,
            distressDetected: true,
            distressDetectedAt: now,
            distressMessageId: message.id
          }
        });
        // Cancel any pending scheduled replies — if one was already in
        // flight from a prior lead message in this batch, it must not
        // fire. sendAIReply's preflight also re-checks aiActive, so this
        // is defense-in-depth.
        await prisma.scheduledReply.updateMany({
          where: { conversationId, status: 'PENDING' },
          data: { status: 'CANCELLED' }
        });
        // Create the urgent notification. SYSTEM type + prefixed title
        // so it sorts / renders distinctly in the operator's feed.
        try {
          await prisma.notification.create({
            data: {
              accountId,
              type: 'SYSTEM',
              title: 'URGENT — distress signal detected, review immediately',
              body: `${senderName} (@${senderHandle}): the lead's latest message matched a crisis / distress pattern ("${distress.match}"). AI has been paused on this conversation. Please review and respond personally.`,
              leadId: lead.id
            }
          });
        } catch (notifErr) {
          console.error(
            '[webhook-processor] Distress notification create failed (non-fatal):',
            notifErr
          );
        }
        // Broadcast the inbound lead message (so operator sees context
        // before the supportive response arrives). Normal broadcast
        // happens later in Step 6 but we haven't gotten there — do it
        // here explicitly.
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
          aiActive: false,
          unreadCount: (lead.conversation!.unreadCount || 0) + 1,
          lastMessageAt: now.toISOString()
        });

        // Generate + ship the supportive (non-sales) response.
        try {
          const { generateSupportiveResponse } = await import(
            '@/lib/distress-response'
          );
          const supportiveText = await generateSupportiveResponse(messageText);
          const supportiveMsg = await prisma.message.create({
            data: {
              conversationId,
              sender: 'AI',
              content: supportiveText,
              timestamp: new Date(),
              // Deliberately no stage / sub_stage — this is not a sales
              // turn and should not count toward stage progression or
              // funnel analytics.
              stage: null,
              subStage: null
            }
          });
          // Platform send. Use the existing helpers — same retry
          // behaviour as the normal send path. Failure here is logged
          // but non-fatal: the message row exists, operator can resend.
          if (lead.platformUserId) {
            try {
              if (lead.platform === 'INSTAGRAM') {
                await sendInstagramDM(
                  accountId,
                  lead.platformUserId,
                  supportiveText
                );
              } else if (lead.platform === 'FACEBOOK') {
                await sendFacebookMessage(
                  accountId,
                  lead.platformUserId,
                  supportiveText
                );
              }
            } catch (sendErr) {
              console.error(
                '[webhook-processor] Distress supportive response platform send failed:',
                sendErr
              );
            }
          }
          broadcastNewMessage({
            id: supportiveMsg.id,
            conversationId,
            sender: 'AI',
            content: supportiveText,
            timestamp: supportiveMsg.timestamp.toISOString()
          });
          broadcastAIStatusChange({ conversationId, aiActive: false });
        } catch (supErr) {
          console.error(
            '[webhook-processor] Distress supportive-response path failed (non-fatal):',
            supErr
          );
        }
        // Skip the rest of normal processing — no effectiveness backfill,
        // no re-engagement, no scoring. Return early so caller doesn't
        // schedule an AI reply.
        return {
          leadId: lead.id,
          conversationId,
          messageId: message.id,
          isNewLead,
          skipReply: true
        };
      }
    }
  } catch (detectErr) {
    // A bug in the detector must NEVER stop normal message processing.
    // Log loudly and continue — the Layer 2 safety net in ai-engine.ts
    // runs on every generation as a backstop.
    console.error(
      '[webhook-processor] Distress detection threw (non-fatal, continuing to normal processing):',
      detectErr
    );
  }

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
  const _pipelineStart = Date.now();
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

  // ── Step 0a: "Nothing to reply to" guard ──────────────────────
  // Catches the race where MULTIPLE WEBHOOKS for the SAME lead message
  // arrive close together (Meta retries, duplicate deliveries) — each
  // would otherwise trigger its own generation.
  //
  // Semantic check: if the latest message in the conversation is NOT
  // from the LEAD (it's either an AI reply we just sent, or a human
  // takeover), there's nothing new to respond to — bail.
  //
  // Previous version used a 15-second time window ("AI replied recently,
  // bail") which was too aggressive: it blocked legitimate new lead
  // messages that arrived within 15s of an AI reply. Fast-typing leads
  // trip that constantly. The ordering-based check below catches the
  // duplicate-webhook race while allowing real lead follow-ups through.
  //
  // Never applies when the cron is re-running us with skipDelayQueue —
  // that's the legitimate "deliver the scheduled one now" path.
  if (!options?.skipDelayQueue) {
    const latestMsg = await prisma.message.findFirst({
      where: { conversationId },
      orderBy: { timestamp: 'desc' },
      select: { sender: true, timestamp: true, content: true }
    });
    if (latestMsg && latestMsg.sender !== 'LEAD') {
      const ageMs = Date.now() - latestMsg.timestamp.getTime();
      log(
        'sched.step0a.noLeadToReplyTo',
        `latest msg is ${latestMsg.sender} (${Math.round(ageMs / 1000)}s ago) — nothing new to reply to, skipping`
      );
      return;
    }

    // ── Step 0a-ii: Close detection ────────────────────────────
    // If the lead's message is a closing acknowledgment (emoji-only,
    // "bet", "alright", etc.) AND the previous AI message was a
    // sign-off ("take care", "catch you later"), don't reply. The
    // conversation has naturally ended. Any AI response here is
    // noise that steps on the close. aiActive stays true so
    // re-engagement (the lead coming back later with a real message)
    // triggers normal generation.
    if (latestMsg && latestMsg.sender === 'LEAD') {
      const prevAI = await prisma.message.findFirst({
        where: {
          conversationId,
          sender: 'AI',
          timestamp: { lt: latestMsg.timestamp }
        },
        orderBy: { timestamp: 'desc' },
        select: { content: true, timestamp: true }
      });
      // Lead's previous message (the one immediately before `latestMsg`,
      // regardless of AI interspersing) — drives the 2+ consecutive
      // gratitude detection in closing-signal-detector.
      const prevLead = await prisma.message.findFirst({
        where: {
          conversationId,
          sender: 'LEAD',
          timestamp: { lt: latestMsg.timestamp }
        },
        orderBy: { timestamp: 'desc' },
        select: { content: true }
      });
      const { isClosingSignal } = await import('@/lib/closing-signal-detector');
      const check = isClosingSignal(
        latestMsg.content,
        prevAI?.content ?? null,
        prevAI?.timestamp ?? null,
        prevLead?.content ?? null
      );
      if (check.isClosing) {
        log(
          'sched.step0a.closeDetected',
          `skipping AI reply — ${check.reason}`
        );
        return;
      }
    }
  }

  // ── Step 0b: Cancel any existing PENDING scheduled replies ────
  // When the lead sends multiple messages in quick succession, each
  // webhook lands here. The previous in-flight ScheduledReply is now
  // stale (based on older context) — cancel it so only the newest
  // reply ships. Skip this when the cron is processing a specific row
  // (that row is in PROCESSING state, not PENDING, so it wouldn't be
  // touched by this updateMany anyway; we skip for clarity).
  if (!options?.skipDelayQueue) {
    const cancelled = await prisma.scheduledReply.updateMany({
      where: { conversationId, status: 'PENDING' },
      data: { status: 'CANCELLED' }
    });
    if (cancelled.count > 0) {
      log(
        'sched.step0b.cancelledStale',
        `cancelled ${cancelled.count} stale PENDING scheduled reply(ies)`
      );
    }
  }

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

  // Check account-level PER-PLATFORM away mode. The lead's platform decides
  // whether the Instagram or Facebook switch applies to this conversation.
  //
  // Auto-send requires BOTH:
  //   (1) The platform's away-mode is ON (operator has explicitly opted this
  //       platform in to AI auto-send), AND
  //   (2) The conversation's aiActive flag is true (no human has taken over
  //       this specific lead).
  //
  // Earlier version used OR semantics ("either gate opens the floodgate"),
  // which bit us because `Conversation.aiActive` defaults to true on
  // creation. That meant any new Instagram lead coming in through the Meta
  // webhook created a conversation with aiActive=true, and the AI
  // auto-replied even though the operator had never flipped the Instagram
  // switch on. See daetradez's @l.galeza for a real example. Requiring
  // BOTH makes the per-platform switch an actual opt-in: no sends until
  // the operator turns the platform on.
  //
  // REGRESSION NOTE — DELIVERY-TIME RE-CHECK: this entire scheduleAIReply
  // function re-runs from scratch every time the cron picks up a PENDING
  // ScheduledReply (via the skipDelayQueue=true branch). That means both
  // toggles (awayModeInstagram/Facebook here, and conversation.aiActive
  // inside sendAIReply below) are re-fetched at DELIVERY time, not snapshotted
  // at scheduling time. So an operator who flips the platform switch off
  // between a lead's message and the scheduled reply firing will NOT see
  // a stale auto-send go out — the delivery path re-evaluates against
  // the current DB state. sendAIReply does the final "is aiActive still
  // true?" check one more time as a belt-and-suspenders guard (see line
  // ~1605). Do NOT cache or pass these flags across the scheduling-to-
  // delivery boundary — always resolve them from the current DB row.
  log('sched.step1.findAccount');
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { awayModeInstagram: true, awayModeFacebook: true }
  });
  const awayModeForPlatform =
    lead.platform === 'INSTAGRAM'
      ? (account?.awayModeInstagram ?? false)
      : lead.platform === 'FACEBOOK'
        ? (account?.awayModeFacebook ?? false)
        : false;

  // Auto-send only when the platform is enabled AND the per-conversation
  // AI toggle is on. Either off → suggestion-only mode (no auto-send).
  const aiActive = conversation.aiActive;
  const shouldAutoSend = aiActive && awayModeForPlatform;
  log(
    'sched.step1.aiActive',
    `aiActive=${aiActive} platform=${lead.platform} awayMode=${awayModeForPlatform} shouldAutoSend=${shouldAutoSend}`
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
    status: lead.stage,
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
    timezone: lead.timezone || undefined,
    // Safety: when the conversation has a previously-detected distress
    // flag and the operator has re-enabled AI, the prompt needs to
    // know so it can soft check-in instead of pitching. Permanent flag
    // — stays true for the life of the conversation.
    distressDetected: conversation.distressDetected === true
  };

  // ── Step 3.0: Inbound qualification classifier (first AI gen only) ──
  // Universal stage-skip intelligence: if this is the FIRST AI generation
  // for this conversation and the lead's opening messages revealed
  // experience / pain / goal / financial context / explicit buying intent,
  // skip forward in the funnel. The skip is capped at +3 stages (+4 for
  // inbound leads) from Stage 1. Results are logged to InboundQualification
  // for analytics and re-used on subsequent turns via leadContext.preQualified.
  try {
    const aiMsgCount = await prisma.message.count({
      where: { conversationId, sender: 'AI' }
    });
    const existing = await prisma.inboundQualification.findUnique({
      where: { conversationId }
    });

    if (aiMsgCount === 0 && !existing) {
      // First AI generation cycle — run the classifier
      const leadMessages = messages
        .filter((m) => m.sender === 'LEAD')
        .map((m) => m.content)
        .filter(
          (c): c is string => typeof c === 'string' && c.trim().length > 0
        );

      // isInbound: the first message in the conversation was from the lead
      // (they DMed us or commented first). This is the most reliable signal
      // that the lead sought us out vs. us reaching out to them.
      const isInbound = messages.length > 0 && messages[0].sender === 'LEAD';

      const { classifyInboundQualification, applySkipCap, stageNumberToName } =
        await import('@/lib/inbound-qualification-classifier');

      const classification = await classifyInboundQualification(
        accountId,
        leadMessages,
        isInbound
      );

      const { finalStartStage, capped } = applySkipCap(
        classification.suggestedStartStage,
        isInbound,
        1 // new conversation always starts at stage 1 from the machine's POV
      );
      const stagesSkipped = Math.max(0, finalStartStage - 1);
      const finalStageName = stageNumberToName(finalStartStage);

      // Persist the classification result
      await prisma.inboundQualification.create({
        data: {
          conversationId,
          accountId,
          leadId: lead.id,
          suggestedStartStage: classification.suggestedStartStage,
          finalStartStage,
          stagesSkipped,
          stageSkipReason: classification.stageSkipReason,
          classifierConfidence: classification.confidence,
          capped,
          hasExperience: classification.extractedData.hasExperience,
          experienceLevel: classification.extractedData.experienceLevel,
          hasPainPoint: classification.extractedData.hasPainPoint,
          painPointSummary: classification.extractedData.painPointSummary,
          hasGoal: classification.extractedData.hasGoal,
          goalSummary: classification.extractedData.goalSummary,
          hasUrgency: classification.extractedData.hasUrgency,
          urgencySummary: classification.extractedData.urgencySummary,
          hasFinancialInfo: classification.extractedData.hasFinancialInfo,
          financialSummary: classification.extractedData.financialSummary,
          hasExplicitIntent: classification.extractedData.hasExplicitIntent,
          intentType: classification.extractedData.intentType,
          isInbound: classification.extractedData.isInbound,
          rawResponse: classification.raw as object | undefined
        }
      });

      // Back-fill lead.experience if the classifier detected one and the
      // lead doesn't already have it set. Never overwrite an explicit value.
      if (classification.extractedData.experienceLevel && !lead.experience) {
        await prisma.lead
          .update({
            where: { id: lead.id },
            data: { experience: classification.extractedData.experienceLevel }
          })
          .catch((err) => {
            console.error(
              '[webhook-processor] Failed to backfill lead.experience (non-fatal):',
              err
            );
          });
      }

      // Mark the skipped stage timestamps so the conversation state
      // machine knows those stages were "auto-skipped". Use classifiedAt
      // as the timestamp (same moment for each stage skipped).
      if (stagesSkipped > 0) {
        const now = new Date();
        const stageTimestampField: Record<number, string> = {
          1: 'stageOpeningAt',
          2: 'stageSituationDiscoveryAt',
          3: 'stageGoalEmotionalWhyAt',
          4: 'stageUrgencyAt',
          5: 'stageSoftPitchCommitmentAt',
          6: 'stageFinancialScreeningAt',
          7: 'stageBookingAt'
        };
        const toSet: Record<string, Date> = {};
        for (let s = 1; s <= finalStartStage; s++) {
          const field = stageTimestampField[s];
          if (field) toSet[field] = now;
        }
        if (Object.keys(toSet).length > 0) {
          await prisma.conversation
            .update({ where: { id: conversationId }, data: toSet })
            .catch((err) => {
              console.error(
                '[webhook-processor] Failed to record skipped stage timestamps (non-fatal):',
                err
              );
            });
        }
      }

      console.log(
        `[webhook-processor] [inbound-qual] suggested=${classification.suggestedStartStage} final=${finalStartStage}(${finalStageName}) skipped=${stagesSkipped} capped=${capped} intent=${classification.extractedData.intentType} conf=${classification.confidence.toFixed(2)} isInbound=${isInbound}`
      );

      // Inject the pre-qualified context into leadContext so the prompt
      // builder can emit the <pre_qualified_context> block.
      if (finalStartStage > 1) {
        leadContext.preQualified = {
          suggestedStartStage: finalStartStage,
          suggestedStartStageName: finalStageName,
          stagesSkipped,
          stageSkipReason: classification.stageSkipReason,
          experienceLevel: classification.extractedData.experienceLevel,
          painPointSummary: classification.extractedData.painPointSummary,
          goalSummary: classification.extractedData.goalSummary,
          urgencySummary: classification.extractedData.urgencySummary,
          financialSummary: classification.extractedData.financialSummary,
          intentType: classification.extractedData.intentType,
          isInbound: classification.extractedData.isInbound
        };
      }
    } else if (existing && aiMsgCount > 0) {
      // Not the first turn, but we have a prior classification — keep
      // injecting the pre-qualified summary so the AI remembers what the
      // lead said across turns.
      if (existing.finalStartStage > 1) {
        const { stageNumberToName } = await import(
          '@/lib/inbound-qualification-classifier'
        );
        leadContext.preQualified = {
          suggestedStartStage: existing.finalStartStage,
          suggestedStartStageName: stageNumberToName(existing.finalStartStage),
          stagesSkipped: existing.stagesSkipped,
          stageSkipReason: existing.stageSkipReason,
          experienceLevel: existing.experienceLevel,
          painPointSummary: existing.painPointSummary,
          goalSummary: existing.goalSummary,
          urgencySummary: existing.urgencySummary,
          financialSummary: existing.financialSummary,
          intentType: existing.intentType,
          isInbound: existing.isInbound
        };
      }
    }
  } catch (err) {
    console.error(
      '[webhook-processor] Inbound qualification classifier failed (non-fatal):',
      err
    );
  }

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
    // updateLeadStageFromConversation see the conversation as fully qualified.
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

  // ── Step 3.5: DEBOUNCE — wait for the lead to finish typing ────
  //
  // The lead often sends bursts of short messages. Instead of triggering
  // generation per message (which produced 2-5 near-duplicate AI replies
  // in production), we wait for a pause in their typing and respond to
  // the full batch at once.
  //
  // Flow:
  //   - Each inbound lead msg lands here → cancel any pending
  //     ScheduledReply (Step 0b already did that) and create a new one
  //     at now + debounce_window.
  //   - The fire time respects the response-delay random jitter (for
  //     texting-cadence realism) and is capped by maxDebounceWindow from
  //     the first lead msg in the current batch (so a lead typing for
  //     5 minutes straight still gets a reply by ~2 min in).
  //   - Cron picks up the PENDING row when due and re-enters
  //     scheduleAIReply with skipDelayQueue=true → generation runs on
  //     the freshest conversation state (every message that arrived
  //     during the debounce is now in history).
  if (
    !options?.skipDelayQueue &&
    !leadContext.testModeSkipToBooking &&
    shouldAutoSend
  ) {
    try {
      const accountRow = await prisma.account.findUnique({
        where: { id: accountId },
        select: {
          responseDelayMin: true,
          responseDelayMax: true,
          debounceWindowSeconds: true,
          maxDebounceWindowSeconds: true
        }
      });
      const minDelay = Math.max(0, accountRow?.responseDelayMin ?? 0);
      const maxDelay = Math.max(minDelay, accountRow?.responseDelayMax ?? 0);
      const debounceSec = Math.max(0, accountRow?.debounceWindowSeconds ?? 45);
      const maxDebounceSec = Math.max(
        debounceSec,
        accountRow?.maxDebounceWindowSeconds ?? 120
      );

      // Find the earliest lead message in the current batch (since the
      // last AI message). Used to enforce the max-cap so the AI can't
      // be indefinitely postponed by a chatty lead.
      const lastAiMsg = await prisma.message.findFirst({
        where: { conversationId, sender: 'AI' },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true }
      });
      const earliestLeadInBatch = await prisma.message.findFirst({
        where: {
          conversationId,
          sender: 'LEAD',
          ...(lastAiMsg ? { timestamp: { gt: lastAiMsg.timestamp } } : {})
        },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true }
      });

      const { humanResponseDelay } = await import('@/lib/delay-utils');
      const delayRandomSec = humanResponseDelay(minDelay, maxDelay);
      const now = Date.now();
      // Debounce floor: at least `debounceSec` from now OR the random
      // response delay, whichever is later. This replaces the additive
      // "debounce + delay" stacking — either one naturally provides the
      // conversational pause.
      const preferredFireAt =
        now + Math.max(debounceSec, delayRandomSec) * 1000;
      // Cap: never fire later than `maxDebounceSec` after the FIRST lead
      // msg in the batch.
      const maxFireAt = earliestLeadInBatch
        ? earliestLeadInBatch.timestamp.getTime() + maxDebounceSec * 1000
        : preferredFireAt;
      // Final: min(preferred, cap), but always at least 1s from now so
      // the cron can pick it up.
      const fireAt = Math.max(now + 1000, Math.min(preferredFireAt, maxFireAt));
      const scheduledFor = new Date(fireAt);

      await prisma.scheduledReply.create({
        data: {
          conversationId,
          accountId,
          scheduledFor,
          status: 'PENDING'
        }
      });
      const secFromNow = Math.round((fireAt - now) / 1000);
      const batchAgeSec = earliestLeadInBatch
        ? Math.round((now - earliestLeadInBatch.timestamp.getTime()) / 1000)
        : 0;
      console.log(
        `[webhook-processor] AI reply debounced for ${conversationId} ` +
          `(fire in ${secFromNow}s, debounce=${debounceSec}s delay=${delayRandomSec}s ` +
          `batchAge=${batchAgeSec}s cap=${maxDebounceSec}s scheduledFor=${scheduledFor.toISOString()})`
      );
      return;
    } catch (err) {
      console.error(
        '[webhook-processor] Debounce queue failed (proceeding immediately):',
        err
      );
    }
  } else if (leadContext.testModeSkipToBooking) {
    console.log(
      `[webhook-processor] [TEST MODE] Bypassing debounce for ${conversationId}`
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

      console.log(
        `[BOOKING_FLOW] Availability.start`,
        JSON.stringify({
          conversationId,
          leadTimezone: conversation.leadTimezone,
          rangeStart: now.toISOString(),
          rangeEnd: end.toISOString(),
          ts: new Date().toISOString()
        })
      );

      const avail = await getUnifiedAvailability(
        accountId,
        now.toISOString(),
        end.toISOString(),
        conversation.leadTimezone
      );

      console.log(
        `[BOOKING_FLOW] Availability.rawSlots`,
        JSON.stringify({
          conversationId,
          provider: avail.provider,
          rawSlotCount: avail.slots?.length || 0,
          rawSlots: (avail.slots || []).slice(0, 20).map((s) => ({
            start: s.start,
            end: s.end
          })),
          ts: new Date().toISOString()
        })
      );

      // Filter to business hours 9am-7pm in the lead's tz
      const preFilterSlots = avail.slots || [];
      availableSlots = preFilterSlots
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
        `[BOOKING_FLOW] Availability.filtered`,
        JSON.stringify({
          conversationId,
          preFilterCount: preFilterSlots.length,
          postFilterCount: availableSlots.length,
          filteredSlots: availableSlots.map((s) => ({
            start: s.start,
            end: s.end
          })),
          filterTimezone: conversation.leadTimezone,
          ts: new Date().toISOString()
        })
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
  const _aiGenStart = Date.now();
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
    const _aiGenMs = Date.now() - _aiGenStart;
    log(
      'sched.step4.generateDone',
      `stage=${result.stage} aiGen=${(_aiGenMs / 1000).toFixed(1)}s`
    );
  } catch (err) {
    console.error(
      `[webhook-processor] AI generation failed for ${conversationId}:`,
      err
    );
    return;
  }

  // ── Step 4a-pre: Script-bound runtime_match VN resolution ──────
  // If the AI responded with a runtime_match voice note action (from a
  // script [VN] slot set to runtime_match mode), resolve it via the
  // embedding + LLM context matcher. Non-fatal: falls back to text.
  if (
    result.voiceNoteAction?.slot_id === 'runtime_match' ||
    (result.format === 'voice_note' && !result.voiceNoteAction?.slot_id)
  ) {
    try {
      const { findBestVoiceNoteMatch } = await import(
        '@/lib/voice-note-context-matcher'
      );
      const matchResult = await findBestVoiceNoteMatch({
        accountId,
        conversationContext: messages
          .slice(-5)
          .map((m) => `${m.sender}: ${m.content}`)
          .join('\n'),
        leadStage: lead.stage,
        lastLeadMessage: messages[messages.length - 1]?.content || '',
        actionContent: result.reply
      });
      if (matchResult && matchResult.confidence > 0.7) {
        result.shouldVoiceNote = true;
        result.voiceNoteAction = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result as any)._libraryVoiceNote = {
          id: matchResult.voiceNoteId,
          audioFileUrl: matchResult.audioFileUrl,
          triggerType: 'runtime_match'
        };
        log(
          'sched.step4apre.runtimeMatch',
          `voiceNote=${matchResult.voiceNoteId} confidence=${matchResult.confidence.toFixed(2)}`
        );
      }
    } catch (err) {
      console.error(
        '[webhook-processor] Runtime match failed (non-fatal):',
        err
      );
    }
  }

  // ── Step 4a: Voice Note Library Trigger Evaluation ──────────────
  // Check if any library voice note should be sent based on structured
  // triggers (stage transition, content intent, conversational move).
  // Non-fatal: if evaluation fails, fall through to existing behavior.
  try {
    const { evaluateTriggers } = await import(
      '@/lib/voice-note-trigger-engine'
    );

    const triggerResult = await evaluateTriggers({
      accountId,
      leadId: lead.id,
      leadStage: lead.stage,
      conversationId,
      lastLeadMessage: messages[messages.length - 1]?.content || '',
      recentMessages: messages.slice(-5).map((m) => ({
        sender: m.sender,
        content: m.content
      })),
      currentMessageIndex: messages.length
    });

    if (triggerResult.matchedVoiceNote) {
      // Override the LLM's voice note decision with the library match
      result.shouldVoiceNote = true;
      result.voiceNoteAction = null; // Clear slot-based action
      // Attach library voice note info for sendAIReply to use
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)._libraryVoiceNote = triggerResult.matchedVoiceNote;
      log(
        'sched.step4a.triggerMatch',
        `voiceNote=${triggerResult.matchedVoiceNote.id} trigger=${triggerResult.matchedVoiceNote.triggerType}`
      );
    } else {
      log(
        'sched.step4a.noMatch',
        `evaluated=${triggerResult.candidatesEvaluated} intent=${triggerResult.intentDetected}`
      );
    }
  } catch (err) {
    console.error(
      '[webhook-processor] Trigger evaluation failed (non-fatal):',
      err
    );
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

  // ── Step 4d removed ──────────────────────────────────────────────
  // Voice-note-aware split removed: debounce now governs the pause in
  // Step 3.5, so we no longer need a post-generation delay branch. The
  // voice-note path still works — ElevenLabs generates the audio in
  // Step 5 and ships it; the "wait N minutes before sending a voice
  // note" timing logic was removed as part of the debounce unification.
  // If per-message-type timing ever comes back, do it here post-gen.

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
      (options?.skipDelayQueue ? ' (delivered after scheduled delay)' : '') +
      ` | pipeline so far: ${((Date.now() - _pipelineStart) / 1000).toFixed(1)}s`
  );
  await sendAIReply(conversationId, accountId, lead, result);
}

// ---------------------------------------------------------------------------
// Multi-bubble delivery helpers
// ---------------------------------------------------------------------------
// When the LLM emits messages: string[] with length >1 AND the turn has
// no voice-note action, sendAIReply dispatches to deliverBubbleGroup.
// Each bubble is saved as its own Message row, shipped to Meta with a
// typing-like delay between sends, and SSE-broadcast independently so
// the operator dashboard renders them in real time. The MessageGroup
// parent row tracks bubbleCount, totalCharacters, completedAt, failedAt
// and any delivery notes (human-aborted, rate-limited, etc.).

/**
 * Typing-time delay between bubbles. Roughly 30-50ms per character of
 * the NEXT bubble, plus a 200-800ms base "thinking" pause. Capped at
 * 4s so a 200-char bubble doesn't stall the conversation for 7s. The
 * per-character + random-base structure produces delays that feel like
 * someone typing, not a robot dumping messages on a fixed schedule.
 */
function calculateBubbleDelay(nextBubbleChars: number): number {
  const baseTypingDelay = 200 + Math.random() * 600; // 200-800ms
  const perCharFactor = 30 + Math.random() * 20; // 30-50ms per char
  const charBasedDelay = nextBubbleChars * perCharFactor;
  return Math.min(Math.round(baseTypingDelay + charBasedDelay), 4000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deliver a multi-bubble AI response as N separate platform sends.
 * Creates a MessageGroup parent row, then iterates the bubble array:
 *   1. prisma.message.create with messageGroupId + bubbleIndex
 *   2. platform send (sendInstagramDM / sendFacebookMessage — each
 *      already does its own 1s/2s/4s exponential backoff on transient
 *      errors, so we only catch POST-retry failures here)
 *   3. broadcastNewMessage with group fields so the UI can render in
 *      real time
 *   4. sleep calculateBubbleDelay(nextBubbleChars) before next bubble
 *
 * Between bubbles, re-query for HUMAN messages arrived since groupStart.
 * If a human took over mid-group, abort the remaining bubbles — whatever
 * already shipped stays on Meta (we can't unsend). Record
 * deliveryNotes.abortedByHuman so the UI / analytics can flag it.
 *
 * Metadata fields (stage, substage, objectionType, etc.) are written on
 * bubble 0 only. Downstream analytics queries (`WHERE stage IS NOT NULL`)
 * continue counting one AI turn, not N. Bubbles 1..N-1 are "content
 * continuation" rows with the group FK.
 */
async function deliverBubbleGroup(params: {
  conversationId: string;
  lead: {
    id: string;
    platform: string;
    platformUserId: string | null;
    accountId: string;
  };
  bubbles: string[];
  result: {
    reply: string;
    stage: string;
    subStage?: string | null;
    stageConfidence: number;
    sentimentScore: number;
    experiencePath?: string | null;
    objectionDetected?: string | null;
    stallType?: string | null;
    followUpNumber?: number | null;
    systemPromptVersion: string;
    suggestionId?: string | null;
  };
  now: Date;
}): Promise<{
  groupId: string;
  delivered: number;
  failedAt: Date | null;
  firstMessageId: string;
}> {
  const { conversationId, lead, bubbles, result, now } = params;
  const totalCharacters = bubbles.reduce((sum, b) => sum + b.length, 0);

  // 1. Create the parent MessageGroup first so bubble rows can link.
  const group = await prisma.messageGroup.create({
    data: {
      conversationId,
      generatedAt: now,
      aiSuggestionId: result.suggestionId || null,
      bubbleCount: bubbles.length,
      totalCharacters,
      sentByType: 'AI'
    }
  });

  const groupStart = now;
  let delivered = 0;
  let failedAt: Date | null = null;
  let firstMessageId = '';
  let abortedByHuman = false;

  for (let i = 0; i < bubbles.length; i++) {
    const isFirst = i === 0;
    const bubble = bubbles[i];

    // Mid-group human-takeover check (skip on the first bubble — we
    // already passed the top-of-sendAIReply preflight).
    if (!isFirst) {
      const humanInterrupt = await prisma.message.findFirst({
        where: {
          conversationId,
          sender: 'HUMAN',
          timestamp: { gt: groupStart }
        },
        select: { id: true }
      });
      if (humanInterrupt) {
        abortedByHuman = true;
        console.log(
          `[webhook-processor] Multi-bubble group ${group.id} aborted at bubble ${i}/${bubbles.length}: human took over`
        );
        break;
      }
    }

    // 2. Per-bubble Message row. Metadata written on bubble 0 only —
    // downstream analytics group by AI-turn = one stage-bearing row.
    const bubbleTimestamp = i === 0 ? now : new Date();
    const msg = await prisma.message.create({
      data: {
        conversationId,
        sender: 'AI',
        content: bubble,
        timestamp: bubbleTimestamp,
        messageGroupId: group.id,
        bubbleIndex: i,
        bubbleTotalCount: bubbles.length,
        intraGroupDelayMs: null, // back-filled below on the NEXT bubble
        stage: isFirst ? result.stage || null : null,
        subStage: isFirst ? result.subStage || null : null,
        stageConfidence: isFirst ? result.stageConfidence : null,
        sentimentScore: isFirst ? result.sentimentScore : null,
        experiencePath: isFirst ? result.experiencePath || null : null,
        objectionType: isFirst ? result.objectionDetected || null : null,
        stallType: isFirst ? result.stallType || null : null,
        followUpAttemptNumber: isFirst ? (result.followUpNumber ?? null) : null,
        systemPromptVersion: isFirst ? result.systemPromptVersion : null,
        suggestionId: isFirst ? result.suggestionId || null : null
      }
    });
    if (isFirst) firstMessageId = msg.id;

    // 3. Platform send. sendInstagramDM / sendFacebookMessage each
    // internally retry 1s/2s/4s on transient errors — a throw here
    // means all retries exhausted.
    if (lead.platformUserId) {
      try {
        if (lead.platform === 'INSTAGRAM') {
          await sendInstagramDM(lead.accountId, lead.platformUserId, bubble);
        } else if (lead.platform === 'FACEBOOK') {
          await sendFacebookMessage(
            lead.accountId,
            lead.platformUserId,
            bubble
          );
        }
        console.log(
          `[webhook-processor] bubble ${i}/${bubbles.length - 1} sent to ${lead.platformUserId} (group=${group.id})`
        );
      } catch (err: unknown) {
        failedAt = new Date();
        console.error(
          `[webhook-processor] Multi-bubble delivery failed at bubble ${i}/${bubbles.length}:`,
          err
        );
        // Notify operator — we stop the loop, whatever already shipped stays.
        try {
          await prisma.notification.create({
            data: {
              accountId: lead.accountId,
              type: 'SYSTEM',
              title: 'Multi-bubble delivery failed',
              body: `Bubble ${i + 1} of ${bubbles.length} failed to deliver to ${lead.platformUserId} on ${lead.platform}: ${((err as Error)?.message || 'Unknown error').slice(0, 200)}. Earlier bubbles were delivered; no further bubbles will be sent.`,
              leadId: lead.id
            }
          });
          broadcastNotification({
            accountId: lead.accountId,
            type: 'SYSTEM',
            title: 'Multi-bubble delivery failed'
          });
        } catch (notifyErr) {
          console.error(
            '[webhook-processor] Failed to create mid-group failure notification:',
            notifyErr
          );
        }
        break;
      }
    }

    // 4. SSE broadcast — include group fields so the dashboard can
    // render in real time without re-fetching.
    broadcastNewMessage({
      id: msg.id,
      conversationId,
      sender: 'AI',
      content: bubble,
      timestamp: msg.timestamp.toISOString(),
      messageGroupId: group.id,
      bubbleIndex: i,
      bubbleTotalCount: bubbles.length
    });

    delivered++;

    // 5. Typing-delay sleep before next bubble. Skip after the last one.
    if (i < bubbles.length - 1) {
      const nextChars = bubbles[i + 1].length;
      const delayMs = calculateBubbleDelay(nextChars);
      await sleep(delayMs);
      // Back-fill the delay on the NEXT bubble we're about to create —
      // do it via an update after the create so we always have a value.
      // Simplest: we'll write it when creating the next message above by
      // passing delayMs, but we're already past the write boundary for
      // bubble i. Write a separate update.
      // Minor: fire-and-forget — analytics-only, not load-bearing.
      prisma.message
        .updateMany({
          where: {
            messageGroupId: group.id,
            bubbleIndex: i + 1
          },
          data: { intraGroupDelayMs: delayMs }
        })
        .catch(() => {
          /* non-fatal: the next-bubble row doesn't exist yet, we'll
           * set it via a second pass below if this race loses */
        });
    }
  }

  // Close out the MessageGroup lifecycle.
  const notes: Record<string, unknown> = {};
  if (abortedByHuman) notes.abortedByHuman = true;
  if (failedAt) notes.failedAtBubble = delivered;
  // Prisma's InputJsonValue requires an object literal cast through
  // unknown because its union type excludes arbitrary index signatures.
  await prisma.messageGroup.update({
    where: { id: group.id },
    data: {
      completedAt: failedAt ? null : new Date(),
      failedAt: failedAt ?? null,
      deliveryNotes: Object.keys(notes).length
        ? (notes as Prisma.InputJsonValue)
        : undefined
    }
  });

  return {
    groupId: group.id,
    delivered,
    failedAt,
    firstMessageId
  };
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
    stage: string;
  },
  result: {
    reply: string;
    // Multi-bubble output. Always populated — single-message responses
    // appear as [reply]. When length >1 and no voice-note is active,
    // sendAIReply dispatches to deliverBubbleGroup instead of the
    // single-send path.
    messages: string[];
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
    escalateToHuman?: boolean;
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
    suggestionId?: string | null;
    // R24 capital-verification outcome — drives Lead.stage update so
    // `FINANCIAL_SCREENING reached` doesn't blindly promote the lead to
    // QUALIFIED when the gate actually failed.
    capitalOutcome?:
      | 'passed'
      | 'failed'
      | 'hedging'
      | 'ambiguous'
      | 'not_asked'
      | 'not_evaluated';
    // Layer 2 safety net: ai-engine flagged the last LEAD message as
    // distress. sendAIReply MUST reroute through the supportive path
    // instead of shipping the (empty) normal result.
    distressDetected?: boolean;
    distressMatch?: string | null;
    distressLabel?: string | null;
  }
): Promise<void> {
  // ── LAYER 2 distress handler ──────────────────────────────────
  // ai-engine.generateReply sets distressDetected=true when the lead's
  // latest message matched the distress detector — happens when Layer 1
  // (processIncomingMessage pre-generation gate) was bypassed somehow
  // (retried webhook, stale cron-fired ScheduledReply, etc.). We run
  // the SAME flow Layer 1 runs: flip aiActive, flag the conversation,
  // cancel pending replies, notify the operator, ship a dedicated
  // supportive response. Skip all normal ship logic below.
  if (result.distressDetected) {
    console.warn(
      `[webhook-processor] Layer 2 distress path engaged for conv ${conversationId} — match="${result.distressMatch}" label=${result.distressLabel}`
    );
    try {
      // Find the lead's most recent message — that's the one that
      // triggered detection. distressMessageId points at it so the
      // operator review can jump straight to the offending turn.
      const latestLead = await prisma.message.findFirst({
        where: { conversationId, sender: 'LEAD' },
        orderBy: { timestamp: 'desc' },
        select: { id: true, content: true }
      });
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          aiActive: false,
          distressDetected: true,
          distressDetectedAt: new Date(),
          distressMessageId: latestLead?.id ?? null
        }
      });
      await prisma.scheduledReply.updateMany({
        where: { conversationId, status: 'PENDING' },
        data: { status: 'CANCELLED' }
      });
      try {
        await prisma.notification.create({
          data: {
            accountId: lead.accountId,
            type: 'SYSTEM',
            title: 'URGENT — distress signal detected, review immediately',
            body: `${lead.name} (@${lead.handle}): the lead's latest message matched a crisis / distress pattern ("${result.distressMatch ?? 'unknown'}"). AI has been paused. Please review and respond personally. (Layer 2 safety net — Layer 1 was bypassed, investigate.)`,
            leadId: lead.id
          }
        });
      } catch (notifErr) {
        console.error(
          '[webhook-processor] Layer 2 distress notification failed (non-fatal):',
          notifErr
        );
      }
      // Ship the supportive response through the same helper as Layer 1.
      if (latestLead?.content) {
        const { generateSupportiveResponse } = await import(
          '@/lib/distress-response'
        );
        const supportiveText = await generateSupportiveResponse(
          latestLead.content
        );
        const supportiveMsg = await prisma.message.create({
          data: {
            conversationId,
            sender: 'AI',
            content: supportiveText,
            timestamp: new Date(),
            stage: null,
            subStage: null
          }
        });
        if (lead.platformUserId) {
          try {
            if (lead.platform === 'INSTAGRAM') {
              await sendInstagramDM(
                lead.accountId,
                lead.platformUserId,
                supportiveText
              );
            } else if (lead.platform === 'FACEBOOK') {
              await sendFacebookMessage(
                lead.accountId,
                lead.platformUserId,
                supportiveText
              );
            }
          } catch (sendErr) {
            console.error(
              '[webhook-processor] Layer 2 supportive platform send failed:',
              sendErr
            );
          }
        }
        broadcastNewMessage({
          id: supportiveMsg.id,
          conversationId,
          sender: 'AI',
          content: supportiveText,
          timestamp: supportiveMsg.timestamp.toISOString()
        });
      }
      broadcastAIStatusChange({ conversationId, aiActive: false });
    } catch (err) {
      console.error(
        '[webhook-processor] Layer 2 distress handler failed (non-fatal, AI still paused):',
        err
      );
    }
    return;
  }

  // Belt-and-suspenders: re-check that AI is still active at DELIVERY
  // time. This covers two race conditions the scheduling-time check
  // above can't catch on its own:
  //   (1) Human took over the specific conversation mid-delay (flipped
  //       per-chat aiActive to false via the dashboard toggle)
  //   (2) Operator toggled the platform-level away-mode off between
  //       scheduling and firing — this check handles per-conversation;
  //       platform-level is covered by scheduleAIReply re-running from
  //       scratch when cron picks up the PENDING row.
  // Either condition means we should NOT ship the reply the LLM just
  // generated. Instead, broadcast it as a suggestion so the dashboard
  // can still render the AI's draft for the human to take or discard.
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

  // ── Double-fire guard: skip if the conversation is already our turn ──
  // Catches duplicate ships caused by concurrent generations reaching
  // sendAIReply for the same batch. Semantic check: if the latest
  // message in the conversation is NOT from the LEAD, the AI has
  // already answered (or a human took over) and shouldn't send again.
  //
  // Previously used a 25s time window which blocked legitimate replies
  // when the AI's debounce fired shortly after a prior reply — same
  // class of bug as Step 0a.
  const latestMsgInConvo = await prisma.message.findFirst({
    where: { conversationId },
    orderBy: { timestamp: 'desc' },
    select: { sender: true, timestamp: true }
  });
  if (latestMsgInConvo && latestMsgInConvo.sender !== 'LEAD') {
    const ageMs = Date.now() - latestMsgInConvo.timestamp.getTime();
    console.log(
      `[webhook-processor] Double-fire guard: latest msg is ${latestMsgInConvo.sender} (${Math.round(ageMs / 1000)}s ago) for ${conversationId} — discarding duplicate reply`
    );
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

  // ── Zero-tolerance empty-message guard ────────────────────────
  // A 0-char / whitespace-only payload shipped to production on
  // 2026-04-19 11:21:39 (conv cmo5lrc9q0002l404xcdt13zv): the voice
  // quality retry loop exhausted 3 attempts on a low-scoring reply
  // and fell through to a "best effort" ship path that never
  // re-checked the payload length. The LLM's final parsed.message
  // ended up as the empty string, parseAIResponse wrapped it as
  // [""], and this function saved a Message row with `content=""`
  // and called the platform-send API with empty text. Hard gate
  // here guarantees that can never happen: if the entire turn has
  // no non-whitespace content, pause the AI, create a SYSTEM
  // notification, and return without any save or send.
  const bubblesForEmptyCheck =
    Array.isArray(result.messages) && result.messages.length > 0
      ? result.messages
      : [result.reply ?? ''];
  const hasRealContent = bubblesForEmptyCheck.some(
    (b) => typeof b === 'string' && b.trim().length > 0
  );
  if (!hasRealContent) {
    console.error(
      `[webhook-processor] empty_message_blocked for conv ${conversationId} — AI produced 0-char / whitespace-only content across ${bubblesForEmptyCheck.length} bubble(s). Pausing AI, notifying operator, no platform send.`
    );
    try {
      // Mark the suggestion rejected so analytics / override
      // detection don't treat it as selected-and-sent.
      if (result.suggestionId) {
        await prisma.aISuggestion
          .update({
            where: { id: result.suggestionId },
            data: { wasRejected: true, finalSentText: null }
          })
          .catch(() => {});
      }
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { aiActive: false }
      });
      broadcastAIStatusChange({ conversationId, aiActive: false });
      await prisma.notification.create({
        data: {
          accountId: lead.accountId,
          type: 'SYSTEM',
          title: 'AI produced empty response — human takeover required',
          body: `${lead.name} (@${lead.handle}): the AI's last generation had no text content to send (voice quality gate likely exhausted retries on a failing reply). AI is now paused on this conversation. Please review and take over.`,
          leadId: lead.id
        }
      });
    } catch (err) {
      console.error(
        '[webhook-processor] Empty-message escalation bookkeeping failed (non-fatal):',
        err
      );
    }
    return;
  }

  // ── Dedup safety net ──────────────────────────────────────────
  // Last-line defense against near-duplicate sends that slip through the
  // debounce + cancel-pending + 25s recency guard. Compare the new reply
  // against the last 3 AI messages using word-level Jaccard. Threshold
  // 0.85 catches copy-pastes and trivial rewordings but allows genuinely
  // different responses that happen to share common words (like "bro"
  // or "gotchu").
  try {
    const last3 = await prisma.message.findMany({
      where: { conversationId, sender: 'AI' },
      orderBy: { timestamp: 'desc' },
      take: 3,
      select: { content: true }
    });
    const tokenize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 0);
    const newArr = tokenize(result.reply);
    const newTokens = new Set(newArr);
    for (const prev of last3) {
      const prevArr = tokenize(prev.content);
      const prevTokens = new Set(prevArr);
      if (newTokens.size === 0 || prevTokens.size === 0) continue;
      let intersection = 0;
      for (const w of newArr) if (prevTokens.has(w)) intersection++;
      // Correct intersection: use set semantics (count unique words in common)
      intersection = newArr.filter(
        (w, i) => prevTokens.has(w) && newArr.indexOf(w) === i
      ).length;
      const union = new Set(newArr.concat(prevArr)).size;
      const similarity = union > 0 ? intersection / union : 0;
      if (similarity >= 0.85) {
        console.warn(
          `[webhook-processor] duplicate_suppressed ${conversationId} — sim=${similarity.toFixed(2)} vs prior AI msg. Not sending: "${result.reply.slice(0, 80)}"`
        );
        // Mark the suggestion as rejected-by-dedup so analytics can track it
        if (result.suggestionId) {
          await prisma.aISuggestion
            .update({
              where: { id: result.suggestionId },
              data: { wasRejected: true, finalSentText: null }
            })
            .catch(() => {});
        }
        return;
      }
    }
  } catch (err) {
    console.error(
      '[webhook-processor] Dedup check failed (non-fatal, proceeding with send):',
      err
    );
  }

  // ── Decide single-send vs multi-bubble path ──────────────────
  // Multi-bubble applies only when the LLM emitted 2+ bubbles AND no
  // voice-note action is active this turn (voice notes are
  // single-turn by nature — one audio file, not a sequence). For
  // flag-off accounts the LLM emits a single message so messages.length
  // is 1 and this always falls to the single-send path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const libraryVN = (result as any)?._libraryVoiceNote as
    | { id: string; audioFileUrl: string; triggerType: string }
    | undefined;
  const useMultiBubble =
    Array.isArray(result.messages) &&
    result.messages.length > 1 &&
    !result.shouldVoiceNote &&
    !result.voiceNoteAction?.slot_id &&
    !libraryVN;

  let aiMessageId: string;

  if (useMultiBubble) {
    // ── Multi-bubble path ────────────────────────────────────────
    const groupResult = await deliverBubbleGroup({
      conversationId,
      lead,
      bubbles: result.messages,
      result,
      now
    });
    aiMessageId = groupResult.firstMessageId;
    if (groupResult.failedAt) {
      console.warn(
        `[webhook-processor] Multi-bubble group ${groupResult.groupId} failed after ${groupResult.delivered}/${result.messages.length} bubbles delivered`
      );
    }
  } else {
    // ── Single-message path (legacy, voice-note compatible) ──────
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
        systemPromptVersion: result.systemPromptVersion,
        suggestionId: result.suggestionId || null
      }
    });
    aiMessageId = aiMessage.id;
  }

  // ── Link AISuggestion as selected ──────────────────────────────
  // finalSentText carries the full outgoing text. For multi-bubble,
  // join bubbles with "\n" so override-detection Jaccard comparison
  // sees the complete message the lead received.
  if (result.suggestionId) {
    try {
      const finalText = useMultiBubble
        ? result.messages.join('\n')
        : result.reply;
      await prisma.aISuggestion.update({
        where: { id: result.suggestionId },
        data: {
          wasSelected: true,
          finalSentText: finalText
        }
      });
    } catch (err) {
      console.error(
        '[webhook-processor] AISuggestion selection update failed (non-fatal):',
        err
      );
    }
  }

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

  // ── Booking is now script-driven, not API-triggered ─────────────
  // Previously this block called bookUnifiedAppointment() (LeadConnector
  // / Calendly / Cal.com) whenever the AI reached BOOKING_CONFIRM with
  // a slot + email. Removed at the user's request: the AI would try to
  // auto-book, the provider would fail (wrong creds, no LeadConnector
  // configured, etc.), and the lead saw a phantom "you're locked in"
  // message with no actual calendar entry.
  //
  // New flow: the AI reaches Stage 7, follows the script, and drops the
  // booking link from the script's `send_link` action. The lead clicks
  // and books themselves. lead.stage transitions to BOOKED only via a
  // real calendar webhook or a human manually updating the lead — never
  // automatically from the LLM's sub_stage.
  //
  // We still capture leadTimezone / leadEmail on the conversation row
  // above (bookingUpdates) so humans have context for follow-up.
  if (result.subStage === 'BOOKING_CONFIRM') {
    console.log(
      `[webhook-processor] BOOKING_CONFIRM reached for ${conversationId} — script-driven flow, no server-side booking triggered`
    );
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

  // ── R20: Escalation to human ──────────────────────────────────
  // The AI set escalate_to_human=true because either (a) the lead
  // reported the same issue twice, or (b) the AI made 3+ consecutive
  // "I'll check on it" promises. Pause the AI and create a SYSTEM
  // notification so a human teammate picks it up.
  if (result.escalateToHuman) {
    try {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { aiActive: false }
      });
      broadcastAIStatusChange({ conversationId, aiActive: false });
      await prisma.notification.create({
        data: {
          accountId: lead.accountId,
          type: 'SYSTEM',
          title: 'AI escalated conversation — needs human',
          body: `${lead.name} (@${lead.handle}): AI hit an escalation condition (stuck loop or repeat issue). AI is now paused. Please review the conversation and take over.`,
          leadId: lead.id
        }
      });
      console.log(
        `[webhook-processor] R20 escalation to human for ${conversationId} — AI paused, notification created`
      );
    } catch (err) {
      console.error(
        '[webhook-processor] Failed to record R20 escalation (non-fatal):',
        err
      );
    }
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

  // ── Update lead stage based on conversation stage ──────────────
  // Pass subStage + R24 capitalOutcome so the mapping can distinguish
  // "reached FINANCIAL_SCREENING" (don't promote) from "passed R24"
  // (promote to QUALIFIED) from "failed R24 / routed to downsell"
  // (promote to UNQUALIFIED).
  await updateLeadStageFromConversation(
    lead.id,
    lead.stage,
    result.stage,
    result.subStage ?? null,
    result.capitalOutcome ?? 'not_evaluated'
  ).catch((err) =>
    console.error('[webhook-processor] Lead stage update error:', err)
  );

  // ── Broadcast + platform send (single-message path only) ───────
  // Multi-bubble already did both per-bubble inside deliverBubbleGroup,
  // so everything below is skipped for multi-bubble turns. Voice-note
  // paths remain inside this single-message branch — voice notes are
  // inherently one-turn and never coexist with multi-bubble (see the
  // useMultiBubble check earlier in this function).
  if (!useMultiBubble) {
    broadcastNewMessage({
      id: aiMessageId,
      conversationId,
      sender: 'AI',
      content: result.reply,
      timestamp: now.toISOString()
    });

    // ── Send to platform ────────────────────────────────────────────
    if (lead.platformUserId) {
      let voiceNoteSent = false;

      // libraryVN captured at the top of sendAIReply (used for the
      // useMultiBubble check). Reuse it here.
      if (libraryVN && !voiceNoteSent) {
        try {
          await prisma.message.update({
            where: { id: aiMessageId },
            data: { isVoiceNote: true, voiceNoteUrl: libraryVN.audioFileUrl }
          });

          if (lead.platform === 'INSTAGRAM') {
            const { sendAudioDM } = await import('@/lib/instagram');
            await sendAudioDM(
              lead.accountId,
              lead.platformUserId,
              libraryVN.audioFileUrl
            );
          } else if (lead.platform === 'FACEBOOK') {
            const { sendAudioMessage } = await import('@/lib/facebook');
            await sendAudioMessage(
              lead.accountId,
              lead.platformUserId,
              libraryVN.audioFileUrl
            );
          }

          voiceNoteSent = true;

          // Log the send for cooldown tracking
          try {
            const { logVoiceNoteSend } = await import(
              '@/lib/voice-note-send-log'
            );
            await logVoiceNoteSend({
              accountId,
              leadId: lead.id,
              voiceNoteId: libraryVN.id,
              messageIndex: await prisma.message.count({
                where: { conversationId }
              }),
              triggerType: libraryVN.triggerType
            });
          } catch (logErr) {
            console.error(
              '[webhook-processor] Failed to log VN send (non-fatal):',
              logErr
            );
          }

          console.log(
            `[webhook-processor] Library voice note (id: ${libraryVN.id}) sent to ${lead.platformUserId}`
          );
        } catch (err) {
          console.error(
            '[webhook-processor] Library voice note send failed:',
            err
          );
          // Fall through to slot system
        }
      }

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
              where: { id: aiMessageId },
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
            where: { id: aiMessageId },
            data: { isVoiceNote: true, voiceNoteUrl: audioUrl }
          });

          // Send audio to platform
          if (lead.platform === 'INSTAGRAM') {
            const { sendAudioDM } = await import('@/lib/instagram');
            await sendAudioDM(lead.accountId, lead.platformUserId, audioUrl);
          } else if (lead.platform === 'FACEBOOK') {
            const { sendAudioMessage } = await import('@/lib/facebook');
            await sendAudioMessage(
              lead.accountId,
              lead.platformUserId,
              audioUrl
            );
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
    } // close if (lead.platformUserId) — single-message platform send
  } // close if (!useMultiBubble) — single-message path

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
  // When AI sends a reply via the Instagram / Facebook Send API, Meta
  // echoes it back as an admin message (is_echo=true). The AI-saved
  // message won't have a platformMessageId, so the platformMessageId
  // dedup above won't catch it. Instead, check if a recent AI message
  // with equivalent content exists — if so, this is just the echo of
  // the AI's own message. Link the platformMessageId to the existing
  // AI message and skip the "human took over" logic.
  //
  // IMPORTANT: compare on TRIMMED content. Meta strips trailing
  // whitespace from echoes, so a 1-char trailing-space difference
  // between our saved AI text and Meta's echo was enough to bust the
  // exact-match dedup and cause the echo to be saved as a second HUMAN
  // message (see daetradez @l.galeza 2026-04-18 16:44). Both messages
  // then rendered in the UI as separate bubbles ("AI Setter" + "Human
  // Setter") for what was really one send + its echo.
  const echoSearchWindow = new Date(Date.now() - 60000);
  const trimmedIncoming = (messageText ?? '').trim();
  const recentAIMessages = await prisma.message.findMany({
    where: {
      conversationId,
      sender: 'AI',
      timestamp: { gte: echoSearchWindow }
    },
    orderBy: { timestamp: 'desc' }
  });
  const recentAIMessage = recentAIMessages.find(
    (m) => m.content.trim() === trimmedIncoming
  );

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

  // ── Closed-loop training: detect human override of AI suggestion ──
  let isHumanOverride = false;
  let rejectedAISuggestionId: string | null = null;
  let editedFromSuggestion = false;
  let loggedDuringTrainingPhase = false;

  try {
    // Find the most recent AISuggestion in the last 2 hours that hasn't been
    // selected or rejected yet — this is the suggestion the human is overriding.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const recentSuggestion = await prisma.aISuggestion.findFirst({
      where: {
        conversationId,
        wasSelected: false,
        wasRejected: false,
        generatedAt: { gte: twoHoursAgo }
      },
      orderBy: { generatedAt: 'desc' }
    });

    if (recentSuggestion) {
      isHumanOverride = true;
      rejectedAISuggestionId = recentSuggestion.id;

      // Check training phase for snapshot
      const accountRow = await prisma.account.findUnique({
        where: { id: accountId },
        select: { trainingPhase: true, trainingOverrideCount: true }
      });
      loggedDuringTrainingPhase = accountRow?.trainingPhase === 'ONBOARDING';

      // Compute rough text similarity (word overlap / Jaccard) for
      // editedFromSuggestion. For multi-bubble suggestions, the human's
      // single message is compared against the CONCATENATED group so
      // "the human typed something covering what the AI planned to say
      // across 3 bubbles" still registers as a high-similarity override.
      // Falls back to responseText (= first bubble, or the legacy single
      // message) for flag-off personas / older suggestion rows.
      const bubblesRaw = recentSuggestion.messageBubbles;
      const comparisonSource = Array.isArray(bubblesRaw)
        ? (bubblesRaw as string[]).join(' ')
        : recentSuggestion.responseText;
      const suggestionArr = comparisonSource.toLowerCase().split(/\s+/);
      const humanArr = messageText.toLowerCase().split(/\s+/);
      const humanWordSet = new Set(humanArr);
      const intersection = suggestionArr.filter((w) =>
        humanWordSet.has(w)
      ).length;
      const allWords = new Set(suggestionArr.concat(humanArr));
      const similarity = allWords.size > 0 ? intersection / allWords.size : 0;
      editedFromSuggestion = similarity > 0.7;

      // Update the AISuggestion
      await prisma.aISuggestion.update({
        where: { id: recentSuggestion.id },
        data: {
          wasRejected: true,
          wasEdited: editedFromSuggestion,
          finalSentText: messageText,
          similarityToFinalSent: similarity
        }
      });

      // Always increment override count — phase gates the UI experience,
      // not whether we capture the signal. Previously this was gated on
      // `loggedDuringTrainingPhase`, which meant accounts that had been
      // grandfathered to ACTIVE (or manually flipped) could never rebuild
      // the counter, locking them out of Phase 1 training data forever.
      // `loggedDuringTrainingPhase` is still set on the Message so we can
      // filter downstream if we want "onboarding-only" subsets.
      await prisma.account.update({
        where: { id: accountId },
        data: { trainingOverrideCount: { increment: 1 } }
      });

      console.log(
        `[webhook-processor] Human override detected for ${conversationId}: ` +
          `suggestion=${recentSuggestion.id}, similarity=${similarity.toFixed(2)}, ` +
          `edited=${editedFromSuggestion}, onboarding=${loggedDuringTrainingPhase}`
      );
    }
  } catch (err) {
    console.error(
      '[webhook-processor] Override detection failed (non-fatal):',
      err
    );
  }

  // Save as HUMAN message (genuinely sent by a human admin)
  const message = await prisma.message.create({
    data: {
      conversationId,
      sender: 'HUMAN',
      content: messageText,
      timestamp: new Date(),
      platformMessageId: platformMessageId || null,
      isHumanOverride,
      rejectedAISuggestionId,
      editedFromSuggestion,
      loggedDuringTrainingPhase
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
// Orphan AISuggestion rescue (platform away-mode flip false→true)
// ---------------------------------------------------------------------------
// When an operator flips per-conversation `aiActive` on for a chat BEFORE
// flipping the platform-level away-mode on, the AI generation fires
// immediately (via handleAIHandoff) but the `shouldAutoSend` dual-gate
// evaluates to false (aiActive=true && awayModeFacebook=false → false).
// The generated reply gets saved as an AISuggestion row + broadcast to
// the dashboard websocket but NEVER shipped to Meta and NEVER saved as
// a Message row. Later when the operator flips the platform on, nothing
// retroactively re-fires those orphans.
//
// This rescue finds conversations where:
//   - Platform matches the one that just got turned on
//   - Conversation has aiActive=true (operator wants AI on this chat)
//   - There's a recent AISuggestion that was never selected/rejected
//   - The latest Message in the conversation is from LEAD (it's the
//     AI's turn — AI hasn't already replied in the meantime, and no
//     human has taken over)
// For each hit, re-fire scheduleAIReply. With both gates now open, the
// reply ships to Meta on this second run. Safe to call multiple times:
// once an AI Message lands in the convo, the "latest = LEAD" filter
// excludes it from subsequent rescue passes. Capped at maxConvos to
// prevent runaway when someone accumulated hundreds of orphans.
export async function rescueOrphanAISuggestions(
  accountId: string,
  platform: 'INSTAGRAM' | 'FACEBOOK',
  options?: { sinceMinutes?: number; maxConvos?: number }
): Promise<{ candidates: number; dispatched: number; skipped: number }> {
  const sinceMinutes = options?.sinceMinutes ?? 30;
  const maxConvos = options?.maxConvos ?? 50;
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000);

  // Pull one orphan AISuggestion per conversationId (most recent).
  const orphans = await prisma.aISuggestion.findMany({
    where: {
      accountId,
      generatedAt: { gte: since },
      wasSelected: false,
      wasRejected: false,
      conversation: {
        aiActive: true,
        lead: { platform }
      }
    },
    orderBy: { generatedAt: 'desc' },
    distinct: ['conversationId'],
    take: maxConvos,
    select: {
      id: true,
      conversationId: true,
      generatedAt: true,
      conversation: {
        select: {
          id: true,
          lead: { select: { id: true, name: true, accountId: true } }
        }
      }
    }
  });

  if (orphans.length === 0) {
    console.log(
      `[away-mode rescue] No orphan AISuggestions for ${platform} on account ${accountId} in last ${sinceMinutes}m`
    );
    return { candidates: 0, dispatched: 0, skipped: 0 };
  }
  console.log(
    `[away-mode rescue] Found ${orphans.length} candidate orphan(s) for ${platform} on account ${accountId}`
  );

  let dispatched = 0;
  let skipped = 0;
  for (const orphan of orphans) {
    const latestMsg = await prisma.message.findFirst({
      where: { conversationId: orphan.conversationId },
      orderBy: { timestamp: 'desc' },
      select: { sender: true, timestamp: true }
    });
    if (!latestMsg || latestMsg.sender !== 'LEAD') {
      // AI already replied, or human took over → nothing to rescue
      console.log(
        `[away-mode rescue] Skipping ${orphan.conversationId} (${orphan.conversation.lead.name}): latest msg is ${latestMsg?.sender || 'none'}, not LEAD`
      );
      skipped++;
      continue;
    }
    try {
      console.log(
        `[away-mode rescue] Re-firing scheduleAIReply for ${orphan.conversationId} (${orphan.conversation.lead.name}) — orphan generated ${Math.round((Date.now() - orphan.generatedAt.getTime()) / 1000)}s ago`
      );
      await scheduleAIReply(
        orphan.conversationId,
        orphan.conversation.lead.accountId
      );
      dispatched++;
    } catch (err) {
      console.error(
        `[away-mode rescue] Dispatch failed for ${orphan.conversationId}:`,
        err
      );
      skipped++;
    }
  }

  console.log(
    `[away-mode rescue] Done. platform=${platform} candidates=${orphans.length} dispatched=${dispatched} skipped=${skipped}`
  );
  return { candidates: orphans.length, dispatched, skipped };
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
// Helper: Update Lead Stage from Conversation Stage
// ---------------------------------------------------------------------------

async function updateLeadStageFromConversation(
  leadId: string,
  currentStage: string,
  conversationStage: string,
  subStage: string | null,
  capitalOutcome:
    | 'passed'
    | 'failed'
    | 'hedging'
    | 'ambiguous'
    | 'not_asked'
    | 'not_evaluated'
): Promise<void> {
  // Map AI conversation stages to lead stages (only upgrade, never downgrade
  // into QUALIFYING/lower — UNQUALIFIED is a separate terminal transition
  // allowed from any non-terminal).
  //
  // CRITICAL: BOOKING conversation stage caps at CALL_PROPOSED, NOT 'BOOKED'.
  // The 'BOOKED' stage must ONLY be set inside the success branch of
  // bookUnifiedAppointment() in sendAIReply (search for `lead.stage: 'BOOKED'`).
  // Setting it here would create a phantom "BOOKED" lead even when the
  // calendar booking silently failed (e.g. R14 anti-hallucination guard
  // rejected the AI's slot pick), which is exactly the bug we hit on
  // 2026-04-08 with conversation cmngzdbbu0002if04jjxlm35i.
  //
  // CRITICAL: FINANCIAL_SCREENING is "reached", NOT "passed". The default
  // mapping lands the lead at QUALIFYING, and ONLY promotes to QUALIFIED
  // when the R24 capital gate returns `capitalOutcome === 'passed'`. This
  // fixes the 2026-04-19 MercyAttah incident where a lead who stated
  // capital below threshold was shown as QUALIFIED in the sidebar badge
  // because the AI's JSON still labeled the turn's stage=FINANCIAL_SCREENING
  // while the downsell branch was being delivered.
  const stageToLeadStage: Record<string, string> = {
    // New 7-stage SOP sequence
    OPENING: 'NEW_LEAD',
    SITUATION_DISCOVERY: 'QUALIFYING',
    GOAL_EMOTIONAL_WHY: 'QUALIFYING',
    URGENCY: 'QUALIFYING',
    SOFT_PITCH_COMMITMENT: 'QUALIFIED',
    FINANCIAL_SCREENING: 'QUALIFYING', // ← was 'QUALIFIED' — only passing R24 promotes
    BOOKING: 'CALL_PROPOSED', // ← capped at CALL_PROPOSED — only real booking promotes to BOOKED
    // Legacy stage names (backward compat)
    GREETING: 'NEW_LEAD',
    QUALIFICATION: 'QUALIFYING',
    VISION_BUILDING: 'QUALIFYING',
    PAIN_IDENTIFICATION: 'QUALIFYING',
    SOLUTION_OFFER: 'QUALIFYING',
    CAPITAL_QUALIFICATION: 'QUALIFYING' // ← was 'QUALIFIED', same reasoning
  };

  // Default from the stage-name mapping, then override based on R24 /
  // downsell signals. The override wins because the conversation-stage
  // name alone can't distinguish reached vs passed vs failed.
  let newStage: string | undefined = stageToLeadStage[conversationStage];

  // Downsell branch — when the AI routes to the financial waterfall or
  // the low-ticket offer, that's an explicit disqualification regardless
  // of R24 state (R25 can detect low-capital signals EARLIER than the
  // financial stage is reached, and the AI pivots to the downsell flow
  // directly). Treat any WATERFALL_* or LOW_TICKET sub-stage as a hard
  // UNQUALIFIED signal.
  const isDownsellBranch =
    typeof subStage === 'string' &&
    (subStage.startsWith('WATERFALL_') || subStage === 'LOW_TICKET');
  if (isDownsellBranch) {
    newStage = 'UNQUALIFIED';
  } else if (capitalOutcome === 'failed') {
    // R24 gate failed — lead stated capital below threshold OR hit a
    // disqualifier phrase ("broke", "jobless", "can't afford", etc.).
    newStage = 'UNQUALIFIED';
  } else if (
    conversationStage === 'FINANCIAL_SCREENING' ||
    conversationStage === 'CAPITAL_QUALIFICATION'
  ) {
    if (capitalOutcome === 'passed') {
      // R24 gate passed — lead confirmed adequate capital, safe to mark
      // QUALIFIED. Overrides the default QUALIFYING mapping above.
      newStage = 'QUALIFIED';
    }
    // hedging / ambiguous / not_asked / not_evaluated: keep the default
    // QUALIFYING mapping — the lead reached the capital stage but
    // hasn't passed it yet. Do NOT promote to QUALIFIED.
  }

  if (!newStage) return;

  // Stage priority order. Non-terminal stages upgrade monotonically;
  // terminal side-stages (UNQUALIFIED, GHOSTED, etc.) can transition
  // from any non-terminal and then lock the lead.
  const stagePriority: Record<string, number> = {
    NEW_LEAD: 0,
    ENGAGED: 1,
    QUALIFYING: 2,
    QUALIFIED: 3,
    CALL_PROPOSED: 4,
    BOOKED: 5,
    SHOWED: 6,
    CLOSED_WON: 7,
    // Terminal/side stages — once set, don't auto-override
    CLOSED_LOST: 10,
    UNQUALIFIED: 10,
    GHOSTED: 10,
    NURTURE: 10,
    NO_SHOWED: 10,
    RESCHEDULED: 10
  };

  const currentPriority = stagePriority[currentStage] ?? 0;
  const newPriority = stagePriority[newStage] ?? 0;

  if (newPriority > currentPriority && currentPriority < 10) {
    await prisma.lead.update({
      where: { id: leadId },
      data: { stage: newStage as any }
    });
    console.log(
      `[webhook-processor] Lead ${leadId} stage: ${currentStage} → ${newStage} (conv=${conversationStage}, sub=${subStage ?? 'null'}, capital=${capitalOutcome})`
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
  const accountRow = await prisma.account.findUnique({
    where: { id: accountId },
    select: { responseDelayMin: true, responseDelayMax: true }
  });
  const minDelay = Math.max(0, accountRow?.responseDelayMin ?? 0);
  const maxDelay = Math.max(minDelay, accountRow?.responseDelayMax ?? 0);
  if (maxDelay <= 0) return 0;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}
