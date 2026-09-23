import prisma from '@/lib/prisma';
import { isStageProgressionDisabledForConversation } from '@/lib/lead-stage';
import {
  classifyMetaDeliveryError,
  getScheduledReplyRetryAt,
  SCHEDULED_REPLY_MAX_ATTEMPTS
} from '@/lib/meta-delivery-errors';
import { processScheduledReply } from '@/lib/webhook-processor';
import { scheduledReplyTerminalNoSendOutcome } from '@/lib/scheduled-reply-no-send';
import {
  claimScheduledReply,
  retryScheduledReplyData,
  SCHEDULED_REPLY_TERMINAL_REASONS,
  terminalScheduledReplyData
} from '@/lib/scheduled-reply-outcome';
import { reconcileScheduledReplyAfterError } from '@/lib/scheduled-reply-delivery-reconciliation';
import {
  FAILED_QUALITY_GATE_STATUS,
  isQualityGateEscalationError,
  QUALITY_GATE_FAILURE_REASON
} from '@/lib/quality-gate-escalation';
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

// A reply scheduled more than this long ago can no longer be delivered:
// Meta's standard messaging window is 24h from the lead's last message. Such
// rows are aged out as terminal FAILED instead of being retried forever.
// Without this floor the picker (oldest-first, take 10) served the same ten
// July rows on held conversations every tick and starved everything newer.
const UNDELIVERABLE_AFTER_MS = 24 * 60 * 60 * 1000;

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

  // Resurrection dedup (Ahsan Ali 2026-07-17, double link-send): the newest
  // un-actioned suggestion may be a draft of content that ALREADY shipped —
  // resurrecting it re-sends the same bubbles ("yo bro, check this out" +
  // funnel link, twice). If the suggestion's text already exists verbatim
  // among delivered AI messages in this conversation, do not resurrect it.
  const candidateTexts = [
    suggestion.responseText,
    ...(Array.isArray(suggestion.messageBubbles)
      ? (suggestion.messageBubbles as unknown[]).filter(
          (b): b is string => typeof b === 'string'
        )
      : [])
  ]
    .map((t) => t?.trim())
    .filter((t): t is string => !!t && t.length > 0);
  if (candidateTexts.length > 0) {
    const alreadySent = await prisma.message.findFirst({
      where: {
        conversationId: params.conversationId,
        sender: 'AI',
        content: { in: candidateTexts }
      },
      select: { id: true }
    });
    if (alreadySent) {
      console.warn(
        `[process-scheduled-replies] fallback suggestion ${suggestion.id} matches already-delivered content on ${params.conversationId} — skipping resurrection`
      );
      return undefined;
    }
  }

  const result = generatedResultFromSuggestion(suggestion);

  // Stage suppression: the stored aiStageReported predates the source-null
  // fix (or belongs to a qualification persona). Never let a resurrected
  // result stamp a funnel stage on a persona that disables stage progression
  // — this exact path put stage=QUALIFYING on a low-ticket Message row.
  if (await isStageProgressionDisabledForConversation(params.conversationId)) {
    result.stage = null as unknown as string;
    result.subStage = null;
  }

  return result as Prisma.InputJsonValue;
}

