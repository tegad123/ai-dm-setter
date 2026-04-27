/* eslint-disable no-console */
// Reports recent HUMAN/PHONE messages on daetradez. Settles the question
// of whether echoes are reaching the DB at all.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } }
  });
  if (!account) {
    console.error('No daetradez account found.');
    process.exit(1);
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const phoneMsgs = await prisma.message.findMany({
    where: {
      sender: 'HUMAN',
      humanSource: 'PHONE',
      timestamp: { gte: since },
      conversation: { lead: { accountId: account.id } }
    },
    orderBy: { timestamp: 'desc' },
    take: 25,
    include: {
      conversation: {
        select: {
          id: true,
          aiActive: true,
          lead: { select: { name: true, handle: true } }
        }
      }
    }
  });

  console.log(
    `Last 7 days — HUMAN/PHONE messages on daetradez: ${phoneMsgs.length}\n`
  );

  for (const m of phoneMsgs) {
    const lead = m.conversation.lead;
    console.log(
      `  ${m.timestamp.toISOString()} ` +
        `${lead.name} (@${lead.handle}) ` +
        `aiActive=${m.conversation.aiActive} ` +
        `→ "${m.content.slice(0, 80)}"`
    );
  }

  // Also show count vs. dashboard sends so we can verify both paths are firing.
  const dashboardMsgs = await prisma.message.count({
    where: {
      sender: 'HUMAN',
      humanSource: 'DASHBOARD',
      timestamp: { gte: since },
      conversation: { lead: { accountId: account.id } }
    }
  });
  console.log(
    `\nLast 7 days — HUMAN/DASHBOARD messages on daetradez: ${dashboardMsgs}`
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
