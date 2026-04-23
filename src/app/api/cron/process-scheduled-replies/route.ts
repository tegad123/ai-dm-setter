import prisma from '@/lib/prisma';
import { processScheduledReply } from '@/lib/webhook-processor';
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

    // Find pending replies that are due
    const dueReplies = await prisma.scheduledReply.findMany({
      where: {
        status: 'PENDING',
        scheduledFor: { lte: now },
        attempts: { lt: 3 }
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
      where: { id: { in: ids }, status: 'PENDING' },
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
          data: { status: 'SENT', processedAt: new Date() }
        });
        sent++;
      } catch (err: any) {
        console.error(
          `[cron] Failed to process scheduled reply ${reply.id}:`,
          err
        );
        await prisma.scheduledReply.update({
          where: { id: reply.id },
          data: {
            status: reply.attempts + 1 >= 3 ? 'FAILED' : 'PENDING',
            attempts: { increment: 1 },
            lastError: (err?.message || 'Unknown error').slice(0, 500)
          }
        });
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
