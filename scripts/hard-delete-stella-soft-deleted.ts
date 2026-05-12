/* eslint-disable no-console */
import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { scheduleAIReply } from '../src/lib/webhook-processor';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: { handle: { contains: 'atstella', mode: 'insensitive' } },
    include: { conversation: true }
  });
  if (!lead || !lead.conversation) {
    console.error('lead/convo not found');
    process.exit(1);
  }

  // Show soft-deleted messages first.
  const softDeleted = await prisma.message.findMany({
    where: { conversationId: lead.conversation.id, deletedAt: { not: null } },
    orderBy: { timestamp: 'asc' },
    select: {
      id: true,
      sender: true,
      content: true,
      timestamp: true,
      deletedAt: true
    }
  });
  console.log(`Soft-deleted messages on convo: ${softDeleted.length}`);
  for (const m of softDeleted) {
    console.log(
      `  ${m.id} ${m.timestamp.toISOString()} [${m.sender}] deletedAt=${m.deletedAt?.toISOString()}`
    );
    console.log(`    ${(m.content || '').slice(0, 150)}`);
  }

  if (softDeleted.length === 0) {
    console.log('Nothing to hard-delete. Re-arming + triggering anyway.');
  } else {
    const result = await prisma.message.deleteMany({
      where: {
        conversationId: lead.conversation.id,
        deletedAt: { not: null }
      }
    });
    console.log(`Hard-deleted ${result.count} soft-deleted message row(s).`);
  }

  // Re-arm.
  const lastLead = await prisma.message.findFirst({
    where: {
      conversationId: lead.conversation.id,
      sender: 'LEAD',
      deletedAt: null
    },
    orderBy: { timestamp: 'desc' },
    select: { id: true, timestamp: true, content: true }
  });
  if (!lastLead) {
    console.error('no LEAD message left');
    process.exit(1);
  }
  console.log(
    `Last LEAD: ${lastLead.timestamp.toISOString()} "${lastLead.content?.slice(0, 100)}"`
  );

  await prisma.scheduledReply.updateMany({
    where: {
      conversationId: lead.conversation.id,
      status: { in: ['PENDING', 'PROCESSING'] }
    },
    data: { status: 'CANCELLED' }
  });

  await prisma.conversation.update({
    where: { id: lead.conversation.id },
    data: {
      aiActive: true,
      awaitingAiResponse: true,
      awaitingSince: lastLead.timestamp,
      autoSendOverride: true,
      systemStage: null,
      llmEmittedStage: null,
      stageMismatchCount: 0,
      silentStopCount: 0,
      lastMessageAt: lastLead.timestamp
    }
  });

  console.log('Re-armed. Invoking scheduleAIReply...');
  await scheduleAIReply(lead.conversation.id, lead.accountId);
  console.log('Done.');
}
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
