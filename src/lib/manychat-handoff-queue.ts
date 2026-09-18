import prisma from '@/lib/prisma';
import { humanResponseDelay } from '@/lib/delay-utils';

export function firstReplyScheduledFor(
  params: {
    now: Date;
    earliestLeadAt: Date;
    minDelay: number;
    maxDelay: number;
    debounceSeconds: number;
    maxDebounceSeconds: number;
  },
  drawDelay = humanResponseDelay
): Date {
  const min = Math.max(0, params.minDelay);
  const max = Math.max(min, params.maxDelay);
  const debounce = Math.max(0, params.debounceSeconds);
  const cap = Math.max(debounce, params.maxDebounceSeconds);
  // Preserve the former eight-second collection period without sleeping in HTTP
  // or starting generation in this worker. Cron reads the latest history later.
  const baseline = params.now.getTime() + 8000;
  return new Date(
    Math.max(
      baseline + 1000,
      Math.min(
        baseline + debounce * 1000,
        params.earliestLeadAt.getTime() + cap * 1000
      ),
      baseline + drawDelay(min, max) * 1000
    )
  );
}

/** Narrow opt-in scheduling entry point; never generates or delivers text. */
export async function queueManyChatFirstReply(
  conversationId: string,
  accountId: string,
  receiptId: string,
  leaseToken: string
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`manychat-first-reply:${conversationId}`}, 0))`;
      const now = new Date();
      const receipt = await tx.manyChatHandoffReceipt.findFirst({
        where: {
          id: receiptId,
          accountId,
          conversationId,
          status: 'PROCESSING',
          leaseToken,
          leaseUntil: { gt: now }
        }
      });
      if (!receipt?.leadMessageId)
        throw new Error('HANDOFF_REVIEW: receipt lease or input missing');
      const conversation = await tx.conversation.findFirst({
        where: {
          id: conversationId,
          lead: { accountId, platform: 'INSTAGRAM' }
        },
        include: { lead: { include: { account: true } } }
      });
      if (!conversation)
        throw new Error('HANDOFF_REVIEW: conversation missing');
      const account = conversation.lead.account;
      if (
        !conversation.aiActive ||
        conversation.awaitingHumanReview ||
        conversation.distressDetected ||
        conversation.schedulingConflict ||
        account.generateOnlyInstagram ||
        !(account.awayModeInstagram || conversation.autoSendOverride)
      ) {
        throw new Error(
          'HANDOFF_HELD: auto-send is disabled or conversation needs review'
        );
      }
      const latest = await tx.message.findFirst({
        where: { conversationId, sender: { not: 'SYSTEM' }, deletedAt: null },
        orderBy: { timestamp: 'desc' }
      });
      if (
        !latest ||
        latest.sender !== 'LEAD' ||
        latest.id !== receipt.leadMessageId
      ) {
        throw new Error(
          'HANDOFF_REVIEW: first reply is no longer the latest input'
        );
      }
      if (now.getTime() - latest.timestamp.getTime() >= 24 * 60 * 60 * 1000) {
        throw new Error('HANDOFF_REVIEW: messaging window expired');
      }
      const outbound = await tx.message.findFirst({
        where: {
          conversationId,
          sender: { in: ['AI', 'HUMAN'] },
          deletedAt: null
        }
      });
      const group = await tx.messageGroup.findFirst({
        where: { conversationId }
      });
      if (outbound || group)
        throw new Error('HANDOFF_REVIEW: prior or uncertain outbound exists');
      const jobs = await tx.scheduledReply.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' }
      });
      if (
        jobs.some((j) => j.status.startsWith('FAILED') || j.status === 'SENT')
      ) {
        throw new Error('HANDOFF_REVIEW: terminal reply work exists');
      }
      if (jobs.some((j) => j.status === 'PROCESSING'))
        throw new Error('HANDOFF_DEFERRED: reply is processing');
      const pending = jobs.find((j) => j.status === 'PENDING');
      if (pending) {
        await tx.manyChatHandoffReceipt.update({
          where: { id: receiptId },
          data: { scheduledReplyId: pending.id }
        });
        return;
      }
      // Native ingress persisted this input before the worker linked it. Its
      // scheduler may be between saving/claiming a job; never start a second one.
      // Persisted ownership survives a later MID attachment to worker-owned input.
      if (receipt.nativeInboundOwned)
        throw new Error('HANDOFF_DEFERRED: native ingress owns this input');
      if (
        conversation.generationClaimAt &&
        conversation.generationClaimMessageId === latest.id &&
        now.getTime() - conversation.generationClaimAt.getTime() < 3 * 60 * 1000
      ) {
        throw new Error('HANDOFF_DEFERRED: native scheduler owns this input');
      }
      const jobId = `manychat-first-${receiptId}`;
      if (jobs.some((j) => j.id === jobId))
        throw new Error('HANDOFF_REVIEW: previous handoff work was cancelled');
      const scheduledFor = firstReplyScheduledFor({
        now,
        earliestLeadAt: latest.timestamp,
        minDelay: account.responseDelayMin ?? 45,
        maxDelay: account.responseDelayMax ?? 120,
        debounceSeconds: account.debounceWindowSeconds ?? 45,
        maxDebounceSeconds: account.maxDebounceWindowSeconds ?? 120
      });
      await tx.scheduledReply.create({
        data: {
          id: jobId,
          conversationId,
          accountId,
          scheduledFor,
          status: 'PENDING'
        }
      });
      await tx.manyChatHandoffReceipt.update({
        where: { id: receiptId },
        data: { scheduledReplyId: jobId }
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          awaitingAiResponse: true,
          awaitingSince: latest.timestamp
        }
      });
    },
    { maxWait: 2000, timeout: 5000 }
  );
}
