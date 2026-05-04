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
  firedAt: z.string().datetime().optional()
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

  const oneHourAgo = new Date(firedAt.getTime() - 60 * 60 * 1000);
  if (
    existingLead?.conversation?.source === 'MANYCHAT' &&
    existingLead.conversation.manyChatFiredAt &&
    existingLead.conversation.manyChatFiredAt >= oneHourAgo
  ) {
    return {
      ok: true,
      duplicate: true,
      accountId: account.id,
      leadId: existingLead.id,
      conversationId: existingLead.conversation.id
    };
  }

  if (existingLead?.conversation) {
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
      select: { id: true }
    });
    await prisma.lead.update({
      where: { id: existingLead.id },
      data: {
        handle,
        name: existingLead.name || leadName,
        platformUserId: payload.instagramUserId,
        triggerType: payload.triggerType === 'comment' ? 'COMMENT' : 'DM',
        triggerSource
      }
    });
    return {
      ok: true,
      duplicate: false,
      accountId: account.id,
      leadId: existingLead.id,
      conversationId: updated.id
    };
  }

  if (existingLead) {
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
      select: { id: true }
    });
    return {
      ok: true,
      duplicate: false,
      accountId: account.id,
      leadId: existingLead.id,
      conversationId: conversation.id
    };
  }

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
    include: { conversation: { select: { id: true } } }
  });

  return {
    ok: true,
    duplicate: false,
    accountId: account.id,
    leadId: lead.id,
    conversationId: lead.conversation!.id
  };
}
