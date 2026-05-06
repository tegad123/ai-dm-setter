import prisma from '@/lib/prisma';
import {
  classifyMetaDeliveryError,
  getScheduledReplyRetryAt,
  SCHEDULED_REPLY_MAX_ATTEMPTS
} from '@/lib/meta-delivery-errors';
import { processScheduledReply } from '@/lib/webhook-processor';
import { broadcastNotification } from '@/lib/realtime';
import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

// Rows stuck in PROCESSING for longer than this get bumped back to
// PENDING. Happens when a prior invocation flipped the row to
// PROCESSING but crashed or timed out before transitioning to SENT /
// FAILED — without a reclaim, subsequent ticks never re-pick the row
// and the lead's reply is orphaned.
//
// 90s cutoff picked from two bounds:
//   - Vercel cron runs once/min + `maxDuration: 60` on this route;
//     a single AI generation + send takes ~30-60s. A legitimate
//     in-flight row stays well under 90s from its scheduledFor.
//   - Worst-case latency for a crashed row: scheduledFor + 90s
//     reclaim cutoff + up to 60s for next cron tick = ~2.5 min.
//
// Safety: sendAIReply's double-fire guard blocks a second ship if
// the first attempt already saved a Message row — so even if we
// reclaim a row whose prior attempt is actually still in-flight, the
// second attempt aborts cleanly.
//
// History: initially 5min (commit 4665b91) — too slow, Rj.__666's
// 03:49:45 LEAD still had no response 4+ minutes later. Tightened
// to 90s 2026-04-23.
const PROCESSING_STALE_MS = 90 * 1000;

type SuggestionForRetry = {
  id: string;
  responseText: string;
  messageBubbles: Prisma.JsonValue | null;
  aiStageReported: string | null;
  aiSubStageReported: string | null;
  qualityGateScore: number | null;
  leadStageSnapshot: string | null;
  modelUsed: string | null;
};

function generatedResultFromSuggestion(suggestion: SuggestionForRetry) {
  const bubblesRaw = suggestion.messageBubbles;
  const messages =
    Array.isArray(bubblesRaw) && bubblesRaw.every((b) => typeof b === 'string')
      ? (bubblesRaw as string[])
      : [suggestion.responseText];
  const reply = messages[0] ?? suggestion.responseText;

  return {
    reply,
    messages,
    stage:
      suggestion.aiStageReported ?? suggestion.leadStageSnapshot ?? 'UNKNOWN',
    subStage: suggestion.aiSubStageReported,
    stageConfidence: suggestion.qualityGateScore ?? 0,
    sentimentScore: 0,
    experiencePath: null,
    objectionDetected: null,
    stallType: null,
    suggestedTag: 'NEUTRAL',
    suggestedTags: [],
    suggestedDelay: 0,
    systemPromptVersion: suggestion.modelUsed ?? 'stored-suggestion',
    suggestionId: suggestion.id
  };
}

function generatedReplyText(generatedResult: unknown): string | null {
  if (!generatedResult || typeof generatedResult !== 'object') return null;
  const result = generatedResult as { reply?: unknown; messages?: unknown };
  if (Array.isArray(result.messages)) {
    const messages = result.messages.filter(
      (m): m is string => typeof m === 'string' && m.trim().length > 0
    );
    if (messages.length > 0) return messages.join('\n');
  }
  return typeof result.reply === 'string' && result.reply.trim()
    ? result.reply
    : null;
}

async function fallbackGeneratedResultForReply(params: {
  conversationId: string;
  accountId: string;
  generatedResult: unknown;
}): Promise<Prisma.InputJsonValue | undefined> {
  if (generatedReplyText(params.generatedResult)) {
    return params.generatedResult as Prisma.InputJsonValue;
  }

  const suggestion = await prisma.aISuggestion.findFirst({
    where: {
      conversationId: params.conversationId,
      accountId: params.accountId,
      wasSelected: false,
      wasRejected: false
    },
    orderBy: { generatedAt: 'desc' },
    select: {
      id: true,
      responseText: true,
      messageBubbles: true,
      aiStageReported: true,
      aiSubStageReported: true,
      qualityGateScore: true,
      leadStageSnapshot: true,
      modelUsed: true
    }
  });
  if (!suggestion) return undefined;
  return generatedResultFromSuggestion(suggestion) as Prisma.InputJsonValue;
}

