// One-off: manually fire scheduleAIReply for @shepherdgushe.zw after
// the silent-stop "yo bro you still around?" was unsent. The lead's
// last message ("I need to make some money for school fees and help
// my parents") needs a real AI response — Goal/Why disclosure that
// the AI should acknowledge empathetically and advance.
import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { scheduleAIReply } from '../src/lib/webhook-processor';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: { handle: 'shepherdgushe.zw' },
    include: { conversation: true }
  });
  if (!lead?.conversation) {
    console.error('Lead or conversation not found for shepherdgushe.zw');
    process.exit(1);
  }
  console.log(
    `Found conversation ${lead.conversation.id} for lead ${lead.handle} (account=${lead.accountId})`
  );

  // Make sure the conversation is in a state scheduleAIReply expects:
  // aiActive=true, awaitingAiResponse=true, awaitingSince anchored to
  // the lead's actual last message so the gen has a clean baseline.
  const lastLead = await prisma.message.findFirst({
    where: { conversationId: lead.conversation.id, sender: 'LEAD' },
    orderBy: { timestamp: 'desc' },
    select: { id: true, timestamp: true, content: true }
  });
  if (!lastLead) {
    console.error('No LEAD message found on this conversation — bailing');
    process.exit(1);
  }
  console.log(
    `Last lead message at ${lastLead.timestamp.toISOString()}: "${lastLead.content.slice(0, 80)}"`
  );

  await prisma.conversation.update({
    where: { id: lead.conversation.id },
    data: {
      aiActive: true,
      awaitingAiResponse: true,
      awaitingSince: lastLead.timestamp
    }
  });
  console.log(
    'Conversation re-armed (aiActive=true, awaitingAiResponse=true, awaitingSince=last lead message)'
  );

  console.log('Invoking scheduleAIReply...');
  await scheduleAIReply(lead.conversation.id, lead.accountId);
  console.log('scheduleAIReply returned.');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
