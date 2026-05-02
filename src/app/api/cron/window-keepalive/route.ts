import prisma from '@/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';
import { sendDM as sendInstagramDM } from '@/lib/instagram';
import { sendMessage as sendFacebookMessage } from '@/lib/facebook';
import { generateKeepaliveMessage } from '@/lib/keepalive-generator';
import { isClosingSignal } from '@/lib/closing-signal-detector';
import { isNearDuplicateOfRecentAiMessages } from '@/lib/ai-dedup';
import { sanitizeDashCharacters } from '@/lib/voice-quality-gate';
import {
  broadcastNewMessage,
  broadcastConversationUpdate
} from '@/lib/realtime';

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// /api/cron/window-keepalive
// ---------------------------------------------------------------------------
// Detects conversations approaching the 24-hour Meta messaging window
// expiry and sends a natural check-in message to keep the window open.
// Runs every 15 minutes.
//
// Rationale: Meta (Facebook + Instagram) blocks automated messaging
// once 24h pass without an inbound from the lead. Leads who book a
// call 3+ days out cross multiple 24h windows before the call. If any
// window closes, the AI can't send the day-before or morning-of
// reminder. A light check-in at hour 20 gets the lead to reply, which
// resets the clock for free.
//
// Candidate criteria:
//   1. aiActive=true
//   2. scheduledCallAt set AND in the future
//   3. Last message (any sender) between 18–23h ago
//   4. No WINDOW_KEEPALIVE fired in the last 20h for this conversation
//   5. distressDetected=false
//   6. Not a closing-signal conversation (last AI+Lead interaction
//      wasn't an emoji-only goodbye / gratitude-only close)
//   7. Fewer than 3 consecutive keepalives already sent with no lead
//      response between them (exhaustion cap)
//
// On a hit: generate a short natural check-in via Haiku, ship via the
// platform API, save a Message row + a ScheduledMessage row (status=
// FIRED) as the dedup anchor. The ScheduledMessage is the lookup for
// "when did we last send a keepalive" in subsequent ticks and for the
// dashboard's "keepalive sent, no response yet" attention item.
// ---------------------------------------------------------------------------