async function alertTerminalScheduledReplyFailure(params: {
  scheduledReplyId: string;
  conversationId: string;
  accountId: string;
  errorMessage: string;
  errorMeaning: string;
  metaCode: number | null;
  httpStatus: number | null;
  generatedResult: unknown;
}): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: {
      lead: { select: { id: true, name: true, handle: true } }
    }
  });
  const lead = conversation?.lead;
  const replyText = generatedReplyText(params.generatedResult);
  const codeLabel =
    params.metaCode !== null
      ? `Meta code ${params.metaCode}`
      : params.httpStatus !== null
        ? `HTTP ${params.httpStatus}`
        : 'unknown error code';

  try {
    await prisma.notification.create({
      data: {
        accountId: params.accountId,
        type: 'SYSTEM',
        title: 'Delivery Failed — manual send required',
        body:
          `${lead?.handle ? `@${lead.handle}` : (lead?.name ?? 'Lead')} did not receive the generated AI reply.\n` +
          `Error: ${codeLabel} — ${params.errorMeaning}\n\n` +
          `Generated reply:\n${replyText ?? '(reply text unavailable)'}\n\n` +
          `ScheduledReply: ${params.scheduledReplyId}`,
        leadId: lead?.id
      }
    });
    broadcastNotification(params.accountId, {
      type: 'SYSTEM',
      title: 'Delivery Failed — manual send required'
    });
  } catch (err) {
    console.error('[cron] terminal delivery notification failed:', err);
  }

  await sendDeliveryFailureSlackAlert({
    leadName: lead?.name,
    leadHandle: lead?.handle,
    conversationId: params.conversationId,
    scheduledReplyId: params.scheduledReplyId,
    codeLabel,
    errorMeaning: params.errorMeaning,
    replyText
  });
}

async function sendDeliveryFailureSlackAlert(params: {
  leadName?: string;
  leadHandle?: string;
  conversationId: string;
  scheduledReplyId: string;
  codeLabel: string;
  errorMeaning: string;
  replyText: string | null;
}): Promise<void> {
  const webhook =
    process.env.QDMS_DAETRADEZ_ALERTS_SLACK_WEBHOOK_URL ||
    process.env.OPERATOR_SLACK_WEBHOOK_URL ||
    process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;

  const who = params.leadHandle
    ? `@${params.leadHandle}`
    : (params.leadName ?? 'Unknown lead');
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text:
          `Delivery Failed — manual send required\n` +
          `Lead: ${who}\n` +
          `Conversation: ${params.conversationId}\n` +
          `ScheduledReply: ${params.scheduledReplyId}\n` +
          `Error: ${params.codeLabel} — ${params.errorMeaning}\n` +
          `Generated reply:\n${params.replyText ?? '(reply text unavailable)'}`
      })
    });
  } catch (err) {
    console.error('[cron] delivery failure Slack alert failed:', err);
  }
}

