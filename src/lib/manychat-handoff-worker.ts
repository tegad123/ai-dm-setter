import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';
import { extractInstagramNumericId, findSubscriberById } from '@/lib/manychat';
import { manyChatHandoffSchema } from '@/lib/manychat-handoff';

const LEASE_MS = 5 * 60_000;
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MATCH_WINDOW_MS = 5 * 60_000;
const WORKER_STATUSES = ['PENDING', 'RETRY', 'PROCESSING'];
type Receipt = Prisma.ManyChatHandoffReceiptGetPayload<Record<string, never>>;
type Outcome = 'QUEUED' | 'RETRY' | 'HELD' | 'NEEDS_REVIEW' | 'ALREADY_HANDLED';

export interface ManyChatHandoffWorkerSummary {
  claimed: number;
  queued: number;
  retried: number;
  held: number;
  needsReview: number;
  alreadyHandled: number;
  leaseLost: number;
}

interface WorkerDependencies {
  db: PrismaClient;
  now: () => Date;
  token: () => string;
  resolveRecipient: (
    accountId: string,
    subscriberId: string,
    platform: 'INSTAGRAM' | 'FACEBOOK'
  ) => Promise<string | null>;
  schedule: (
    conversationId: string,
    accountId: string,
    receiptId: string,
    leaseToken: string
  ) => Promise<void>;
}

class LeaseLost extends Error {}
class RetryLater extends Error {}

function usableRecipient(
  platform: 'INSTAGRAM' | 'FACEBOOK',
  value: string | null | undefined,
  subscriberId: string
): value is string {
  if (!value) return false;
  if (platform === 'FACEBOOK') return /^\d{5,}$/.test(value);
  return value !== subscriberId && /^\d{12,}$/.test(value);
}

function payloadIdentity(
  payload: ReturnType<typeof manyChatHandoffSchema.parse>
) {
  if (payload.platform === 'FACEBOOK') {
    const userId =
      payload.facebookUserId?.trim() || payload.manyChatSubscriberId.trim();
    return {
      userId,
      // Display names are not identity keys on Facebook. Only Instagram
      // usernames can recover a context row whose numeric ID is unresolved.
      handle: ''
    };
  }
  return {
    userId: payload.instagramUserId.trim(),
    handle: payload.instagramUsername.replace(/^@+/, '').trim()
  };
}

