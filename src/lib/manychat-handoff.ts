import prisma from '@/lib/prisma';
import { z } from 'zod';
import { resolveActivePersonaIdForCreate } from '@/lib/active-persona';

const MANYCHAT_TRIGGER_TYPES = [
  'new_follower',
  'comment',
  'story_reply',
  'post_dm',
  'other'
] as const;

export const manyChatHandoffSchema = z.object({
  // Coerce to string because ManyChat's variable picker outputs numeric
  // IDs as JSON numbers (not strings) for `user.id` — Zod's z.string()
  // would reject those without coercion. The schema validates min length
  // after coercion so we still reject empty values.
  instagramUserId: z.coerce.string().min(1),
  instagramUsername: z.string().min(1),
  openerMessage: z.string().min(1).max(2000),
  triggerType: z.enum(MANYCHAT_TRIGGER_TYPES),
  commentText: z.string().max(2000).optional(),
  postUrl: z.string().max(2000).optional(),
  manyChatSubscriberId: z.coerce.string().min(1),
  // Optional in the wire format — ManyChat doesn't always expose a ready
  // ISO-8601 timestamp variable in their picker. When absent, the
  // handler defaults to server-time `new Date()` (set in
  // processManyChatHandoff below). When present it must still be a
  // valid datetime so we don't ingest gibberish.
  firedAt: z.string().datetime().optional(),
  // Lead's button-click response inside the ManyChat flow (e.g. "Yes,
  // send it over!" — what they tapped after the opener). Button taps
  // are internal to ManyChat — they don't fire IG webhooks, so without
  // this field the conversation in QualifyDMs would show only the
  // opener and never the lead's first engagement signal. When the
  // operator wires a SECOND External Request in ManyChat right after
  // the button-click step, this field carries the button label back
  // and we insert it as a LEAD-side Message in the thread so the AI
  // sees it on its next turn.
  leadResponseText: z.string().min(1).max(2000).optional()
});

export type ManyChatHandoffPayload = z.infer<typeof manyChatHandoffSchema>;

interface ManyChatHandoffResult {
  ok: true;
  duplicate: boolean;
  accountId: string;
  leadId: string;
  conversationId: string;
}

export class ManyChatHandoffError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ManyChatHandoffError';
    this.status = status;
  }
}

export function cleanInstagramUsername(username: string): string {
  return username.replace(/^@+/, '').trim();
}

function looksLikeInstagramRecipientId(
  value: string,
  manyChatSubscriberId?: string
): boolean {
  const trimmed = value.trim();
  if (manyChatSubscriberId && trimmed === manyChatSubscriberId.trim()) {
    return false;
  }
  return /^\d{12,}$/.test(trimmed);
}

