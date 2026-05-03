/**
 * One-time live-conversation self-recovery sweep.
 *
 * Finds conversations whose last AI turn was a stall/holding message and
 * creates PENDING_APPROVAL SelfRecoveryEvent rows. It never sends to leads.
 *
 * Run: npx tsx scripts/run-self-recovery-sweep.ts
 */

import prisma from '@/lib/prisma';
import {
  attemptSelfRecovery,
  isSelfRecoveryTrigger,
  type ScriptHistoryMessage
} from '@/lib/script-state-recovery';

const LOOKBACK_DAYS = Number(process.env.RECOVERY_SWEEP_LOOKBACK_DAYS || 7);
const HUMAN_PICKUP_GRACE_HOURS = Number(
  process.env.RECOVERY_SWEEP_HUMAN_GRACE_HOURS || 4
);

async function main() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const humanGraceSince = new Date(
    Date.now() - HUMAN_PICKUP_GRACE_HOURS * 60 * 60 * 1000
  );

  const conversations = await prisma.conversation.findMany({
    where: {
      lastMessageAt: { gte: since },
      distressDetected: false,
      messages: {
        some: {
          sender: 'AI',
          timestamp: { gte: since },
          content: {
            contains: 'double-check',
            mode: 'insensitive'
          }
        }
      }
    },
    include: {
      lead: { select: { id: true, accountId: true, name: true, handle: true } },
      messages: { orderBy: { timestamp: 'asc' } }
    },
    take: 200
  });

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const conversation of conversations) {
    const lastHuman = [...conversation.messages]
      .reverse()
      .find((m) => m.sender === 'HUMAN');
    if (lastHuman && lastHuman.timestamp > humanGraceSince) {
      skipped++;
      continue;
    }

    const lastAi = [...conversation.messages]
      .reverse()
      .find((m) => m.sender === 'AI');
    const trigger = isSelfRecoveryTrigger({
      message: lastAi?.content,
      messages: lastAi?.content ? [lastAi.content] : [],
      escalateToHuman: false,
      stallType: lastAi?.stallType ?? null
    });
    if (!trigger.triggered) {
      skipped++;
      continue;
    }

    const existingPending = await prisma.selfRecoveryEvent.findFirst({
      where: {
        conversationId: conversation.id,
        status: 'PENDING_APPROVAL'
      },
      select: { id: true }
    });
    if (existingPending) {
      skipped++;
      continue;
    }

    const history: ScriptHistoryMessage[] = conversation.messages.map((m) => ({
      id: m.id,
      sender: m.sender,
      content: m.content,
      timestamp: m.timestamp
    }));

    const recovery = await attemptSelfRecovery({
      accountId: conversation.lead.accountId,
      conversationId: conversation.id,
      history,
      triggerReason: `sweep_${trigger.reason || 'stall_message_detected'}`,
      llmEmittedStage: lastAi?.stage ?? null,
      approvalMode: true
    });

    if (recovery.recovered) {
      created++;
      console.log(
        `[self-recovery-sweep] pending ${recovery.priority} ${conversation.lead.handle}: ${recovery.reason}`
      );
    } else {
      failed++;
      console.log(
        `[self-recovery-sweep] failed ${conversation.lead.handle}: ${recovery.reason}`
      );
    }
  }

  console.log(
    `[self-recovery-sweep] complete created=${created} skipped=${skipped} failed=${failed}`
  );
}

main()
  .catch((err) => {
    console.error('[self-recovery-sweep] fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
