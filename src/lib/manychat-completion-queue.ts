import type { Platform, PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { humanResponseDelay } from '@/lib/delay-utils';
import { isManyChatProcessingEligible } from '@/lib/manychat-ai-eligibility';

export type ManyChatCompletionScheduleStatus =
  | 'scheduled'
  | 'already_scheduled'
  | 'already_handled'
  | 'held'
  | 'no_lead_input'
  | 'needs_review';

export interface ManyChatCompletionScheduleResult {
  status: ManyChatCompletionScheduleStatus;
  scheduledReplyId: string | null;
}

type CompletionQueueDb = Pick<
  PrismaClient,
  | '$transaction'
  | 'conversation'
  | 'message'
  | 'messageGroup'
  | 'scheduledReply'
>;

export function manyChatCompletionScheduledFor(
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
  const nowMs = params.now.getTime();
  const debounceAt = Math.min(
    nowMs + debounce * 1000,
    params.earliestLeadAt.getTime() + cap * 1000
  );
  const delayAt = nowMs + drawDelay(min, max) * 1000;
  return new Date(Math.max(nowMs + 1000, debounceAt, delayAt));
}

/**
 * Queue the current lead turn after ManyChat explicitly completes control.
 * The deterministic job id and advisory lock make callback retries converge on
 * one ScheduledReply. The existing cron then re-enters scheduleAIReply, which
 * performs the normal generation and delivery-time safety checks.
 */
export async function queueManyChatCompletionReply(
  conversationId: string,
  accountId: string,
  platform: Platform,
  deps: {
    db?: CompletionQueueDb;
    now?: () => Date;
    drawDelay?: (min: number, max: number) => number;
  } = {}
): Promise<ManyChatCompletionScheduleResult> {
  const db = deps.db ?? prisma;
  const nowFn = deps.now ?? (() => new Date());
  const drawDelay = deps.drawDelay ?? humanResponseDelay;

  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`manychat-complete:${conversationId}`}, 0))`;
      const now = nowFn();
      const conversation = await tx.conversation.findFirst({
        where: {
          id: conversationId,
          lead: { accountId, platform }
        },
        include: { lead: { include: { account: true } } }
      });
      if (!conversation) {
        return { status: 'needs_review', scheduledReplyId: null };
      }

      const account = conversation.lead.account;
      if (
        !isManyChatProcessingEligible({
          platform,
          aiActive: conversation.aiActive,
          awaitingHumanReview: conversation.awaitingHumanReview,
          distressDetected: conversation.distressDetected,
          schedulingConflict: conversation.schedulingConflict,
          autoSendOverride: conversation.autoSendOverride,
          awayModeInstagram: account.awayModeInstagram,
          awayModeFacebook: account.awayModeFacebook,
          generateOnlyInstagram: account.generateOnlyInstagram,
          generateOnlyFacebook: account.generateOnlyFacebook
        })
      ) {
        return { status: 'held', scheduledReplyId: null };
      }

      const latest = await tx.message.findFirst({
        where: {
          conversationId,
          sender: { not: 'SYSTEM' },
          deletedAt: null
        },
        orderBy: { timestamp: 'desc' }
      });
      if (!latest || latest.sender !== 'LEAD') {
        return { status: 'no_lead_input', scheduledReplyId: null };
      }
      if (now.getTime() - latest.timestamp.getTime() >= 24 * 60 * 60 * 1000) {
        return { status: 'needs_review', scheduledReplyId: null };
      }

      const outbound = await tx.message.findFirst({
        where: {
          conversationId,
          sender: { in: ['AI', 'HUMAN'] },
          deletedAt: null,
          timestamp: { gt: latest.timestamp }
        }
      });
      if (outbound) {
        return { status: 'already_handled', scheduledReplyId: null };
      }
      const uncertainGroup = await tx.messageGroup.findFirst({
        where: {
          conversationId,
          generatedAt: { gt: latest.timestamp }
        }
      });
      if (uncertainGroup) {
        return { status: 'needs_review', scheduledReplyId: null };
      }

      // A reply that began for an earlier lead turn can still be regenerating
      // against the newest conversation state. Do not create a second PENDING
      // row beside it: the partial unique index only protects PENDING rows and
      // therefore cannot prevent a PENDING + PROCESSING race.
      const processing = await tx.scheduledReply.findFirst({
        where: { conversationId, status: 'PROCESSING' },
        orderBy: { createdAt: 'desc' }
      });
      if (processing) {
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            awaitingAiResponse: true,
            awaitingSince: latest.timestamp
          }
        });
        return {
          status: 'already_scheduled',
          scheduledReplyId: processing.id
        };
      }

      const jobs = await tx.scheduledReply.findMany({
        where: {
          conversationId,
          createdAt: { gte: latest.timestamp }
        },
        orderBy: { createdAt: 'desc' }
      });
      const active = jobs.find(
        (job) => job.status === 'PENDING' || job.status === 'PROCESSING'
      );
      if (active) {
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            awaitingAiResponse: true,
            awaitingSince: latest.timestamp
          }
        });
        return {
          status: 'already_scheduled',
          scheduledReplyId: active.id
        };
      }
      if (jobs.some((job) => job.status === 'SENT')) {
        return { status: 'already_handled', scheduledReplyId: null };
      }
      if (
        jobs.some(
          (job) =>
            job.status === 'FAILED' ||
            job.status === 'FAILED_QUALITY_GATE' ||
            job.status === 'CANCELLED'
        )
      ) {
        return { status: 'needs_review', scheduledReplyId: null };
      }

      if (
        conversation.generationClaimAt &&
        conversation.generationClaimMessageId === latest.id &&
        now.getTime() - conversation.generationClaimAt.getTime() < 3 * 60 * 1000
      ) {
        return { status: 'already_scheduled', scheduledReplyId: null };
      }

      const id = `manychat-complete-${latest.id}`;
      const previous = await tx.scheduledReply.findFirst({ where: { id } });
      if (previous) {
        if (previous.status === 'PENDING' || previous.status === 'PROCESSING') {
          return { status: 'already_scheduled', scheduledReplyId: previous.id };
        }
        return {
          status:
            previous.status === 'SENT' ? 'already_handled' : 'needs_review',
          scheduledReplyId: previous.id
        };
      }

      const scheduledFor = manyChatCompletionScheduledFor(
        {
          now,
          earliestLeadAt: latest.timestamp,
          minDelay: account.responseDelayMin ?? 45,
          maxDelay: account.responseDelayMax ?? 120,
          debounceSeconds: account.debounceWindowSeconds ?? 45,
          maxDebounceSeconds: account.maxDebounceWindowSeconds ?? 120
        },
        drawDelay
      );
      await tx.scheduledReply.create({
        data: {
          id,
          conversationId,
          accountId,
          scheduledFor,
          status: 'PENDING'
        }
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          awaitingAiResponse: true,
          awaitingSince: latest.timestamp
        }
      });
      return { status: 'scheduled', scheduledReplyId: id };
    });
  } catch (error) {
    // A normal inbound scheduler does not take our advisory lock. If it wins
    // the database's one-PENDING-per-conversation constraint, reconcile only
    // after the failed transaction has rolled back (Postgres aborts a
    // transaction after a unique violation, so querying inside it is unsafe).
    if (
      typeof error !== 'object' ||
      error === null ||
      (error as { code?: string }).code !== 'P2002'
    ) {
      throw error;
    }
    const pending = await db.scheduledReply.findFirst({
      where: { conversationId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' }
    });
    if (!pending) throw error;
    return {
      status: 'already_scheduled',
      scheduledReplyId: pending.id
    };
  }
}
