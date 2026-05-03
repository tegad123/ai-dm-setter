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
  attemptMidConversationRequalification,
  attemptSelfRecovery,
  detectMidConversationStepSkip,
  isSelfRecoveryTrigger,
  prepareScriptState,
  type ScriptHistoryMessage
} from '@/lib/script-state-recovery';

const LOOKBACK_DAYS = Number(process.env.RECOVERY_SWEEP_LOOKBACK_DAYS || 7);
const HUMAN_PICKUP_GRACE_HOURS = Number(
  process.env.RECOVERY_SWEEP_HUMAN_GRACE_HOURS || 4
);
const TARGET_HANDLE = process.env.RECOVERY_SWEEP_HANDLE?.replace(/^@/, '');

async function main() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const humanGraceSince = new Date(
    Date.now() - HUMAN_PICKUP_GRACE_HOURS * 60 * 60 * 1000
  );

  const conversations = await prisma.conversation.findMany({
    where: {
      lastMessageAt: { gte: since },
      distressDetected: false,
      ...(TARGET_HANDLE
        ? { lead: { handle: { equals: TARGET_HANDLE, mode: 'insensitive' } } }
        : {}),
      OR: [
        {
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
        { lead: { stage: { in: ['QUALIFIED', 'CALL_PROPOSED'] } } },
        {
          messages: {
            some: {
              sender: 'AI',
              timestamp: { gte: since },
              OR: [
                {
                  content: {
                    contains: 'call with anthony',
                    mode: 'insensitive'
                  }
                },
                { content: { contains: 'quick call', mode: 'insensitive' } },
                { content: { contains: 'gameplan', mode: 'insensitive' } },
                { content: { contains: 'game plan', mode: 'insensitive' } },
                {
                  content: {
                    contains: 'would you be open',
                    mode: 'insensitive'
                  }
                }
              ]
            }
          }
        }
      ]
    },
    include: {
      lead: {
        select: {
          id: true,
          accountId: true,
          name: true,
          handle: true,
          stage: true
        }
      },
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

    let recovery:
      | Awaited<ReturnType<typeof attemptSelfRecovery>>
      | Awaited<ReturnType<typeof attemptMidConversationRequalification>>;

    if (trigger.triggered) {
      recovery = await attemptSelfRecovery({
        accountId: conversation.lead.accountId,
        conversationId: conversation.id,
        history,
        triggerReason: `sweep_${trigger.reason || 'stall_message_detected'}`,
        llmEmittedStage: lastAi?.stage ?? null,
        approvalMode: true
      });
    } else {
      const snapshot = await prepareScriptState({
        accountId: conversation.lead.accountId,
        conversationId: conversation.id,
        history
      });
      const skip = detectMidConversationStepSkip({ snapshot, history });
      const hasCapital =
        snapshot.capturedDataPoints.verifiedCapitalUsd?.confidence === 'HIGH' ||
        snapshot.capturedDataPoints.capitalThresholdMet?.value === true;
      if (
        !skip.skip &&
        (conversation.lead.stage !== 'QUALIFIED' || hasCapital)
      ) {
        skipped++;
        continue;
      }

      recovery = await attemptMidConversationRequalification({
        accountId: conversation.lead.accountId,
        conversationId: conversation.id,
        history,
        triggerReason: skip.skip
          ? 'sweep_mid_conversation_step_skip'
          : 'sweep_stage_qualified_without_capital',
        llmEmittedStage: lastAi?.stage ?? null,
        approvalMode: true
      });
    }

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
