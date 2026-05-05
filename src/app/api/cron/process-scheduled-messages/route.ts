import prisma from '@/lib/prisma';
import { generateReply } from '@/lib/ai-engine';
import { buildReminderPromptAppendix } from '@/lib/reminder-generator';
import {
  CALL_CONFIRMATION_TYPES,
  decodeScheduledBubbles,
  sendScheduledCallSequenceMessage
} from '@/lib/call-confirmation-sequence';
import { sendDM as sendInstagramDM } from '@/lib/instagram';
import { sendMessage as sendFacebookMessage } from '@/lib/facebook';
import {
  broadcastNewMessage,
  broadcastConversationUpdate
} from '@/lib/realtime';
import { isNearDuplicateOfRecentAiMessages } from '@/lib/ai-dedup';
import { scheduleNextInCascade } from '@/lib/follow-up-sequence';
import { transitionLeadStage } from '@/lib/lead-stage';
import { sanitizeDashCharacters } from '@/lib/voice-quality-gate';
import { NextRequest, NextResponse } from 'next/server';
import type { LeadContext } from '@/lib/ai-prompts';

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// GET /api/cron/process-scheduled-messages
// Runs every minute. Picks up due ScheduledMessage rows, generates the
// body text via the existing ai-engine (so voice rules + quality gate
// still apply), and sends to the platform.
// ---------------------------------------------------------------------------

