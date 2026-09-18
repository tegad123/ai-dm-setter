import prisma from '@/lib/prisma';
import { z } from 'zod';
import { resolveAndUpgradeInstagramNumericId } from '@/lib/manychat-resolve-ig-id';
import {
  resolveManyChatContactIdentity,
  type ManyChatPlatform
} from '@/lib/manychat-contact';
import {
  queueManyChatCompletionReply,
  type ManyChatCompletionScheduleStatus
} from '@/lib/manychat-completion-queue';

// Sequence-completion handoff. Daniel's ManyChat flow fires this as the
// FINAL action (after the Smart Delay + Condition) to signal "sequence
// done, AI take over." The `manychat-handoff` endpoint runs EARLY when
// the lead clicks the opener button — by design it doesn't flip the
// AI-eligibility flags because the operator's automation is still
// running. This endpoint flips them.
//
// If the operator forgets to wire this final step, the time-based
// fallback in silent-stop-recovery.ts kicks in within 5 min and flips
// the same flags. Either path lands in the same state.

export const manyChatCompleteSchema = z
  .object({
    platform: z
      .preprocess(
        (value) =>
          typeof value === 'string' ? value.trim().toUpperCase() : value,
        z.enum(['INSTAGRAM', 'FACEBOOK'])
      )
      .optional()
      .default('INSTAGRAM'),
    // Same coercion behavior as the handoff endpoint — ManyChat's variable
    // picker emits numeric IDs as JSON numbers.
    instagramUserId: z.coerce.string().optional().default(''),
    instagramUsername: z.string().optional(),
    facebookUserId: z.coerce.string().optional(),
    contactName: z.string().max(200).optional(),
    manyChatSubscriberId: z.coerce.string().optional()
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

export type ManyChatCompletePayload = z.infer<typeof manyChatCompleteSchema>;

export interface ManyChatCompleteResult {
  ok: true;
  conversationId: string;
  alreadyHandedOff: boolean;
  processingStatus: ManyChatCompletionScheduleStatus;
  scheduledReplyId: string | null;
}

export class ManyChatCompleteError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ManyChatCompleteError';
    this.status = status;
  }
}

export async function processManyChatComplete(params: {
  webhookKey: string | null;
  payload: unknown;
  deps?: {
    db?: Pick<typeof prisma, 'account' | 'lead'>;
    resolveInstagramRecipient?: typeof resolveAndUpgradeInstagramNumericId;
    queueReply?: typeof queueManyChatCompletionReply;
    instagramResolutionTimeoutMs?: number;
  };
}): Promise<ManyChatCompleteResult> {
  const db = params.deps?.db ?? prisma;
  const resolveInstagramRecipient =
    params.deps?.resolveInstagramRecipient ??
    resolveAndUpgradeInstagramNumericId;
  const queueReply = params.deps?.queueReply ?? queueManyChatCompletionReply;
  const webhookKey = params.webhookKey?.trim();
  if (!webhookKey) {
    throw new ManyChatCompleteError('Missing X-QualifyDMs-Key', 401);
  }

  const account = await db.account.findUnique({
    where: { manyChatWebhookKey: webhookKey },
    select: { id: true }
  });
  if (!account) {
    throw new ManyChatCompleteError('Invalid webhook key', 401);
  }

  const parsed = manyChatCompleteSchema.safeParse(params.payload);
  if (!parsed.success) {
    throw new ManyChatCompleteError('Invalid ManyChat payload', 400);
  }
  const payload = parsed.data;
  const identity = resolveManyChatContactIdentity(payload);
  const platform = identity.platform as ManyChatPlatform;

  // Mirror the handoff lookup. Facebook resolves by its PSID (with the
  // ManyChat subscriber id as a supported fallback); Instagram also keeps
  // the legacy handle fallback for rows created before numeric-id upgrades.
  const leads = await db.lead.findMany({
    where: {
      accountId: account.id,
      platform,
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
    include: { conversation: true },
    take: 2
  });
  if (leads.length > 1) {
    throw new ManyChatCompleteError('contact_identity_conflict', 409);
  }
  const lead = leads[0];

  if (!lead?.conversation) {
    throw new ManyChatCompleteError('lead_not_found', 404);
  }

  const conversation = lead.conversation;

  // Resolve & upgrade `Lead.platformUserId` to the IG numeric user ID
  // (`ig_id`). ManyChat's variable picker doesn't expose `ig_id` for
  // IG accounts — `{{contact.id}}` returns the ManyChat-internal
  // subscriber ID. The shared resolver calls ManyChat's REST API
  // (`/fb/subscriber/getInfo`) to translate subscriber ID → ig_id and
  // updates the lead in one shot. Without this, the silent-stop
  // heartbeat's `hasUsablePlatformRecipient` rejects the lead and the
  // AI reply never ships.
  if (platform === 'INSTAGRAM') {
    const resolution = resolveInstagramRecipient({
      accountId: account.id,
      leadId: lead.id,
      existingPlatformUserId: lead.platformUserId,
      incomingInstagramUserId: payload.instagramUserId,
      manyChatSubscriberId: payload.manyChatSubscriberId
    }).catch((error) => {
      console.warn(
        `[manychat-complete] Instagram recipient resolution failed for lead ${lead.id}:`,
        error
      );
      return null;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        resolution,
        new Promise<null>((resolve) => {
          timeout = setTimeout(
            () => resolve(null),
            params.deps?.instagramResolutionTimeoutMs ?? 5000
          );
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  // Completion is a control-transfer signal, not permission to override an
  // operator pause or safety hold. The queue helper preserves those states,
  // and creates/adopts exactly one ScheduledReply for the current lead turn.
  const scheduled = await queueReply(conversation.id, account.id, platform);

  return {
    ok: true,
    conversationId: conversation.id,
    alreadyHandedOff:
      scheduled.status === 'already_scheduled' ||
      scheduled.status === 'already_handled',
    processingStatus: scheduled.status,
    scheduledReplyId: scheduled.scheduledReplyId
  };
}