export async function processManyChatHandoff(params: {
  webhookKey: string | null;
  payload: unknown;
}): Promise<ManyChatHandoffResult> {
  const webhookKey = params.webhookKey?.trim();
  if (!webhookKey) {
    throw new ManyChatHandoffError('Missing X-QualifyDMs-Key', 401);
  }

  const account = await prisma.account.findUnique({
    where: { manyChatWebhookKey: webhookKey },
    select: { id: true, awayModeInstagram: true }
  });
  if (!account) {
    throw new ManyChatHandoffError('Invalid webhook key', 401);
  }

  const parsed = manyChatHandoffSchema.safeParse(params.payload);
  if (!parsed.success) {
    throw new ManyChatHandoffError('Invalid ManyChat payload', 400);
  }
  const payload = parsed.data;
  // ManyChat omits `firedAt` from many flow setups — see schema. Default
  // to server-time on the assumption the External Request fires within
  // milliseconds of the trigger event, which is true for ManyChat's
  // synchronous flow execution model.
  const firedAt = payload.firedAt ? new Date(payload.firedAt) : new Date();
  const handle = cleanInstagramUsername(payload.instagramUsername);
  const leadName = handle || payload.instagramUserId;
  let canSendViaInstagramApi = looksLikeInstagramRecipientId(
    payload.instagramUserId,
    payload.manyChatSubscriberId
  );
  const triggerSource =
    payload.triggerType === 'comment'
      ? payload.postUrl || 'manychat:comment'
      : `manychat:${payload.triggerType}`;

  const existingLead = await prisma.lead.findFirst({
    where: {
      accountId: account.id,
      platform: 'INSTAGRAM',
      OR: [
        { platformUserId: payload.instagramUserId },
        { handle: { equals: handle, mode: 'insensitive' } }
      ]
    },
    include: { conversation: true }
  });

  // Note: dedup is enforced at the Message level by ensureOpenerMessage and
  // ensureLeadResponseMessage (content-keyed). Earlier logic returned early
  // on any ManyChat handoff fired in the last hour, which silently dropped
  // legitimate follow-up events — most importantly the second External
  // Request that carries the lead's button-click as `leadResponseText`.
  // Multi-step ManyChat sequences fire several events in close succession
  // and each one needs to land in the thread.

  let conversationId: string;
  let leadId: string;
  let leadResponseInserted = false;
  let aiActiveOnConversation = false;

  if (existingLead?.conversation) {
    const platformUserId =
      canSendViaInstagramApi || !existingLead.platformUserId
        ? payload.instagramUserId
        : existingLead.platformUserId;
    canSendViaInstagramApi = looksLikeInstagramRecipientId(
      platformUserId || '',
      payload.manyChatSubscriberId
    );
    const updated = await prisma.conversation.update({
      where: { id: existingLead.conversation.id },
      data: {
        source: 'MANYCHAT',
        leadSource: 'OUTBOUND',
        manyChatOpenerMessage: payload.openerMessage,
        manyChatTriggerType: payload.triggerType,
        manyChatCommentText: payload.commentText ?? null,
        manyChatFiredAt: firedAt
      },
      select: { id: true, aiActive: true }
    });
    await prisma.lead.update({
      where: { id: existingLead.id },
      data: {
        handle,
        name: existingLead.name || leadName,
        platformUserId,
        triggerType: payload.triggerType === 'comment' ? 'COMMENT' : 'DM',
        triggerSource
      }
    });
    await ensureOpenerMessage(updated.id, payload.openerMessage, firedAt);
    leadResponseInserted = await ensureLeadResponseMessage(
      updated.id,
      payload.leadResponseText,
      firedAt
    );
    conversationId = updated.id;
    leadId = existingLead.id;
    aiActiveOnConversation = updated.aiActive;
  } else if (existingLead) {
    canSendViaInstagramApi = looksLikeInstagramRecipientId(
      existingLead.platformUserId || payload.instagramUserId,
      payload.manyChatSubscriberId
    );
    const personaId = await resolveActivePersonaIdForCreate(account.id);
    const conversation = await prisma.conversation.create({
      data: {
        leadId: existingLead.id,
        personaId,
        aiActive: account.awayModeInstagram,
        unreadCount: 0,
        source: 'MANYCHAT',
        leadSource: 'OUTBOUND',
        manyChatOpenerMessage: payload.openerMessage,
        manyChatTriggerType: payload.triggerType,
        manyChatCommentText: payload.commentText ?? null,
        manyChatFiredAt: firedAt
      },
      select: { id: true, aiActive: true }
    });
    await ensureOpenerMessage(conversation.id, payload.openerMessage, firedAt);
    leadResponseInserted = await ensureLeadResponseMessage(
      conversation.id,
      payload.leadResponseText,
      firedAt
    );
    conversationId = conversation.id;
    leadId = existingLead.id;
    aiActiveOnConversation = conversation.aiActive;
  } else {
    const newLeadPersonaId = await resolveActivePersonaIdForCreate(account.id);
    const lead = await prisma.lead.create({
      data: {
        accountId: account.id,
        name: leadName,
        handle,
        platform: 'INSTAGRAM',
        platformUserId: payload.instagramUserId,
        triggerType: payload.triggerType === 'comment' ? 'COMMENT' : 'DM',
        triggerSource,
        stage: 'NEW_LEAD',
        conversation: {
          create: {
            personaId: newLeadPersonaId,
            aiActive: account.awayModeInstagram,
            unreadCount: 0,
            source: 'MANYCHAT',
            leadSource: 'OUTBOUND',
            manyChatOpenerMessage: payload.openerMessage,
            manyChatTriggerType: payload.triggerType,
            manyChatCommentText: payload.commentText ?? null,
            manyChatFiredAt: firedAt
          }
        }
      },
      include: {
        conversation: { select: { id: true, aiActive: true } }
      }
    });

    await ensureOpenerMessage(
      lead.conversation!.id,
      payload.openerMessage,
      firedAt
    );
    leadResponseInserted = await ensureLeadResponseMessage(
      lead.conversation!.id,
      payload.leadResponseText,
      firedAt
    );
    conversationId = lead.conversation!.id;
    leadId = lead.id;
    aiActiveOnConversation = lead.conversation!.aiActive;
  }

  // Schedule the AI reply when the lead actually engaged (button click
  // landed as a new LEAD message) and the conversation is AI-eligible.
  // ManyChat's button-click step is the sequence-completion signal —
  // without scheduling here, the LEAD message just sits in the thread
  // and the AI never picks it up because no Instagram webhook ever fires
  // for a button click (it's internal to ManyChat).
  if (
    leadResponseInserted &&
    aiActiveOnConversation &&
    canSendViaInstagramApi
  ) {
    try {
      const { scheduleAIReply } = await import('@/lib/webhook-processor');
      await scheduleAIReply(conversationId, account.id);
    } catch (err) {
      console.error(
        `[manychat-handoff] scheduleAIReply failed for conversation ${conversationId} (non-fatal):`,
        err
      );
    }
  } else if (leadResponseInserted && aiActiveOnConversation) {
    console.warn(
      `[manychat-handoff] Skipping AI schedule for conversation ${conversationId}: ManyChat instagramUserId="${payload.instagramUserId}" is not a Meta recipient ID. AI will resume when an Instagram webhook upgrades the lead by handle.`
    );
  }

  return {
    ok: true,
    duplicate: false,
    accountId: account.id,
    leadId,
    conversationId
  };
}

