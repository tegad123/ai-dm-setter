/* eslint-disable no-console */
import 'dotenv/config';
import prisma from '../src/lib/prisma';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: { handle: { contains: 'atstella', mode: 'insensitive' } },
    include: { conversation: true }
  });
  if (!lead || !lead.conversation) {
    console.error('lead or conversation not found');
    process.exit(1);
  }
  const c = await prisma.conversation.findUnique({
    where: { id: lead.conversation.id },
    select: {
      id: true,
      aiActive: true,
      awaitingAiResponse: true,
      awaitingSince: true,
      lastMessageAt: true,
      systemStage: true,
      currentScriptStep: true,
      llmEmittedStage: true,
      stageMismatchCount: true,
      silentStopCount: true,
      capturedDataPoints: true,
      personaId: true
    }
  });
  console.log(`Lead: ${lead.id} @${lead.handle} acct=${lead.accountId}`);
  console.log('CONVO:', JSON.stringify(c, null, 2));
  const msgs = await prisma.message.findMany({
    where: { conversationId: lead.conversation.id },
    orderBy: { timestamp: 'asc' },
    select: {
      sender: true,
      content: true,
      timestamp: true,
      stage: true,
      subStage: true
    }
  });
  console.log('MESSAGES:');
  for (const m of msgs) {
    console.log(
      `  ${m.timestamp.toISOString()} [${m.sender}] stage=${m.stage ?? 'null'}/${m.subStage ?? 'null'}`
    );
    console.log(`    ${(m.content || '').slice(0, 200)}`);
  }
  const sched = await prisma.scheduledReply.findMany({
    where: { conversationId: lead.conversation.id },
    orderBy: { createdAt: 'desc' },
    take: 6,
    select: {
      id: true,
      status: true,
      scheduledFor: true,
      processedAt: true,
      lastError: true
    }
  });
  console.log('SCHEDULED:');
  for (const s of sched) {
    console.log(
      `  ${s.id} ${s.status} for=${s.scheduledFor?.toISOString()} processed=${s.processedAt?.toISOString() ?? 'null'}`
    );
    if (s.lastError) console.log(`    err=${s.lastError.slice(0, 200)}`);
  }
}
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