export async function GET(req: NextRequest) {
  try {
    // Validate bearer token against CRON_SECRET env var
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[cron] starting');
    const now = new Date();

    // Reclaim rows stuck in PROCESSING from a crashed prior invocation.
    // Flips them back to PENDING so the findMany below re-picks them
    // in this same tick.
    const staleCutoff = new Date(now.getTime() - PROCESSING_STALE_MS);
    const reclaimed = await prisma.scheduledReply.updateMany({
      where: {
        status: 'PROCESSING',
        scheduledFor: { lt: staleCutoff }
      },
      data: { status: 'PENDING' }
    });
    if (reclaimed.count > 0) {
      console.warn(
        `[cron] reclaimed ${reclaimed.count} stale PROCESSING rows (crashed prior invocations)`
      );
    }

    // Find due replies. FAILED rows with attempts remaining are retried
    // on later ticks so transient Meta outages stay visible without
    // becoming permanent "AI silence".
    const dueReplies = await prisma.scheduledReply.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        scheduledFor: { lte: now },
        attempts: { lt: SCHEDULED_REPLY_MAX_ATTEMPTS }
      },
      orderBy: { scheduledFor: 'asc' },
      take: 10
    });
    console.log(`[cron] picked up ${dueReplies.length} due replies`);

    if (dueReplies.length === 0) {
      return NextResponse.json({ processed: 0, failed: 0, total: 0 });
    }

    // Defensive de-dup: only process ONE reply per conversation per cron tick.
    // If two ScheduledReply rows exist for the same convo (e.g. Meta retried
    // a webhook and the route enqueued twice), the cron used to process both
    // and send the same AI message twice — exactly the duplicate the user
    // saw on tegaumukoro_ on 2026-04-08. We keep the earliest-scheduled row
    // per conversation, cancel the rest, and only act on the survivors.
    const pendingReplies: typeof dueReplies = [];
    const dupIdsToCancel: string[] = [];
    const seenConvos = new Set<string>();
    for (const r of dueReplies) {
      if (seenConvos.has(r.conversationId)) {
        dupIdsToCancel.push(r.id);
        continue;
      }
      seenConvos.add(r.conversationId);
      pendingReplies.push(r);
    }
    if (dupIdsToCancel.length > 0) {
      await prisma.scheduledReply.updateMany({
        where: { id: { in: dupIdsToCancel } },
        data: { status: 'CANCELLED' }
      });
      console.log(
        `[cron] cancelled ${dupIdsToCancel.length} duplicate replies (same conversation already queued)`
      );
    }

    // Mark as PROCESSING (optimistic lock to prevent double-pickup)
    const ids = pendingReplies.map((r) => r.id);
    await prisma.scheduledReply.updateMany({
      where: { id: { in: ids }, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'PROCESSING' }
    });

    let sent = 0;
    let failed = 0;

    for (const reply of pendingReplies) {
      console.log(
        `[cron] processing reply ${reply.id} convo=${reply.conversationId}`
      );
      try {
        await processScheduledReply(reply.conversationId, reply.accountId, {
          messageType: reply.messageType,
          generatedResult: reply.generatedResult,
          createdAt: reply.createdAt
        });
        console.log(`[cron] processed reply ${reply.id} OK`);

        await prisma.scheduledReply.update({
          where: { id: reply.id },
          data: { status: 'SENT', processedAt: new Date(), lastError: null }
        });
        sent++;
      } catch (err) {
        console.error(
          `[cron] Failed to process scheduled reply ${reply.id}:`,
          err
        );
        const errorInfo = classifyMetaDeliveryError(err);
        const errorMessage = errorInfo.rawMessage.slice(0, 2000);
        const failedAttempt = reply.attempts + 1;
        const terminalFailure =
          errorInfo.permanent ||
          !errorInfo.retryable ||
          failedAttempt >= SCHEDULED_REPLY_MAX_ATTEMPTS;
        const storedGeneratedResult = await fallbackGeneratedResultForReply({
          conversationId: reply.conversationId,
          accountId: reply.accountId,
          generatedResult: reply.generatedResult
        });
        const generatedResultUpdate = storedGeneratedResult
          ? { generatedResult: storedGeneratedResult }
          : {};

        if (terminalFailure) {
          const failedAt = new Date();
          await prisma.scheduledReply.update({
            where: { id: reply.id },
            data: {
              status: 'FAILED',
              attempts: errorInfo.permanent
                ? SCHEDULED_REPLY_MAX_ATTEMPTS
                : failedAttempt,
              scheduledFor: failedAt,
              processedAt: failedAt,
              lastError: errorMessage,
              ...generatedResultUpdate
            }
          });
          await alertTerminalScheduledReplyFailure({
            scheduledReplyId: reply.id,
            conversationId: reply.conversationId,
            accountId: reply.accountId,
            errorMessage,
            errorMeaning: errorInfo.meaning,
            metaCode: errorInfo.metaCode,
            httpStatus: errorInfo.httpStatus,
            generatedResult: storedGeneratedResult ?? reply.generatedResult
          });
        } else {
          const retryAt =
            getScheduledReplyRetryAt(failedAttempt, new Date()) ?? new Date();
          await prisma.scheduledReply.update({
            where: { id: reply.id },
            data: {
              status: 'PENDING',
              attempts: failedAttempt,
              scheduledFor: retryAt,
              processedAt: null,
              lastError: errorMessage,
              ...generatedResultUpdate
            }
          });
          console.warn(
            `[cron] scheduled retry ${failedAttempt + 1}/${SCHEDULED_REPLY_MAX_ATTEMPTS} for reply ${reply.id} at ${retryAt.toISOString()} (${errorInfo.meaning})`
          );
        }

        await prisma.conversation
          .update({
            where: { id: reply.conversationId },
            data: terminalFailure
              ? {
                  awaitingAiResponse: false,
                  awaitingSince: null,
                  lastSilentStopAt: new Date()
                }
              : {
                  awaitingAiResponse: true,
                  lastSilentStopAt: new Date()
                }
          })
          .catch(() => null);
        failed++;
      }
    }

    console.log(
      `[cron] Processed scheduled replies: ${sent} sent, ${failed} failed`
    );
    return NextResponse.json({
      processed: sent,
      failed,
      total: pendingReplies.length
    });
  } catch (error) {
    console.error('[cron] process-scheduled-replies error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
