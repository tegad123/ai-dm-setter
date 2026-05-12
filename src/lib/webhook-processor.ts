import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
  detectRestrictedGeography,
  generateReply,
  type ConversationMessage,
  type GenerateReplyResult
} from '@/lib/ai-engine';
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
  detectMetadataLeak,
  detectTypeformFilledNoBookingContext,
  sanitizeDashCharacters,
  TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE
} from '@/lib/voice-quality-gate';
import {
  extractUrlsFromText,
  sanitizeMessageGroupUrls
} from '@/lib/url-allowlist';
import {
  appendAutoClearedStaleReviewEvent,
  AUTO_CLEARED_STALE_REVIEW_EVENT,
  type AutoClearedStaleReviewEvent,
  shouldAutoClearAwaitingHumanReview
} from '@/lib/stale-human-review';
import {
  runPostMessageScoring,
  getScoringContextForPrompt,
  runPostAIReplyScoring
} from '@/lib/scoring-integration';
import { getMessages as getInstagramMessages } from '@/lib/instagram';
import { getMessages as getFacebookMessages } from '@/lib/facebook';
import { getUnifiedAvailability } from '@/lib/calendar-adapter';
import { getCredentials } from '@/lib/credential-store';
import { isNearDuplicateOfRecentAiMessages } from '@/lib/ai-dedup';
import { transitionLeadStage } from '@/lib/lead-stage';
import {
  buildQualityGateGeneratedResult,
  isTerminalQualityGateResult,
  QualityGateEscalationError,
  QUALITY_GATE_FAILURE_REASON
} from '@/lib/quality-gate-escalation';
import {
  resolvePlatformAwayMode,
  shouldMarkEngagedFromLeadMessage,
  updateLeadStageFromConversation
} from '@/lib/stage-progression';
import {
  enqueueInboundMediaProcessing,
  extractAttachmentDurationSeconds,
  findFirstMediaAttachment,
  type InboundMediaAttachment
} from '@/lib/media-processing';
import { randomUUID } from 'crypto';

// Mirrors the same constant in manychat-handoff.ts — detect when an IGSID
// leaked through as a username/handle before any DB write.
const NUMERIC_IGSID = /^\d{12,}$/;

// ---------------------------------------------------------------------------
// Meta send helper — delivery with pmid capture + token-invalidation alert
// ---------------------------------------------------------------------------
//
// Wraps sendInstagramDM / sendFacebookMessage and returns a structured
// outcome the caller uses to decide whether to persist the Message row.
// Prevents the "ghost send" class of bug where a Message row gets saved
// before the platform ack, then the Meta send fails (dead token, rate
// limit, etc.) and the dashboard shows "AI replied" while the lead
// receives nothing.
//
// The "save AFTER ship" invariant: NEVER write a Message row for an AI
// send until Meta has returned a messageId. Callers pass the captured
// `messageId` as `platformMessageId` so the DB is always in sync with
// what was actually delivered (enables echo dedup, too).

interface ShipOutcome {
  /** Meta's returned messageId on success. null when ship failed. */
  messageId: string | null;
  /** Populated when ship failed. */
  error: Error | null;
  /**
   * True when the error indicates the Meta access token is invalidated
   * (OAuthException code=190, session-invalidated, password-changed, etc.).
   * Callers should trigger an operator-facing alert so the account owner
   * knows to reconnect Meta — one bad token silences both outbound sends
   * AND inbound webhook forwarding.
   */
  tokenInvalid: boolean;
}

/**
 * Identify Meta Graph API errors that mean the stored access token is
 * dead. Matches error code 190, subcode 460, and the "session
 * invalidated" / "changed password" wording Meta returns.
 */
function isMetaTokenError(err: unknown): boolean {
  const msg = (
    err instanceof Error ? err.message : String(err ?? '')
  ).toLowerCase();
  return (
    /\bcode[\s":]*190\b/.test(msg) ||
    /session has been invalidated/.test(msg) ||
    /subcode[\s":]*460/.test(msg) ||
    /access token.*expired/.test(msg) ||
    /access token.*invalid/.test(msg)
  );
}

function canShipToPlatformRecipient(
  platform: string,
  platformUserId: string | null | undefined
): boolean {
  if (!platformUserId) return false;
  if (platform === 'INSTAGRAM') {
    return /^\d{12,}$/.test(platformUserId.trim());
  }
  return true;
}

/**
 * Ship a text message to Meta + classify any error. Does NOT save a
 * Message row — that's the caller's responsibility, to ensure we only
 * save when Meta confirms delivery.
 */
async function shipTextToMeta(
  platform: string,
  accountId: string,
  platformUserId: string,
  text: string
): Promise<ShipOutcome> {
  try {
    if (!canShipToPlatformRecipient(platform, platformUserId)) {
      throw new Error(
        `invalid_${platform.toLowerCase()}_recipient_id:${platformUserId}`
      );
    }
    if (platform === 'INSTAGRAM') {
      const r = await sendInstagramDM(accountId, platformUserId, text);
      const messageId = r?.messageId?.trim();
      if (!messageId) {
        throw new Error('Instagram send DM succeeded without a messageId');
      }
      return {
        messageId,
        error: null,
        tokenInvalid: false
      };
    }
    if (platform === 'FACEBOOK') {
      const r = await sendFacebookMessage(accountId, platformUserId, text);
      const messageId = r?.messageId?.trim();
      if (!messageId) {
        throw new Error('Facebook send message succeeded without a messageId');
      }
      return {
        messageId,
        error: null,
        tokenInvalid: false
      };
    }
    throw new Error(`Unsupported platform for ship: ${platform}`);
  } catch (err) {
    return {
      messageId: null,
      error: err instanceof Error ? err : new Error(String(err)),
      tokenInvalid: isMetaTokenError(err)
    };
  }
}

async function shipAudioToMeta(
  platform: string,
  accountId: string,
  platformUserId: string,
  audioUrl: string
): Promise<ShipOutcome> {
  try {
    if (!canShipToPlatformRecipient(platform, platformUserId)) {
      throw new Error(
        `invalid_${platform.toLowerCase()}_recipient_id:${platformUserId}`
      );
    }
    if (platform === 'INSTAGRAM') {
      const { sendAudioDM } = await import('@/lib/instagram');
      const r = await sendAudioDM(accountId, platformUserId, audioUrl);
      const messageId = r?.messageId?.trim();
      if (!messageId) {
        throw new Error(
          'Instagram send audio DM succeeded without a messageId'
        );
      }
      return {
        messageId,
        error: null,
        tokenInvalid: false
      };
    }
    if (platform === 'FACEBOOK') {
      const { sendAudioMessage } = await import('@/lib/facebook');
      const r = await sendAudioMessage(accountId, platformUserId, audioUrl);
      const messageId = r?.messageId?.trim();
      if (!messageId) {
        throw new Error(
          'Facebook send audio message succeeded without a messageId'
        );
      }
      return {
        messageId,
        error: null,
        tokenInvalid: false
      };
    }
    throw new Error(`Unsupported platform for audio ship: ${platform}`);
  } catch (err) {
    return {
      messageId: null,
      error: err instanceof Error ? err : new Error(String(err)),
      tokenInvalid: isMetaTokenError(err)
    };
  }
}

/**
 * Fire a throttled operator notification when the Meta token is dead.
 * Rate-limited to at most one notification per account per hour so a
 * burst of failed sends doesn't spam the operator's inbox with N
 * identical "Meta credential invalidated" messages.
 */
async function alertMetaTokenInvalidated(params: {
  accountId: string;
  leadId: string;
  platform: string;
  errorDetail: string;
}): Promise<void> {
  const { accountId, leadId, platform, errorDetail } = params;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const existing = await prisma.notification
    .findFirst({
      where: {
        accountId,
        type: 'SYSTEM',
        title: { contains: 'Meta credential invalidated' },
        createdAt: { gte: oneHourAgo }
      },
      select: { id: true }
    })
    .catch(() => null);
  if (existing) return;

  try {
    await prisma.notification.create({
      data: {
        accountId,
        type: 'SYSTEM',
        title: 'Meta credential invalidated — reconnect required',
        body: `Your Meta access token is no longer valid. AI replies on ${platform} are NOT being delivered and new inbound DMs may not reach the app until you reconnect via Settings → Integrations. Graph error: ${errorDetail.slice(0, 300)}`,
        leadId
      }
    });
    broadcastNotification(accountId, {
      type: 'SYSTEM',
      title: 'Meta credential invalidated — reconnect required'
    });
  } catch (err) {
    console.error(
      '[webhook-processor] Failed to create token-invalidated notification:',
      err
    );
  }
}

async function escalateQualityGateFailure(params: {
  conversationId: string;
  accountId: string;
  lead: {
    id: string;
    name: string;
    handle: string;
    accountId: string;
  };
  result: GenerateReplyResult;
  latestLeadTimestamp?: Date | null;
}): Promise<void> {
  const { conversationId, accountId, lead, result, latestLeadTimestamp } =
    params;
  const hardFails = result.qualityGateHardFails ?? [];
  const generatedText = (
    Array.isArray(result.messages) && result.messages.length > 0
      ? result.messages
      : [result.reply]
  )
    .filter((message): message is string => typeof message === 'string')
    .join('\n')
    .slice(0, 1200);

  if (result.suggestionId) {
    await prisma.aISuggestion
      .update({
        where: { id: result.suggestionId },
        data: { wasRejected: true, finalSentText: null }
      })
      .catch((err) =>
        console.error(
          '[webhook-processor] quality-gate suggestion mark rejected failed:',
          err
        )
      );
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      aiActive: true,
      autoSendOverride: true,
      awaitingHumanReview: true,
      awaitingAiResponse: true,
      awaitingSince: latestLeadTimestamp ?? new Date(),
      lastSilentStopAt: new Date()
    }
  });
  await prisma.scheduledReply
    .updateMany({
      where: { conversationId, status: 'PENDING' },
      data: { status: 'CANCELLED' }
    })
    .catch((err) =>
      console.error(
        '[webhook-processor] quality-gate pending reply cancel failed:',
        err
      )
    );

  try {
    const { escalate } = await import('@/lib/escalation-dispatch');
    const origin = process.env.NEXT_PUBLIC_APP_URL || '';
    const link = origin
      ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
      : undefined;
    await escalate({
      type: 'ai_stuck',
      accountId,
      leadId: lead.id,
      conversationId,
      leadName: lead.name,
      leadHandle: lead.handle,
      title: 'AI generation failed quality gate — manual response required',
      body:
        `${lead.name} (@${lead.handle}): ${QUALITY_GATE_FAILURE_REASON}. ` +
        `No AI message was delivered and the scheduled reply was escalated for manual handling.\n\n` +
        `Hard fails: ${hardFails.length ? hardFails.join(', ') : 'unknown'}\n\n` +
        `Generated draft:\n${generatedText || '(draft unavailable)'}`,
      details: hardFails.length
        ? hardFails.join(', ')
        : QUALITY_GATE_FAILURE_REASON,
      link
    });
  } catch (err) {
    console.error(
      '[webhook-processor] quality-gate escalation notification failed:',
      err
    );
  }
}

async function notifyDeliveryFailure(params: {
  accountId: string;
  leadId: string;
  platform: string;
  platformUserId: string | null;
  ship: ShipOutcome;
  title?: string;
  bodyPrefix?: string;
}): Promise<Error> {
  const {
    accountId,
    leadId,
    platform,
    platformUserId,
    ship,
    title = 'Message delivery failed',
    bodyPrefix = 'AI reply'
  } = params;
  const error = ship.error ?? new Error('Unknown delivery error');
  const errorMessage = error.message || String(error);

  console.error(
    `[webhook-processor] Failed to deliver to ${platform} after retries:`,
    error
  );

  if (ship.tokenInvalid) {
    await alertMetaTokenInvalidated({
      accountId,
      leadId,
      platform,
      errorDetail: errorMessage
    });
  } else {
    try {
      await prisma.notification.create({
        data: {
          accountId,
          type: 'SYSTEM',
          title,
          body: `${bodyPrefix} to ${platformUserId ?? 'unknown recipient'} on ${platform} failed to send: ${errorMessage.slice(0, 200)}`,
          leadId
        }
      });
      broadcastNotification(accountId, { type: 'SYSTEM', title });
    } catch (notifyErr) {
      console.error(
        '[webhook-processor] Failed to create failure notification:',
        notifyErr
      );
    }
  }

  return error;
}

async function notifyAndThrowDeliveryFailure(
  params: Parameters<typeof notifyDeliveryFailure>[0]
): Promise<never> {
  throw await notifyDeliveryFailure(params);
}

// ---------------------------------------------------------------------------
// URL hallucination guard
// ---------------------------------------------------------------------------

/**
 * Build the set of URLs the AI is allowed to send for a given account.
 * Pulls from active script records AND active persona config. Both are
 * operator-controlled — ScriptAction/ScriptSlot rows for the script-driven
 * flow, and persona.{freeValueLink, downsellConfig.link, promptConfig.*} for
 * accounts that configure URLs at the persona level (smoke tests + any
 * account that hasn't migrated to ScriptAction rows).
 *
 * Anything NOT in this set is considered hallucinated and will be stripped
 * from the AI's reply before delivery.
 */
async function getAllowedUrls(accountId: string): Promise<Set<string>> {
  const allowed = new Set<string>();
  const addUrl = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (trimmed && /^https?:\/\//i.test(trimmed)) {
      allowed.add(trimmed);
    }
  };
  const readJsonString = (
    value: Prisma.JsonValue | null | undefined,
    key: string
  ): string | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw : null;
  };
  const addPromptAssetUrls = (value: Prisma.JsonValue | null | undefined) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const assets = (value as Record<string, unknown>).assetLinks;
    if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return;
    const assetRecord = assets as Record<string, unknown>;
    addUrl(assetRecord.bookingLink);
    addUrl(assetRecord.freeValueLink);
    const videoLinks = assetRecord.videoLinks;
    if (Array.isArray(videoLinks)) {
      for (const video of videoLinks) {
        if (typeof video === 'string') addUrl(video);
        if (video && typeof video === 'object' && !Array.isArray(video)) {
          addUrl((video as Record<string, unknown>).url);
        }
      }
    }
  };

  try {
    const activeScript = await prisma.script.findFirst({
      where: { accountId, isActive: true },
      select: { id: true }
    });
    const hasActiveRelationalScript = !!activeScript;

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
      addUrl(slot.url);
    }

    // Sprint 3 Revised: Add URLs from active Script template actions.
    // Include explicit [LINK]/[VIDEO] rows and literal URLs authored
    // inside [MSG]/[ASK] content so ship-time sanitization does not strip
    // operator-written links that are not modeled as send_link actions.
    const scriptUrlActions = await prisma.scriptAction.findMany({
      where: {
        step: { script: { accountId, isActive: true } },
        OR: [
          { linkUrl: { not: null } },
          { content: { contains: 'http', mode: 'insensitive' } },
          { content: { contains: 'www.', mode: 'insensitive' } }
        ]
      },
      select: { linkUrl: true, content: true }
    });
    for (const action of scriptUrlActions) {
      addUrl(action.linkUrl);
      for (const url of extractUrlsFromText(action.content)) {
        addUrl(url);
      }
    }

    // Persona-level URLs. Operators configure downsell / booking / free-value
    // links directly on AIPersona (no ScriptAction row required) — without
    // this branch the sanitizer strips every persona-driven artifact link to
    // "[link removed]". Smoke test SMOKE 05 (artifact-delivered-with-url) and
    // any production account that hasn't created ScriptAction rows depend on
    // this path.
    const personas = await prisma.aIPersona.findMany({
      where: { accountId, isActive: true },
      select: {
        freeValueLink: true,
        downsellConfig: true,
        promptConfig: true
      }
    });
    for (const persona of personas) {
      addUrl(persona.freeValueLink);
      addUrl(readJsonString(persona.downsellConfig, 'link'));
      addUrl(readJsonString(persona.promptConfig, 'downsellLink'));
      addUrl(readJsonString(persona.promptConfig, 'youtubeFallbackUrl'));
      addUrl(readJsonString(persona.promptConfig, 'freeValueLink'));
      if (!hasActiveRelationalScript) {
        addUrl(readJsonString(persona.promptConfig, 'bookingTypeformUrl'));
        addUrl(readJsonString(persona.promptConfig, 'typeformUrl'));
        addPromptAssetUrls(persona.promptConfig);
      }
    }
  } catch (err) {
    console.error('[webhook-processor] getAllowedUrls failed:', err);
  }
  return allowed;
}

function sanitizeAIResultDashes(
  result: { reply: string; messages?: string[] },
  context: string
): void {
  const beforeReply = result.reply;
  const beforeMessages = Array.isArray(result.messages)
    ? [...result.messages]
    : null;

  result.reply = sanitizeDashCharacters(result.reply);
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map((message) =>
      sanitizeDashCharacters(message)
    );
  }

  const changedReply = result.reply !== beforeReply;
  const changedMessages =
    beforeMessages !== null &&
    result.messages?.some(
      (message, index) => message !== beforeMessages[index]
    );

  if (changedReply || changedMessages) {
    console.warn(
      `[webhook-processor] R17 violation for ${context}: AI used em/en-dashes — sanitized before delivery.`
    );
  }
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
  attachments?: IncomingMessageAttachment[];
  triggerType: 'DM' | 'COMMENT';
  triggerSource?: string;
  platformMessageId?: string; // Meta's event.message.mid for dedup
}

