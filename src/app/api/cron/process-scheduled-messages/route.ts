import prisma from '@/lib/prisma';
import { generateReply } from '@/lib/ai-engine';
import { buildReminderPromptAppendix } from '@/lib/reminder-generator';
import { sendDM as sendInstagramDM } from '@/lib/instagram';
import { sendMessage as sendFacebookMessage } from '@/lib/facebook';
import {
  broadcastNewMessage,
  broadcastConversationUpdate
} from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';
import type { LeadContext } from '@/lib/ai-prompts';

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// GET /api/cron/process-scheduled-messages
// Runs every minute. Picks up due ScheduledMessage rows, generates the
// body text via the existing ai-engine (so voice rules + quality gate
// still apply), and sends to the platform.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const now = new Date();
    console.log('[cron/scheduled-messages] tick', now.toISOString());

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

    // Dedup: at most ONE scheduled message per conversation per tick so we
    // don't fire 2 reminders back-to-back if somehow two rows ended up due
    // at the same time.
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

    // Optimistic lock: flip PENDING → FIRING so concurrent cron runs don't
    // double-process.
    const processIds = toProcess.map((r) => r.id);
    const locked = await prisma.scheduledMessage.updateMany({
      where: { id: { in: processIds }, status: 'PENDING' },
      data: { status: 'FIRING' }
    });
    console.log(
      `[cron/scheduled-messages] locked ${locked.count}/${processIds.length} rows`
    );

    let sent = 0;
    let failed = 0;
    for (const row of toProcess) {
      try {
        await fireScheduledMessage(row.id);
        await prisma.scheduledMessage.update({
          where: { id: row.id },
          data: { status: 'FIRED', firedAt: new Date() }
        });
        sent++;
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
      total: toProcess.length
    });
  } catch (err) {
    console.error('[cron/scheduled-messages] Fatal:', err);
    return NextResponse.json({ error: 'cron failed' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Core: generate + send ONE scheduled message
// ---------------------------------------------------------------------------

async function fireScheduledMessage(scheduledMessageId: string): Promise<void> {
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
      `[cron/scheduled-messages] ${row.id}: aiActive=false, skipping (marked FIRED to clean up)`
    );
    return; // let the caller mark FIRED so we don't keep retrying
  }

  let messageBody = row.messageBody;

  // Generate fresh at fire time if requested
  if (row.generateAtSendTime) {
    const appendix = buildReminderPromptAppendix({
      messageType: row.messageType,
      scheduledCallAt:
        row.relatedCallAt ?? conversation.scheduledCallAt ?? null,
      scheduledCallTimezone: conversation.scheduledCallTimezone ?? null,
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
      timestamp: m.timestamp.toISOString()
    }));

    const result = await generateReply(
      lead.accountId,
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

  // Save the outbound message
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

  broadcastNewMessage({
    id: saved.id,
    conversationId: conversation.id,
    sender: 'AI',
    content: messageBody,
    timestamp: now.toISOString()
  });
  broadcastConversationUpdate({
    id: conversation.id,
    leadId: lead.id,
    aiActive: true,
    unreadCount: conversation.unreadCount,
    lastMessageAt: now.toISOString()
  });

  // Deliver to platform
  if (!lead.platformUserId) {
    console.warn(
      `[cron/scheduled-messages] ${row.id}: no platformUserId — message saved locally only`
    );
    return;
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
    }
    console.log(
      `[cron/scheduled-messages] fired ${row.messageType} on ${row.id} (${lead.platform}/${lead.name})`
    );
  } catch (err) {
    console.error(
      `[cron/scheduled-messages] delivery failed for ${row.id}:`,
      err
    );
    throw err;
  }
}
