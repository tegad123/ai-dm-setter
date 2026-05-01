/* eslint-disable no-console */
// Read-only diag for the Wout Lngrs P0 (2026-05-01).
// Lead had $5,000 capital + a confirmed Sunday call, but at 5:08 AM
// the AI shipped "gotchu bro, with $12 i wouldn't force the main
// call yet... build closer to $2,000". This script prints the state
// so we can confirm:
//   1. Whether $12 actually appears anywhere in the message history
//   2. Whether the message that fired was a scheduled FOLLOW_UP_*
//      cascade (canned) or a fresh AI generation
//   3. The conversation.scheduledCallAt + lead.stage at the time
//   4. The exact AISuggestion row that produced the disqualification
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
import prisma from '../src/lib/prisma';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: {
      OR: [
        { name: { contains: 'Wout Lngrs', mode: 'insensitive' } },
        { name: { contains: 'wout', mode: 'insensitive' } },
        { handle: { contains: 'lngrs', mode: 'insensitive' } }
      ]
    },
    include: {
      conversation: {
        select: {
          id: true,
          scheduledCallAt: true,
          callConfirmed: true,
          callConfirmedAt: true,
          aiActive: true,
          createdAt: true,
          source: true
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (!lead?.conversation) {
    console.log('Wout Lngrs not found.');
    await prisma.$disconnect();
    return;
  }
  console.log(
    `Lead ${lead.id} @${lead.handle} (${lead.name}) stage=${lead.stage} aiActive=${lead.conversation.aiActive}`
  );
  console.log(
    `Conv ${lead.conversation.id} scheduledCallAt=${lead.conversation.scheduledCallAt?.toISOString() ?? 'null'} callConfirmed=${lead.conversation.callConfirmed}`
  );

  const msgs = await prisma.message.findMany({
    where: { conversationId: lead.conversation.id },
    orderBy: { timestamp: 'asc' },
    select: { sender: true, content: true, timestamp: true }
  });
  const hasTwelve = msgs.some(
    (m) => /\b\$?\s?12\b/.test(m.content) && !/\b12pm\b/i.test(m.content)
  );
  const hasTwelveAnywhere = msgs.some((m) => /12/.test(m.content));
  console.log(
    `\n${msgs.length} total messages. "$12" anywhere: ${hasTwelve}. Any "12" substring: ${hasTwelveAnywhere}.`
  );
  // Find which prior message contained "12" (if any)
  for (const m of msgs) {
    if (/12/.test(m.content)) {
      console.log(
        `  ${m.timestamp.toISOString()} ${m.sender}: ${m.content.slice(0, 120)}`
      );
    }
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const suggestions = await prisma.aISuggestion.findMany({
    where: {
      conversationId: lead.conversation.id,
      generatedAt: { gte: since }
    },
    orderBy: { generatedAt: 'desc' },
    take: 10,
    select: {
      generatedAt: true,
      responseText: true,
      qualityGateAttempts: true,
      qualityGateScore: true,
      modelUsed: true,
      wasSelected: true,
      wasRejected: true,
      finalSentText: true
    }
  });
  console.log(
    `\n${suggestions.length} AISuggestion(s) in last 24h (newest first):`
  );
  for (const s of suggestions) {
    const txt =
      s.responseText.length > 160
        ? s.responseText.slice(0, 160) + '…'
        : s.responseText;
    console.log(
      `  ${s.generatedAt.toISOString()} q=${s.qualityGateScore ?? '?'} attempts=${s.qualityGateAttempts ?? '?'} sent="${(s.finalSentText ?? '').slice(0, 60)}"\n    text: ${txt}`
    );
  }

  const scheduled = await prisma.scheduledMessage.findMany({
    where: {
      conversationId: lead.conversation.id,
      createdAt: { gte: since }
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      messageType: true,
      status: true,
      scheduledFor: true,
      firedAt: true,
      messageBody: true
    }
  });
  console.log(`\n${scheduled.length} scheduled message(s) in last 24h:`);
  for (const s of scheduled) {
    const body = (s.messageBody ?? '').slice(0, 80);
    console.log(
      `  ${s.scheduledFor.toISOString()} ${s.messageType} status=${s.status} firedAt=${s.firedAt?.toISOString() ?? '-'} body="${body}"`
    );
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