const LOWER_BOUND_MS = 18 * 60 * 60 * 1000;
const UPPER_BOUND_MS = 23 * 60 * 60 * 1000;
const DEDUP_WINDOW_MS = 20 * 60 * 60 * 1000;
// If a DAY_BEFORE_REMINDER or MORNING_OF_REMINDER fired (or got marked
// FIRED with a dedup note) within this window, suppress the keepalive
// so the lead doesn't get back-to-back nudges from two different
// subsystems.
const REMINDER_COORDINATION_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_BATCH = 25;
const EXHAUSTION_THRESHOLD = 3;

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const now = new Date();
    const lowerBound = new Date(now.getTime() - UPPER_BOUND_MS);
    const upperBound = new Date(now.getTime() - LOWER_BOUND_MS);

    console.log(
      `[cron/window-keepalive] tick at ${now.toISOString()}: looking for conversations last-active between ${lowerBound.toISOString()} and ${upperBound.toISOString()}`
    );

    // Candidate query: Conversation rows where aiActive=true, a
    // scheduled call in the future, last message time in the 18–23h
    // window. We pull a small batch and run the remaining guardrails
    // in JS because they depend on per-conversation subqueries (close
    // signal, consecutive keepalive count).
    const candidates = await prisma.conversation.findMany({
      where: {
        aiActive: true,
        distressDetected: false,
        scheduledCallAt: { gt: now },
        lastMessageAt: { gte: lowerBound, lte: upperBound },
        // Don't burn keepalives on conversations that have already
        // exited the funnel naturally — resistant exit or soft exit
        // means the lead is done.
        outcome: { notIn: ['RESISTANT_EXIT', 'SOFT_EXIT'] }
      },
      select: {
        id: true,
        lastMessageAt: true,
        scheduledCallAt: true,
        scheduledCallTimezone: true,
        lead: {
          select: {
            id: true,
            accountId: true,
            name: true,
            handle: true,
            platform: true,
            platformUserId: true
          }
        }
      },
      take: MAX_BATCH
    });

    console.log(
      `[cron/window-keepalive] ${candidates.length} candidate conversation(s)`
    );

    let fired = 0;
    let skippedDedup = 0;
    let skippedClose = 0;
    let skippedExhausted = 0;
    let skippedNoPlatformUser = 0;
    let skippedReminderNear = 0;
    let skippedNearDuplicate = 0;
    let errors = 0;

    for (const conv of candidates) {
      try {
        if (!conv.lead.platformUserId) {
          skippedNoPlatformUser++;
          continue;
        }
        // Guardrail 4: dedupe — no WINDOW_KEEPALIVE in the last 20h.
        // Using the scheduledMessage table so the dedupe survives
        // across cron ticks even if the Message row was delayed/
        // broadcast-only.
        const recentKeepalive = await prisma.scheduledMessage.findFirst({
          where: {
            conversationId: conv.id,
            messageType: 'WINDOW_KEEPALIVE',
            firedAt: { gte: new Date(now.getTime() - DEDUP_WINDOW_MS) }
          },
          select: { id: true }
        });
        if (recentKeepalive) {
          skippedDedup++;
          continue;
        }

        // Guardrail 4b: reminder coordination. If a DAY_BEFORE or
        // MORNING_OF reminder has already fired (or been recorded as
        // dedup-suppressed) within the past 12h, skip the keepalive
        // so the lead doesn't get back-to-back "pumped for tomorrow"
        // nudges from both the reminder cron and the keepalive cron.
        const recentReminder = await prisma.scheduledMessage.findFirst({
          where: {
            conversationId: conv.id,
            messageType: { in: ['DAY_BEFORE_REMINDER', 'MORNING_OF_REMINDER'] },
            status: 'FIRED',
            firedAt: {
              gte: new Date(now.getTime() - REMINDER_COORDINATION_WINDOW_MS)
            }
          },
          select: { id: true, messageType: true, firedAt: true }
        });
        if (recentReminder) {
          console.log(
            `[cron/window-keepalive] conv=${conv.id} skipped — ${recentReminder.messageType} fired at ${recentReminder.firedAt?.toISOString()} (within 12h coordination window)`
          );
          skippedReminderNear++;
          continue;
        }

        // Guardrail 7: exhaustion cap — count WINDOW_KEEPALIVE rows
        // fired since the most recent LEAD message. If that count is
        // already >= 3, skip (the conversation is dead, don't burn
        // further messages). The dashboard surfaces this via the
        // keepalive_exhausted action item.
        const latestLead = await prisma.message.findFirst({
          where: { conversationId: conv.id, sender: 'LEAD' },
          orderBy: { timestamp: 'desc' },
          select: { timestamp: true }
        });
        const sinceLeadRef = latestLead?.timestamp ?? new Date(0);
        const keepalivesSinceLead = await prisma.scheduledMessage.count({
          where: {
            conversationId: conv.id,
            messageType: 'WINDOW_KEEPALIVE',
            status: 'FIRED',
            firedAt: { gt: sinceLeadRef }
          }
        });
        if (keepalivesSinceLead >= EXHAUSTION_THRESHOLD) {
          skippedExhausted++;
          continue;
        }

        // Guardrail 6: respect closing signals. If the conversation
        // effectively ended ("take care bro", "thanks", emoji
        // goodbye) we shouldn't poke it back awake. Reuse the existing
        // detector against the latest LEAD message + prior AI
        // message to check.
        const latestAi = await prisma.message.findFirst({
          where: { conversationId: conv.id, sender: 'AI' },
          orderBy: { timestamp: 'desc' },
          select: { content: true, timestamp: true }
        });
        if (latestLead && latestAi) {
          // Need the LEAD message TEXT (not just timestamp) plus the
          // prior lead message for consecutive-gratitude detection.
          const leadMsgRow = await prisma.message.findFirst({
            where: { conversationId: conv.id, sender: 'LEAD' },
            orderBy: { timestamp: 'desc' },
            select: { content: true }
          });
          const priorLeadRow = await prisma.message.findFirst({
            where: {
              conversationId: conv.id,
              sender: 'LEAD',
              timestamp: { lt: latestLead.timestamp }
            },
            orderBy: { timestamp: 'desc' },
            select: { content: true }
          });
          if (leadMsgRow) {
            const closeCheck = isClosingSignal(
              leadMsgRow.content,
              latestAi.content,
              latestAi.timestamp,
              priorLeadRow?.content ?? null
            );
            if (closeCheck.isClosing) {
              skippedClose++;
              continue;
            }
          }
        }

        // All guardrails passed — generate + ship inline.
        const keepaliveText = sanitizeDashCharacters(
          await generateKeepaliveMessage({
            leadName: conv.lead.name,
            scheduledCallAt: conv.scheduledCallAt!,
            now
          })
        );

        // Final dedup pass: even with all the structural guardrails
        // above, Haiku can regenerate a line that rehashes a recent
        // AI message (the Tahir Khan 2026-04-21 symptom — keepalive
        // text was indistinguishable from the future reminder text).
        // Compare against the last 3 AI messages before shipping.
        const dedup = await isNearDuplicateOfRecentAiMessages(
          conv.id,
          keepaliveText
        );
        if (dedup.isDuplicate) {
          console.warn(
            `[cron/window-keepalive] conv=${conv.id} dedup_suppressed sim=${dedup.maxSimilarity.toFixed(2)} text="${keepaliveText.slice(0, 80)}"`
          );
          // Record a FIRED row with a note so we don't retry-in-tight-loop,
          // and the 20h dedup window kicks in naturally.
          await prisma.scheduledMessage
            .create({
              data: {
                conversationId: conv.id,
                accountId: conv.lead.accountId,
                scheduledFor: now,
                messageType: 'WINDOW_KEEPALIVE',
                messageBody: keepaliveText,
                generateAtSendTime: false,
                status: 'FIRED',
                firedAt: now,
                relatedCallAt: conv.scheduledCallAt,
                createdBy: 'SYSTEM',
                attempts: 1,
                lastError: 'dedup:suppressed_near_duplicate'
              }
            })
            .catch(() => {});
          skippedNearDuplicate++;
          continue;
        }

        // Platform send first — if Meta rejects, we don't want a
        // phantom Message row claiming we sent something we didn't.
        try {
          if (conv.lead.platform === 'INSTAGRAM') {
            await sendInstagramDM(
              conv.lead.accountId,
              conv.lead.platformUserId,
              keepaliveText
            );
          } else if (conv.lead.platform === 'FACEBOOK') {
            await sendFacebookMessage(
              conv.lead.accountId,
              conv.lead.platformUserId,
              keepaliveText
            );
          } else {
            console.warn(
              `[cron/window-keepalive] unsupported platform ${conv.lead.platform} for conv ${conv.id} — skipping`
            );
            continue;
          }
        } catch (sendErr) {
          console.error(
            `[cron/window-keepalive] platform send failed for conv ${conv.id}:`,
            sendErr
          );
          // Log a FAILED ScheduledMessage so ops can see the attempt
          // + reason. Don't rethrow — continue the batch.
          await prisma.scheduledMessage
            .create({
              data: {
                conversationId: conv.id,
                accountId: conv.lead.accountId,
                scheduledFor: now,
                messageType: 'WINDOW_KEEPALIVE',
                messageBody: keepaliveText,
                generateAtSendTime: false,
                status: 'FAILED',
                firedAt: now,
                relatedCallAt: conv.scheduledCallAt,
                createdBy: 'SYSTEM',
                attempts: 1,
                lastError: String(sendErr).slice(0, 500)
              }
            })
            .catch(() => {});
          errors++;
          continue;
        }

        // Platform send succeeded — save the Message row + FIRED
        // ScheduledMessage row. Broadcast SSE so the operator
        // dashboard sees it in real-time.
        const msg = await prisma.message.create({
          data: {
            conversationId: conv.id,
            sender: 'AI',
            content: keepaliveText,
            timestamp: now,
            // stage / subStage deliberately null — this is not a
            // funnel-advancing turn, shouldn't count toward stage
            // progression analytics.
            stage: null,
            subStage: null
          }
        });
        await prisma.scheduledMessage.create({
          data: {
            conversationId: conv.id,
            accountId: conv.lead.accountId,
            scheduledFor: now,
            messageType: 'WINDOW_KEEPALIVE',
            messageBody: keepaliveText,
            generateAtSendTime: false,
            status: 'FIRED',
            firedAt: now,
            relatedCallAt: conv.scheduledCallAt,
            createdBy: 'SYSTEM',
            attempts: 1
          }
        });
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { lastMessageAt: now }
        });
        broadcastNewMessage({
          id: msg.id,
          conversationId: conv.id,
          sender: 'AI',
          content: keepaliveText,
          timestamp: now.toISOString()
        });
        broadcastConversationUpdate({
          id: conv.id,
          leadId: conv.lead.id,
          aiActive: true,
          unreadCount: 0,
          lastMessageAt: now.toISOString()
        });
        fired++;
        console.log(
          `[cron/window-keepalive] fired for conv=${conv.id} lead=${conv.lead.name} msg="${keepaliveText.slice(0, 80)}"`
        );
      } catch (convErr) {
        console.error(
          `[cron/window-keepalive] conv ${conv.id} errored:`,
          convErr
        );
        errors++;
      }
    }

    return NextResponse.json({
      ok: true,
      tick: now.toISOString(),
      candidates: candidates.length,
      fired,
      skippedDedup,
      skippedClose,
      skippedExhausted,
      skippedNoPlatformUser,
      skippedReminderNear,
      skippedNearDuplicate,
      errors
    });
  } catch (err) {
    console.error('[cron/window-keepalive] fatal:', err);
    return NextResponse.json(
      { error: 'keepalive cron failed' },
      { status: 500 }
    );
  }
}