/** Injectable worker runs the same control flow in tests. Never called by intake. */
export function createManyChatHandoffReceiptWorker(deps: WorkerDependencies) {
  const { db, now } = deps;
  async function fenced<T>(
    receipt: Receipt,
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ) {
    return db.$transaction(
      async (tx) => {
        // This write also holds the receipt row lock until the transaction commits.
        const fence = await tx.manyChatHandoffReceipt.updateMany({
          where: {
            id: receipt.id,
            status: 'PROCESSING',
            leaseToken: receipt.leaseToken,
            leaseUntil: { gt: now() }
          },
          data: { leaseUntil: new Date(now().getTime() + LEASE_MS) }
        });
        if (fence.count !== 1) throw new LeaseLost();
        return operation(tx);
      },
      { maxWait: 2000, timeout: 5000 }
    );
  }

  async function finish(
    receipt: Receipt,
    status: Outcome,
    reason: string,
    extra: Prisma.ManyChatHandoffReceiptUpdateManyMutationInput = {}
  ) {
    await fenced(receipt, async (tx) => {
      if (status === 'HELD' || status === 'NEEDS_REVIEW') {
        // Stable ID prevents duplicate alerts on crash/reconciliation. Never include tokens or raw payloads.
        await tx.notification.upsert({
          where: { id: `manychat-handoff-${receipt.id}` },
          create: {
            id: `manychat-handoff-${receipt.id}`,
            accountId: receipt.accountId,
            type: 'SYSTEM',
            title: 'ManyChat handoff needs review',
            body: `First-reply handoff ${receipt.id}${receipt.conversationId ? ` for conversation ${receipt.conversationId}` : ''} stopped: ${reason}. No automatic replay was performed.`
          },
          update: {}
        });
      }

      await tx.manyChatHandoffReceipt.updateMany({
        where: { id: receipt.id, leaseToken: receipt.leaseToken },
        data: {
          ...extra,
          status,
          lastError:
            status === 'QUEUED' || status === 'ALREADY_HANDLED' ? null : reason,
          leaseToken: null,
          leaseUntil: null
        }
      });
    });
    return status;
  }

  async function retry(receipt: Receipt, reason: string) {
    const delay = RETRY_MS[receipt.attempts - 1];
    if (delay === undefined)
      return finish(receipt, 'NEEDS_REVIEW', `${reason}_retry_exhausted`);
    return finish(receipt, 'RETRY', reason, {
      nextAttemptAt: new Date(now().getTime() + delay)
    });
  }

  async function reconcile(
    receipt: Receipt,
    allowSchedule: boolean
  ): Promise<Outcome | null> {
    if (!receipt.conversationId || !receipt.leadMessageId)
      return finish(receipt, 'NEEDS_REVIEW', 'missing_persisted_context');
    const conversation = await db.conversation.findUnique({
      where: { id: receipt.conversationId },
      include: { lead: true }
    });
    if (
      !conversation ||
      conversation.lead.accountId !== receipt.accountId ||
      conversation.lead.platform !== receipt.platform
    )
      return finish(receipt, 'NEEDS_REVIEW', 'conversation_identity_conflict');
    const account = await db.account.findUnique({
      where: { id: receipt.accountId },
      select: {
        awayModeInstagram: true,
        generateOnlyInstagram: true,
        awayModeFacebook: true,
        generateOnlyFacebook: true
      }
    });
    const isFacebook = conversation.lead.platform === 'FACEBOOK';
    const awayMode = isFacebook
      ? account?.awayModeFacebook
      : account?.awayModeInstagram;
    const generateOnly = isFacebook
      ? account?.generateOnlyFacebook
      : account?.generateOnlyInstagram;
    if (
      !account ||
      !(awayMode || conversation.autoSendOverride) ||
      generateOnly ||
      !conversation.aiActive ||
      conversation.awaitingHumanReview ||
      conversation.distressDetected ||
      conversation.schedulingConflict
    ) {
      return finish(receipt, 'HELD', 'account_or_conversation_hold');
    }
    const inbound = await db.message.findUnique({
      where: { id: receipt.leadMessageId }
    });
    if (
      !inbound ||
      inbound.deletedAt ||
      inbound.sender !== 'LEAD' ||
      inbound.conversationId !== conversation.id
    )
      return finish(receipt, 'NEEDS_REVIEW', 'inbound_missing_or_removed');
    if (now().getTime() - inbound.timestamp.getTime() >= 24 * 60 * 60_000)
      return finish(receipt, 'NEEDS_REVIEW', 'messaging_window_expired');
    const groups = await db.messageGroup.findMany({
      where: { conversationId: conversation.id },
      include: {
        messages: { select: { platformMessageId: true, deletedAt: true } }
      }
    });
    if (
      groups.some(
        (group) =>
          group.failedAt ||
          !group.completedAt ||
          group.messages.length < group.bubbleCount ||
          group.messages.some(
            (message) => !message.platformMessageId || message.deletedAt
          )
      )
    )
      return finish(
        receipt,
        'NEEDS_REVIEW',
        'partial_or_uncertain_message_group'
      );
    const outbound = await db.message.findMany({
      where: {
        conversationId: conversation.id,
        deletedAt: null,
        sender: { in: ['AI', 'HUMAN'] }
      },
      orderBy: { timestamp: 'asc' }
    });
    if (outbound.length) {
      if (outbound.some((m) => !m.platformMessageId))
        return finish(receipt, 'NEEDS_REVIEW', 'outbound_delivery_uncertain');
      return finish(
        receipt,
        outbound.some((m) => m.timestamp >= inbound.timestamp)
          ? 'ALREADY_HANDLED'
          : 'HELD',
        'conversation_already_advanced'
      );
    }
    const latest = await db.message.findFirst({
      where: {
        conversationId: conversation.id,
        deletedAt: null,
        sender: { not: 'SYSTEM' }
      },
      orderBy: { timestamp: 'desc' }
    });
    if (!latest || latest.id !== inbound.id)
      return finish(receipt, 'NEEDS_REVIEW', 'newer_conversation_activity');
    const jobs = await db.scheduledReply.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    const related = jobs.filter(
      (job) => job.createdAt.getTime() >= inbound.timestamp.getTime() - 1000
    );
    if (jobs.some((job) => String(job.status).startsWith('FAILED')))
      return finish(
        receipt,
        'NEEDS_REVIEW',
        'existing_terminal_delivery_failure'
      );
    if (jobs.some((job) => job.status === 'PROCESSING'))
      return retry(receipt, 'existing_processing_work');
    const pending = jobs.find((job) => job.status === 'PENDING');
    if (pending)
      return finish(receipt, 'QUEUED', 'durable_work_confirmed', {
        scheduledReplyId: pending.id
      });
    if (related.some((job) => job.status === 'SENT'))
      return finish(
        receipt,
        'NEEDS_REVIEW',
        'sent_work_without_delivery_evidence'
      );
    if (related.some((job) => job.status === 'CANCELLED'))
      return finish(receipt, 'NEEDS_REVIEW', 'cancelled_work_needs_review');
    if (receipt.nativeInboundOwned)
      return retry(receipt, 'native_inbound_owns_scheduling');
    if (!allowSchedule || receipt.schedulingStartedAt)
      return finish(receipt, 'NEEDS_REVIEW', 'scheduling_outcome_uncertain');
    return null;
  }

  async function process(receipt: Receipt): Promise<Outcome> {
    if (now().getTime() - receipt.receivedAt.getTime() >= 24 * 60 * 60_000)
      return finish(receipt, 'NEEDS_REVIEW', 'receipt_expired');
    const parsed = manyChatHandoffSchema.safeParse(receipt.payload);
    if (
      !parsed.success ||
      parsed.data.platform !== receipt.platform ||
      !parsed.data.scheduleAi ||
      !parsed.data.leadResponseText?.trim()
    )
      return finish(receipt, 'NEEDS_REVIEW', 'invalid_first_reply_payload');
    const payload = parsed.data;
    if (receipt.conversationId && receipt.leadMessageId) {
      const result = await reconcile(receipt, !receipt.schedulingStartedAt);
      if (result) return result;
    } else {
      const { userId, handle } = payloadIdentity(payload);
      // Prefer the platform ID. Facebook display names are not unique, so an
      // OR query could turn one exact PSID match plus an unrelated same-name
      // lead into a false ambiguity. Instagram still gets its handle fallback
      // when ManyChat supplied an internal subscriber id instead of an IGSID.
      let candidates = await db.lead.findMany({
        where: {
          accountId: receipt.accountId,
          platform: payload.platform,
          platformUserId: userId
        },
        include: { conversation: true },
        take: 3
      });
      if (
        candidates.length === 0 &&
        payload.platform === 'INSTAGRAM' &&
        handle
      ) {
        candidates = await db.lead.findMany({
          where: {
            accountId: receipt.accountId,
            platform: payload.platform,
            handle: { equals: handle, mode: 'insensitive' }
          },
          include: { conversation: true },
          take: 3
        });
      }
      if (
        candidates.length === 0 ||
        (candidates.length === 1 && !candidates[0].conversation)
      )
        throw new RetryLater('original_context_not_found');
      if (candidates.length !== 1)
        return finish(receipt, 'NEEDS_REVIEW', 'ambiguous_contact_identity');
      const lead = candidates[0];
      const conversation = lead.conversation!;
      // Rollout prerequisite: original context-only opener callback already landed.
      // Creating competing leads here can race native Meta ingress; fail closed instead.
      if (
        conversation.source !== 'MANYCHAT' ||
        conversation.manyChatOpenerMessage?.trim() !==
          payload.openerMessage.trim()
      )
        return finish(
          receipt,
          'NEEDS_REVIEW',
          'original_opener_context_conflict'
        );
      let recipient = lead.platformUserId;
      if (
        usableRecipient(payload.platform, userId, receipt.subscriberId) &&
        usableRecipient(payload.platform, recipient, receipt.subscriberId) &&
        userId !== recipient
      )
        return finish(receipt, 'NEEDS_REVIEW', 'recipient_identity_conflict');
      if (!usableRecipient(payload.platform, recipient, receipt.subscriberId)) {
        recipient = usableRecipient(
          payload.platform,
          userId,
          receipt.subscriberId
        )
          ? userId
          : await deps.resolveRecipient(
              receipt.accountId,
              receipt.subscriberId,
              payload.platform
            );
      }
      if (!usableRecipient(payload.platform, recipient, receipt.subscriberId))
        throw new RetryLater('recipient_resolution_unavailable');
      const resolvedRecipient = recipient;
      const links = await fenced(receipt, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`manychat-first-reply:${conversation.id}`}, 0))`;
        const current = await tx.conversation.findUnique({
          where: { id: conversation.id },
          include: { lead: true }
        });
        if (
          !current ||
          current.lead.accountId !== receipt.accountId ||
          current.lead.platform !== payload.platform
        )
          throw new RetryLater('conversation_changed');
        if (
          usableRecipient(
            payload.platform,
            current.lead.platformUserId,
            receipt.subscriberId
          ) &&
          current.lead.platformUserId !== resolvedRecipient
        )
          throw new RetryLater('recipient_changed');
        await tx.lead.update({
          where: { id: lead.id },
          data: { platformUserId: resolvedRecipient }
        });
        // Reuse a visible opener only when an actual post-send provider
        // callback or native Meta echo supplied delivery evidence. The Follow
        // to DM graph can hand off the first response without exposing a
        // post-opener action, so missing opener evidence must not block the
        // lead response and must never be manufactured here. The hidden
        // Conversation.manyChatOpenerMessage remains available to routing.
        const opener = await tx.message.findFirst({
          where: {
            conversationId: conversation.id,
            deletedAt: null,
            sender: 'MANYCHAT',
            content: payload.openerMessage.trim(),
            deliveryStatus: { in: ['PROVIDER_REPORTED', 'META_CONFIRMED'] }
          },
          orderBy: { timestamp: 'asc' }
        });
        let inbound = await tx.message.findFirst({
          where: {
            conversationId: conversation.id,
            deletedAt: null,
            sender: 'LEAD',
            content: payload.leadResponseText!.trim(),
            timestamp: {
              gte: new Date(receipt.receivedAt.getTime() - MATCH_WINDOW_MS),
              lte: new Date(receipt.receivedAt.getTime() + MATCH_WINDOW_MS)
            }
          },
          orderBy: { timestamp: 'desc' }
        });
        if (!inbound) {
          inbound = await tx.message.create({
            data: {
              conversationId: conversation.id,
              sender: 'LEAD',
              content: payload.leadResponseText!.trim(),
              timestamp: receipt.receivedAt
            }
          });
          await tx.conversation.update({
            where: { id: conversation.id },
            data: { unreadCount: { increment: 1 } }
          });
          await tx.conversation.updateMany({
            where: {
              id: conversation.id,
              OR: [
                { lastMessageAt: null },
                { lastMessageAt: { lt: receipt.receivedAt } }
              ]
            },
            data: { lastMessageAt: receipt.receivedAt }
          });
        }
        const data = {
          conversationId: conversation.id,
          openerMessageId: opener?.id ?? null,
          leadMessageId: inbound.id,
          nativeInboundOwned: Boolean(inbound.platformMessageId)
        };
        await tx.manyChatHandoffReceipt.updateMany({
          where: { id: receipt.id, leaseToken: receipt.leaseToken },
          data
        });
        return data;
      });
      Object.assign(receipt, links);
      const result = await reconcile(receipt, true);
      if (result) return result;
    }
    // Persist intent BEFORE invoking the scheduler. An interrupted call is reconciled,
    // never blindly repeated; it may already have created work in another process.
    await fenced(receipt, async (tx) => {
      await tx.manyChatHandoffReceipt.updateMany({
        where: { id: receipt.id, leaseToken: receipt.leaseToken },
        data: { schedulingStartedAt: now() }
      });
    });
    receipt.schedulingStartedAt = now();
    try {
      await deps.schedule(
        receipt.conversationId!,
        receipt.accountId,
        receipt.id,
        receipt.leaseToken!
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('HANDOFF_DEFERRED')
      ) {
        // The queue-only helper guarantees this signal is issued before queue mutation.
        await fenced(receipt, async (tx) => {
          await tx.manyChatHandoffReceipt.updateMany({
            where: { id: receipt.id, leaseToken: receipt.leaseToken },
            data: { schedulingStartedAt: null }
          });
        });
        receipt.schedulingStartedAt = null;
        return retry(receipt, 'scheduler_deferred');
      }
      // Otherwise inspect durable evidence, never blindly repeat an uncertain call.
    }
    return (await reconcile(receipt, false))!;
  }

  return async function run({
    limit = 3
  }: { limit?: number } = {}): Promise<ManyChatHandoffWorkerSummary> {
    const summary: ManyChatHandoffWorkerSummary = {
      claimed: 0,
      queued: 0,
      retried: 0,
      held: 0,
      needsReview: 0,
      alreadyHandled: 0,
      leaseLost: 0
    };
    const eligible = {
      status: { in: WORKER_STATUSES },
      nextAttemptAt: { lte: now() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now() } }]
    };
    const candidates = await db.manyChatHandoffReceipt.findMany({
      where: eligible,
      orderBy: { receivedAt: 'asc' },
      take: Math.max(1, Math.min(3, Math.floor(limit) || 1))
    });
    for (const candidate of candidates) {
      const token = deps.token();
      const claim = await db.manyChatHandoffReceipt.updateMany({
        where: { ...eligible, id: candidate.id },
        data: {
          status: 'PROCESSING',
          leaseToken: token,
          leaseUntil: new Date(now().getTime() + LEASE_MS),
          attempts: { increment: 1 }
        }
      });
      if (claim.count !== 1) continue;
      summary.claimed++;
      const receipt = {
        ...candidate,
        status: 'PROCESSING',
        leaseToken: token,
        attempts: candidate.attempts + 1
      };
      try {
        let outcome: Outcome;
        try {
          outcome = await process(receipt);
        } catch (error) {
          if (error instanceof LeaseLost) throw error;
          // If scheduling might have begun, retry only reconciliation on next lease.
          outcome = await retry(
            receipt,
            error instanceof RetryLater
              ? error.message
              : 'temporary_processing_failure'
          );
        }
        const key = {
          QUEUED: 'queued',
          RETRY: 'retried',
          HELD: 'held',
          NEEDS_REVIEW: 'needsReview',
          ALREADY_HANDLED: 'alreadyHandled'
        } as const;
        summary[key[outcome]]++;
      } catch (error) {
        if (error instanceof LeaseLost) summary.leaseLost++;
        // A DB outage leaves the lease to expire and durable receipt to be recovered.
        else
          console.error(
            '[manychat-handoff-worker] receipt processing deferred',
            { receiptId: receipt.id }
          );
      }
    }
    return summary;
  };
}

export const processManyChatHandoffReceipts =
  createManyChatHandoffReceiptWorker({
    db: prisma,
    now: () => new Date(),
    token: randomUUID,
    resolveRecipient: async (accountId, subscriberId, platform) => {
      // A Facebook ManyChat subscriber id is the page-scoped PSID used by
      // Messenger. It must not be sent through Instagram's identity lookup.
      if (platform === 'FACEBOOK') return subscriberId;
      const credentials = await getCredentials(accountId, 'MANYCHAT');
      if (!credentials?.apiKey || typeof credentials.apiKey !== 'string')
        return null;
      const subscriber = await findSubscriberById(
        credentials.apiKey,
        subscriberId,
        { signal: AbortSignal.timeout(5000) }
      );
      return extractInstagramNumericId(subscriber);
    },
    schedule: async (conversationId, accountId, receiptId, leaseToken) => {
      const { scheduleAIReply } = await import('@/lib/webhook-processor');
      await scheduleAIReply(conversationId, accountId, {
        queueOnly: true,
        handoffReceiptId: receiptId,
        handoffLeaseToken: leaseToken
      });
    }
  });