export interface IncomingMessageAttachment extends InboundMediaAttachment {}

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

function extractFirstImageUrl(
  attachments?: IncomingMessageAttachment[]
): string | null {
  return findFirstMediaAttachment(attachments, 'image')?.url ?? null;
}

// Extract the first audio attachment URL (voice note from IG/FB
// messenger). Webhooks deliver these alongside text in the same
// `attachments` array. Without this helper the inbound filter
// silently dropped voice-note-only messages, and operator voice
// notes echoed by Meta were never tagged as HUMAN sends.
function extractFirstAudioUrl(
  attachments?: IncomingMessageAttachment[]
): string | null {
  return findFirstMediaAttachment(attachments, 'audio')?.url ?? null;
}

const LEAD_EMAIL_PATTERN = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;

export const RESCHEDULE_PATTERNS: RegExp[] = [
  /reschedule/i,
  /mix.?up/i,
  /wasn.t prepared/i,
  /missed the call/i,
  /another time/i,
  /another day/i,
  /can we do.*(sunday|monday|tomorrow|later)/i
];

export function isRescheduleSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  return RESCHEDULE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Send-decision policy. Auto-send fires when aiActive=true AND either:
 *   (a) account-level away-mode is ON for the lead's platform, OR
 *   (b) operator explicitly enabled per-conversation override
 *       (autoSendOverride=true, set by the ai-toggle route)
 *
 * Why awayMode is back: Conversation.aiActive @default(true) in the
 * schema means every row starts with aiActive=true. A pure aiActive
 * gate would fire on every lead on every account regardless of whether
 * the operator enabled AI. The awayMode || autoSendOverride term is
 * the account/intent check that scopes auto-send to accounts where
 * the operator turned it on, plus any conversations where they
 * explicitly overrode it per-conversation.
 */
export function shouldAutoSendReply(args: {
  aiActive: boolean;
  awayMode: boolean;
  autoSendOverride: boolean;
}): boolean {
  return args.aiActive && (args.awayMode || args.autoSendOverride);
}

export type GenerateReplyHistoryRow = {
  id: string;
  sender: string;
  content: string;
  timestamp: Date | string;
  isVoiceNote?: boolean | null;
  voiceNoteUrl?: string | null;
  imageUrl?: string | null;
  hasImage?: boolean | null;
  mediaType?: string | null;
  mediaUrl?: string | null;
  transcription?: string | null;
  imageMetadata?: Prisma.JsonValue | null;
  mediaProcessedAt?: Date | string | null;
  mediaProcessingError?: string | null;
  mediaCostUsd?: Prisma.Decimal | number | string | null;
  messageGroupId?: string | null;
  bubbleIndex?: number | null;
  bubbleTotalCount?: number | null;
  suggestionId?: string | null;
  isHumanCorrection?: boolean | null;
};

export function formatMessagesForGenerateReply(
  messages: GenerateReplyHistoryRow[]
): ConversationMessage[] {
  return messages.map((m) => ({
    id: m.id,
    sender: m.sender,
    content: m.content,
    timestamp: m.timestamp,
    isVoiceNote: m.isVoiceNote ?? undefined,
    voiceNoteUrl: m.voiceNoteUrl,
    imageUrl: m.imageUrl,
    hasImage: m.hasImage ?? undefined,
    mediaType: m.mediaType,
    mediaUrl: m.mediaUrl,
    transcription: m.transcription,
    imageMetadata: m.imageMetadata,
    mediaProcessedAt: m.mediaProcessedAt,
    mediaProcessingError: m.mediaProcessingError,
    mediaCostUsd: m.mediaCostUsd,
    messageGroupId: m.messageGroupId,
    bubbleIndex: m.bubbleIndex,
    bubbleTotalCount: m.bubbleTotalCount,
    suggestionId: m.suggestionId,
    // Carry through to ai-engine so the [Operator correction]
    // directive fires when the most recent setter message is a
    // post-unsend manual reply.
    isHumanCorrection: m.isHumanCorrection ?? undefined
  }));
}

export function suggestionIdForDeliveredBubble(
  suggestionId: string | null | undefined
): string | null {
  return suggestionId || null;
}

function extractLeadEmail(text: string): string | null {
  const match = text.match(LEAD_EMAIL_PATTERN);
  return match ? match[0].toLowerCase() : null;
}

function extensionFromContentType(contentType: string): string {
  const normalized = contentType.toLowerCase().split(';')[0]?.trim();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  return 'jpg';
}

