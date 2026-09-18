import prisma from '@/lib/prisma';
import { z } from 'zod';
import { resolveAndUpgradeInstagramNumericId } from '@/lib/manychat-resolve-ig-id';
import { resolveManyChatContactIdentity } from '@/lib/manychat-contact';

// Record ManyChat's post-send acknowledgement for one automated DM. This is
// provider-reported evidence, not proof that Meta delivered the message. A
// later native Meta echo upgrades the same row to META_CONFIRMED.

export const manyChatMessageSchema = z
  .object({
    platform: z
      .preprocess(
        (value) =>
          typeof value === 'string' ? value.trim().toUpperCase() : value,
        z.enum(['INSTAGRAM', 'FACEBOOK'])
      )
      .optional()
      .default('INSTAGRAM'),
    // Coerced because ManyChat emits numeric IDs as JSON numbers.
    instagramUserId: z.coerce.string().optional().default(''),
    instagramUsername: z.string().optional(),
    facebookUserId: z.coerce.string().optional(),
    contactName: z.string().max(200).optional(),
    manyChatSubscriberId: z.coerce.string().optional(),
    // The text that ManyChat sent to the lead. Required.
    messageText: z.string().min(1).max(4000),
    // Optional ISO-8601 timestamp from ManyChat. Defaults to server time.
    sentAt: z.string().datetime().optional(),
    // Optional ManyChat operation/message identifier so retries can be deduped.
    // This is deliberately separate from Meta's event.message.mid.
    manyChatMessageId: z.string().optional()
  })
  .superRefine((payload, ctx) => {
    try {
      resolveManyChatContactIdentity(payload);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [
          payload.platform === 'FACEBOOK' ? 'facebookUserId' : 'instagramUserId'
        ],
        message:
          error instanceof Error ? error.message : 'Missing contact identity'
      });
    }
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

const MAX_SENT_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_SENT_AT_AGE_MS = 24 * 60 * 60 * 1000;