async function alertTerminalScheduledReplyFailure(params: {
  scheduledReplyId: string;
  conversationId: string;
  accountId: string;
  errorMessage: string;
  errorMeaning: string;
  metaCode: number | null;
  metaSubcode: number | null;
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
      ? `Meta code ${params.metaCode}${params.metaSubcode !== null ? ` / subcode ${params.metaSubcode}` : ''}`
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

    // Reclaim rows stuck in PROCESSING from a crashed prior invocation so
    // the findMany below re-picks them in this same tick.
    //
    // 2026-09-06 outage: this used to be ONE blind
    // updateMany(PROCESSING → PENDING). Since 2026-07-28 a partial unique
    // index (ScheduledReply_one_pending_per_conversation) allows exactly one
    // PENDING row per conversation, so the moment a stale PROCESSING row's
    // conversation already had a PENDING sibling the updateMany threw P2002
    // — before findMany ever ran — and the identical set collided again on
    // the next tick. The cron crashed on its first statement every minute
    // from 2026-08-26: 244 rows frozen in PROCESSING, zero replies delivered
    // after 2026-09-05 07:28 UTC, 771 conversations stuck awaitingAiResponse.
    // The inline after() path masked it for as long as replies fit inside its
    // budget. Reclaim now (a) ages out undeliverable rows in bulk as terminal
    // FAILED — no unique-index interaction, (b) reclaims recent stale rows
    // one at a time and CANCELS a row whose conversation already has a
    // PENDING sibling instead of throwing, and (c) can never abort the tick.
    const staleCutoff = new Date(now.getTime() - PROCESSING_STALE_MS);
    const undeliverableCutoff = new Date(
      now.getTime() - UNDELIVERABLE_AFTER_MS
    );
    try {
      const aged = await prisma.scheduledReply.updateMany({
        where: {
          status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
          scheduledFor: { lt: undeliverableCutoff },
          attempts: { lt: SCHEDULED_REPLY_MAX_ATTEMPTS }
        },
        data: {
          ...terminalScheduledReplyData({
            status: 'FAILED',
            reasonCode:
              SCHEDULED_REPLY_TERMINAL_REASONS.OUTSIDE_MESSAGING_WINDOW,
            terminalAt: now,
            attempts: SCHEDULED_REPLY_MAX_ATTEMPTS,
            lastError:
              'stale: scheduled more than 24h ago, outside the messaging window — not deliverable'
          })
        }
      });
      if (aged.count > 0) {
        console.warn(
          `[cron] aged out ${aged.count} undeliverable rows (scheduled >24h ago)`
        );
      }

      const stale = await prisma.scheduledReply.findMany({
        where: {
          status: 'PROCESSING',
          scheduledFor: { lt: staleCutoff, gte: undeliverableCutoff }
        },
        select: { id: true, conversationId: true },
        take: 50
      });
      let reclaimed = 0;
      let cancelled = 0;
      for (const row of stale) {
        try {
          await prisma.scheduledReply.update({
            where: { id: row.id },
            data: { status: 'PENDING' }
          });
          reclaimed++;
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            // A newer PENDING reply already exists for this conversation;
            // it supersedes the crashed one.
            await prisma.scheduledReply
              .update({
                where: { id: row.id },
                data: {
                  ...terminalScheduledReplyData({
                    status: 'CANCELLED',
                    reasonCode:
                      SCHEDULED_REPLY_TERMINAL_REASONS.SUPERSEDED_PENDING_REPLY,
                    terminalAt: now,
                    lastError:
                      'reclaim: a newer PENDING reply already exists for this conversation'
                  })
                }
              })
              .catch(() => null);
            cancelled++;
          } else {
            throw err;
          }
        }
      }
      if (reclaimed > 0 || cancelled > 0) {
        console.warn(
          `[cron] reclaimed ${reclaimed} stale PROCESSING rows, cancelled ${cancelled} superseded (crashed prior invocations)`
        );
      }
    } catch (err) {
      console.error(
        '[cron] reclaim failed (non-fatal — pickup continues):',
        err instanceof Error ? err.message : err
      );
    }

    // Find due replies. FAILED rows with attempts remaining are retried
    // on later ticks so transient Meta outages stay visible without
    // becoming permanent "AI silence". Rows older than the messaging
    // window are excluded (aged out above) so they can never starve
    // deliverable ones.
    const dueReplies = await prisma.scheduledReply.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        scheduledFor: { lte: now, gte: undeliverableCutoff },
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
        data: terminalScheduledReplyData({
          status: 'CANCELLED',
          reasonCode: SCHEDULED_REPLY_TERMINAL_REASONS.SUPERSEDED_PENDING_REPLY,
          lastError: 'duplicate queued reply for the same conversation'
        })
      });
      console.log(
        `[cron] cancelled ${dupIdsToCancel.length} duplicate replies (same conversation already queued)`
      );
    }

    // Mark as PROCESSING (optimistic lock to prevent double-pickup)
    const claimedReplies: typeof pendingReplies = [];
    for (const reply of pendingReplies) {
      if (
        await claimScheduledReply({
          id: reply.id,
          conversationId: reply.conversationId,
          fromStatuses: ['PENDING', 'FAILED']
        })
      ) {
        claimedReplies.push(reply);
      }
    }

    let sent = 0;
    let failed = 0;

    for (const reply of claimedReplies) {
      console.log(
        `[cron] processing reply ${reply.id} convo=${reply.conversationId}`
      );
      const processingStartedAt = new Date();
      let reviewHoldExistedBeforeAttempt: boolean | null = null;
      try {
        const conversationBeforeAttempt = await prisma.conversation.findUnique({
          where: { id: reply.conversationId },
          select: { awaitingHumanReview: true }
        });
        reviewHoldExistedBeforeAttempt =
          conversationBeforeAttempt?.awaitingHumanReview ?? null;
        await processScheduledReply(reply.conversationId, reply.accountId, {
          scheduledReplyId: reply.id,
          messageType: reply.messageType,
          generatedResult: reply.generatedResult,
          createdAt: reply.createdAt
        });
        const deliveredMessage = await prisma.message.findFirst({
          where: {
            conversationId: reply.conversationId,
            sender: 'AI',
            timestamp: { gte: processingStartedAt }
          },
          select: { id: true }
        });
        if (!deliveredMessage) {
          // Some completed paths intentionally produce no outbound Message
          // (generate-only suggestion or a repeated question after the lead
          // already answered). Their durable CANCELLED marker is a successful
          // terminal outcome, not a delivery failure.
          const noSendOutcome = await scheduledReplyTerminalNoSendOutcome(
            reply.id
          );
          if (noSendOutcome) {
            console.log(
              `[cron] reply ${reply.id} completed without send (${noSendOutcome.reason}) for convo ${reply.conversationId}`
            );
            continue;
          }
          // Another path already answered this lead turn after the row was
          // created (inline after(), a sibling row, a recovery sweep):
          // processScheduledReply correctly found nothing to do. That is a
          // delivered turn, not a failure — 2026-09-14 this raised five
          // "Delivery Failed" alerts and five regenerations on one delivered
          // reply (conv cmu0zhsp40003lh043d9f0ndt).
          const deliveredByOtherPath = await prisma.message.findFirst({
            where: {
              conversationId: reply.conversationId,
              sender: 'AI',
              platformMessageId: { not: null },
              timestamp: { gte: reply.createdAt }
            },
            select: { id: true, timestamp: true }
          });
          if (deliveredByOtherPath) {
            console.log(
              `[cron] reply ${reply.id} already answered by another path at ${deliveredByOtherPath.timestamp.toISOString()} (convo ${reply.conversationId}) — marking SENT`
            );
            await prisma.scheduledReply.update({
              where: { id: reply.id },
              data: {
                ...terminalScheduledReplyData({
                  status: 'SENT',
                  reasonCode:
                    SCHEDULED_REPLY_TERMINAL_REASONS.DELIVERED_BY_OTHER_PATH,
                  lastError:
                    'delivered by another path before this row ran (no duplicate sent)'
                })
              }
            });
            sent++;
            continue;
          }
          // Every bubble of the generated turn was a verbatim repeat of
          // content already delivered — the egress guard suppressed the
          // whole group (deliveryNotes.reason = 'all_bubbles_repeat'). Not a
          // delivery failure: nothing new to say, nothing to retry.
          const suppressedGroup = await prisma.messageGroup.findFirst({
            where: {
              conversationId: reply.conversationId,
              completedAt: { gte: processingStartedAt }
            },
            orderBy: { completedAt: 'desc' },
            select: { id: true, deliveryNotes: true }
          });
          const suppressedReason = (
            suppressedGroup?.deliveryNotes as { reason?: string } | null
          )?.reason;
          if (suppressedReason === 'all_bubbles_repeat') {
            console.warn(
              `[cron] reply ${reply.id} suppressed: every bubble was a verbatim repeat (group ${suppressedGroup?.id}, convo ${reply.conversationId})`
            );
            await prisma.scheduledReply.update({
              where: { id: reply.id },
              data: {
                ...terminalScheduledReplyData({
                  status: 'CANCELLED',
                  reasonCode: SCHEDULED_REPLY_TERMINAL_REASONS.VERBATIM_REPEAT,
                  lastError:
                    'suppressed: every bubble repeated already-delivered content (VERBATIM_REPEAT guard)'
                })
              }
            });
            continue;
          }
          throw new Error(
            'ScheduledReply completed without delivering an AI Message'
          );
        }
        console.log(`[cron] processed reply ${reply.id} OK`);

        await prisma.scheduledReply.update({
          where: { id: reply.id },
          data: terminalScheduledReplyData({
            status: 'SENT',
            reasonCode: SCHEDULED_REPLY_TERMINAL_REASONS.DELIVERED,
            lastError: null
          })
        });
        sent++;
      } catch (err) {
        console.error(
          `[cron] Failed to process scheduled reply ${reply.id}:`,
          err
        );
        const reconciled = await reconcileScheduledReplyAfterError({
          scheduledReplyId: reply.id,
          conversationId: reply.conversationId,
          scheduledReplyCreatedAt: reply.createdAt,
          reviewHoldExistedBeforeAttempt,
          error: err
        }).catch((reconciliationError) => {
          console.error(
            `[cron] delivery reconciliation failed for reply ${reply.id}:`,
            reconciliationError
          );
          return null;
        });
        if (reconciled) {
          console.warn(
            `[cron] reply ${reply.id} raised after Meta delivery ` +
              `(message=${reconciled.deliveredMessage.id}); reconciled as SENT`
          );
          sent++;
          continue;
        }
        if (isQualityGateEscalationError(err)) {
          const failedAt = new Date();
          await prisma.scheduledReply.update({
            where: { id: reply.id },
            data: {
              ...terminalScheduledReplyData({
                status: FAILED_QUALITY_GATE_STATUS,
                reasonCode: SCHEDULED_REPLY_TERMINAL_REASONS.QUALITY_GATE_HOLD,
                terminalAt: failedAt,
                attempts: reply.attempts + 1,
                scheduledFor: failedAt,
                lastError: err.message.slice(0, 2000),
                ...(err.generatedResult
                  ? { generatedResult: err.generatedResult }
                  : {})
              })
              // 2026-07-27 (Tega): record the REAL attempt count — the
              // terminal status already prevents retries (the picker only
              // claims PENDING rows). Stamping MAX here made a first-attempt
              // gate failure read as "5 attempts" in Needs Attention, which
              // misread as minutes of silent retries.
            }
          });
          await prisma.conversation
            .update({
              where: { id: reply.conversationId },
              data: {
                aiActive: true,
                autoSendOverride: true,
                awaitingHumanReview: true,
                awaitingAiResponse: true,
                awaitingSince: err.awaitingSince ?? failedAt,
                lastSilentStopAt: failedAt
              }
            })
            .catch(() => null);
          console.warn('[cron] scheduled reply escalated to human review:', {
            scheduledReplyId: reply.id,
            conversationId: reply.conversationId,
            reason: QUALITY_GATE_FAILURE_REASON
          });
          failed++;
          continue;
        }
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
              ...terminalScheduledReplyData({
                status: 'FAILED',
                reasonCode:
                  errorInfo.permanent || !errorInfo.retryable
                    ? SCHEDULED_REPLY_TERMINAL_REASONS.META_PERMANENT_FAILURE
                    : SCHEDULED_REPLY_TERMINAL_REASONS.RETRY_EXHAUSTED,
                terminalAt: failedAt,
                attempts: SCHEDULED_REPLY_MAX_ATTEMPTS,
                scheduledFor: failedAt,
                lastError: errorMessage,
                ...(storedGeneratedResult
                  ? { generatedResult: storedGeneratedResult }
                  : {})
              })
              // Terminal means terminal: the picker claims FAILED rows with
              // attempts < MAX, so a non-retryable failure stamped with its
              // real attempt count was re-picked every tick until it hit
              // MAX — five alerts for one failure (2026-09-14). Stamp MAX so
              // it is never re-picked; lastError keeps the real story.
            }
          });
          await alertTerminalScheduledReplyFailure({
            scheduledReplyId: reply.id,
            conversationId: reply.conversationId,
            accountId: reply.accountId,
            errorMessage,
            errorMeaning: errorInfo.meaning,
            metaCode: errorInfo.metaCode,
            metaSubcode: errorInfo.metaSubcode,
            httpStatus: errorInfo.httpStatus,
            generatedResult: storedGeneratedResult ?? reply.generatedResult
          });
        } else {
          const retryAt =
            getScheduledReplyRetryAt(failedAttempt, new Date()) ?? new Date();
          await prisma.scheduledReply.update({
            where: { id: reply.id },
            data: {
              ...retryScheduledReplyData({
                attempts: failedAttempt,
                scheduledFor: retryAt,
                lastError: errorMessage
              }),
              ...generatedResultUpdate
            }
          });
          console.warn(
            `[cron] scheduled retry ${failedAttempt + 1}/${SCHEDULED_REPLY_MAX_ATTEMPTS} for reply ${reply.id} at ${retryAt.toISOString()} (${errorInfo.meaning})`
          );
          // 2026-07-27 (Tega): retries used to be invisible until all 5
          // attempts burned (~5 min of apparent silence). From the SECOND
          // failed attempt, surface a throttled SYSTEM notification so the
          // operator can see the reply is struggling while retries continue.
          if (failedAttempt >= 2) {
            const existing = await prisma.notification
              .findFirst({
                where: {
                  accountId: reply.accountId,
                  type: 'SYSTEM',
                  title: { contains: `retrying — reply ${reply.id.slice(-8)}` }
                },
                select: { id: true }
              })
              .catch(() => null);
            if (!existing) {
              await prisma.notification
                .create({
                  data: {
                    accountId: reply.accountId,
                    type: 'SYSTEM',
                    title: `AI reply retrying — reply ${reply.id.slice(-8)}`,
                    body: `A reply in conversation ${reply.conversationId} has failed ${failedAttempt} of ${SCHEDULED_REPLY_MAX_ATTEMPTS} attempts (${errorInfo.meaning}). Retries continue; if all attempts fail it will escalate for manual handling.`
                  }
                })
                .catch(() => {});
            }
          }
        }

        await prisma.conversation
          .update({
            where: { id: reply.conversationId },
            // N3 (2026-07-25, Tega run-2): terminal failure used to set
            // awaitingAiResponse=false, which makes the conversation INVISIBLE
            // to silent-stop-heartbeat (it filters awaitingAiResponse=true) —
            // the lead got permanent silence until a human noticed the 4h
            // "stuck" tile. Keep it heartbeat-visible: the heartbeat's
            // contextual re-engagement is the recovery of last resort. The
            // operator alert (alertTerminalScheduledReplyFailure above) still
            // fires either way.
            data: {
              awaitingAiResponse: true,
              awaitingSince: new Date(),
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
