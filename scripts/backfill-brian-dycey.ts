/* eslint-disable no-console */
// Recover Brian Dycey's stuck conversation by:
//   1. Detecting the abandoned MessageGroup (bubbleCount=2, only 1
//      Message row exists, completedAt + failedAt both null).
//   2. Looking up the AISuggestion's messageBubbles for the missing
//      content.
//   3. Asking the operator (--apply) to ship the missing bubble +
//      schedule FOLLOW_UP_1 + close the MessageGroup. Without
//      --apply this is dry-run.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';
import { sendMessage as sendFacebookMessage } from '../src/lib/facebook';
import { sendDM as sendInstagramDM } from '../src/lib/instagram';

async function main() {
  const apply = process.argv.includes('--apply');

  const lead = await prisma.lead.findFirst({
    where: {
      OR: [
        { name: { contains: 'dycey', mode: 'insensitive' } },
        { handle: { contains: 'dycey', mode: 'insensitive' } }
      ]
    },
    include: { conversation: true }
  });
  if (!lead?.conversation) {
    console.error('No Brian Dycey lead.');
    process.exit(1);
  }

  // Find the abandoned MessageGroup (most recent open one)
  const group = await prisma.messageGroup.findFirst({
    where: {
      conversationId: lead.conversation.id,
      completedAt: null,
      failedAt: null,
      bubbleCount: { gt: 1 }
    },
    orderBy: { generatedAt: 'desc' },
    include: {
      messages: {
        orderBy: { bubbleIndex: 'asc' },
        select: { bubbleIndex: true, content: true }
      },
      aiSuggestion: { select: { id: true, messageBubbles: true } }
    }
  });

  if (!group) {
    console.log('No abandoned MessageGroup. Nothing to recover.');
    process.exit(0);
  }

  console.log(`Conversation: ${lead.conversation.id}`);
  console.log(`Lead: ${lead.name} (@${lead.handle}) ${lead.platform}`);
  console.log(
    `Abandoned group: ${group.id} bubbleCount=${group.bubbleCount} delivered=${group.messages.length} generatedAt=${group.generatedAt.toISOString()}`
  );
  const bubbles = group.aiSuggestion?.messageBubbles as
    | string[]
    | null
    | undefined;
  if (!Array.isArray(bubbles)) {
    console.error('AISuggestion.messageBubbles missing — cannot recover.');
    process.exit(1);
  }
  console.log('Original bubbles:');
  bubbles.forEach((b, i) =>
    console.log(
      `  [${i}] ${i < group.messages.length ? '(shipped)' : '(MISSING)'} "${b.slice(0, 100)}"`
    )
  );

  if (!apply) {
    console.log(
      '\nDry-run. Re-run with --apply to ship missing bubble + schedule FOLLOW_UP_1.'
    );
    await prisma.$disconnect();
    return;
  }

  // Ship missing bubbles in order
  const shipped = group.messages.length;
  for (let i = shipped; i < bubbles.length; i++) {
    const text = bubbles[i];
    let messageId: string | null = null;
    try {
      if (lead.platform === 'INSTAGRAM') {
        const r = await sendInstagramDM(
          lead.accountId,
          lead.platformUserId!,
          text
        );
        messageId = r?.messageId ?? null;
      } else if (lead.platform === 'FACEBOOK') {
        const r = await sendFacebookMessage(
          lead.accountId,
          lead.platformUserId!,
          text
        );
        messageId = typeof r === 'string' ? r : ((r as any)?.messageId ?? null);
      }
      console.log(`Shipped bubble ${i}: messageId=${messageId}`);
    } catch (err) {
      console.error(`Ship failed at bubble ${i}:`, err);
      await prisma.messageGroup.update({
        where: { id: group.id },
        data: {
          failedAt: new Date(),
          deliveryNotes: { reason: 'manual_recovery_ship_failed' }
        }
      });
      process.exit(1);
    }
    await prisma.message.create({
      data: {
        conversationId: lead.conversation.id,
        sender: 'AI',
        content: text,
        timestamp: new Date(),
        messageGroupId: group.id,
        bubbleIndex: i,
        bubbleTotalCount: group.bubbleCount,
        platformMessageId: messageId
      }
    });
  }

  // Close out the group
  await prisma.messageGroup.update({
    where: { id: group.id },
    data: {
      completedAt: new Date(),
      deliveryNotes: { recovered: true, mode: 'manual_backfill' }
    }
  });

  // Schedule FOLLOW_UP_1
  const { scheduleFollowUp1AfterAiMessage } = await import(
    '../src/lib/follow-up-sequence'
  );
  await scheduleFollowUp1AfterAiMessage(lead.conversation.id, lead.accountId, {
    leadStage: lead.stage,
    softExit: false,
    conversationOutcome: lead.conversation.outcome,
    replyText: bubbles.join(' ')
  });
  console.log('FOLLOW_UP_1 scheduled.');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