function notificationIdentifier(value: string | undefined): string {
  const sanitized = value
    ?.trim()
    .replace(/[\u0000-\u001f\u007f]/g, '?')
    .slice(0, 120);
  return sanitized || 'not supplied';
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
  const identity = resolveManyChatContactIdentity(payload);
  const reportedAt = new Date();
  const sentAt = payload.sentAt ? new Date(payload.sentAt) : reportedAt;
  if (
    sentAt.getTime() > reportedAt.getTime() + MAX_SENT_AT_FUTURE_SKEW_MS ||
    sentAt.getTime() < reportedAt.getTime() - MAX_SENT_AT_AGE_MS
  ) {
    throw new ManyChatMessageError('sent_at_out_of_range', 400);
  }

  const leads = await prisma.lead.findMany({
    where: {
      accountId: account.id,
      platform: identity.platform,
      OR: [
        ...identity.platformUserIds.map((platformUserId) => ({
          platformUserId
        })),
        ...(identity.handle
          ? [
              {
                handle: {
                  equals: identity.handle,
                  mode: 'insensitive' as const
                }
              }
            ]
          : [])
      ]
    },
    include: { conversation: { select: { id: true, source: true } } },
    take: 2
  });
  if (leads.length > 1) {
    throw new ManyChatMessageError('contact_identity_conflict', 409);
  }
  const lead = leads[0];

  if (!lead?.conversation) {
    throw new ManyChatMessageError('lead_not_found', 404);
  }
  const conversationId = lead.conversation.id;
  const conversationSource = lead.conversation.source;

  // Resolve the IG numeric user ID via ManyChat REST when the lead is
  // still stored with a handle / subscriber ID. Same rationale as in
  // manychat-complete: silent-stop heartbeat refuses to ship AI replies
  // to leads whose `platformUserId` isn't a 12+ digit IG ID. Fire-and-
  // forget so a transient ManyChat API blip doesn't fail the message
  // capture itself.
  if (identity.platform === 'INSTAGRAM') {
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
  }

  const trimmed = payload.messageText.trim();
  const dedupWindowStart = new Date(sentAt.getTime() - 5 * 60 * 1000);
  const dedupWindowEnd = new Date(sentAt.getTime() + 5 * 60 * 1000);
  const result = await prisma.$transaction(async (tx) => {
    // Serialize provider callbacks and native echoes for this conversation so
    // callback/echo races cannot create two bubbles for the same send.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`manychat-message:${conversationId}`}, 0))`;

    const existingByProviderId = payload.manyChatMessageId
      ? await tx.message.findFirst({
          where: {
            conversationId,
            providerMessageId: payload.manyChatMessageId
          }
        })
      : null;

    const contentCandidates = existingByProviderId
      ? []
      : await tx.message.findMany({
          where: {
            conversationId,
            sender: { in: ['MANYCHAT', 'HUMAN'] },
            content: trimmed,
            deletedAt: null,
            timestamp: { gte: dedupWindowStart, lte: dedupWindowEnd },
            ...(payload.manyChatMessageId
              ? {
                  OR: [
                    { providerMessageId: null },
                    { providerMessageId: payload.manyChatMessageId }
                  ]
                }
              : {})
          },
          orderBy: { timestamp: 'desc' }
        });
    const existingByContent =
      contentCandidates.find((candidate) => candidate.sender === 'MANYCHAT') ??
      (conversationSource === 'MANYCHAT'
        ? contentCandidates.find(
            (candidate) =>
              candidate.sender === 'HUMAN' &&
              candidate.humanSource === 'PHONE' &&
              Boolean(candidate.platformMessageId)
          )
        : null);
    const existing = existingByProviderId ?? existingByContent ?? null;

    let message;
    let duplicate: boolean;
    if (existing) {
      if (
        existing.sender === 'HUMAN' &&
        existing.echoAttributionFinalizedAt &&
        !existing.echoAttributionPendingUntil
      ) {
        // The bounded correlation window already finalized durable human-side
        // effects. Reclassifying now would make the row say MANYCHAT while the
        // suggestion/training/follow-up state still says HUMAN. Surface the
        // late callback for review instead of silently corrupting either side.
        await tx.notification.upsert({
          where: { id: `manychat-late-provider-${existing.id}` },
          create: {
            id: `manychat-late-provider-${existing.id}`,
            accountId: account.id,
            leadId: lead.id,
            type: 'SYSTEM',
            title: 'ManyChat callback needs review',
            body:
              `Conversation ${conversationId}, message ${existing.id}: a ${identity.platform} ` +
              `ManyChat callback arrived after this native echo was finalized as human. ` +
              `Provider operation ${notificationIdentifier(payload.manyChatMessageId)}. ` +
              `No reclassification was performed.`
          },
          update: {}
        });
        return {
          conflict: true as const,
          messageId: existing.id
        };
      }
      const metaConfirmed =
        existing.deliveryStatus === 'META_CONFIRMED' ||
        (existing.sender === 'HUMAN' &&
          existing.humanSource === 'PHONE' &&
          Boolean(existing.platformMessageId));
      message = await tx.message.update({
        where: { id: existing.id },
        data: {
          sender: 'MANYCHAT',
          providerMessageId:
            existing.providerMessageId ?? payload.manyChatMessageId ?? null,
          deliveryStatus: metaConfirmed
            ? 'META_CONFIRMED'
            : 'PROVIDER_REPORTED',
          deliveryReportedAt: existing.deliveryReportedAt ?? reportedAt,
          deliveryConfirmedAt: metaConfirmed
            ? (existing.deliveryConfirmedAt ?? existing.timestamp)
            : null,
          echoAttributionPendingUntil: null,
          echoAttributionFinalizedAt:
            existing.echoAttributionPendingUntil &&
            !existing.echoAttributionFinalizedAt
              ? reportedAt
              : existing.echoAttributionFinalizedAt,
          humanSource: null,
          sentByUserId: null,
          isHumanOverride: false,
          rejectedAISuggestionId: null,
          editedFromSuggestion: false,
          humanOverrideNote: null,
          loggedDuringTrainingPhase: false,
          systemPromptVersion: 'manychat-automation',
          msgSource: 'MANYCHAT_FLOW'
        }
      });
      duplicate = true;
    } else {
      message = await tx.message.create({
        data: {
          conversationId,
          sender: 'MANYCHAT',
          content: trimmed,
          timestamp: sentAt,
          providerMessageId: payload.manyChatMessageId || null,
          deliveryStatus: 'PROVIDER_REPORTED',
          deliveryReportedAt: reportedAt,
          systemPromptVersion: 'manychat-automation',
          msgSource: 'MANYCHAT_FLOW'
        }
      });
      duplicate = false;
      await tx.conversation.updateMany({
        where: {
          id: conversationId,
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: sentAt } }]
        },
        data: { lastMessageAt: sentAt }
      });
    }

    // A post-send callback proves ManyChat produced another automation step.
    // If that step is still the newest conversation event, it supersedes AI
    // work queued for the earlier lead turn. Limit cancellation to jobs that
    // already existed when this callback began so a concurrent/newer lead
    // cannot lose a reply job created after this callback started.
    const newestMessage = await tx.message.findFirst({
      where: {
        conversationId,
        sender: { not: 'SYSTEM' },
        deletedAt: null
      },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }]
    });
    if (newestMessage?.id === message.id) {
      await tx.scheduledReply.updateMany({
        where: {
          conversationId,
          status: 'PENDING',
          createdAt: { lte: reportedAt }
        },
        data: { status: 'CANCELLED' }
      });
      await tx.conversation.updateMany({
        where: {
          id: conversationId,
          OR: [
            { lastMessageAt: null },
            { lastMessageAt: { lte: message.timestamp } }
          ]
        },
        data: {
          awaitingAiResponse: false,
          awaitingSince: null
        }
      });
    }

    return { conflict: false as const, message, duplicate };
  });

  if (result.conflict) {
    throw new ManyChatMessageError('echo_attribution_already_finalized', 409);
  }

  return {
    ok: true,
    conversationId,
    messageId: result.message.id,
    duplicate: result.duplicate
  };
}
