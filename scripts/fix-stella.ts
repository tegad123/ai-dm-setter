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
    console.error('no lead message');
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
      silentStopCount: 0
    }
  });
  console.log('Re-armed. Invoking scheduleAIReply...');
  await scheduleAIReply(lead.conversation.id, lead.accountId);
  console.log('Done. Reply scheduled via cron pipeline.');
}
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