async function persistInboundImageUrl(params: {
  accountId: string;
  imageUrl: string;
  platformMessageId?: string;
}): Promise<string> {
  const { accountId, imageUrl, platformMessageId } = params;
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(
        `Meta image download failed: ${response.status} ${response.statusText}`
      );
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const extension = extensionFromContentType(contentType);
    const buffer = Buffer.from(await response.arrayBuffer());
    const { put } = await import('@vercel/blob');
    const safeObjectName = (platformMessageId || randomUUID()).replace(
      /[^a-zA-Z0-9._-]/g,
      '-'
    );
    const blob = await put(
      `lead-images/${accountId}/${safeObjectName}.${extension}`,
      buffer,
      {
        access: 'public',
        contentType
      }
    );
    return blob.url;
  } catch (err) {
    // Sprint 7: make permanent storage mandatory for all inbound images.
    // Meta CDN attachment URLs typically expire after about an hour; this
    // fallback keeps the turn processable even when Blob/network access is
    // unavailable, but old conversation images may stop rendering.
    console.warn(
      '[webhook-processor] Failed to persist inbound image; falling back to expiring Meta CDN URL:',
      err
    );
    return imageUrl;
  }
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
    messageText: rawMessageText,
    attachments = [],
    triggerType,
    triggerSource
  } = params;
  const inboundImageAttachment = findFirstMediaAttachment(attachments, 'image');
  const inboundAudioAttachment = findFirstMediaAttachment(attachments, 'audio');
  const inboundImageUrl = inboundImageAttachment?.url ?? null;
  const inboundAudioUrl = inboundAudioAttachment?.url ?? null;
  const inboundMediaType = inboundAudioUrl
    ? 'audio'
    : inboundImageUrl
      ? 'image'
      : null;
  // Voice notes (FAILURE B 2026-05-02): when the lead sends an
  // audio attachment with no text, we used to drop the message at
  // the webhook layer. Accept it here and use a placeholder content
  // string so downstream save / broadcast / AI generation see SOMETHING
  // (the AI's prompt path uses a voice_note_received directive to
  // ensure the reply asks the lead to type it out instead of
  // hallucinating what was said).
  const messageText =
    rawMessageText?.trim() ||
    (inboundAudioUrl ? '[Voice note]' : inboundImageUrl ? '[Image]' : '');
  const detectedEmail = extractLeadEmail(messageText);

  console.log(
    `[webhook-processor] Processing ${platform} ${triggerType} from ${senderHandle}: "${messageText.slice(0, 80)}"`
  );

  // Guard: Meta sometimes delivers the raw IGSID as both sender name and
  // handle when its user-lookup side-channel fails. Resolve before any DB
  // write so we never persist a 15-digit number as Lead.handle / Lead.name.
  let resolvedHandle = senderHandle;
  let resolvedName = senderName;
  if (platform === 'INSTAGRAM' && NUMERIC_IGSID.test(senderHandle)) {
    console.warn(
      `[webhook-processor] numeric senderHandle "${senderHandle}" received — IG username resolution failed upstream. Attempting getUserProfile for ${platformUserId}.`
    );
    try {
      const { getUserProfile } = await import('@/lib/instagram');
      const profile = await getUserProfile(accountId, platformUserId);
      if (profile?.username) {
        resolvedHandle = profile.username;
        resolvedName = profile.name || profile.username;
        console.log(
          `[webhook-processor] resolved @${resolvedHandle} from getUserProfile (was "${senderHandle}")`
        );
      } else {
        console.warn(
          `[webhook-processor] getUserProfile returned no username for ${platformUserId} — persisting numeric handle as fallback`
        );
      }
    } catch (err) {
      console.warn(
        '[webhook-processor] getUserProfile failed (non-fatal):',
        err
      );
    }
  }

  // ── Step 1: Find or create the lead ────────────────────────────
  // Match priority:
  //   1. platformUserId — the IG/FB numeric ID. Stable, unique per
  //      person on the platform. Always the first attempt.
  //   2. handle (case-insensitive) — fallback to recover leads created
  //      by upstream paths that didn't have the numeric ID at the time.
  //      Specifically: ManyChat handoff (manychat-handoff.ts) stores
  //      the IG handle as platformUserId because ManyChat's Make
  //      External Request variable picker doesn't expose the IG numeric
  //      user ID. When the same lead later DMs back, IG sends the
  //      numeric ID — that won't match step 1, but step 2 by handle
  //      catches it. We then upgrade the lead's platformUserId to the
  //      numeric ID so future webhooks hit step 1 directly.
  //
  // Without this fallback, every ManyChat-handoff'd lead splits into
  // two duplicate Lead rows the moment they reply: one with the
  // ManyChat opener + outbound_context (handle-as-platformUserId), and
  // a fresh orphan with the inbound message (numeric platformUserId).
  // Operator sees the orphan in the dashboard, opener appears nowhere.
  let lead = await prisma.lead.findFirst({
    where: { accountId, platformUserId, platform },
    include: { conversation: true }
  });

  if (!lead && senderHandle) {
    const byHandle = await prisma.lead.findFirst({
      where: {
        accountId,
        platform,
        handle: { equals: senderHandle, mode: 'insensitive' }
      },
      include: { conversation: true }
    });
    if (byHandle) {
      // Upgrade the lead's platformUserId to the proper numeric ID so
      // subsequent webhooks match by ID directly (faster, deterministic).
      // Only overwrite when the existing value isn't already the numeric
      // ID — avoids needless writes on repeat webhooks.
      if (byHandle.platformUserId !== platformUserId) {
        await prisma.lead.update({
          where: { id: byHandle.id },
          data: { platformUserId }
        });
        console.log(
          `[webhook-processor] Recovered ManyChat-handoff'd lead by handle @${senderHandle} ` +
            `— upgraded platformUserId from "${byHandle.platformUserId}" to "${platformUserId}"`
        );
      }
      lead = byHandle;
    }
  }

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
      select: {
        awayMode: true,
        awayModeInstagram: true,
        awayModeFacebook: true
      }
    });
    const awayModeForPlatform = resolvePlatformAwayMode(account, platform);
    const shouldEnableAI = isOngoing ? false : awayModeForPlatform;

    // ── ManyChat handoff detection + recovery (2026-04-30, expanded 2026-05-06) ──
    // For Instagram leads on accounts that have a ManyChat
    // integration active, look up the subscriber. If found within the
    // recency window, mark the conversation source MANYCHAT so the
    // AI suppresses its own opener and prepends an outbound_context
    // block. Additionally use the subscriber's `ig_username` and
    // `name` to recover proper handle / display name when our local
    // resolution returned a numeric IGSID (Meta API down, or upstream
    // never resolved). This catches every lead where ManyChat's
    // External Request action failed to fire (e.g. button-gated flow
    // that the lead bypassed by replying with text). Fail-closed:
    // any error → INBOUND with whatever resolution we already have.
    let initialSource: 'INBOUND' | 'MANYCHAT' = 'INBOUND';
    // Use the resolved handle (post-getUserProfile) — ManyChat's
    // findByInstagramUsername 404s on numeric IGSIDs, so calling with
    // an unresolved handle is wasted RTT.
    const lookupHandle = resolvedHandle || senderHandle;
    if (
      platform === 'INSTAGRAM' &&
      lookupHandle &&
      !NUMERIC_IGSID.test(lookupHandle)
    ) {
      try {
        const { getCredentials } = await import('@/lib/credential-store');
        const creds = await getCredentials(accountId, 'MANYCHAT');
        if (creds?.apiKey && typeof creds.apiKey === 'string') {
          const { findSubscriberByInstagramUsername } = await import(
            '@/lib/manychat'
          );
          // Tighten ManyChat-handoff detection to a 10-minute recency
          // window. The default 7-day window in the helper was tagging
          // any prior-campaign subscriber as MANYCHAT — including leads
          // who were in the subscriber list from months ago and are
          // now sending a fresh direct DM. A real ManyChat → IG
          // handoff completes in seconds-to-minutes; 10 minutes is a
          // generous upper bound. Anything older is a stale subscriber
          // and the current DM is INBOUND, not a ManyChat-fired event.
          // (Bug-fix 2026-05-10 — Stella @atstellagram + Step 1 branch
          // misrouting / "Outbound" tag on direct DMs.)
          const sub = await findSubscriberByInstagramUsername(
            creds.apiKey,
            lookupHandle,
            { windowMinutes: 10 }
          );
          if (sub) {
            initialSource = 'MANYCHAT';
            // Recover handle/name from ManyChat when our resolution is
            // still numeric or empty. ManyChat tracks subscribers with
            // ig_username + name as soon as their automation triggers,
            // so this fills the gap when Meta's user-lookup side-channel
            // failed upstream.
            if (sub.ig_username && NUMERIC_IGSID.test(resolvedHandle)) {
              resolvedHandle = sub.ig_username.replace(/^@+/, '').trim();
              console.log(
                `[webhook-processor] recovered @${resolvedHandle} via ManyChat subscriber lookup (was "${senderHandle}")`
              );
            }
            const mcName =
              sub.name ||
              [sub.first_name, sub.last_name].filter(Boolean).join(' ').trim();
            if (mcName && /^\d+$/.test(resolvedName)) {
              resolvedName = mcName;
              console.log(
                `[webhook-processor] recovered name "${mcName}" via ManyChat subscriber lookup`
              );
            }
            console.log(
              `[webhook-processor] ManyChat handoff detected for new lead @${resolvedHandle} on account ${accountId}`
            );
          }
        }
      } catch (mcErr) {
        console.warn(
          '[webhook-processor] ManyChat handoff detection threw (non-fatal, falling back to INBOUND):',
          mcErr
        );
      }
    }

    // Create new lead + conversation. personaId resolution via the
    // transitional helper preserves current behavior (account's active
    // persona) — Phase 3 will replace this with the persona the inbound
    // webhook event was actually sent to.
    const { resolveActivePersonaIdForCreate } = await import(
      '@/lib/active-persona'
    );
    const newConversationPersonaId =
      await resolveActivePersonaIdForCreate(accountId);
    lead = await prisma.lead.create({
      data: {
        accountId,
        name: resolvedName,
        handle: resolvedHandle,
        platform,
        platformUserId,
        triggerType,
        triggerSource: triggerSource || null,
        email: detectedEmail,
        stage: 'NEW_LEAD',
        conversation: {
          create: {
            personaId: newConversationPersonaId,
            // POLICY (2026-05-06): new conversations are created with
            // AI OFF. Operator must explicitly toggle AI on. This
            // overrides the legacy awayMode-based default. Going
            // forward awayMode no longer auto-enables AI on new
            // inbound leads — same applies to ongoing-conversation
            // detection (the old `shouldEnableAI` ternary is gone).
            aiActive: false,
            unreadCount: 1,
            leadEmail: detectedEmail,
            source: initialSource,
            // Mirror to leadSource so existing analytics that read
            // OUTBOUND vs INBOUND continue to work.
            leadSource: initialSource === 'MANYCHAT' ? 'OUTBOUND' : 'INBOUND'
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
      data: { name: resolvedName, handle: resolvedHandle }
    });
    console.log(
      `[webhook-processor] Updated lead name: ${lead.name} → ${resolvedName} (@${resolvedHandle})`
    );
  }

  const conversationId = lead.conversation!.id;
  // F3.2: scope by Conversation.personaId (Phase 1 schema field)
  // instead of guessing the active persona by accountId. This is the
  // exact persona generateReply will run against, so the media-
  // transcription flag matches what the AI will actually consume.
  const mediaPersona = inboundMediaType
    ? await prisma.aIPersona.findUnique({
        where: { id: lead.conversation!.personaId },
        select: { id: true, mediaTranscriptionEnabled: true }
      })
    : null;
  const shouldProcessInboundMedia =
    Boolean(mediaPersona?.mediaTranscriptionEnabled) &&
    inboundMediaType !== null;

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
        // Script-state machine reset (added 2026-05-08). Without these,
        // the conversation re-entered with stale systemStage/script-step
        // and the AI skipped early stages on the "fresh" lead. Mirrors
        // the script-state fields populated by prepareScriptState +
        // ai-engine retry loop.
        systemStage: null,
        currentScriptStep: 1,
        capturedDataPoints: {},
        awaitingAiResponse: false,
        awaitingHumanReview: false,
        awaitingSince: null,
        silentStopCount: 0,
        stageMismatchCount: 0,
        llmEmittedStage: null,
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
        bookingUrl: null,
        typeformFilledNoBooking: false,
        typeformFilledNoBookingAt: null,
        typeformFilledNoBookingMessageId: null
      }
    });
    // Stage transition goes through the sanctioned helper so the
    // reset produces an audit row (+ SSE broadcast). The remaining
    // non-stage fields are cleared in a separate update.
    if (lead.stage !== 'NEW_LEAD') {
      await transitionLeadStage(
        lead.id,
        'NEW_LEAD',
        'system',
        'clear conversation reset command'
      );
    }
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        qualityScore: 0,
        bookedAt: null,
        showedUp: false,
        closedAt: null,
        revenue: null,
        experience: null,
        incomeLevel: null,
        geography: null,
        email: null
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
  const persistedImageUrl = inboundImageUrl
    ? shouldProcessInboundMedia
      ? inboundImageUrl
      : await persistInboundImageUrl({
          accountId,
          imageUrl: inboundImageUrl,
          platformMessageId: params.platformMessageId
        })
    : null;
  const priorLeadMessageCount = await prisma.message.count({
    where: { conversationId, sender: 'LEAD' }
  });
  let message;
  try {
    message = await prisma.message.create({
      data: {
        conversationId,
        sender: 'LEAD',
        content: messageText,
        imageUrl: persistedImageUrl,
        hasImage: Boolean(persistedImageUrl),
        mediaType: inboundMediaType,
        mediaUrl: shouldProcessInboundMedia ? null : persistedImageUrl,
        // Voice note (FAILURE B 2026-05-02): persist the Meta CDN URL
        // so a future transcription job can read it. isVoiceNote
        // drives the dashboard 🎙️ indicator + the ai-prompt
        // voice_note_received directive.
        isVoiceNote: Boolean(inboundAudioUrl),
        voiceNoteUrl: inboundAudioUrl,
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

  // Media processing must complete before any downstream AI generation sees
  // the turn. The webhook has already persisted the Message row so the media
  // worker can store under {personaId}/{conversationId}/{messageId}.{ext};
  // after it returns, re-read the row so broadcasts and generateReply()
  // receive the transcription / OCR metadata.
  if (shouldProcessInboundMedia && mediaPersona && inboundMediaType) {
    const sourceUrl = inboundAudioUrl || inboundImageUrl;
    if (sourceUrl) {
      const durationSeconds =
        inboundMediaType === 'audio'
          ? extractAttachmentDurationSeconds(inboundAudioAttachment?.attachment)
          : null;
      await enqueueInboundMediaProcessing({
        accountId,
        personaId: mediaPersona.id,
        conversationId,
        messageId: message.id,
        mediaType: inboundMediaType,
        sourceUrl,
        durationSeconds
      });
      const processedMessage = await prisma.message.findUnique({
        where: { id: message.id }
      });
      if (processedMessage) {
        message = processedMessage;
      }
    }
  }

  if (shouldMarkEngagedFromLeadMessage(lead.stage, priorLeadMessageCount)) {
    try {
      await transitionLeadStage(
        lead.id,
        'ENGAGED',
        'lead',
        'lead replied after prior lead message'
      );
      lead.stage = 'ENGAGED';
    } catch (err) {
      console.error('[webhook-processor] ENGAGED transition failed:', err);
    }
  }

  // ── Step 3: Update conversation metadata ───────────────────────
  if (detectedEmail && lead.email !== detectedEmail) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { email: detectedEmail }
    });
  }

  // Persist geography restrictions when the lead states a location or
  // timezone that makes funding-partner routes unavailable. There is no
  // dedicated fundingPartnerEligible column today; downstream eligibility
  // is derived from Lead.geography via detectRestrictedGeography().
  const inboundGeo = detectRestrictedGeography(lead.geography, [messageText]);
  if (inboundGeo.restricted && inboundGeo.country) {
    const normalizedGeo = inboundGeo.country;
    if (lead.geography !== normalizedGeo) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { geography: normalizedGeo }
      });
      lead = {
        ...lead,
        geography: normalizedGeo
      };
      console.log(
        `[webhook-processor] Restricted geography detected for lead ${lead.id}: ${normalizedGeo} — funding partner branch disabled`
      );
    }
  }

  const autoClearAwaitingHumanReview = shouldAutoClearAwaitingHumanReview({
    awaitingHumanReview: lead.conversation!.awaitingHumanReview,
    aiActive: lead.conversation!.aiActive,
    distressDetected: lead.conversation!.distressDetected
  });
  const awaitingHumanReviewAfterInbound =
    lead.conversation!.awaitingHumanReview && !autoClearAwaitingHumanReview;
  const shouldAwaitAiResponse =
    lead.conversation!.aiActive && !awaitingHumanReviewAfterInbound;
  const autoClearEvent = autoClearAwaitingHumanReview
    ? ({
        eventType: AUTO_CLEARED_STALE_REVIEW_EVENT,
        conversationId,
        leadMessageId: message.id,
        leadMessagePreview: messageText.slice(0, 160),
        clearedAt: now.toISOString(),
        reason:
          'Lead sent a new message while AI was active and the conversation was awaiting human review.'
      } satisfies AutoClearedStaleReviewEvent)
    : null;

  if (autoClearEvent) {
    console.warn('[webhook-processor] auto-cleared stale human review:', {
      conversationId,
      leadId: lead.id,
      messageId: message.id
    });
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: now,
      unreadCount: { increment: 1 },
      awaitingHumanReview: autoClearEvent ? false : undefined,
      awaitingAiResponse: shouldAwaitAiResponse,
      awaitingSince: shouldAwaitAiResponse ? now : null,
      capturedDataPoints: autoClearEvent
        ? appendAutoClearedStaleReviewEvent(
            lead.conversation!.capturedDataPoints,
            autoClearEvent
          )
        : undefined,
      ...(detectedEmail ? { leadEmail: detectedEmail } : {})
    }
  });

  if (autoClearEvent) {
    try {
      const title = 'AI review auto-cleared after lead reply';
      await prisma.notification.create({
        data: {
          accountId,
          type: 'SYSTEM',
          title,
          body:
            `${resolvedName} (@${resolvedHandle}) replied while this conversation was awaiting human review. ` +
            'QualifyDMs cleared the stale review flag and resumed AI scheduling.',
          leadId: lead.id
        }
      });
      broadcastNotification(accountId, { type: 'SYSTEM', title });
    } catch (notifyErr) {
      console.error(
        '[webhook-processor] stale review auto-clear notification failed:',
        notifyErr
      );
    }
  }

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
            awaitingAiResponse: false,
            awaitingSince: null,
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
        // Escalate via unified dispatcher: writes the in-app SYSTEM
        // notification AND sends the URGENT email when the operator
        // has notifyOnDistress=true (default ON). 2026-04-30 — was
        // notif-only previously, which meant operators only saw
        // distress alerts when they happened to refresh the
        // dashboard. Email is the right channel for safety alerts.
        try {
          const { escalate } = await import('@/lib/escalation-dispatch');
          const origin = process.env.NEXT_PUBLIC_APP_URL || '';
          const link = origin
            ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
            : undefined;
          await escalate({
            type: 'distress',
            accountId,
            leadId: lead.id,
            conversationId,
            leadName: senderName,
            leadHandle: senderHandle,
            title: 'URGENT — distress signal detected, review immediately',
            body: `${senderName} (@${senderHandle}): the lead's latest message matched a crisis / distress pattern ("${distress.match}"). AI has been paused on this conversation. Please review and respond personally.`,
            details: `Match: "${distress.match}"`,
            link
          });
        } catch (notifErr) {
          console.error(
            '[webhook-processor] Distress escalation dispatch failed (non-fatal):',
            notifErr
          );
        }
        // Broadcast the inbound lead message (so operator sees context
        // before the supportive response arrives). Normal broadcast
        // happens later in Step 6 but we haven't gotten there — do it
        // here explicitly.
        broadcastNewMessage(accountId, {
          id: message.id,
          conversationId,
          sender: 'LEAD',
          content: messageText,
          imageUrl: message.imageUrl,
          hasImage: message.hasImage,
          timestamp: now.toISOString()
        });
        broadcastConversationUpdate(accountId, {
          id: conversationId,
          leadId: lead.id,
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
          broadcastNewMessage(accountId, {
            id: supportiveMsg.id,
            conversationId,
            sender: 'AI',
            content: supportiveText,
            timestamp: supportiveMsg.timestamp.toISOString()
          });
          broadcastAIStatusChange(accountId, {
            conversationId
          });
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

  // ── Step 3c: Cold-pitch / agency-spam detection ────────────────
  // Omar 2026-04-25: textbook SMMA cold pitch ("helped a coach go from
  // 800 to 55K followers ... want me to send it over?") landed on a
  // brand-new lead row and the AI engaged with it. Detect the most
  // common pitch shapes BEFORE any AI generation fires. Only checks
  // first-contact messages — once the conversation has any prior
  // history, a casual "I run an agency too" is fine and shouldn't
  // be silenced.
  //
  // When matched:
  //   • outcome → SPAM (the conversation is closed in a dedicated
  //     bucket; SPAM is excluded from leads-today + the default
  //     conversations list)
  //   • apply 'cold-pitch' tag so ops can review the bucket if they
  //     want to find a missed real lead
  //   • DO NOT set aiActive=false — per spec, just skip this turn.
  //     If the operator wants to manually engage, the dashboard
  //     toggle is one click.
  //   • return early with skipReply=true so no AI scheduling runs.
  try {
    const [aiMsgCount, leadMsgCount] = await Promise.all([
      prisma.message.count({
        where: { conversationId, sender: 'AI' }
      }),
      prisma.message.count({
        where: { conversationId, sender: 'LEAD' }
      })
    ]);
    if (aiMsgCount === 0 && leadMsgCount === 1) {
      const { detectColdPitch, COLD_PITCH_TAG_NAME } = await import(
        '@/lib/cold-pitch-detector'
      );
      const pitch = detectColdPitch(messageText);
      if (pitch.detected) {
        console.warn(
          `[webhook-processor] COLD PITCH DETECTED on conv ${conversationId} — patternIndex=${pitch.patternIndex} match="${pitch.match}" lead=@${senderHandle}`
        );
        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            outcome: 'SPAM',
            awaitingAiResponse: false,
            awaitingSince: null
          }
        });
        try {
          await applyAutoTags(accountId, lead.id, [COLD_PITCH_TAG_NAME], 1.0);
        } catch (tagErr) {
          console.error(
            '[webhook-processor] cold-pitch tag application failed (non-fatal):',
            tagErr
          );
        }
        broadcastNewMessage(accountId, {
          id: message.id,
          conversationId,
          sender: 'LEAD',
          content: messageText,
          imageUrl: message.imageUrl,
          hasImage: message.hasImage,
          timestamp: now.toISOString()
        });
        broadcastConversationUpdate(accountId, {
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
          isNewLead,
          skipReply: true
        };
      }
    }
  } catch (pitchErr) {
    // Non-fatal — fall through to normal processing on any error.
    console.error(
      '[webhook-processor] cold-pitch detection threw (non-fatal):',
      pitchErr
    );
  }

  // (Step 3d "Geography gate" removed 2026-04-30 — replaced with
  // smarter capital-qualification signals downstream. The Abdulahi
  // false-positive demonstrated that nationality is the wrong filter;
  // financial readiness is. The promptConfig.geographyGate.enabled
  // flag is silently ignored if any persona still has it set.)

  // ── Step 3b-ii: Typeform filled but no booking slot ────────────
  // If the AI asked "what day and time did you book?" and the lead
  // says they only completed the basic form / did not book a time,
  // the Typeform screening likely did not approve them into the
  // calendar step. This is expected flow, not an Action Required
  // item. Ship the fixed soft exit, mark UNQUALIFIED, tag the lead,
  // pause AI, and skip the LLM.
  try {
    const previousAI = await prisma.message.findFirst({
      where: {
        conversationId,
        sender: 'AI',
        timestamp: { lt: now }
      },
      orderBy: { timestamp: 'desc' },
      select: { content: true }
    });

    if (
      detectTypeformFilledNoBookingContext(previousAI?.content, messageText)
    ) {
      console.warn(
        `[webhook-processor] TYPEFORM_FILLED_NO_BOOKING detected on ${conversationId} — lead=@${senderHandle}`
      );
      await handleTypeformFilledNoBookingScreenOut({
        conversationId,
        leadId: lead.id,
        accountId,
        platform: lead.platform,
        platformUserId: lead.platformUserId,
        inboundMessageId: message.id,
        inboundContent: messageText,
        inboundImageUrl: message.imageUrl,
        inboundHasImage: message.hasImage,
        inboundAt: now,
        unreadCount: lead.conversation!.unreadCount || 0
      });
      return {
        leadId: lead.id,
        conversationId,
        messageId: message.id,
        isNewLead,
        skipReply: true
      };
    }
  } catch (screenOutErr) {
    console.error(
      '[webhook-processor] typeform-filled-no-booking detection threw (non-fatal):',
      screenOutErr
    );
  }

  // ── Step 3c: Scheduling-conflict detection ─────────────────────
  // Only fires when the lead has ALREADY filled out the Typeform (i.e.
  // stage=CALL_PROPOSED and no scheduledCallAt yet). Detects "can't
  // make it", "available Sunday", "move to Monday" style messages the
  // AI can't resolve — no calendar access, no ability to re-book.
  // Flags the conversation + fires a CRITICAL escalation (in-app
  // Notification + email to Account.notificationEmail if set) so a
  // human can confirm the alternate slot within minutes, not hours.
  // Idempotent: once schedulingConflict=true, we don't re-fire on
  // subsequent lead messages — operator responds manually.
  try {
    if (
      lead.stage === 'CALL_PROPOSED' &&
      lead.conversation &&
      !lead.conversation.scheduledCallAt &&
      !lead.conversation.schedulingConflict
    ) {
      const {
        detectSchedulingConflict,
        detectHardSchedulingConflict,
        HARD_SCHEDULING_HANDOFF_MESSAGE
      } = await import('@/lib/scheduling-conflict-detector');

      // ── HARD path — strict patterns short-circuit with a fixed
      // handoff. Mirrors the distress-detection contract: pause AI,
      // cancel pending replies, ship the exact handoff line, escalate
      // to operator (in-app + email), and return skipReply so no LLM
      // call runs for this turn. The fixed copy means the AI can't
      // contradict itself ("got it bro, Saturday works!" right after
      // the lead said "I can't do this weekend").
      const hard = detectHardSchedulingConflict(messageText);
      if (hard.detected) {
        console.warn(
          `[webhook-processor] HARD scheduling_conflict detected on ${conversationId} — match="${hard.match}" lead=@${senderHandle}`
        );
        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            awaitingAiResponse: false,
            awaitingSince: null,
            schedulingConflict: true,
            schedulingConflictAt: now,
            schedulingConflictMessageId: message.id,
            schedulingConflictPreference: null
          }
        });
        // Cancel anything pending so the next cron tick can't fire an
        // AI follow-up after the handoff has shipped.
        await prisma.scheduledReply.updateMany({
          where: { conversationId, status: 'PENDING' },
          data: { status: 'CANCELLED' }
        });
        try {
          const { cancelAllPendingFollowUps } = await import(
            '@/lib/follow-up-sequence'
          );
          await cancelAllPendingFollowUps(conversationId);
        } catch (cancelErr) {
          console.error(
            '[webhook-processor] cancelAllPendingFollowUps after hard scheduling conflict failed (non-fatal):',
            cancelErr
          );
        }

        // Save the AI handoff message row + ship via the platform
        // helper. Mirrors the distress block (save-then-ship): the
        // text is fixed, so there's no fabrication risk, and ops can
        // retry the platform send manually if it fails.
        const handoffMsg = await prisma.message.create({
          data: {
            conversationId,
            sender: 'AI',
            content: HARD_SCHEDULING_HANDOFF_MESSAGE,
            timestamp: new Date(),
            stage: null,
            subStage: null
          }
        });
        if (lead.platformUserId) {
          try {
            if (lead.platform === 'INSTAGRAM') {
              await sendInstagramDM(
                accountId,
                lead.platformUserId,
                HARD_SCHEDULING_HANDOFF_MESSAGE
              );
            } else if (lead.platform === 'FACEBOOK') {
              await sendFacebookMessage(
                accountId,
                lead.platformUserId,
                HARD_SCHEDULING_HANDOFF_MESSAGE
              );
            }
          } catch (sendErr) {
            console.error(
              '[webhook-processor] Hard scheduling handoff platform send failed (non-fatal):',
              sendErr
            );
          }
        }
        // Broadcast the inbound + outbound + status flip so the
        // dashboard updates immediately.
        broadcastNewMessage(accountId, {
          id: message.id,
          conversationId,
          sender: 'LEAD',
          content: messageText,
          imageUrl: message.imageUrl,
          hasImage: message.hasImage,
          timestamp: now.toISOString()
        });
        broadcastNewMessage(accountId, {
          id: handoffMsg.id,
          conversationId,
          sender: 'AI',
          content: HARD_SCHEDULING_HANDOFF_MESSAGE,
          timestamp: handoffMsg.timestamp.toISOString()
        });
        broadcastConversationUpdate(accountId, {
          id: conversationId,
          leadId: lead.id,
          unreadCount: (lead.conversation!.unreadCount || 0) + 1,
          lastMessageAt: now.toISOString()
        });

        // Escalate to operator: in-app URGENT row + email (gated by
        // notifyOnSchedulingConflict). Same code path the soft
        // detector uses; we just supply a stronger details string.
        const { escalate } = await import('@/lib/escalation-dispatch');
        const origin = process.env.NEXT_PUBLIC_APP_URL || '';
        const link = origin
          ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
          : undefined;
        const quote =
          messageText.length > 220
            ? messageText.slice(0, 220) + '…'
            : messageText;
        await escalate({
          type: 'scheduling_conflict',
          accountId,
          leadId: lead.id,
          conversationId,
          leadName: lead.name,
          leadHandle: lead.handle,
          title: `URGENT — ${lead.name} can't make available booking times. Flagged for manual scheduling.`,
          body: `${lead.name} (@${lead.handle}) — can't make available booking times. Flagged for manual scheduling. AI has been paused and the team needs to reach out manually to sort a time.\n\nLead's message: "${quote}"`,
          details: `Match: "${hard.match}". Lead message: "${quote}"`,
          link
        });

        // Skip rest of normal processing — no scoring, no AI reply.
        return {
          leadId: lead.id,
          conversationId,
          messageId: message.id,
          isNewLead,
          skipReply: true
        };
      }

      // ── SOFT path — weaker signals trigger an escalation but the
      // AI continues to generate. Behaviour unchanged from the
      // pre-hard-path implementation.
      const conflict = detectSchedulingConflict(messageText);
      if (conflict.detected) {
        console.warn(
          `[webhook-processor] scheduling_conflict detected on ${conversationId} — label=${conflict.label} match="${conflict.match}" preference=${JSON.stringify(conflict.preference)}`
        );
        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            schedulingConflict: true,
            schedulingConflictAt: now,
            schedulingConflictMessageId: message.id,
            schedulingConflictPreference: conflict.preference
          }
        });
        const { escalate } = await import('@/lib/escalation-dispatch');
        const origin = process.env.NEXT_PUBLIC_APP_URL || '';
        const link = origin
          ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
          : undefined;
        const quote =
          messageText.length > 220
            ? messageText.slice(0, 220) + '…'
            : messageText;
        const detailsLine = conflict.preference
          ? `Available: ${conflict.preference}. Lead message: "${quote}"`
          : `Lead message: "${quote}"`;
        await escalate({
          type: 'scheduling_conflict',
          accountId,
          leadId: lead.id,
          conversationId,
          leadName: lead.name,
          leadHandle: lead.handle,
          title: `Lead needs manual scheduling — ${lead.name}`,
          body: `${lead.name} (@${lead.handle}) filled out the application but can't make the available times.${conflict.preference ? `\n\nThey're available: ${conflict.preference}.` : ''}\n\nTheir message: "${quote}"\n\nThis lead needs a human to reach out and confirm a time.`,
          details: detailsLine,
          link
        });
      }
    }
  } catch (schedErr) {
    console.error(
      '[webhook-processor] scheduling-conflict detection threw (non-fatal):',
      schedErr
    );
  }

  // ── Step 4: Back-fill effectiveness tracking on previous AI messages
  await backfillEffectivenessTracking(conversationId).catch((err) =>
    console.error('[webhook-processor] Effectiveness tracking error:', err)
  );

  // ── Step 5: Re-engage LEFT_ON_READ conversations ───────────────
  const currentOutcome = lead.conversation?.outcome;
  if (currentOutcome === 'LEFT_ON_READ' || currentOutcome === 'DORMANT') {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { outcome: 'ONGOING' }
    });
    console.log(
      `[webhook-processor] Re-engaged ${currentOutcome} conversation: ${conversationId}`
    );
  }

  // ── Snooze detection + cancel pending silent-lead follow-ups ───
  // Lead just responded. Two paths:
  //   (a) Snooze signal ("tomorrow", "few hours", "busy rn", "hit you
  //       back later"). Cancel the pending cascade AND reschedule
  //       FOLLOW_UP_1 for the parsed duration so the chain resumes
  //       when the lead is actually available. Preserves booking
  //       context if the prior cascade was booking-aware.
  //   (b) Normal reply. Cancel the pending cascade; no reschedule.
  try {
    const {
      cancelAllPendingFollowUps,
      detectSnooze,
      rescheduleFollowUpAfterSnooze
    } = await import('@/lib/follow-up-sequence');
    const snooze = detectSnooze(messageText);
    if (snooze.matched) {
      const res = await rescheduleFollowUpAfterSnooze(
        conversationId,
        accountId,
        snooze.delayMs
      );
      console.log(
        `[webhook-processor] snooze detected ("${snooze.match}" / ${snooze.reason}) → cancelled ${res.cancelled}, rescheduled FOLLOW_UP_1 at ${res.scheduledFor.toISOString()} (${res.bookingContext ? 'booking' : 'generic'})`
      );
    } else {
      await cancelAllPendingFollowUps(conversationId);
    }

    // Wout Lngrs follow-up 2026-05-02: WINDOW_KEEPALIVE rows exist
    // to nudge a stale conversation back to life. The moment the
    // lead re-engages on their own (this inbound), the keepalive
    // is moot — cancel any pending one. Call-day reminders
    // (DAY_BEFORE_REMINDER / MORNING_OF_REMINDER / CALL_DAY_* /
    // PRE_CALL_HOMEWORK) are NOT cancelled here — those fire on
    // their own time regardless of inbound activity.
    try {
      const cancelled = await prisma.scheduledMessage.updateMany({
        where: {
          conversationId,
          status: 'PENDING',
          messageType: 'WINDOW_KEEPALIVE'
        },
        data: { status: 'CANCELLED' }
      });
      if (cancelled.count > 0) {
        console.log(
          `[webhook-processor] cancelled ${cancelled.count} pending WINDOW_KEEPALIVE row(s) on lead inbound for ${conversationId}`
        );
      }
    } catch (kaErr) {
      console.error(
        '[webhook-processor] WINDOW_KEEPALIVE cancellation failed (non-fatal):',
        kaErr
      );
    }
  } catch (err) {
    console.error(
      '[webhook-processor] snooze/cancel hook failed (non-fatal):',
      err
    );
  }

  // ── Step 5b: Call-day confirmation replies ─────────────────────
  // If the lead is responding to the morning-of confirmation or
  // two-hour reminder, handle that deterministic branch here instead
  // of sending the turn through the general LLM. Distress detection
  // has already run above, so safety still wins.
  try {
    const { handleCallConfirmationLeadReply } = await import(
      '@/lib/call-confirmation-sequence'
    );
    const confirmation = await handleCallConfirmationLeadReply({
      conversationId,
      messageId: message.id,
      messageText
    });
    if (confirmation.handled) {
      await prisma.conversation
        .update({
          where: { id: conversationId },
          data: { awaitingAiResponse: false, awaitingSince: null }
        })
        .catch((err) =>
          console.error(
            '[webhook-processor] call-confirmation awaiting clear failed:',
            err
          )
        );
      broadcastNewMessage(accountId, {
        id: message.id,
        conversationId,
        sender: 'LEAD',
        content: messageText,
        imageUrl: message.imageUrl,
        hasImage: message.hasImage,
        timestamp: now.toISOString()
      });
      broadcastConversationUpdate(accountId, {
        id: conversationId,
        leadId: lead.id,
        aiActive:
          confirmation.kind === 'reschedule'
            ? false
            : lead.conversation!.aiActive,
        unreadCount: (lead.conversation!.unreadCount || 0) + 1,
        lastMessageAt: now.toISOString()
      });
      return {
        leadId: lead.id,
        conversationId,
        messageId: message.id,
        isNewLead,
        skipReply: true
      };
    }
  } catch (err) {
    console.error(
      '[webhook-processor] call-confirmation reply handling failed (non-fatal):',
      err
    );
  }

  // ── Step 6: Broadcast real-time events ─────────────────────────
  broadcastNewMessage(accountId, {
    id: message.id,
    conversationId,
    sender: 'LEAD',
    content: message.content,
    imageUrl: message.imageUrl,
    hasImage: message.hasImage,
    mediaType: message.mediaType,
    mediaUrl: message.mediaUrl,
    transcription: message.transcription,
    imageMetadata: message.imageMetadata,
    mediaProcessedAt: message.mediaProcessedAt?.toISOString() ?? null,
    mediaProcessingError: message.mediaProcessingError,
    timestamp: now.toISOString()
  });

  broadcastConversationUpdate(accountId, {
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
      where: { conversationId, sender: { not: 'SYSTEM' }, deletedAt: null },
      orderBy: { timestamp: 'desc' },
      select: { sender: true, timestamp: true, content: true }
    });
    if (latestMsg && latestMsg.sender !== 'LEAD') {
      const ageMs = Date.now() - latestMsg.timestamp.getTime();
      log(
        'sched.step0a.noLeadToReplyTo',
        `latest msg is ${latestMsg.sender} (${Math.round(ageMs / 1000)}s ago) — nothing new to reply to, skipping`
      );
      await prisma.conversation
        .update({
          where: { id: conversationId },
          data: { awaitingAiResponse: false, awaitingSince: null }
        })
        .catch(() => null);
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
          deletedAt: null,
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
          deletedAt: null,
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
        await prisma.conversation
          .update({
            where: { id: conversationId },
            data: { awaitingAiResponse: false, awaitingSince: null }
          })
          .catch(() => null);
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
        // Soft-deleted messages (operator unsends, lead unsends) MUST
        // NOT enter the AI context. Once a message is unsent, the
        // conversation continues as if it never existed — the
        // operator's correction (or the lead's retraction) is the
        // canonical state. See conversation-message-unsend.ts.
        where: { deletedAt: null },
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

  if (conversation.awaitingHumanReview) {
    log('sched.step1.awaitingHumanReview', 'manual response required');
    if (options?.skipDelayQueue) {
      throw new Error('Conversation is awaiting human review');
    }
    return;
  }

  const { lead } = conversation;

  const latestLeadMessage = [...conversation.messages]
    .reverse()
    .find((m) => m.sender === 'LEAD');
  let rescheduleFlowActive = false;
  if (
    !conversation.aiActive &&
    conversation.scheduledCallAt &&
    isRescheduleSignal(latestLeadMessage?.content)
  ) {
    const cancelledReminders = await prisma.scheduledMessage.updateMany({
      where: { conversationId, status: 'PENDING' },
      data: { status: 'CANCELLED' }
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        aiActive: true,
        autoSendOverride: true,
        // Rescheduling clears only scheduling state. Durable capital
        // verification survives; a booked lead is still qualified.
        scheduledCallAt: null,
        scheduledCallTimezone: null,
        scheduledCallSource: null,
        scheduledCallConfirmed: false,
        callConfirmed: false,
        callConfirmedAt: null,
        callOutcome: null,
        typeformCallScheduledAt: null
      }
    });
    if (lead.stage !== 'CALL_PROPOSED') {
      await transitionLeadStage(
        lead.id,
        'CALL_PROPOSED',
        'system',
        'AI re-enabled for reschedule flow'
      );
      lead.stage = 'CALL_PROPOSED';
    }
    conversation.aiActive = true;
    conversation.autoSendOverride = true;
    conversation.scheduledCallAt = null;
    conversation.scheduledCallTimezone = null;
    conversation.scheduledCallSource = null;
    conversation.scheduledCallConfirmed = false;
    conversation.callConfirmed = false;
    conversation.callConfirmedAt = null;
    conversation.callOutcome = null;
    conversation.typeformCallScheduledAt = null;
    broadcastAIStatusChange(accountId, { conversationId, aiActive: true });
    log(
      'sched.step1.rescheduleReenabled',
      `AI re-enabled for reschedule flow; autoSendOverride=true; cancelled ${cancelledReminders.count} pending scheduled message(s)`
    );
    console.log('AI re-enabled for reschedule flow');
    rescheduleFlowActive = true;
  }

  // Send-decision policy (2026-05-05):
  //   aiActive = true  → AI auto-sends responses
  //   aiActive = false → AI generates suggestions only
  //
  // Away mode is a separate concern, intentionally decoupled from
  // delivery: it only controls the DEFAULT for NEW conversation
  // creation (Conversation.aiActive's initial value when an inbound
  // creates the row — see processIncomingMessage where
  // shouldEnableAI = awayModeForPlatform). Once a conversation
  // exists, awayMode does not influence whether the AI sends or
  // suggests — only aiActive does.
  //
  // The previous version coupled both — auto-send required
  // (awayMode || autoSendOverride) AND aiActive. That coupling caused
  // a class of bugs where flipping aiActive ON for a specific
  // conversation produced an AISuggestion that never shipped because
  // platform-level awayMode was off. The @l.galeza incident the old
  // comment cited was about the OPPOSITE failure mode (a brand-new
  // inbound lead auto-replying before opt-in) — that risk is now
  // owned by the conversation-creation path: a lead created while
  // awayMode=false comes in with aiActive=false and stays in
  // suggestion mode until the operator manually flips it.
  //
  // REGRESSION NOTE — DELIVERY-TIME RE-CHECK: this entire scheduleAIReply
  // function re-runs from scratch every time the cron picks up a PENDING
  // ScheduledReply (via the skipDelayQueue=true branch). The aiActive
  // flag is re-fetched at DELIVERY time, not snapshotted at scheduling
  // time. So an operator who flips aiActive=false between a lead's
  // message and the scheduled reply firing will see the delivery path
  // route to suggestion mode instead of shipping. Do NOT cache the
  // flag across the scheduling-to-delivery boundary — always resolve
  // from the current DB row.
  log('sched.step1.aiActiveCheck');
  const aiActive = conversation.aiActive;
  const autoSendOverride = conversation.autoSendOverride;
  const accountForSend = await prisma.account.findUnique({
    where: { id: accountId },
    select: { awayModeInstagram: true, awayModeFacebook: true, awayMode: true }
  });
  const awayModeForSend = resolvePlatformAwayMode(
    accountForSend,
    lead.platform
  );
  const shouldAutoSend = shouldAutoSendReply({
    aiActive,
    awayMode: awayModeForSend,
    autoSendOverride
  });
  log(
    'sched.step1.aiActive',
    `aiActive=${aiActive} awayMode=${awayModeForSend} autoSendOverride=${autoSendOverride} platform=${lead.platform} shouldAutoSend=${shouldAutoSend}`
  );

  if (
    shouldAutoSend &&
    conversation.source === 'MANYCHAT' &&
    !canShipToPlatformRecipient(lead.platform, lead.platformUserId)
  ) {
    log(
      'sched.step1.unsendableManyChatRecipient',
      `platformUserId=${lead.platformUserId || 'null'} — waiting for real Instagram webhook recipient id`
    );
    await prisma.conversation
      .update({
        where: { id: conversationId },
        data: { awaitingAiResponse: false, awaitingSince: null }
      })
      .catch(() => null);
    return;
  }

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
    // Pass-through for per-conversation Typeform deep-linking. The
    // prompt builder appends `#conversationid=<id>` to the form URL
    // so when this lead fills it out, the webhook routes the response
    // back to THIS conversation deterministically — no email / IG-
    // handle guessing.
    conversationId: conversationId,
    // Enrichment from conversation + lead metadata
    intentTag: conversation.leadIntentTag || undefined,
    tags: lead.tags.map((lt) => lt.tag.name),
    leadScore: conversation.priorityScore || undefined,
    source: conversation.leadSource || undefined,
    experience: lead.experience || undefined,
    incomeLevel: lead.incomeLevel || undefined,
    geography: lead.geography || undefined,
    timezone: lead.timezone || undefined,
    rescheduleFlow: rescheduleFlowActive || undefined,
    // Safety: when the conversation has a previously-detected distress
    // flag and the operator has re-enabled AI, the prompt needs to
    // know so it can soft check-in instead of pitching. Permanent flag
    // — stays true for the life of the conversation.
    distressDetected: conversation.distressDetected === true,
    // Conversation-level stats drive the ongoing-conversation anti-
    // restart override. Surface messageCount + first-message timestamp
    // so buildDynamicSystemPrompt can inject the block when the
    // conversation has 10+ messages. Rufaro 2026-04-20 fix.
    conversationStats:
      conversation.messages.length > 0
        ? {
            messageCount: conversation.messages.length,
            firstMessageAt: conversation.messages[0].timestamp.toISOString()
          }
        : undefined
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
      // Defaults nudged to (45, 120) so a row with NULL columns
      // (impossibly old account, schema drift, etc.) never produces
      // an instant 0-second fire — instant replies are a bot tell.
      // Operator-set values always take precedence over the defaults.
      const minDelay = Math.max(0, accountRow?.responseDelayMin ?? 45);
      const maxDelay = Math.max(minDelay, accountRow?.responseDelayMax ?? 120);
      let debounceSec = Math.max(0, accountRow?.debounceWindowSeconds ?? 45);
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
        select: { timestamp: true, content: true }
      });

      // Capital-question debounce floor (Kelvin Kelvot 2026-04-24 incident):
      // if the previous AI message asked for capital, give the lead 10s
      // minimum to send a burst like "Yes / actually No / I don't have
      // it". Otherwise the debounce-by-message cancellation can still
      // lose the correction if the account's default debounceWindow is
      // short. Extending the floor (not the cap) so custom account
      // settings still apply when they're longer.
      const CAPITAL_Q_PATTERNS: RegExp[] = [
        /\byou got at least \$\d/i,
        /\byou have at least \$\d/i,
        /\bat least \$\d+[,\d]*\s*(in\s+capital|capital|ready|to\s+start)/i,
        /\bcapital ready\b/i,
        /\bready to start with \$/i,
        /\bhow much (do you |have you )?(got|have|set aside|saved|working with|to start|to invest|to put (in|aside))/i,
        /\bwhat('s| is) your (budget|capital|starting (amount|capital|budget))/i
      ];
      const lastAiIsCapitalQ =
        lastAiMsg?.content &&
        CAPITAL_Q_PATTERNS.some((re) => re.test(lastAiMsg.content));
      if (lastAiIsCapitalQ) {
        const CAPITAL_Q_MIN_DEBOUNCE_SEC = 10;
        if (debounceSec < CAPITAL_Q_MIN_DEBOUNCE_SEC) {
          console.log(
            `[webhook-processor] capital-Q debounce floor applied: ${debounceSec}s → ${CAPITAL_Q_MIN_DEBOUNCE_SEC}s for conv ${conversationId}`
          );
          debounceSec = CAPITAL_Q_MIN_DEBOUNCE_SEC;
        }
      }
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
      // ── Two independent floors, take the max ─────────────────────
      // 1. DEBOUNCE phase — how long we wait for MORE lead messages
      //    before generating. Capped at maxDebounceSec measured from
      //    the FIRST lead message in the batch so a chatty lead can't
      //    indefinitely postpone the AI.
      // 2. RESPONSE DELAY phase — operator-configured human-feel pause
      //    that ALWAYS applies regardless of debounce state. Pre-fix
      //    bug: this was clamped by maxDebounceSec, which silently
      //    overrode operator settings (daetradez 2026-04-28 incident:
      //    operator set 2-10min, AI fired in <60s because
      //    maxDebounceWindowSeconds=120 was capping fireAt).
      const debouncedFireAt = earliestLeadInBatch
        ? Math.min(
            now + debounceSec * 1000,
            earliestLeadInBatch.timestamp.getTime() + maxDebounceSec * 1000
          )
        : now + debounceSec * 1000;
      const responseDelayFireAt = now + delayRandomSec * 1000;
      // Final: take the LATER of the two floors. Always at least 1s
      // from now so the cron can pick it up.
      const fireAt = Math.max(now + 1000, debouncedFireAt, responseDelayFireAt);
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
      leadEmail: conversation.leadEmail ?? lead.email,
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
  const formattedMessages = formatMessagesForGenerateReply(messages);

  let result: GenerateReplyResult;
  try {
    result = (await generateReply(
      accountId,
      conversation.personaId,
      formattedMessages,
      leadContext,
      scoringContext
    )) as GenerateReplyResult;
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
    await prisma.conversation
      .update({
        where: { id: conversationId },
        data: {
          awaitingAiResponse: true,
          awaitingSince:
            conversation.awaitingSince ??
            latestLeadMessage?.timestamp ??
            new Date(),
          lastSilentStopAt: new Date()
        }
      })
      .catch(() => null);
    if (options?.skipDelayQueue) {
      throw err;
    }
    return;
  }

  if (isTerminalQualityGateResult(result)) {
    await escalateQualityGateFailure({
      conversationId,
      accountId,
      lead,
      result,
      latestLeadTimestamp: latestLeadMessage?.timestamp ?? null
    });
    throw new QualityGateEscalationError({
      conversationId,
      accountId,
      suggestionId: result.suggestionId,
      generatedResult: buildQualityGateGeneratedResult(result),
      hardFails: result.qualityGateHardFails,
      awaitingSince: latestLeadMessage?.timestamp ?? null
    });
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
    const removed = sanitizeMessageGroupUrls(result, allowedUrls);
    if (removed.length) {
      console.warn(
        `[webhook-processor] R16 violation for ${conversationId}: AI tried to send ${removed.length} unauthorized URL(s) across reply bubbles:`,
        removed
      );
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
  // and every multi-bubble item before delivery.
  try {
    sanitizeAIResultDashes(result, conversationId);
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
    broadcastAISuggestion(accountId, {
      conversationId,
      suggestedReply: result.reply,
      stage: result.stage,
      confidence: result.stageConfidence
    });
    console.log(
      `[webhook-processor] AI suggestion generated for ${conversationId} (not auto-sending)`
    );
    await prisma.conversation
      .update({
        where: { id: conversationId },
        data: { awaitingAiResponse: false, awaitingSince: null }
      })
      .catch(() => null);
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
 * Inter-bubble delay. Simulates reading-then-typing cadence rather
 * than a burst-send. Pre-2026-04-24 this returned 750-1500ms for a
 * ~40-char bubble, which meant both bubbles landed with the same
 * minute timestamp and read as "arrived together" to the lead.
 *
 * New math:
 *   base reading delay: 8-15s (lead reads bubble N before N+1 shows up)
 *   typing factor: 50-80ms per char of the NEXT bubble
 * For a 40-char bubble: 8-15s + 2-3.2s = ~10-18s total.
 * For an 80-char bubble: 8-15s + 4-6.4s = ~12-21s total.
 *
 * Capped at 25s — longer than that feels like the AI forgot what it
 * was saying. These delays are ON TOP of the first-bubble
 * humanResponseDelay that fires before bubble 1 leaves.
 */
function calculateBubbleDelay(nextBubbleChars: number): number {
  const baseReadingDelay = 8000 + Math.random() * 7000; // 8-15s
  const perCharFactor = 50 + Math.random() * 30; // 50-80ms per char
  const typingDelay = nextBubbleChars * perCharFactor;
  return Math.min(Math.round(baseReadingDelay + typingDelay), 25000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deliver a multi-bubble AI response as N separate platform sends.
 * Creates a MessageGroup parent row, then iterates the bubble array:
 *   1. platform send (sendInstagramDM / sendFacebookMessage — each
 *      already does its own 1s/2s/4s exponential backoff on transient
 *      errors, so we only catch POST-retry failures here)
 *   2. prisma.message.create with messageGroupId + bubbleIndex
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
  const sanitizedBubbles = bubbles.map((bubble) =>
    sanitizeDashCharacters(bubble)
  );
  const totalCharacters = sanitizedBubbles.reduce(
    (sum, b) => sum + b.length,
    0
  );

  // 1. Create the parent MessageGroup first so bubble rows can link.
  const group = await prisma.messageGroup.create({
    data: {
      conversationId,
      generatedAt: now,
      aiSuggestionId: result.suggestionId || null,
      bubbleCount: sanitizedBubbles.length,
      totalCharacters,
      sentByType: 'AI'
    }
  });

  const groupStart = now;
  let delivered = 0;
  let failedAt: Date | null = null;
  let deliveryError: Error | null = null;
  let firstMessageId = '';
  let abortedByHuman = false;

  for (let i = 0; i < sanitizedBubbles.length; i++) {
    const isFirst = i === 0;
    const bubble = sanitizedBubbles[i];

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
          `[webhook-processor] Multi-bubble group ${group.id} aborted at bubble ${i}/${sanitizedBubbles.length}: human took over`
        );
        break;
      }
    }

    // 2. Platform send FIRST. Only create the Message row after Meta
    // returns a messageId, otherwise a transient outage looks like a
    // successful AI reply in the dashboard and the scheduled row never
    // retries.
    const ship = lead.platformUserId
      ? await shipTextToMeta(
          lead.platform,
          lead.accountId,
          lead.platformUserId,
          bubble
        )
      : {
          messageId: null,
          error: new Error('no platformUserId on lead'),
          tokenInvalid: false
        };

    if (!ship.messageId) {
      failedAt = new Date();
      deliveryError = await notifyDeliveryFailure({
        accountId: lead.accountId,
        leadId: lead.id,
        platform: lead.platform,
        platformUserId: lead.platformUserId,
        ship,
        title: 'Multi-bubble delivery failed',
        bodyPrefix: `Bubble ${i + 1} of ${sanitizedBubbles.length}`
      });
      break;
    }

    // 3. Per-bubble Message row. Metadata written on bubble 0 only —
    // downstream analytics group by AI-turn = one stage-bearing row.
    // TODO(Sprint 7 / Fix D): real state-machine rows should own stage
    // progression so every bubble can reference the turn stage without
    // duplicating nullable Message.stage metadata.
    const bubbleTimestamp = i === 0 ? now : new Date();
    const msg = await prisma.message.create({
      data: {
        conversationId,
        sender: 'AI',
        content: bubble,
        timestamp: bubbleTimestamp,
        messageGroupId: group.id,
        bubbleIndex: i,
        bubbleTotalCount: sanitizedBubbles.length,
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
        suggestionId: suggestionIdForDeliveredBubble(result.suggestionId),
        msgSource: 'QUALIFYDMS_AI',
        platformMessageId: ship.messageId
      }
    });
    if (isFirst) firstMessageId = msg.id;

    console.log(
      `[webhook-processor] bubble ${i}/${sanitizedBubbles.length - 1} sent to ${lead.platformUserId} (group=${group.id}, mid=${ship.messageId})`
    );

    // 4. SSE broadcast — include group fields so the dashboard can
    // render in real time without re-fetching.
    broadcastNewMessage(lead.accountId, {
      id: msg.id,
      conversationId,
      sender: 'AI',
      content: bubble,
      timestamp: msg.timestamp.toISOString(),
      messageGroupId: group.id,
      bubbleIndex: i,
      bubbleTotalCount: sanitizedBubbles.length
    });

    delivered++;

    // 4b. Brian Dycey 2026-04-27 fix — schedule the silent-lead
    // follow-up cascade RIGHT HERE on bubble 0, NOT after the loop.
    // If the function dies mid-sleep before bubble N+1 ships, the
    // post-ship hook in sendAIReply never runs and FOLLOW_UP_1
    // never gets queued. Scheduling on bubble 0 means: even if the
    // multi-bubble group is incomplete, the lead still gets chased
    // 12h later. Best-effort — wrapped so a follow-up scheduling
    // failure never breaks the bubble loop.
    if (i === 0 && !failedAt) {
      try {
        const {
          scheduleFollowUp1AfterAiMessage,
          containsBookingLink,
          scheduleBookingLinkFollowup
        } = await import('@/lib/follow-up-sequence');
        const joinedReply = sanitizedBubbles.join(' ');
        const convLookup = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: {
            outcome: true,
            lead: { select: { stage: true } }
          }
        });
        const gate = {
          leadStage: convLookup?.lead.stage ?? null,
          softExit: false,
          conversationOutcome: convLookup?.outcome ?? null,
          replyText: joinedReply
        };
        await scheduleFollowUp1AfterAiMessage(
          conversationId,
          lead.accountId,
          gate
        );
        if (containsBookingLink(joinedReply)) {
          await scheduleBookingLinkFollowup(
            conversationId,
            lead.accountId,
            gate
          );
        }
      } catch (followUpErr) {
        console.error(
          '[webhook-processor] follow-up scheduling on bubble-0 ship failed (non-fatal):',
          followUpErr
        );
      }
    }

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

  if (failedAt && delivered === 0) {
    throw deliveryError ?? new Error('Multi-bubble delivery failed');
  }

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

export function matchFailedCapitalBookingPitch(text: string): string | null {
  const patterns: RegExp[] = [
    /\b(hop|jump)\s+on\s+(a\s+)?(quick\s+)?(call|chat|zoom|meeting|convo)\b/i,
    /\b(hop|jump|get|book|schedule|lock)\s+(on|in|into|a|the|you)?\s*(quick\s+)?(call|chat|zoom|meeting|convo)\b/i,
    /\b(quick\s+)?(call|chat|zoom|meeting|convo)\s+(with|for)\s+(the\s+)?(closer|team|us|me)\b/i,
    /\b(the\s+)?(team|closer|setter|coach|anthony)\s+(will|would|gonna|is\s+gonna|can)\s+(reach\s+out|hit\s+you|call|chat|speak)\b/i,
    /\b(fill\s+out|complete|submit)\s+(the\s+)?(typeform|application|form)\b/i,
    /\bgrab\s+a\s+time\b/i
  ];

  return (
    patterns.map((pat) => text.match(pat)?.[0] ?? null).find(Boolean) ?? null
  );
}

async function deliverSingleAIMessage(params: {
  conversationId: string;
  accountId: string;
  lead: {
    id: string;
    platform: string;
    platformUserId: string | null;
    accountId: string;
  };
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
    shouldVoiceNote?: boolean;
    voiceNoteAction?: { slot_id: string } | null;
  };
  now: Date;
  libraryVN?: { id: string; audioFileUrl: string; triggerType: string };
}): Promise<{ id: string; content: string; timestamp: Date } | null> {
  const { conversationId, accountId, lead, result, now, libraryVN } = params;
  const platformUserId = lead.platformUserId;

  if (!platformUserId) {
    await notifyAndThrowDeliveryFailure({
      accountId: lead.accountId,
      leadId: lead.id,
      platform: lead.platform,
      platformUserId,
      ship: {
        messageId: null,
        error: new Error('no platformUserId on lead'),
        tokenInvalid: false
      }
    });
    return null;
  }

  let platformMessageId: string | null = null;
  let isVoiceNote = false;
  let voiceNoteUrl: string | null = null;
  let sentLibraryVoiceNote: {
    id: string;
    triggerType: string;
    audioFileUrl: string;
  } | null = null;

  if (libraryVN) {
    const ship = await shipAudioToMeta(
      lead.platform,
      lead.accountId,
      platformUserId,
      libraryVN.audioFileUrl
    );
    if (ship.messageId) {
      platformMessageId = ship.messageId;
      isVoiceNote = true;
      voiceNoteUrl = libraryVN.audioFileUrl;
      sentLibraryVoiceNote = libraryVN;
      console.log(
        `[webhook-processor] Library voice note (id: ${libraryVN.id}) sent to ${platformUserId}`
      );
    } else {
      console.error(
        '[webhook-processor] Library voice note send failed, falling back to text:',
        ship.error
      );
    }
  }

  if (!platformMessageId && result.voiceNoteAction?.slot_id) {
    try {
      const slot = await prisma.voiceNoteSlot.findFirst({
        where: { id: result.voiceNoteAction.slot_id, accountId }
      });

      if (
        slot?.audioFileUrl &&
        (slot.status === 'UPLOADED' || slot.status === 'APPROVED')
      ) {
        const ship = await shipAudioToMeta(
          lead.platform,
          lead.accountId,
          platformUserId,
          slot.audioFileUrl
        );
        if (ship.messageId) {
          platformMessageId = ship.messageId;
          isVoiceNote = true;
          voiceNoteUrl = slot.audioFileUrl;
          console.log(
            `[webhook-processor] Pre-recorded voice note (slot: ${slot.slotName}) sent to ${platformUserId}`
          );
        } else {
          console.error(
            '[webhook-processor] Pre-recorded voice note send failed, falling back to text:',
            ship.error
          );
        }
      } else if (
        slot &&
        slot.fallbackBehavior === 'SEND_TEXT_EQUIVALENT' &&
        slot.fallbackText
      ) {
        result.reply = slot.fallbackText;
        console.log(
          `[webhook-processor] Voice note slot "${slot.slotName}" empty — using fallback text`
        );
      } else if (slot && slot.fallbackBehavior === 'BLOCK_UNTIL_FILLED') {
        console.warn(
          `[webhook-processor] Voice note slot "${slot.slotName}" blocked — halting conversation`
        );
        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            awaitingAiResponse: false,
            awaitingSince: null
          }
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
        return null;
      }
    } catch (slotErr) {
      const errMsg =
        slotErr instanceof Error ? slotErr.message : String(slotErr);
      console.error(
        '[webhook-processor] Pre-recorded voice note error:',
        errMsg
      );
    }
  }

  if (!platformMessageId && result.shouldVoiceNote) {
    try {
      const { generateVoiceNote } = await import('@/lib/elevenlabs');
      const { audioUrl } = await generateVoiceNote(accountId, result.reply);
      const ship = await shipAudioToMeta(
        lead.platform,
        lead.accountId,
        platformUserId,
        audioUrl
      );
      if (ship.messageId) {
        platformMessageId = ship.messageId;
        isVoiceNote = true;
        voiceNoteUrl = audioUrl;
        console.log(
          `[webhook-processor] Voice note sent to ${platformUserId} on ${lead.platform}`
        );
      } else {
        console.error(
          '[webhook-processor] Voice note failed, falling back to text:',
          ship.error
        );
      }
    } catch (voiceErr) {
      console.error(
        '[webhook-processor] Voice note failed, falling back to text:',
        voiceErr instanceof Error ? voiceErr.message : voiceErr
      );
    }
  }

  if (!platformMessageId) {
    const ship = await shipTextToMeta(
      lead.platform,
      lead.accountId,
      platformUserId,
      result.reply
    );
    if (!ship.messageId) {
      await notifyAndThrowDeliveryFailure({
        accountId: lead.accountId,
        leadId: lead.id,
        platform: lead.platform,
        platformUserId,
        ship
      });
    }
    platformMessageId = ship.messageId;
    console.log(
      `[webhook-processor] ${lead.platform === 'INSTAGRAM' ? 'IG DM' : 'FB message'} sent to ${platformUserId} (mid=${platformMessageId})`
    );
  }

  const message = await prisma.message.create({
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
      suggestionId: result.suggestionId || null,
      msgSource: 'QUALIFYDMS_AI',
      platformMessageId,
      isVoiceNote,
      voiceNoteUrl
    }
  });

  if (sentLibraryVoiceNote) {
    try {
      const { logVoiceNoteSend } = await import('@/lib/voice-note-send-log');
      await logVoiceNoteSend({
        accountId,
        leadId: lead.id,
        voiceNoteId: sentLibraryVoiceNote.id,
        messageIndex: await prisma.message.count({
          where: { conversationId }
        }),
        triggerType: sentLibraryVoiceNote.triggerType
      });
    } catch (logErr) {
      console.error(
        '[webhook-processor] Failed to log VN send (non-fatal):',
        logErr
      );
    }
  }

  broadcastNewMessage(accountId, {
    id: message.id,
    conversationId,
    sender: 'AI',
    content: result.reply,
    platformMessageId,
    timestamp: message.timestamp.toISOString()
  });

  return {
    id: message.id,
    content: message.content,
    timestamp: message.timestamp
  };
}

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
    // Typeform screen-out safety net from ai-engine direct generation.
    typeformFilledNoBooking?: boolean;
    selfRecovered?: boolean;
    selfRecoveryEventId?: string | null;
    selfRecoveryReason?: string | null;
    systemStage?: string | null;
    currentScriptStep?: number | null;
    stageOverrideReason?: string | null;
  }
): Promise<void> {
  // Delivery-path R17 backstop. scheduleAIReply normally sanitizes right after
  // generation, but direct/manual AI send paths can call this closer to ship.
  sanitizeAIResultDashes(result, conversationId);

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
          awaitingAiResponse: false,
          awaitingSince: null,
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
        const { escalate } = await import('@/lib/escalation-dispatch');
        const origin = process.env.NEXT_PUBLIC_APP_URL || '';
        const link = origin
          ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
          : undefined;
        await escalate({
          type: 'distress',
          accountId: lead.accountId,
          leadId: lead.id,
          conversationId,
          leadName: lead.name,
          leadHandle: lead.handle,
          title: 'URGENT — distress signal detected, review immediately',
          body: `${lead.name} (@${lead.handle}): the lead's latest message matched a crisis / distress pattern ("${result.distressMatch ?? 'unknown'}"). AI has been paused. Please review and respond personally. (Layer 2 safety net — Layer 1 was bypassed, investigate.)`,
          details: `Match: "${result.distressMatch ?? 'unknown'}" (Layer 2)`,
          link
        });
      } catch (notifErr) {
        console.error(
          '[webhook-processor] Layer 2 distress escalation failed (non-fatal):',
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
        broadcastNewMessage(accountId, {
          id: supportiveMsg.id,
          conversationId,
          sender: 'AI',
          content: supportiveText,
          timestamp: supportiveMsg.timestamp.toISOString()
        });
      }
    } catch (err) {
      console.error(
        '[webhook-processor] Layer 2 distress handler failed (non-fatal, AI still paused):',
        err
      );
    }
    return;
  }

  // ── No-training suppression ────────────────────────────────────
  // generateReply refused because the persona has no training messages.
  // Without training, the master prompt's legacy brand fixtures bleed
  // into replies (cross-tenant voice leak — nickdoesfutures 2026-05-07).
  // Pause AI on this conversation and notify the operator to upload
  // training data before re-enabling.
  if ((result as GenerateReplyResult).noTrainingSuppressed) {
    console.warn(
      `[webhook-processor] No-training suppression engaged for conv ${conversationId} (account ${accountId}) — AI paused, awaiting training data.`
    );
    try {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          aiActive: false,
          awaitingAiResponse: false,
          awaitingSince: null
        }
      });
      await prisma.scheduledReply.updateMany({
        where: { conversationId, status: 'PENDING' },
        data: { status: 'CANCELLED' }
      });
      try {
        const { escalate } = await import('@/lib/escalation-dispatch');
        const origin = process.env.NEXT_PUBLIC_APP_URL || '';
        const link = origin
          ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
          : undefined;
        await escalate({
          type: 'ai_stuck',
          accountId: lead.accountId,
          leadId: lead.id,
          conversationId,
          leadName: lead.name,
          leadHandle: lead.handle,
          title: 'AI paused — upload training data to enable replies',
          body: `${lead.name} (@${lead.handle}): AI is paused because this persona has no training data uploaded. Replies are blocked to prevent cross-tenant voice leakage. Upload training conversations in Settings → Training, then re-enable AI on this conversation.`,
          details: 'noTrainingSuppressed set by ai-engine pre-flight guard',
          link
        });
      } catch (notifErr) {
        console.error(
          '[webhook-processor] No-training escalation failed (non-fatal):',
          notifErr
        );
      }
    } catch (err) {
      console.error(
        '[webhook-processor] No-training suppression handler failed (non-fatal, AI still paused):',
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
    broadcastAISuggestion(accountId, {
      conversationId,
      suggestedReply: result.reply,
      stage: result.stage,
      confidence: result.stageConfidence
    });
    await prisma.conversation
      .update({
        where: { id: conversationId },
        data: { awaitingAiResponse: false, awaitingSince: null }
      })
      .catch(() => null);
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
    where: { conversationId, sender: { not: 'SYSTEM' }, deletedAt: null },
    orderBy: { timestamp: 'desc' },
    select: { sender: true, timestamp: true }
  });
  if (latestMsgInConvo && latestMsgInConvo.sender !== 'LEAD') {
    const ageMs = Date.now() - latestMsgInConvo.timestamp.getTime();
    console.log(
      `[webhook-processor] Double-fire guard: latest msg is ${latestMsgInConvo.sender} (${Math.round(ageMs / 1000)}s ago) for ${conversationId} — discarding duplicate reply`
    );
    await prisma.conversation
      .update({
        where: { id: conversationId },
        data: { awaitingAiResponse: false, awaitingSince: null }
      })
      .catch(() => null);
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
    await prisma.conversation
      .update({
        where: { id: conversationId },
        data: { awaitingAiResponse: false, awaitingSince: null }
      })
      .catch(() => null);
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
        data: {
          awaitingAiResponse: false,
          awaitingSince: null
        }
      });
      const { escalate } = await import('@/lib/escalation-dispatch');
      const origin = process.env.NEXT_PUBLIC_APP_URL || '';
      const link = origin
        ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
        : undefined;
      await escalate({
        type: 'ai_stuck',
        accountId: lead.accountId,
        leadId: lead.id,
        conversationId,
        leadName: lead.name,
        leadHandle: lead.handle,
        title: 'AI produced empty response — human takeover required',
        body: `${lead.name} (@${lead.handle}): the AI's last generation had no text content to send (voice quality gate likely exhausted retries on a failing reply). AI is now paused on this conversation. Please review and take over.`,
        details: 'Empty AI output at ship time',
        link
      });
    } catch (err) {
      console.error(
        '[webhook-processor] Empty-message escalation bookkeeping failed (non-fatal):',
        err
      );
    }
    return;
  }

  const joinedAtShip = bubblesForEmptyCheck
    .filter((b): b is string => typeof b === 'string')
    .join(' ');

  // ── Ship-time R34 metadata leak guard (P0) ────────────────────
  // Parser + voice gates should catch structured metadata leaks before
  // this point, but delivery must fail closed. Internal fields like
  // stage_confidence:1.0, quality_score, stage:, intent:, JSON
  // fragments, or placeholders can never reach Instagram/Facebook.
  const metadataLeakAtShip = detectMetadataLeak(joinedAtShip);
  if (metadataLeakAtShip.leak) {
    console.error(
      `[webhook-processor] r34_metadata_leak_at_ship for conv ${conversationId} — AI output still contained "${metadataLeakAtShip.matchedText}" after retry loop. Pausing AI, notifying operator, no platform send.`
    );
    try {
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
        data: {
          awaitingAiResponse: false,
          awaitingSince: null
        }
      });
      await prisma.voiceQualityFailure
        .create({
          data: {
            accountId: lead.accountId,
            message: joinedAtShip.slice(0, 1000),
            score: 0,
            hardFails: [
              `r34_metadata_leak_at_ship: matched "${metadataLeakAtShip.matchedText}" via ${metadataLeakAtShip.matchedPattern}`
            ],
            attempt: 999,
            leadMessage: null
          }
        })
        .catch(() => {});
      const { escalate } = await import('@/lib/escalation-dispatch');
      const origin = process.env.NEXT_PUBLIC_APP_URL || '';
      const link = origin
        ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
        : undefined;
      await escalate({
        type: 'ai_stuck',
        accountId: lead.accountId,
        leadId: lead.id,
        conversationId,
        leadName: lead.name,
        leadHandle: lead.handle,
        title: 'AI produced internal metadata — human takeover required',
        body: `${lead.name} (@${lead.handle}): the AI's last generation contained internal metadata (${metadataLeakAtShip.matchedText ?? 'unknown metadata'}) that cannot reach the lead. Send was blocked before delivery. Please review and take over.`,
        details: `R34 metadata leak at ship: "${metadataLeakAtShip.matchedText ?? 'unknown'}"`,
        link
      });
    } catch (err) {
      console.error(
        '[webhook-processor] R34 metadata leak escalation bookkeeping failed (non-fatal):',
        err
      );
    }
    return;
  }

  // ── Ship-time R24 backstop ────────────────────────────────────
  // R24 runs in ai-engine before send and should regenerate failed-
  // capital booking pitches into a downsell/clarifier. This final
  // check makes the send path fail-closed if a future retry/fallback
  // regression leaves a call proposal in the outgoing text after the
  // capital gate has already marked the lead below threshold.
  if (result.capitalOutcome === 'failed') {
    const badPitchMatch = matchFailedCapitalBookingPitch(joinedAtShip);
    if (badPitchMatch) {
      console.error(
        `[webhook-processor] r24_failed_call_pitch_at_ship for conv ${conversationId} — capitalOutcome=failed but outgoing text still contained "${badPitchMatch}". Pausing AI, notifying operator, no platform send.`
      );
      try {
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
          data: {
            awaitingAiResponse: false,
            awaitingSince: null
          }
        });
        const { escalate } = await import('@/lib/escalation-dispatch');
        const origin = process.env.NEXT_PUBLIC_APP_URL || '';
        const link = origin
          ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
          : undefined;
        await escalate({
          type: 'ai_stuck',
          accountId: lead.accountId,
          leadId: lead.id,
          conversationId,
          leadName: lead.name,
          leadHandle: lead.handle,
          title: 'R24 blocked failed-capital call pitch',
          body: `${lead.name} (@${lead.handle}): AI tried to send booking/call language after the capital gate marked the lead below threshold. Send was blocked before delivery. Please review and send the correct downsell manually.`,
          details: `R24 ship-time block: matched "${badPitchMatch}"`,
          link
        });
      } catch (err) {
        console.error(
          '[webhook-processor] R24 ship-time block bookkeeping failed (non-fatal):',
          err
        );
      }
      return;
    }
  }

  // ── Ship-time bracketed-placeholder guard (P0) ────────────────
  // Defense-in-depth: even though voice-quality-gate.ts's
  // bracketed_placeholder_leaked hard fail is supposed to block
  // this at generation time AND ai-engine.ts's retry-exhaustion
  // branch now escalates rather than ships on that hard fail,
  // we re-scan right before the platform send. [BOOKING LINK]
  // reaching a lead is a P0 (Steven Petty 2026-04-20) — the lead
  // cannot click a literal placeholder, the conversation is
  // broken, and we'd rather pause + notify than ship a dead
  // message.
  //
  // Pattern matches any [A-Z][A-Z0-9 _]{2+} token (same as the
  // voice-gate regex). Scans EVERY bubble in the group — if
  // any contains a placeholder, the entire send is blocked.
  const BRACKETED_PLACEHOLDER_AT_SHIP = /\[[A-Z][A-Z0-9 _]{2,}\]/;
  const placeholderBubble = bubblesForEmptyCheck.find(
    (b) => typeof b === 'string' && BRACKETED_PLACEHOLDER_AT_SHIP.test(b)
  );
  if (placeholderBubble) {
    const match = placeholderBubble.match(BRACKETED_PLACEHOLDER_AT_SHIP);
    console.error(
      `[webhook-processor] bracketed_placeholder_at_ship for conv ${conversationId} — AI output still contained "${match?.[0]}" after retry loop. Pausing AI, notifying operator, no platform send.`
    );
    try {
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
        data: {
          awaitingAiResponse: false,
          awaitingSince: null
        }
      });
      const { escalate } = await import('@/lib/escalation-dispatch');
      const origin = process.env.NEXT_PUBLIC_APP_URL || '';
      const link = origin
        ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
        : undefined;
      await escalate({
        type: 'ai_stuck',
        accountId: lead.accountId,
        leadId: lead.id,
        conversationId,
        leadName: lead.name,
        leadHandle: lead.handle,
        title: 'AI produced bracketed placeholder — human takeover required',
        body: `${lead.name} (@${lead.handle}): the AI's last generation contained a literal placeholder token (${match?.[0] ?? '[PLACEHOLDER]'}) that cannot reach the lead — typically "[BOOKING LINK]" or similar. AI is now paused on this conversation. Please review and send the correct URL manually.`,
        details: `Placeholder leaked: "${match?.[0] ?? '[PLACEHOLDER]'}"`,
        link
      });
    } catch (err) {
      console.error(
        '[webhook-processor] Bracketed-placeholder escalation bookkeeping failed (non-fatal):',
        err
      );
    }
    return;
  }

  // ── Ship-time link-promise-without-url guard (P0) ─────────────
  // Parallel to the bracketed-placeholder guard. Voice-quality-gate
  // and ai-engine's retry-exhaustion branch SHOULD catch this at
  // generation time (escalateToHuman=true), but that flag is
  // handled AFTER the platform send downstream — meaning an
  // unshippable link-promise reply still ships. This is the
  // Jonathan Frimpong 2026-04-23 incident: AI said "i'm gonna send
  // you the link to apply for the call with the closer" with no URL,
  // gate flagged it, retries exhausted, escalateToHuman=true set,
  // yet the message shipped anyway and the lead sat waiting.
  //
  // Uses the same regex family as voice-quality-gate.ts's
  // LINK_PROMISE_PATTERNS + containsUrl check. If any bubble
  // announces a link-send but no URL is anywhere in the joined
  // group, block the send.
  const LINK_PROMISE_AT_SHIP: RegExp[] = [
    /\b(i'?ll|lemme|let\s+me|gonna|going\s+to|about\s+to|i'?m\s+(gonna|going\s+to|about\s+to))\s+(send|drop|shoot|share|grab|get)\s+(you\s+)?(the\s+|a\s+|this\s+|your\s+|my\s+)?(link|url|application|typeform|form|booking\s+link|booking\s+url)\b/i,
    /\b(sending|dropping|shooting|sharing|grabbing)\s+(you\s+)?(the\s+|a\s+|this\s+|your\s+|my\s+)?(link|url|application|typeform|form|booking\s+link|booking\s+url)\b/i,
    /\bhere'?s\s+(the\s+|a\s+|your\s+|my\s+)?(link|url|application|booking\s+link|typeform|form)\b/i,
    /\b(send|drop|shoot)\s+you\s+the\s+link\b/i
  ];
  const hasUrlAtShip = /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/i.test(joinedAtShip);
  const linkPromiseMatch = !hasUrlAtShip
    ? LINK_PROMISE_AT_SHIP.map((pat) => joinedAtShip.match(pat)).find(
        (m) => m !== null
      )
    : null;
  if (linkPromiseMatch) {
    console.error(
      `[webhook-processor] link_promise_without_url_at_ship for conv ${conversationId} — AI output announced "${linkPromiseMatch[0]}" but no URL is present. Pausing AI, notifying operator, no platform send.`
    );
    try {
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
        data: {
          awaitingAiResponse: false,
          awaitingSince: null
        }
      });
      const { escalate } = await import('@/lib/escalation-dispatch');
      const origin = process.env.NEXT_PUBLIC_APP_URL || '';
      const link = origin
        ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
        : undefined;
      await escalate({
        type: 'ai_stuck',
        accountId: lead.accountId,
        leadId: lead.id,
        conversationId,
        leadName: lead.name,
        leadHandle: lead.handle,
        title:
          'AI promised a link without including URL — human takeover required',
        body: `${lead.name} (@${lead.handle}): the AI's last generation announced sending a link ("${linkPromiseMatch[0]}") but did not include the actual URL. Lead would be left waiting. AI is now paused on this conversation. Please review and send the correct link manually.`,
        details: `Link promise without URL: "${linkPromiseMatch[0]}"`,
        link
      });
    } catch (err) {
      console.error(
        '[webhook-processor] Link-promise-without-url escalation bookkeeping failed (non-fatal):',
        err
      );
    }
    return;
  }

  // ── Ship-time markdown observer (soft, 2026-04-30) ───────────
  // Was a hard pause + SYSTEM notif (P0 daetradez 2026-04-24); now
  // soft-fail best-effort: write a bookingRoutingAudit row so the
  // dashboard surfaces an amber Action Required item, ship the
  // bubbles as-is, AI stays active. Lead may see literal asterisks
  // — readable but ugly — and ops review during their daily check.
  // Trade-off: fewer cold pauses for cosmetic formatting failures
  // vs. occasional broken-looking messages reaching the lead.
  const MARKDOWN_NUMBERED_BOLD = /^\s*\d+\.\s+\*\*/m;
  const MARKDOWN_HEADER_LINE = /(^|\n)\s{0,3}#{1,6}\s/;
  const markdownBubble = bubblesForEmptyCheck.find(
    (b) =>
      typeof b === 'string' &&
      (MARKDOWN_NUMBERED_BOLD.test(b) || MARKDOWN_HEADER_LINE.test(b))
  );
  if (markdownBubble) {
    console.warn(
      `[webhook-processor] markdown_in_single_bubble_at_ship for conv ${conversationId} — sending best effort, logging audit row for dashboard review`
    );
    try {
      await prisma.bookingRoutingAudit.create({
        data: {
          conversationId,
          accountId: lead.accountId,
          routingAllowed: false,
          regenerationForced: false,
          blockReason: 'gate_exhausted_sent_best_effort',
          aiStageReported: result.stage || null,
          aiSubStageReported: `gate=markdown_at_ship${result.subStage ? '|' + result.subStage : ''}`,
          contentPreview:
            typeof markdownBubble === 'string'
              ? markdownBubble.slice(0, 200)
              : null
        }
      });
    } catch (auditErr) {
      console.error(
        '[webhook-processor] markdown_at_ship audit write failed (non-fatal):',
        auditErr
      );
    }
    // Fall through — no return, no pause, no notification. The send
    // path below ships the bubbles as the LLM produced them.
  }

  // ── Dedup safety net ──────────────────────────────────────────
  // Last-line defense against near-duplicate sends that slip through the
  // debounce + cancel-pending + 25s recency guard. Uses the shared
  // `isNearDuplicateOfRecentAiMessages` helper so scheduled-message /
  // keepalive crons apply the same 85% Jaccard threshold against the
  // last 3 AI messages.
  const dedup = await isNearDuplicateOfRecentAiMessages(
    conversationId,
    result.reply
  );
  if (dedup.isDuplicate) {
    console.warn(
      `[webhook-processor] duplicate_suppressed ${conversationId} — sim=${dedup.maxSimilarity.toFixed(2)} vs prior AI msg. Not sending: "${result.reply.slice(0, 80)}"`
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
    await prisma.conversation
      .update({
        where: { id: conversationId },
        data: { awaitingAiResponse: false, awaitingSince: null }
      })
      .catch(() => null);
    return;
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

  let deliveredReplyText = result.reply;
  let deliveredAt = now;

  if (useMultiBubble) {
    // ── Multi-bubble path ────────────────────────────────────────
    const groupResult = await deliverBubbleGroup({
      conversationId,
      lead,
      bubbles: result.messages,
      result,
      now
    });
    deliveredReplyText = result.messages
      .slice(0, groupResult.delivered)
      .join('\n');
    if (groupResult.failedAt) {
      console.warn(
        `[webhook-processor] Multi-bubble group ${groupResult.groupId} failed after ${groupResult.delivered}/${result.messages.length} bubbles delivered`
      );
    }
  } else {
    // ── Single-message path (legacy, voice-note compatible) ──────
    const delivered = await deliverSingleAIMessage({
      conversationId,
      accountId,
      lead,
      result,
      now,
      libraryVN
    });
    if (!delivered) return;
    deliveredReplyText = delivered.content;
    deliveredAt = delivered.timestamp;
  }

  // ── Link AISuggestion as selected ──────────────────────────────
  // finalSentText carries the text Meta confirmed. For multi-bubble
  // partial delivery, only delivered bubbles are marked selected.
  if (result.suggestionId) {
    try {
      await prisma.aISuggestion.update({
        where: { id: result.suggestionId },
        data: {
          wasSelected: true,
          finalSentText: deliveredReplyText
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
    data: {
      lastMessageAt: deliveredAt,
      awaitingAiResponse: false,
      awaitingSince: null
    }
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
  if (result.leadEmail) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { email: result.leadEmail.toLowerCase() }
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

  // ── Typeform screened-out safety net ──────────────────────────
  // Normal live flow handles this pre-generation in
  // processIncomingMessage. This branch covers any path that entered
  // generateReply directly and returned the deterministic screen-out
  // response.
  if (result.typeformFilledNoBooking) {
    const latestLead = await prisma.message.findFirst({
      where: { conversationId, sender: 'LEAD' },
      orderBy: { timestamp: 'desc' },
      select: { id: true, timestamp: true }
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        outcome: 'UNQUALIFIED_REDIRECT',
        awaitingAiResponse: false,
        awaitingSince: null,
        typeformFilledNoBooking: true,
        typeformFilledNoBookingAt: latestLead?.timestamp ?? now,
        typeformFilledNoBookingMessageId: latestLead?.id ?? null
      }
    });
    await transitionLeadStage(
      lead.id,
      'UNQUALIFIED',
      'ai',
      'typeform_no_booking'
    ).catch((err) =>
      console.error(
        '[webhook-processor] typeform_no_booking safety transition failed (non-fatal):',
        err
      )
    );
    await applyAutoTags(
      lead.accountId,
      lead.id,
      ['typeform-screened-out'],
      1.0
    ).catch((err) =>
      console.error(
        '[webhook-processor] typeform_no_booking safety tag failed (non-fatal):',
        err
      )
    );
    await prisma.scheduledReply.updateMany({
      where: { conversationId, status: 'PENDING' },
      data: { status: 'CANCELLED' }
    });
    await prisma.scheduledMessage.updateMany({
      where: { conversationId, status: 'PENDING' },
      data: { status: 'CANCELLED' }
    });
    console.log(
      `[webhook-processor] Typeform no-booking screen-out finalized for ${conversationId}`
    );
  }

  // ── Handle soft exit ──────────────────────────────────────────
  if (result.softExit && !result.typeformFilledNoBooking) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        outcome: 'SOFT_EXIT',
        awaitingAiResponse: false,
        awaitingSince: null
      }
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
        data: {
          awaitingAiResponse: false,
          awaitingSince: null
        }
      });
      const { escalate } = await import('@/lib/escalation-dispatch');
      const origin = process.env.NEXT_PUBLIC_APP_URL || '';
      const link = origin
        ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversationId}`
        : undefined;
      await escalate({
        type: 'ai_stuck',
        accountId: lead.accountId,
        leadId: lead.id,
        conversationId,
        leadName: lead.name,
        leadHandle: lead.handle,
        title: 'AI escalated conversation — needs human',
        body: `${lead.name} (@${lead.handle}): AI hit an escalation condition (stuck loop or repeat issue). AI is now paused. Please review the conversation and take over.`,
        details: 'R20 escalateToHuman set by ai-engine retry loop',
        link
      });
      console.log(
        `[webhook-processor] R20 escalation to human for ${conversationId} — AI paused, escalation dispatched`
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

  console.log(
    `[webhook-processor] AI reply sent for conversation ${conversationId} | stage: ${result.stage}`
  );

  // ── Silent-lead follow-up sequence + booking-link check-in ─────
  // After a successful AI ship, we schedule two independent things:
  //
  //   1. FOLLOW_UP_1 in 12h. If the lead stays silent, the cron fires
  //      FOLLOW_UP_1 and cascades FOLLOW_UP_2 / _3 / _SOFT_EXIT. Any
  //      incoming LEAD message cancels the chain via
  //      cancelAllPendingFollowUps (called in processIncomingMessage).
  //   2. BOOKING_LINK_FOLLOWUP in 30min — only when the shipped text
  //      contains the Typeform booking URL. "did you get a chance to
  //      fill that out?"
  //
  // Gated on "shipped ok": we look at the conversation's latest message
  // and only schedule if it's AI, recent, and matches the reply content.
  // This avoids scheduling when every send path above bailed (token
  // invalid, voice note blocked, etc.) — in those cases the Message row
  // was either never created or already deleted.
  try {
    const latestAfterShip = await prisma.message.findFirst({
      where: { conversationId, sender: 'AI', deletedAt: null },
      orderBy: { timestamp: 'desc' },
      select: { id: true, content: true, timestamp: true }
    });
    const shippedRecently =
      latestAfterShip &&
      Date.now() - latestAfterShip.timestamp.getTime() < 60_000;
    if (shippedRecently) {
      const {
        scheduleFollowUp1AfterAiMessage,
        containsBookingLink,
        scheduleBookingLinkFollowup
      } = await import('@/lib/follow-up-sequence');

      // Re-fetch the lead's CURRENT stage + conversation outcome so the
      // gate sees the post-ship state (result.softExit just flipped
      // outcome=SOFT_EXIT a few lines above; UNQUALIFIED may have been
      // set during this same turn by transitionLeadStage). Avoids
      // racing the in-memory `lead.stage` snapshot taken pre-generation.
      const stateAfterShip = await prisma.lead.findUnique({
        where: { id: lead.id },
        select: { stage: true, conversation: { select: { outcome: true } } }
      });
      const gate = {
        leadStage: stateAfterShip?.stage ?? lead.stage,
        softExit: result.softExit === true,
        conversationOutcome: stateAfterShip?.conversation?.outcome ?? null,
        replyText: latestAfterShip.content
      };

      await scheduleFollowUp1AfterAiMessage(
        conversationId,
        lead.accountId,
        gate
      );
      if (containsBookingLink(latestAfterShip.content)) {
        await scheduleBookingLinkFollowup(conversationId, lead.accountId, gate);
      }
    }
  } catch (err) {
    console.error(
      '[webhook-processor] follow-up scheduling failed (non-fatal):',
      err
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Process Admin/Human Message (from webhook echo or page-sent message)
// ---------------------------------------------------------------------------

export interface AdminMessageParams {
  accountId: string;
  platformUserId: string; // The lead's platform user ID (recipient of admin message)
  candidatePlatformUserIds?: string[]; // Defensive FB echo sender/recipient variants
  platform: 'INSTAGRAM' | 'FACEBOOK';
  messageText: string;
  /**
   * Voice note CDN URL for operator-sent audio (FAILURE A 2026-05-02).
   * When present, the saved Message row is tagged isVoiceNote=true and
   * voiceNoteUrl=<this>. The cancel-pending-replies path runs as
   * normal so the AI doesn't fire on top of the operator's audio.
   */
  audioUrl?: string;
  platformMessageId?: string;
}

function looksLikeManyChatAutomationEcho(
  conversation: {
    source?: string | null;
    manyChatOpenerMessage?: string | null;
    awaitingAiResponse?: boolean | null;
  },
  messageText: string
): boolean {
  if (conversation.source !== 'MANYCHAT') return false;
  const trimmed = messageText.trim();
  if (!trimmed) return false;

  const opener = conversation.manyChatOpenerMessage?.trim();
  if (opener && trimmed === opener) return true;

  // Existing hardcoded shapes for daetradez's current sequence — keep
  // them as a fast positive match alongside the state-based fallback so
  // the detector still works even if `awaitingAiResponse` is in a
  // transient true state during a race.
  const matchesKnownShape = [
    /\bthis\s+is\s+gonna\s+make\s+you\s+dangerous\b/i,
    /\bminutes?\s+of\s+sauce\b/i,
    /\bdid\s+you\s+give\s+it\s+a\s+watch\b/i
  ].some((pattern) => pattern.test(trimmed));
  if (matchesKnownShape) return true;

  // State-based fallback: while a MANYCHAT-source conversation has not
  // been handed off to AI yet (either via the manychat-complete webhook
  // or the time-based heartbeat fallback), any echo with no matching
  // mid in our DB is most likely a ManyChat-sent automation message —
  // a sequence step we don't have hardcoded text for. Tag it MANYCHAT.
  //
  // Trade-off accepted: an operator messaging the lead from IG mobile
  // during this window also gets tagged MANYCHAT. The window is short
  // (sequence runs ~30 min) and self-clears once `awaitingAiResponse`
  // flips to true, after which operator messages resume HUMAN tagging.
  return conversation.awaitingAiResponse === false;
}

/**
 * Soft-delete a Message in response to an external deletion event —
 * either the lead unsent on Instagram (`deletedBy='LEAD'`,
 * `deletedSource='INSTAGRAM'`) or a future Facebook equivalent. The
 * row stays in the DB so the operator can see "this was deleted at
 * X" rather than "this never existed"; the UI greys out / labels
 * deleted messages.
 *
 * Idempotent: re-firing on a row that's already marked deleted is a
 * no-op (we don't update `deletedAt` on subsequent webhooks for the
 * same mid, otherwise Meta retries would shift the timestamp).
 *
 * Returns true when a row was actually flipped, false when the lookup
 * missed (mid we never saw — likely already-deleted-before-we-stored,
 * or an mid for a different account on a multi-tenant proxy) or when
 * the row was already soft-deleted.
 */
export async function processMessageDeletion(params: {
  accountId: string;
  platformMessageId: string;
  deletedBy: string;
  deletedSource: 'INSTAGRAM' | 'FACEBOOK';
  deletedAt?: Date;
}): Promise<boolean> {
  const trimmed = (params.platformMessageId || '').trim();
  if (!trimmed) return false;

  // Scope by accountId to defend against cross-tenant collisions on
  // platformMessageId (Meta mid uniqueness isn't guaranteed across
  // unrelated pages, and we have a `@@unique([conversationId,
  // platformMessageId])` not a global one).
  const message = await prisma.message.findFirst({
    where: {
      platformMessageId: trimmed,
      conversation: { lead: { accountId: params.accountId } }
    },
    select: { id: true, conversationId: true, deletedAt: true }
  });
  if (!message) {
    console.log(
      `[webhook-processor] processMessageDeletion: no Message row for mid=${trimmed} on account ${params.accountId} — skipping`
    );
    return false;
  }
  if (message.deletedAt) {
    return false;
  }

  const when = params.deletedAt ?? new Date();
  await prisma.message.update({
    where: { id: message.id },
    data: {
      deletedAt: when,
      deletedBy: params.deletedBy,
      deletedSource: params.deletedSource
    }
  });

  // Realtime broadcast so any open dashboard tab on this account
  // greys-out the bubble immediately.
  try {
    const { broadcastMessageDeleted } = await import('@/lib/realtime');
    broadcastMessageDeleted(params.accountId, {
      id: message.id,
      conversationId: message.conversationId,
      deletedAt: when.toISOString(),
      deletedBy: params.deletedBy,
      deletedSource: params.deletedSource
    });
  } catch (err) {
    console.warn(
      '[webhook-processor] broadcastMessageDeleted failed (non-fatal):',
      err
    );
  }

  console.log(
    `[webhook-processor] Soft-deleted message ${message.id} on conversation ${message.conversationId} (mid=${trimmed}, source=${params.deletedSource}, by=${params.deletedBy})`
  );
  return true;
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
    candidatePlatformUserIds = [],
    platform,
    messageText,
    audioUrl,
    platformMessageId
  } = params;

  const leadIdCandidates = Array.from(
    new Set([platformUserId, ...candidatePlatformUserIds].filter(Boolean))
  );
  console.log('processAdminMessage candidates:', leadIdCandidates);

  // Find existing lead by any plausible platformUserId. Facebook echo
  // payloads are documented as sender=PAGE_ID / recipient=LEAD_PSID, but
  // standby/handover deliveries can vary. Trying both non-page IDs prevents
  // a native Page Inbox reply from being dropped before it reaches history.
  const lead = await prisma.lead.findFirst({
    where: {
      accountId,
      platformUserId: { in: leadIdCandidates },
      platform: platform as any
    },
    include: { conversation: true }
  });
  console.log('conversation found:', lead?.conversation?.id ?? null);

  if (!lead?.conversation) {
    console.log(
      `[webhook-processor] Admin message for unknown lead candidates=[${leadIdCandidates.join(',')}] platform=${platform} — skipping`
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

  // ── Our-own-send echo detection (AI + HUMAN) ──────────────────────
  // When WE send a reply via the Instagram / Facebook Send API, Meta
  // echoes it back as an admin message (is_echo=true). If our originally-
  // saved Message row is missing a platformMessageId (because the
  // fire-and-forget patch hasn't committed yet, or Meta's return was
  // lost), the platformMessageId dedup above won't catch it. Fall back
  // to content matching.
  //
  // Widened on 2026-04-21 to include HUMAN in addition to AI. Before:
  // only AI echoes were deduped; Daniel's manual HUMAN send got
  // duplicated because its echo matched nothing. After: we look for
  // any recent OWN-SIDE message (AI or HUMAN) and dedup against both.
  //
  // Compare on TRIMMED content — Meta strips trailing whitespace from
  // echoes, so a 1-char trailing-space difference was enough to bust
  // the exact-match dedup (daetradez @l.galeza 2026-04-18 16:44).
  //
  // Widened from 60s → 10min on 2026-04-26 (daetradez Facebook echo
  // diagnostic). Empirical: FB AI rows have platformMessageId
  // backfilled 47% of the time vs IG's 96%. The bulk of the missing
  // 53% are echoes arriving outside the 60s window — Meta's FB
  // Messenger routing through standby/handover adds latency that
  // exceeded the original 1-minute cap. 10 minutes is generous
  // enough to cover any plausible Meta delivery delay, and the
  // false-positive risk (two byte-identical AI sends within 10min
  // colliding) is vanishingly small in practice.
  const echoSearchWindow = new Date(Date.now() - 10 * 60 * 1000);
  const trimmedIncoming = (messageText ?? '').trim();
  const recentOwnMessages = await prisma.message.findMany({
    where: {
      conversationId,
      sender: { in: ['AI', 'HUMAN'] },
      timestamp: { gte: echoSearchWindow }
    },
    orderBy: { timestamp: 'desc' }
  });
  const recentOwnMessage = recentOwnMessages.find(
    (m) => m.content.trim() === trimmedIncoming
  );

  if (recentOwnMessage) {
    // Link the platform message ID to the existing own-side message so
    // future dedup lookups find it directly.
    if (platformMessageId && !recentOwnMessage.platformMessageId) {
      await prisma.message.update({
        where: { id: recentOwnMessage.id },
        data: { platformMessageId }
      });
    }
    console.log(
      `[webhook-processor] Admin message is echo of own ${recentOwnMessage.sender} message ${recentOwnMessage.id} — skipping duplicate save`
    );
    return;
  }

  if (looksLikeManyChatAutomationEcho(lead.conversation, messageText)) {
    const message = await prisma.message.create({
      data: {
        conversationId,
        sender: 'MANYCHAT',
        content: messageText,
        timestamp: new Date(),
        platformMessageId: platformMessageId || null,
        systemPromptVersion: 'manychat-automation',
        // Capture the audio URL on the row so the downstream Whisper
        // transcription can pick it up. Previously the URL was dropped
        // here and ManyChat-sent voice notes were 100% un-transcribed —
        // the AI saw `[Voice note]` with no content and shipped
        // generic "couldn't catch the audio" replies. (@andreierz
        // 2026-05-05)
        isVoiceNote: Boolean(audioUrl),
        voiceNoteUrl: audioUrl ?? null,
        msgSource: 'MANYCHAT_FLOW'
      }
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        // Note: do NOT touch `aiActive` here — the ManyChat sequence is
        // still running. AI takeover happens via the manychat-complete
        // endpoint or the time-based heartbeat fallback.
        lastMessageAt: message.timestamp
      }
    });
    if (audioUrl) {
      // Mirror the lead-side transcription path
      // (processIncomingMessage → enqueueInboundMediaProcessing). We
      // need a personaId for the Supabase Storage path; ManyChat
      // echoes don't carry one, so resolve to the account's most
      // recent persona. Storage namespace is per-persona, not
      // semantically tied to ManyChat-vs-lead, so any valid persona
      // for the account is fine.
      try {
        const personaForMedia = await prisma.aIPersona.findFirst({
          where: { accountId },
          orderBy: { createdAt: 'desc' },
          select: { id: true }
        });
        if (personaForMedia) {
          await enqueueInboundMediaProcessing({
            accountId,
            personaId: personaForMedia.id,
            conversationId,
            messageId: message.id,
            mediaType: 'audio',
            sourceUrl: audioUrl,
            durationSeconds: null
          });
        } else {
          console.warn(
            `[webhook-processor] ManyChat echo audio for ${conversationId} not transcribed: no persona for account ${accountId}`
          );
        }
      } catch (mediaErr) {
        console.error(
          `[webhook-processor] ManyChat echo transcription failed for ${conversationId}:`,
          mediaErr
        );
      }
    }
    await prisma.scheduledReply.updateMany({
      where: { conversationId, status: 'PENDING' },
      data: { status: 'CANCELLED' }
    });
    broadcastNewMessage(accountId, {
      id: message.id,
      conversationId,
      sender: 'MANYCHAT',
      content: messageText,
      platformMessageId: platformMessageId || null,
      timestamp: message.timestamp.toISOString()
    });
    console.log(
      `[webhook-processor] ManyChat automation echo saved as MANYCHAT for conversation ${conversationId} (voiceNote=${Boolean(audioUrl)})`
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

  // Save as HUMAN message (genuinely sent by a human admin).
  // humanSource='PHONE' — this message came via Meta's echo webhook,
  // i.e. the operator typed it in the native Instagram / Messenger
  // app on their phone rather than through QualifyDMs. The UI uses
  // this to render a "from phone" badge.
  const message = await prisma.message.create({
    data: {
      conversationId,
      sender: 'HUMAN',
      content: messageText,
      timestamp: new Date(),
      platformMessageId: platformMessageId || null,
      humanSource: 'PHONE',
      isVoiceNote: Boolean(audioUrl),
      voiceNoteUrl: audioUrl ?? null,
      isHumanOverride,
      rejectedAISuggestionId,
      editedFromSuggestion,
      loggedDuringTrainingPhase,
      msgSource: 'HUMAN_OVERRIDE'
    }
  });
  console.log('message saved:', message.id);

  // Transcribe operator-sent voice notes the same way we transcribe
  // lead-sent ones (processIncomingMessage at line ~1000-1023). The
  // resulting transcription lands on the row so the next AI
  // generation sees the operator's actual words instead of a bare
  // [Voice note] placeholder. Without this, an operator dropping a
  // 30-second context voice note from their phone got entirely
  // ignored by the next AI turn.
  if (audioUrl) {
    try {
      const personaForMedia = await prisma.aIPersona.findFirst({
        where: { accountId },
        orderBy: { createdAt: 'desc' },
        select: { id: true }
      });
      if (personaForMedia) {
        await enqueueInboundMediaProcessing({
          accountId,
          personaId: personaForMedia.id,
          conversationId,
          messageId: message.id,
          mediaType: 'audio',
          sourceUrl: audioUrl,
          durationSeconds: null
        });
      } else {
        console.warn(
          `[webhook-processor] HUMAN/PHONE echo audio for ${conversationId} not transcribed: no persona for account ${accountId}`
        );
      }
    } catch (mediaErr) {
      console.error(
        `[webhook-processor] HUMAN/PHONE echo transcription failed for ${conversationId}:`,
        mediaErr
      );
    }
  }

  // Bump lastMessageAt but do NOT auto-pause the AI on a single echo.
  // Previous behavior flipped aiActive=false on every echo, which was
  // too aggressive — an operator dropping one context message from
  // their phone doesn't necessarily want to take over the whole
  // conversation. If they DO want to pause, the dashboard toggle is
  // one click. Pending queues (scheduledReply, scheduledMessage
  // follow-ups) ARE still cancelled below because a human just spoke
  // — a redundant AI queue would cause duplicate sends (daetradez
  // 7:58 PM 2026-04-24 incident).
  //
  // Heuristic addition (2026-04-25): if 2+ HUMAN/PHONE messages land
  // back-to-back with no LEAD reply between them, the operator HAS
  // clearly taken over (they aren't dropping single context lines —
  // they're driving the conversation). At that point we auto-pause
  // aiActive so the next inbound LEAD reply doesn't trigger an AI
  // turn that would cross-talk over the human. Single PHONE message
  // = context only; consecutive PHONE messages = takeover.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: new Date(),
      awaitingAiResponse: false,
      awaitingSince: null,
      awaitingHumanReview: false
    }
  });

  let autoPausedFromConsecutivePhone = false;
  try {
    const previousMessage = await prisma.message.findFirst({
      where: { conversationId, id: { not: message.id } },
      orderBy: { timestamp: 'desc' },
      select: { sender: true, humanSource: true }
    });
    const isConsecutivePhone =
      previousMessage?.sender === 'HUMAN' &&
      previousMessage.humanSource === 'PHONE';
    if (isConsecutivePhone) {
      // Re-fetch the conversation aiActive in a single update (avoid a
      // wasted update if it's already false from another path — e.g.
      // distress, scheduling-conflict, manual operator pause).
      const updated = await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          awaitingAiResponse: false,
          awaitingSince: null
        },
        select: { aiActive: true }
      });
      autoPausedFromConsecutivePhone = true;
      console.log(
        `[webhook-processor] 2+ consecutive HUMAN/PHONE messages on ${conversationId} — auto-paused AI (human takeover detected, aiActive=${updated.aiActive})`
      );
    }
  } catch (err) {
    console.error(
      '[webhook-processor] consecutive-PHONE auto-pause check failed (non-fatal):',
      err
    );
  }

  // Cancel any pending scheduled replies for this conversation
  await prisma.scheduledReply.updateMany({
    where: { conversationId, status: 'PENDING' },
    data: { status: 'CANCELLED' }
  });

  // Cancel any pending follow-up cascade rows (BOOKING_LINK_FOLLOWUP /
  // FOLLOW_UP_*). If a human operator has just sent a manual message,
  // the AI follow-up queue is redundant — letting it fire produces
  // duplicate "did you book that call?" messages (daetradez 2026-04-24
  // incident). Mirrors the LEAD-reply cancellation in
  // processIncomingMessage.
  try {
    const { cancelAllPendingFollowUps } = await import(
      '@/lib/follow-up-sequence'
    );
    await cancelAllPendingFollowUps(conversationId);
  } catch (err) {
    console.error(
      '[webhook-processor] cancelAllPendingFollowUps on HUMAN send failed (non-fatal):',
      err
    );
  }

  // Broadcast real-time events. broadcastNewMessage always; the
  // AI-status-change broadcast is conditional on the consecutive-
  // PHONE auto-pause having flipped the flag (otherwise nothing
  // changed).
  broadcastNewMessage(accountId, {
    id: message.id,
    conversationId,
    sender: 'HUMAN',
    content: messageText,
    humanSource: 'PHONE',
    platformMessageId: platformMessageId || null,
    timestamp: message.timestamp.toISOString()
  });
  console.log('SSE broadcast message:new:', {
    conversationId,
    messageId: message.id,
    sender: 'HUMAN',
    humanSource: 'PHONE'
  });
  if (autoPausedFromConsecutivePhone) {
  }

  console.log(
    `[webhook-processor] Admin message saved for conversation ${conversationId} (humanSource=PHONE, autoPaused=${autoPausedFromConsecutivePhone})`
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
  broadcastAIStatusChange(accountId, { conversationId, aiActive: true });

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
// LEGACY (pre-2026-05-05): when an operator flipped per-conversation
// `aiActive` on for a chat BEFORE flipping the platform-level away-mode on,
// the dual-gate `shouldAutoSend = aiActive && (awayMode || autoSendOverride)`
// evaluated to false and the generated reply got stranded as an
// AISuggestion row instead of shipping. Later when the operator flipped
// the platform on, this rescue swept those orphans and re-fired them.
//
// CURRENT (2026-05-05+): the dual-gate is gone. Send decision is now
// `aiActive` alone. New orphans of this exact shape can no longer be
// produced. The rescue is kept for two reasons:
//   1. legacy orphans accrued before the policy change still benefit
//      from a sweep when the operator notices and flips away-mode
//   2. defense-in-depth against any future unintentional re-coupling
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
      where: {
        conversationId: orphan.conversationId,
        sender: { not: 'SYSTEM' },
        deletedAt: null
      },
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

// (handleGeographyDisqualification removed 2026-04-30 — geography
// gate retired. Replaced by smarter capital-qualification signals in
// ai-engine.ts.)

// ---------------------------------------------------------------------------
// Helper: Typeform filled but no booking slot
// ---------------------------------------------------------------------------
// Expected screened-out path. The lead completed some/all of the Typeform
// but could not report a booked day/time after the AI asked for it. Do not
// create Action Required; close the conversation gracefully.

interface HandleTypeformFilledNoBookingParams {
  conversationId: string;
  leadId: string;
  accountId: string;
  platform: string;
  platformUserId: string | null;
  inboundMessageId: string;
  inboundContent: string;
  inboundImageUrl: string | null;
  inboundHasImage: boolean;
  inboundAt: Date;
  unreadCount: number;
}

async function handleTypeformFilledNoBookingScreenOut(
  p: HandleTypeformFilledNoBookingParams
): Promise<void> {
  await prisma.conversation.update({
    where: { id: p.conversationId },
    data: {
      awaitingAiResponse: false,
      awaitingSince: null,
      outcome: 'UNQUALIFIED_REDIRECT',
      typeformFilledNoBooking: true,
      typeformFilledNoBookingAt: p.inboundAt,
      typeformFilledNoBookingMessageId: p.inboundMessageId
    }
  });

  try {
    await transitionLeadStage(
      p.leadId,
      'UNQUALIFIED',
      'ai',
      'typeform_no_booking'
    );
  } catch (stageErr) {
    console.error(
      '[webhook-processor] typeform_no_booking transitionLeadStage failed (non-fatal):',
      stageErr
    );
  }

  try {
    await applyAutoTags(p.accountId, p.leadId, ['typeform-screened-out'], 1.0);
  } catch (tagErr) {
    console.error(
      '[webhook-processor] typeform_no_booking tag application failed (non-fatal):',
      tagErr
    );
  }

  try {
    await prisma.scheduledReply.updateMany({
      where: { conversationId: p.conversationId, status: 'PENDING' },
      data: { status: 'CANCELLED' }
    });
    await prisma.scheduledMessage.updateMany({
      where: { conversationId: p.conversationId, status: 'PENDING' },
      data: { status: 'CANCELLED' }
    });
    const { cancelAllPendingFollowUps } = await import(
      '@/lib/follow-up-sequence'
    );
    await cancelAllPendingFollowUps(p.conversationId);
  } catch (cancelErr) {
    console.error(
      '[webhook-processor] typeform_no_booking cancel pending messages failed (non-fatal):',
      cancelErr
    );
  }

  const exitMsg = await prisma.message.create({
    data: {
      conversationId: p.conversationId,
      sender: 'AI',
      content: TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE,
      timestamp: new Date(),
      stage: 'UNQUALIFIED',
      subStage: 'TYPEFORM_NO_BOOKING'
    }
  });

  if (p.platformUserId) {
    const ship = await shipTextToMeta(
      p.platform,
      p.accountId,
      p.platformUserId,
      TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE
    );
    if (ship.messageId) {
      await prisma.message
        .update({
          where: { id: exitMsg.id },
          data: { platformMessageId: ship.messageId }
        })
        .catch((err) =>
          console.error(
            '[webhook-processor] typeform_no_booking failed to patch platformMessageId (non-fatal):',
            err
          )
        );
    } else {
      console.error(
        '[webhook-processor] typeform_no_booking platform send failed (non-fatal):',
        ship.error
      );
    }
  }

  broadcastNewMessage(p.accountId, {
    id: p.inboundMessageId,
    conversationId: p.conversationId,
    sender: 'LEAD',
    content: p.inboundContent,
    imageUrl: p.inboundImageUrl,
    hasImage: p.inboundHasImage,
    timestamp: p.inboundAt.toISOString()
  });
  broadcastNewMessage(p.accountId, {
    id: exitMsg.id,
    conversationId: p.conversationId,
    sender: 'AI',
    content: TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE,
    timestamp: exitMsg.timestamp.toISOString()
  });
  broadcastConversationUpdate(p.accountId, {
    id: p.conversationId,
    leadId: p.leadId,
    unreadCount: p.unreadCount + 1,
    lastMessageAt: p.inboundAt.toISOString()
  });
  broadcastAIStatusChange(p.accountId, {
    conversationId: p.conversationId
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
    await prisma.leadTag.upsert({
      where: { leadId_tagId: { leadId, tagId: tag.id } },
      create: {
        leadId,
        tagId: tag.id,
        appliedBy: 'AI',
        confidence
      },
      update: { confidence }
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
        console.warn('[stale-regen] processScheduledReply regenerating fresh', {
          conversationId,
          storedCreatedAt: storedResult.createdAt?.toISOString(),
          newerLeadMsgId: newerLeadMsg.id,
          messageType: storedResult.messageType
        });
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
    await prisma.conversation
      .update({
        where: { id: conversationId },
        data: { awaitingAiResponse: false, awaitingSince: null }
      })
      .catch(() => null);
    return;
  }

  const { lead } = conversation;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = generatedResult as any;
  if (isTerminalQualityGateResult(result)) {
    const latestLead = await prisma.message.findFirst({
      where: { conversationId, sender: 'LEAD' },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true }
    });
    await escalateQualityGateFailure({
      conversationId,
      accountId,
      lead,
      result,
      latestLeadTimestamp: latestLead?.timestamp ?? null
    });
    throw new QualityGateEscalationError({
      conversationId,
      accountId,
      suggestionId: result.suggestionId ?? null,
      generatedResult: buildQualityGateGeneratedResult(result),
      hardFails: result.qualityGateHardFails ?? [],
      awaitingSince: latestLead?.timestamp ?? null
    });
  }

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
  // Same defaults as the inline path in scheduleAIReply — never fall
  // back to 0 (instant fire = bot tell). Operator's set value wins.
  const minDelay = Math.max(0, accountRow?.responseDelayMin ?? 45);
  const maxDelay = Math.max(minDelay, accountRow?.responseDelayMax ?? 120);
  if (maxDelay <= 0) return 0;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}
