/* eslint-disable no-console */
import prisma from '../src/lib/prisma';

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: 'daetradez2003' },
    select: { id: true, awayModeInstagram: true }
  });
  if (!account) throw new Error('account not found');

  const lead = await prisma.lead.findFirst({
    where: {
      accountId: account.id,
      handle: { equals: 'mr.cocoabutter', mode: 'insensitive' }
    },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { timestamp: 'asc' } },
          silentStopEvents: { orderBy: { detectedAt: 'desc' }, take: 5 }
        }
      }
    }
  });

  if (!lead) {
    console.log('Lead not found');
    return;
  }
  console.log(`account.awayModeInstagram=${account.awayModeInstagram}`);
  console.log(
    `Lead: ${lead.id} @${lead.handle} platformUserId=${lead.platformUserId} stage=${lead.stage}`
  );
  const c = lead.conversation;
  if (!c) {
    console.log('No conversation');
    return;
  }
  console.log(
    `Convo: ${c.id} source=${c.source} aiActive=${c.aiActive} awaitingAiResponse=${c.awaitingAiResponse} awaitingSince=${c.awaitingSince?.toISOString() ?? 'null'} lastSilentStopAt=${c.lastSilentStopAt?.toISOString() ?? 'null'} silentStopCount=${c.silentStopCount}`
  );
  console.log(`manyChatFiredAt=${c.manyChatFiredAt?.toISOString() ?? 'null'}`);
  console.log(`Messages (${c.messages.length}):`);
  for (const m of c.messages) {
    const t = m.timestamp.toISOString().slice(11, 19);
    console.log(`  [${m.sender.padEnd(8)}] ${t}  ${m.content.slice(0, 90)}`);
  }
  if (c.silentStopEvents.length) {
    console.log(`SilentStopEvents (latest ${c.silentStopEvents.length}):`);
    for (const e of c.silentStopEvents) {
      console.log(
        `  [${e.detectedAt.toISOString().slice(11, 19)}] reason=${e.detectedReason} status=${e.recoveryStatus} action=${e.recoveryAction}`
      );
    }
  } else {
    console.log('SilentStopEvents: (none)');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
