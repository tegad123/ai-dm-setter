import { createHash, randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import {
  ManyChatHandoffError,
  manyChatHandoffSchema,
  type ManyChatHandoffPayload
} from '@/lib/manychat-handoff';

/** Canonical validated data only. Never retain headers, query keys or raw bodies. */
export function normalizeQueuedHandoff(payload: ManyChatHandoffPayload) {
  return {
    ...payload,
    instagramUserId: payload.instagramUserId.trim(),
    instagramUsername: payload.instagramUsername
      .replace(/^@+/, '')
      .trim()
      .toLowerCase(),
    manyChatSubscriberId: payload.manyChatSubscriberId.trim(),
    openerMessage: payload.openerMessage.trim(),
    leadResponseText: payload.leadResponseText?.trim()
  };
}

export function queuedHandoffHash(payload: ManyChatHandoffPayload): string {
  // firedAt is optional and some ManyChat flows regenerate it on HTTP retries.
  // Keep the first accepted timestamp; it is not the identity of the first reply.
  const { firedAt: _firedAt, ...semanticPayload } =
    normalizeQueuedHandoff(payload);
  return createHash('sha256')
    .update(JSON.stringify(semanticPayload))
    .digest('hex');
}

export async function acceptQueuedManyChatHandoff(params: {
  webhookKey: string | null;
  payload: unknown;
}) {
  const key = params.webhookKey?.trim();
  if (!key) throw new ManyChatHandoffError('Missing X-QualifyDMs-Key', 401);
  const account = await prisma.account.findUnique({
    where: { manyChatWebhookKey: key },
    select: { id: true }
  });
  if (!account) throw new ManyChatHandoffError('Invalid webhook key', 401);
  if (process.env.MANYCHAT_QUEUED_HANDOFF_PAUSED === 'true') {
    throw new ManyChatHandoffError('Queued first-reply intake is paused', 503);
  }
  const parsed = manyChatHandoffSchema.safeParse(params.payload);
  if (!parsed.success)
    throw new ManyChatHandoffError('Invalid ManyChat handoff payload', 400);
  const payload = normalizeQueuedHandoff(parsed.data);
  if (
    payload.processingMode !== 'queued_first_reply' ||
    payload.platform !== 'INSTAGRAM' ||
    !payload.scheduleAi ||
    !payload.leadResponseText ||
    !payload.openerMessage ||
    !payload.manyChatSubscriberId
  ) {
    throw new ManyChatHandoffError(
      'queued_first_reply requires Instagram, scheduleAi=true and a nonempty first reply',
      400
    );
  }
  const payloadHash = queuedHandoffHash(payload);
  const id = randomUUID();
  const receipt = await prisma.$transaction(
    async (tx) => {
      await tx.manyChatHandoffReceipt.createMany({
        data: [
          {
            id,
            accountId: account.id,
            platform: payload.platform,
            subscriberId: payload.manyChatSubscriberId,
            payload: JSON.parse(JSON.stringify(payload)),
            payloadHash
          }
        ],
        skipDuplicates: true
      });
      return tx.manyChatHandoffReceipt.findUniqueOrThrow({
        where: {
          accountId_platform_subscriberId: {
            accountId: account.id,
            platform: payload.platform,
            subscriberId: payload.manyChatSubscriberId
          }
        }
      });
    },
    { maxWait: 2000, timeout: 3000 }
  );
  if (receipt.payloadHash !== payloadHash) {
    throw new ManyChatHandoffError(
      'A different first reply was already accepted for this subscriber; review the existing receipt',
      409
    );
  }
  return {
    ok: true,
    duplicate: receipt.id !== id,
    receiptId: receipt.id,
    handoffAccepted: true,
    processingStatus: receipt.status,
    conversationId: receipt.conversationId,
    // Acknowledgement deliberately makes no claim about queueing or delivery.
    scheduledReplyId: receipt.scheduledReplyId
  };
}
