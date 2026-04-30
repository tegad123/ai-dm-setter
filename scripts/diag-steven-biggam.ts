/* eslint-disable no-console */
// Read-only diagnostic for the Steven Biggam silent-AI bug.
// Lead replied to the capital question with "very little tbh", then sent
// two follow-ups including "about to go to sleep". The AI sent nothing.
// This script prints the conversation state so we can pick the right
// fallback shape.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
import prisma from '../src/lib/prisma';
import { parseLeadCapitalAnswer } from '../src/lib/ai-engine';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: {
      OR: [
        { name: { contains: 'Steven Biggam', mode: 'insensitive' } },
        { handle: { contains: 'biggam', mode: 'insensitive' } }
      ]
    },
    include: {
      conversation: { select: { id: true, aiActive: true, createdAt: true } }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (!lead?.conversation) {
    console.log('Steven Biggam not found.');
    await prisma.$disconnect();
    return;
  }
  console.log(
    `Lead ${lead.id} @${lead.handle} (${lead.name}) stage=${lead.stage} aiActive=${lead.conversation.aiActive}`
  );
  console.log(
    `Conv ${lead.conversation.id} created ${lead.conversation.createdAt.toISOString()}\n`
  );

  const msgs = await prisma.message.findMany({
    where: { conversationId: lead.conversation.id },
    orderBy: { timestamp: 'desc' },
    take: 12,
    select: {
      id: true,
      sender: true,
      content: true,
      timestamp: true,
      stage: true,
      platformMessageId: true
    }
  });
  console.log(`Last ${msgs.length} messages (newest first):`);
  for (const m of msgs.reverse()) {
    const txt =
      m.content.length > 110 ? m.content.slice(0, 110) + '…' : m.content;
    const platformId = m.platformMessageId
      ? ` [pmid=${m.platformMessageId.slice(-8)}]`
      : '';
    console.log(
      `  ${m.timestamp.toISOString()}  ${m.sender}${platformId}: ${txt}`
    );
  }

  // AI suggestion rows since the last lead burst
  const lastLeadMsgTime =
    msgs.find((m) => m.sender === 'LEAD')?.timestamp ?? null;
  const since = lastLeadMsgTime
    ? new Date(lastLeadMsgTime.getTime() - 30 * 60 * 1000)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const suggestions = await prisma.aISuggestion.findMany({
    where: {
      conversationId: lead.conversation.id,
      generatedAt: { gte: since }
    },
    orderBy: { generatedAt: 'asc' },
    select: {
      id: true,
      generatedAt: true,
      responseText: true,
      messageBubbles: true,
      bubbleCount: true,
      modelUsed: true,
      qualityGateAttempts: true,
      qualityGateScore: true,
      qualityGatePassedFirstAttempt: true,
      dismissed: true,
      actionedAt: true,
      wasSelected: true,
      wasRejected: true,
      finalSentText: true
    }
  });
  console.log(
    `\n${suggestions.length} AISuggestion row(s) since ${since.toISOString()}:`
  );
  for (const s of suggestions) {
    const bubbles = Array.isArray(s.messageBubbles)
      ? `${s.messageBubbles.length} bubble(s)`
      : 'null';
    const text =
      s.responseText.length > 130
        ? s.responseText.slice(0, 130) + '…'
        : s.responseText;
    console.log(
      `  ${s.generatedAt.toISOString()} model=${s.modelUsed ?? '?'} q=${s.qualityGateScore ?? '?'} attempts=${s.qualityGateAttempts ?? '?'} firstPass=${s.qualityGatePassedFirstAttempt} bubbles=${bubbles} count=${s.bubbleCount}\n    text: ${text}\n    selected=${s.wasSelected} rejected=${s.wasRejected} dismissed=${s.dismissed} sent="${s.finalSentText?.slice(0, 60) ?? ''}"`
    );
  }

  // Scheduled replies for this conversation
  const scheduled = await prisma.scheduledReply.findMany({
    where: { conversationId: lead.conversation.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      status: true,
      scheduledFor: true,
      processedAt: true,
      attempts: true,
      lastError: true,
      messageType: true,
      createdAt: true
    }
  });
  console.log(`\n${scheduled.length} ScheduledReply row(s) (newest first):`);
  for (const r of scheduled) {
    console.log(
      `  created=${r.createdAt.toISOString()} status=${r.status} type=${r.messageType ?? '-'} scheduledFor=${r.scheduledFor.toISOString()} processedAt=${r.processedAt?.toISOString() ?? '-'} attempts=${r.attempts} err=${r.lastError ? r.lastError.slice(0, 60) : '-'}`
    );
  }

  // Notifications around the silence window
  const notifications = await prisma.notification.findMany({
    where: { accountId: lead.accountId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, type: true, title: true, createdAt: true }
  });
  console.log(
    `\n${notifications.length} Notification row(s) for the account in window:`
  );
  for (const n of notifications) {
    console.log(
      `  ${n.createdAt.toISOString()} type=${n.type} title="${n.title.slice(0, 70)}"`
    );
  }

  // Re-run the parser on "very little tbh" so we have ground truth
  const parserOut = parseLeadCapitalAnswer('very little tbh');
  console.log(
    `\nparseLeadCapitalAnswer("very little tbh") → kind=${parserOut.kind} reason=${parserOut.reason ?? '-'} amount=${parserOut.amount}`
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
