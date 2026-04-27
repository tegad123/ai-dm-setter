/* eslint-disable no-console */
// Why did the AI stop after "gotchu bro, and that makes sense"?
// Pull Brian Dycey's full state — messages, AISuggestions, voice gate
// scores, retry attempts, ScheduledReply rows.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: {
      OR: [
        { name: { contains: 'dycey', mode: 'insensitive' } },
        { handle: { contains: 'dycey', mode: 'insensitive' } }
      ]
    },
    include: {
      conversation: {
        include: { messages: { orderBy: { timestamp: 'asc' } } }
      },
      tags: { include: { tag: true } }
    }
  });
  if (!lead?.conversation) {
    console.error('No Brian Dycey lead.');
    process.exit(1);
  }

  console.log(`Lead: ${lead.name} (@${lead.handle}) ${lead.platform}`);
  console.log(
    `Stage: ${lead.stage} | qualityScore: ${lead.qualityScore} | tags: [${lead.tags.map((t) => t.tag.name).join(', ')}]`
  );
  console.log(
    `Conversation: ${lead.conversation.id} | aiActive=${lead.conversation.aiActive} | outcome=${lead.conversation.outcome} | unread=${lead.conversation.unreadCount}`
  );

  console.log(`\n── Full message log ──`);
  for (const m of lead.conversation.messages) {
    console.log(
      `${m.timestamp.toISOString()} ${m.sender.padEnd(6)} ` +
        `humanSrc=${(m.humanSource ?? '—').padEnd(10)} ` +
        `pmid=${(m.platformMessageId ?? '—').slice(0, 14).padEnd(15)} ` +
        `groupId=${(m.messageGroupId ?? '—').slice(0, 6).padEnd(7)} ` +
        `bubble=${m.bubbleIndex ?? '—'}/${m.bubbleTotalCount ?? '—'} ` +
        `"${m.content.slice(0, 110).replace(/\n/g, ' ')}"`
    );
  }

  // AISuggestions for this convo
  const sugs = await prisma.aISuggestion.findMany({
    where: { conversationId: lead.conversation.id },
    orderBy: { generatedAt: 'asc' },
    select: {
      id: true,
      generatedAt: true,
      responseText: true,
      messageBubbles: true,
      bubbleCount: true,
      qualityGateScore: true,
      qualityGateAttempts: true,
      qualityGatePassedFirstAttempt: true,
      modelUsed: true,
      wasSelected: true,
      wasRejected: true,
      wasEdited: true,
      humanEditedContent: true,
      manuallyApproved: true,
      dismissed: true,
      leadStageSnapshot: true,
      intentClassification: true
    }
  });
  console.log(`\n── ${sugs.length} AISuggestion rows ──`);
  for (const s of sugs) {
    console.log(
      `${s.generatedAt.toISOString()} q=${(s.qualityGateScore ?? 0).toFixed(2)} ` +
        `attempts=${s.qualityGateAttempts ?? '—'} passed1st=${s.qualityGatePassedFirstAttempt} ` +
        `bubbles=${s.bubbleCount ?? '—'} model=${(s.modelUsed ?? '—').slice(0, 18).padEnd(20)} ` +
        `selected=${s.wasSelected} rejected=${s.wasRejected} edited=${s.wasEdited}`
    );
    console.log(
      `  responseText: "${(s.responseText ?? '').slice(0, 200).replace(/\n/g, ' ')}"`
    );
    if (Array.isArray(s.messageBubbles)) {
      const bubbles = s.messageBubbles as string[];
      console.log(`  messageBubbles (${bubbles.length}):`);
      bubbles.forEach((b, i) =>
        console.log(`    [${i}] "${b.slice(0, 150).replace(/\n/g, ' ')}"`)
      );
    }
    if (s.humanEditedContent) {
      console.log(
        `  humanEdit: "${s.humanEditedContent.slice(0, 200).replace(/\n/g, ' ')}"`
      );
    }
  }

  // Pending ScheduledReply rows + recent failures
  const sched = await prisma.scheduledReply.findMany({
    where: { conversationId: lead.conversation.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      status: true,
      scheduledFor: true,
      createdAt: true
    }
  });
  console.log(`\n── ${sched.length} ScheduledReply rows ──`);
  for (const s of sched) {
    console.log(
      `${s.createdAt.toISOString()} status=${s.status} scheduledFor=${s.scheduledFor.toISOString()}`
    );
  }

  // Pending ScheduledMessage cascade rows
  const cascade = await prisma.scheduledMessage.findMany({
    where: { conversationId: lead.conversation.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      messageType: true,
      status: true,
      scheduledFor: true,
      messageBody: true
    }
  });
  console.log(`\n── ${cascade.length} ScheduledMessage rows ──`);
  for (const r of cascade) {
    console.log(
      `${r.scheduledFor.toISOString()} ${r.messageType.padEnd(22)} status=${r.status.padEnd(10)} body="${(r.messageBody ?? '').slice(0, 60)}"`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
