/* eslint-disable no-console */
import prisma from '../src/lib/prisma';

const HANDLES = ['philip.pkfr', 'av11a_', 'amanue_l756'];

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: 'daetradez2003' },
    select: { id: true, awayModeInstagram: true }
  });
  if (!account) throw new Error('account not found');
  console.log(`account.awayModeInstagram=${account.awayModeInstagram}`);

  for (const handle of HANDLES) {
    console.log('');
    console.log('==================================================');
    console.log(`@${handle}`);
    console.log('==================================================');
    const lead = await prisma.lead.findFirst({
      where: {
        accountId: account.id,
        handle: { equals: handle, mode: 'insensitive' }
      },
      include: {
        conversation: {
          include: {
            messages: { orderBy: { timestamp: 'asc' } },
            silentStopEvents: {
              orderBy: { detectedAt: 'desc' },
              take: 10
            }
          }
        }
      }
    });
    if (!lead) {
      console.log('  NO LEAD');
      continue;
    }
    console.log(
      `Lead ${lead.id} stage=${lead.stage} platformUserId=${lead.platformUserId}`
    );
    const c = lead.conversation;
    if (!c) {
      console.log('  NO CONVERSATION');
      continue;
    }
    console.log(
      `Convo ${c.id} source=${c.source} aiActive=${c.aiActive} awaitingAiResponse=${c.awaitingAiResponse} awaitingSince=${c.awaitingSince?.toISOString() ?? 'null'} lastSilentStopAt=${c.lastSilentStopAt?.toISOString() ?? 'null'} silentStopCount=${c.silentStopCount}`
    );
    console.log(
      `manyChatFiredAt=${c.manyChatFiredAt?.toISOString() ?? 'null'}`
    );
    console.log(`Messages (${c.messages.length}):`);
    for (const m of c.messages) {
      console.log(
        `  [${m.sender.padEnd(8)}] ${m.timestamp.toISOString().slice(0, 19)}  ${m.content.slice(0, 80)}`
      );
    }
    if (c.silentStopEvents.length) {
      console.log(`SilentStopEvents (latest ${c.silentStopEvents.length}):`);
      for (const e of c.silentStopEvents) {
        console.log(
          `  [${e.detectedAt.toISOString().slice(0, 19)}] reason=${e.detectedReason} status=${e.recoveryStatus} action=${e.recoveryAction ?? 'null'} gateViolation=${e.lastGateViolation ?? 'null'}`
        );
      }
    } else {
      console.log('SilentStopEvents: (none)');
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