/**
 * Insert the ManyChat opener as a Message row so it appears in the
 * conversation thread (dashboard UI + AI prompt history).
 *
 * Uses sender=AI so the dashboard renders it inline like any other
 * outbound message — that's also what the lead saw on Instagram, so
 * treating it as an AI-side message in the thread is faithful to the
 * lead's experience. The voice-quality analyzer keys off training
 * examples + persona style profile, not raw message history, so
 * including this static templated opener does not pollute style
 * inference.
 *
 * Idempotent: skips creation if any message with this exact content
 * already exists on the conversation. Necessary because ManyChat may
 * re-fire the External Request on flow re-entry (e.g. lead unfollows +
 * refollows) and we don't want duplicates in the thread.
 */
async function ensureOpenerMessage(
  conversationId: string,
  content: string,
  timestamp: Date
): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;
  const existing = await prisma.message.findFirst({
    where: { conversationId, sender: 'AI', content: trimmed },
    select: { id: true }
  });
  if (existing) return;
  await prisma.message.create({
    data: {
      conversationId,
      sender: 'AI',
      content: trimmed,
      timestamp
    }
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: timestamp }
  });
}

/**
 * Insert the lead's button-click response (if any) as a LEAD-side
 * Message. Mirrors `ensureOpenerMessage` but on the inbound side: when
 * ManyChat fires a follow-up External Request after a button-click
 * step in the flow, the click label rides through as
 * `leadResponseText` and we land it as a Message so the AI sees
 * "lead engaged with X" on its next turn.
 *
 * Timestamp is bumped 1s past the opener's `firedAt` so the message
 * order in the thread reflects opener → click, not click → opener,
 * even when both External Requests fire within the same JSON payload
 * (rare but possible when the operator wires both events to a single
 * action node).
 *
 * Idempotent on (conversationId, sender=LEAD, content). Returns true when a
 * NEW message was inserted, false when nothing was inserted (no content, or
 * content already in the thread). Caller uses this to decide whether to
 * schedule an AI reply — content-dedup'd retries must NOT re-schedule.
 */
async function ensureLeadResponseMessage(
  conversationId: string,
  content: string | undefined,
  openerFiredAt: Date
): Promise<boolean> {
  const trimmed = content?.trim();
  if (!trimmed) return false;
  const existing = await prisma.message.findFirst({
    where: { conversationId, sender: 'LEAD', content: trimmed },
    select: { id: true }
  });
  if (existing) return false;
  const leadResponseTimestamp = new Date(openerFiredAt.getTime() + 1000);
  await prisma.message.create({
    data: {
      conversationId,
      sender: 'LEAD',
      content: trimmed,
      timestamp: leadResponseTimestamp
    }
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: leadResponseTimestamp,
      unreadCount: { increment: 1 }
    }
  });
  return true;
}
