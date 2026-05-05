import prisma from '@/lib/prisma';
import { z } from 'zod';
import { resolveAndUpgradeInstagramNumericId } from '@/lib/manychat-resolve-ig-id';

// Capture a single automated DM that ManyChat just sent to a lead
// through Daniel's IG account. We can't rely on Meta's IG echo webhooks
// (they're not currently firing for this account), so the operator
// fires this External Request as an additional ManyChat action right
// after each "Send Message" node in the outbound flow. The result is
// a faithful copy of every ManyChat-sent DM in the dashboard tagged
// with sender=MANYCHAT, regardless of Meta's webhook delivery state.

export const manyChatMessageSchema = z.object({
  // Coerced because ManyChat emits numeric IDs as JSON numbers.
  instagramUserId: z.coerce.string().min(1),
  instagramUsername: z.string().optional(),
  manyChatSubscriberId: z.coerce.string().optional(),
  // The text that ManyChat sent to the lead. Required.
  messageText: z.string().min(1).max(4000),
  // Optional ISO-8601 timestamp from ManyChat. Defaults to server time.
  sentAt: z.string().datetime().optional(),
  // Optional ManyChat message identifier so we can dedup re-fires.
  manyChatMessageId: z.string().optional()
});

export type ManyChatMessagePayload = z.infer<typeof manyChatMessageSchema>;

export interface ManyChatMessageResult {
  ok: true;
  conversationId: string;
  messageId: string;
  duplicate: boolean;
}

export class ManyChatMessageError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ManyChatMessageError';
    this.status = status;
  }
}

function cleanInstagramUsername(username: string): string {
  return username.replace(/^@+/, '').trim();
}

export async function processManyChatMessage(params: {
  webhookKey: string | null;
  payload: unknown;
}): Promise<ManyChatMessageResult> {
  const webhookKey = params.webhookKey?.trim();
  if (!webhookKey) {
    throw new ManyChatMessageError('Missing X-QualifyDMs-Key', 401);
  }

  const account = await prisma.account.findUnique({
    where: { manyChatWebhookKey: webhookKey },
    select: { id: true }
  });
  if (!account) {
    throw new ManyChatMessageError('Invalid webhook key', 401);
  }

  const parsed = manyChatMessageSchema.safeParse(params.payload);
  if (!parsed.success) {
    throw new ManyChatMessageError('Invalid ManyChat payload', 400);
  }
  const payload = parsed.data;
  const handle = payload.instagramUsername
    ? cleanInstagramUsername(payload.instagramUsername)
    : '';
  const sentAt = payload.sentAt ? new Date(payload.sentAt) : new Date();

  const lead = await prisma.lead.findFirst({
    where: {
      accountId: account.id,
      platform: 'INSTAGRAM',
      OR: [
        { platformUserId: payload.instagramUserId },
        ...(handle
          ? [{ handle: { equals: handle, mode: 'insensitive' as const } }]
          : [])
      ]
    },
    include: { conversation: { select: { id: true } } }
  });

  if (!lead?.conversation) {
    throw new ManyChatMessageError('lead_not_found', 404);
  }
  const conversationId = lead.conversation.id;

  // Resolve the IG numeric user ID via ManyChat REST when the lead is
  // still stored with a handle / subscriber ID. Same rationale as in
  // manychat-complete: silent-stop heartbeat refuses to ship AI replies
  // to leads whose `platformUserId` isn't a 12+ digit IG ID. Fire-and-
  // forget so a transient ManyChat API blip doesn't fail the message
  // capture itself.
  resolveAndUpgradeInstagramNumericId({
    accountId: account.id,
    leadId: lead.id,
    existingPlatformUserId: lead.platformUserId,
    incomingInstagramUserId: payload.instagramUserId,
    manyChatSubscriberId: payload.manyChatSubscriberId
  }).catch((err) => {
    console.warn(
      `[manychat-message] ig_id resolve failed for lead ${lead.id} (non-fatal):`,
      err
    );
  });

  // Dedup: prefer the operator-provided manyChatMessageId when present
  // (deterministic, survives ManyChat retries). Fall back to a content +
  // sender match within a 5-minute window for re-fires that don't pass
  // through an ID.
  if (payload.manyChatMessageId) {
    const existingById = await prisma.message.findFirst({
      where: {
        conversationId,
        platformMessageId: payload.manyChatMessageId
      },
      select: { id: true }
    });
    if (existingById) {
      return {
        ok: true,
        conversationId,
        messageId: existingById.id,
        duplicate: true
      };
    }
  }

  const trimmed = payload.messageText.trim();
  const dedupWindow = new Date(sentAt.getTime() - 5 * 60 * 1000);
  const existingByContent = await prisma.message.findFirst({
    where: {
      conversationId,
      sender: 'MANYCHAT',
      content: trimmed,
      timestamp: { gte: dedupWindow }
    },
    select: { id: true }
  });
  if (existingByContent) {
    return {
      ok: true,
      conversationId,
      messageId: existingByContent.id,
      duplicate: true
    };
  }

  const message = await prisma.message.create({
    data: {
      conversationId,
      sender: 'MANYCHAT',
      content: trimmed,
      timestamp: sentAt,
      platformMessageId: payload.manyChatMessageId || null,
      systemPromptVersion: 'manychat-automation'
    }
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: sentAt }
  });

  return {
    ok: true,
    conversationId,
    messageId: message.id,
    duplicate: false
  };
}