// Rows stuck in FIRING for longer than this are assumed to have crashed
// mid-fire (lambda timeout, etc.) and get reclaimed on the next tick so
// we don't silently lose reminders.
const FIRING_STALE_MS = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const now = new Date();
    console.log('[cron/scheduled-messages] tick', now.toISOString());

    // Recover rows stuck in FIRING from a prior crashed tick. Flip back
    // to PENDING so they become eligible pickups this run.
    const staleCutoff = new Date(now.getTime() - FIRING_STALE_MS);
    const reclaimed = await prisma.scheduledMessage.updateMany({
      where: { status: 'FIRING', updatedAt: { lt: staleCutoff } },
      data: { status: 'PENDING' }
    });
    if (reclaimed.count > 0) {
      console.warn(
        `[cron/scheduled-messages] reclaimed ${reclaimed.count} stale FIRING rows`
      );
    }

    const due = await prisma.scheduledMessage.findMany({
      where: {
        status: 'PENDING',
        scheduledFor: { lte: now },
        attempts: { lt: 3 }
      },
      orderBy: { scheduledFor: 'asc' },
      take: 20
    });
    console.log(`[cron/scheduled-messages] picked up ${due.length} due rows`);
    if (due.length === 0) {
      return NextResponse.json({ processed: 0 });
    }

    // Dedup within-tick: at most ONE scheduled message per conversation
    // so we don't fire 2 reminders back-to-back if somehow two rows
    // ended up due at the same time.
    const seen = new Set<string>();
    const toProcess: typeof due = [];
    const skipDupIds: string[] = [];
    for (const r of due) {
      if (seen.has(r.conversationId)) {
        skipDupIds.push(r.id);
        continue;
      }
      seen.add(r.conversationId);
      toProcess.push(r);
    }
    if (skipDupIds.length > 0) {
      console.log(
        `[cron/scheduled-messages] deferring ${skipDupIds.length} same-convo dup rows to next tick`
      );
    }

    let sent = 0;
    let failed = 0;
    let skippedRace = 0;
    let skippedDedup = 0;
    for (const row of toProcess) {
      // Atomic per-row lock: only this tick gets to fire `row.id`. If
      // the updateMany's count is 0 another tick already locked it OR
      // something cancelled it between our findMany and this step.
      const lockRes = await prisma.scheduledMessage.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'FIRING' }
      });
      if (lockRes.count === 0) {
        console.log(
          `[cron/scheduled-messages] ${row.id} race-locked by another tick — skipping`
        );
        skippedRace++;
        continue;
      }

      try {
        const outcome = await fireScheduledMessage(row.id);
        if (outcome === 'sent') {
          await prisma.scheduledMessage.update({
            where: { id: row.id },
            data: { status: 'FIRED', firedAt: new Date() }
          });
          sent++;
        } else if (outcome === 'deduped') {
          // Dedup suppressed the send — record as FIRED with a note
          // so we don't retry, but track separately.
          await prisma.scheduledMessage.update({
            where: { id: row.id },
            data: {
              status: 'FIRED',
              firedAt: new Date(),
              lastError: 'dedup:suppressed_near_duplicate'
            }
          });
          skippedDedup++;
        } else if (outcome === 'skipped_ai_inactive') {
          // AI turned off on this convo — mark FIRED to stop retries.
          await prisma.scheduledMessage.update({
            where: { id: row.id },
            data: {
              status: 'FIRED',
              firedAt: new Date(),
              lastError: 'skipped:ai_inactive'
            }
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[cron/scheduled-messages] Failed to fire ${row.id}:`,
          msg
        );
        const nextAttempts = row.attempts + 1;
        await prisma.scheduledMessage.update({
          where: { id: row.id },
          data: {
            status: nextAttempts >= 3 ? 'FAILED' : 'PENDING',
            attempts: nextAttempts,
            lastError: msg.slice(0, 500)
          }
        });
        failed++;
      }
    }

    return NextResponse.json({
      processed: sent,
      failed,
      skippedRace,
      skippedDedup,
      total: toProcess.length
    });
  } catch (err) {
    console.error('[cron/scheduled-messages] Fatal:', err);
    return NextResponse.json({ error: 'cron failed' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Core: generate + send ONE scheduled message
// Returns 'sent' | 'deduped' | 'skipped_ai_inactive'. Throws on
// platform send failure so the caller can bump attempts + set status.
//
// CRITICAL ORDER: platform send FIRST, then Message row + broadcast.
// The old order (create row → broadcast → send) meant a failed send
// left a phantom Message visible in the dashboard AND, on retry with
// `generateAtSendTime: true`, a fresh text generation would write a
// SECOND phantom row. This is what produced Tahir Khan's 3 visible
// duplicates on 2026-04-21 even though Meta rejected every send.
// ---------------------------------------------------------------------------

async function fireScheduledMessage(
  scheduledMessageId: string
): Promise<'sent' | 'deduped' | 'skipped_ai_inactive'> {
  const row = await prisma.scheduledMessage.findUnique({
    where: { id: scheduledMessageId },
    include: {
      conversation: {
        include: {
          lead: {
            include: {
              tags: { include: { tag: { select: { name: true } } } }
            }
          },
          messages: { orderBy: { timestamp: 'asc' } }
        }
      }
    }
  });
  if (!row) throw new Error('row vanished');
  const { conversation } = row;
  const lead = conversation.lead;

  // Guardrail: if the call has already passed, the reminder is moot.
  if (
    row.relatedCallAt &&
    row.relatedCallAt.getTime() < Date.now() - 30 * 60_000
  ) {
    throw new Error(
      `related call is ${Math.round((Date.now() - row.relatedCallAt.getTime()) / 60000)}min in the past — skipping`
    );
  }

  // Guardrail: AI must be active on this conversation.
  if (!conversation.aiActive) {
    console.log(
      `[cron/scheduled-messages] ${row.id}: aiActive=false, skipping`
    );
    return 'skipped_ai_inactive';
  }

  if (
    row.messageType === 'CALL_DAY_REMINDER' &&
    conversation.callConfirmed === true
  ) {
    await prisma.scheduledMessage.update({
      where: { id: row.id },
      data: {
        status: 'CANCELLED',
        lastError: 'call_already_confirmed'
      }
    });
    return 'skipped_ai_inactive';
  }

  // Guardrail for silent-lead cascade + booking-link follow-up.
  // If the lead replied OR a human operator sent a manual message
  // between row creation and this firing, the cascade is moot. The
  // cancellation hooks in processIncomingMessage + processAdminMessage
  // + POST /conversations/:id/messages SHOULD have flipped the row to
  // CANCELLED before we got here — but there's a window where the cron
  // picks up + locks before the inbound/outbound message hits DB. This
  // is the second line of defense.
  //
  // Human check specifically catches daetradez 2026-04-24: operator
  // Daniel sent a manual "brother did you get a chance to book that
  // call?" at 7:58 PM while a BOOKING_LINK_FOLLOWUP row was pending.
  // The lead-only check (pre-this-fix) let the AI fire an identical
  // "yo bro, just checking in — were you able to book that call?"
  // follow-up a few seconds later, producing a duplicate.
  if (
    row.messageType === 'FOLLOW_UP_1' ||
    row.messageType === 'FOLLOW_UP_2' ||
    row.messageType === 'FOLLOW_UP_3' ||
    row.messageType === 'FOLLOW_UP_SOFT_EXIT' ||
    row.messageType === 'BOOKING_LINK_FOLLOWUP'
  ) {
    const freshReply = await prisma.message.findFirst({
      where: {
        conversationId: conversation.id,
        sender: { in: ['LEAD', 'HUMAN'] },
        timestamp: { gt: row.createdAt }
      },
      select: { id: true, sender: true }
    });
    if (freshReply) {
      console.log(
        `[cron/scheduled-messages] ${row.id}: ${freshReply.sender} message since row created — cancelling ${row.messageType}`
      );
      await prisma.scheduledMessage.update({
        where: { id: row.id },
        data: {
          status: 'CANCELLED',
          lastError:
            freshReply.sender === 'HUMAN'
              ? 'human_sent_since_scheduling'
              : 'lead_replied_since_scheduling'
        }
      });
      return 'skipped_ai_inactive';
    }
  }

  let messageBody = row.messageBody;

  if (CALL_CONFIRMATION_TYPES.includes(row.messageType)) {
    if (!messageBody || !messageBody.trim()) {
      throw new Error(`${row.messageType} missing messageBody`);
    }
    await sendScheduledCallSequenceMessage({
      conversationId: conversation.id,
      bubbles: decodeScheduledBubbles(messageBody)
    });
    console.log(
      `[cron/scheduled-messages] fired ${row.messageType} on ${row.id} (${lead.platform}/${lead.name})`
    );
    await scheduleNextInCascade(
      conversation.id,
      lead.accountId,
      row.messageType,
      row.messageBody ?? messageBody
    );
    return 'sent';
  }

  // Generate fresh at fire time if requested
  if (row.generateAtSendTime) {
    const appendix = buildReminderPromptAppendix({
      messageType: row.messageType,
      scheduledCallAt:
        row.relatedCallAt ?? conversation.scheduledCallAt ?? null,
      // Audit fix 6 (2026-05-05): show the call time in the LEAD's
      // timezone, not the timezone the call was booked in (which is
      // typically the host's tz and produces wrong reminders for
      // out-of-zone leads — e.g. "5:00 PM CDT" instead of
      // "12:00 AM CET" for an Amsterdam lead). Fall back to
      // scheduledCallTimezone only when the lead's tz is unknown;
      // reminder-generator handles null by skipping the time entirely
      // rather than inventing one.
      scheduledCallTimezone:
        conversation.leadTimezone ?? conversation.scheduledCallTimezone ?? null,
      leadName: lead.name || 'bro'
    });

    const leadContext: LeadContext = {
      leadName: lead.name,
      handle: lead.handle,
      platform: lead.platform,
      status: lead.stage,
      triggerType: lead.triggerType,
      triggerSource: lead.triggerSource,
      qualityScore: lead.qualityScore,
      tags: lead.tags.map((lt) => lt.tag.name),
      source: conversation.leadSource || undefined,
      experience: lead.experience || undefined,
      incomeLevel: lead.incomeLevel || undefined,
      geography: lead.geography || undefined,
      timezone:
        conversation.scheduledCallTimezone ||
        conversation.leadTimezone ||
        lead.timezone ||
        undefined
    };

    const history = conversation.messages.map((m) => ({
      id: m.id,
      role: m.sender === 'LEAD' ? ('user' as const) : ('assistant' as const),
      content: m.content,
      sender: m.sender,
      timestamp: m.timestamp.toISOString(),
      messageGroupId: m.messageGroupId,
      bubbleIndex: m.bubbleIndex,
      bubbleTotalCount: m.bubbleTotalCount
    }));

    const result = await generateReply(
      lead.accountId,
      conversation.personaId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      history as any,
      leadContext,
      appendix
    );
    messageBody = result.reply;
  }

  if (!messageBody || !messageBody.trim()) {
    throw new Error('generated empty body');
  }
  messageBody = sanitizeDashCharacters(messageBody);

  // Dedup: if this body is a near-duplicate of a recent AI message in
  // the same conversation, skip the send entirely. Catches two bad
  // patterns: (1) a keepalive that already said roughly "pumped for the
  // call tomorrow" then a day-before reminder rehashes the same sentiment;
  // (2) a retry-after-platform-failure that generated near-identical
  // text (was the classic 4-copies-per-tick symptom).
  const dedup = await isNearDuplicateOfRecentAiMessages(
    conversation.id,
    messageBody
  );
  if (dedup.isDuplicate) {
    console.warn(
      `[cron/scheduled-messages] ${row.id}: dedup_suppressed — sim=${dedup.maxSimilarity.toFixed(2)} vs recent AI msg. body="${messageBody.slice(0, 80)}"`
    );
    return 'deduped';
  }

  // Platform send FIRST. If Meta rejects (e.g. "outside allowed window"
  // past the 24h mark) we raise so the caller bumps attempts + retries
  // — no phantom Message row, no phantom SSE.
  if (!lead.platformUserId) {
    console.warn(
      `[cron/scheduled-messages] ${row.id}: no platformUserId — cannot send`
    );
    throw new Error('no platformUserId on lead');
  }

  try {
    if (lead.platform === 'INSTAGRAM') {
      await sendInstagramDM(lead.accountId, lead.platformUserId, messageBody);
    } else if (lead.platform === 'FACEBOOK') {
      await sendFacebookMessage(
        lead.accountId,
        lead.platformUserId,
        messageBody
      );
    } else {
      throw new Error(`unsupported platform: ${lead.platform}`);
    }
  } catch (err) {
    console.error(
      `[cron/scheduled-messages] delivery failed for ${row.id}:`,
      err
    );
    throw err;
  }

  // Platform send succeeded — now persist the Message row + broadcast.
  const now = new Date();
  const saved = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      sender: 'AI',
      content: messageBody,
      timestamp: now
    }
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: now }
  });

  broadcastNewMessage(lead.accountId, {
    id: saved.id,
    conversationId: conversation.id,
    sender: 'AI',
    content: messageBody,
    timestamp: now.toISOString()
  });
  broadcastConversationUpdate(lead.accountId, {
    id: conversation.id,
    leadId: lead.id,
    aiActive: true,
    unreadCount: conversation.unreadCount,
    lastMessageAt: now.toISOString()
  });

  console.log(
    `[cron/scheduled-messages] fired ${row.messageType} on ${row.id} (${lead.platform}/${lead.name})`
  );

  // ── Silent-lead cascade bookkeeping ──────────────────────────────
  // Every ScheduledMessage send calls scheduleNextInCascade after a
  // successful fire. For non-cascade types this returns null; for
  // BOOKING_LINK_FOLLOWUP / FOLLOW_UP_1/2/3 it schedules the next row.
  // After FOLLOW_UP_SOFT_EXIT fires, mark the conversation DORMANT
  // and transition the lead to GHOSTED — the sequence is terminal,
  // no more outbound touches on this convo until the lead re-engages
  // (which cancels via cancelAllPendingFollowUps).
  try {
    await scheduleNextInCascade(
      conversation.id,
      lead.accountId,
      row.messageType,
      row.messageBody ?? messageBody
    );
  } catch (err) {
    console.error(
      `[cron/scheduled-messages] cascade-next scheduling failed for ${row.id}:`,
      err
    );
  }

  if (row.messageType === 'FOLLOW_UP_SOFT_EXIT') {
    try {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { outcome: 'DORMANT' }
      });
      await transitionLeadStage(
        lead.id,
        'GHOSTED',
        'system',
        'silent-lead cascade exhausted (FOLLOW_UP_SOFT_EXIT fired)'
      );
    } catch (err) {
      console.error(
        `[cron/scheduled-messages] DORMANT marking failed for ${row.id}:`,
        err
      );
    }
  }

  return 'sent';
}
