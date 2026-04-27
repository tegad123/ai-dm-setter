/* eslint-disable no-console */
// Broader FB activity probe — distinguishes "page is just quiet" from
// "echoes are blocked downstream of the subscription". Reports counts
// per sender for FB messages in the last 24h.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const fbBySender = await prisma.message.groupBy({
    by: ['sender', 'humanSource'],
    where: {
      timestamp: { gte: since24h },
      conversation: { lead: { platform: 'FACEBOOK' } }
    },
    _count: { _all: true }
  });

  console.log(`FACEBOOK message activity, last 24h:`);
  if (fbBySender.length === 0) {
    console.log('  (no FB messages of any kind in the window)');
  } else {
    for (const row of fbBySender) {
      console.log(
        `  ${row.sender.padEnd(6)} humanSource=${(row.humanSource ?? '—').padEnd(10)} count=${row._count._all}`
      );
    }
  }

  // INSTAGRAM control sample so we can see whether the platform handler
  // is healthy in general.
  const igBySender = await prisma.message.groupBy({
    by: ['sender', 'humanSource'],
    where: {
      timestamp: { gte: since24h },
      conversation: { lead: { platform: 'INSTAGRAM' } }
    },
    _count: { _all: true }
  });
  console.log(`\nINSTAGRAM message activity, last 24h (control):`);
  for (const row of igBySender) {
    console.log(
      `  ${row.sender.padEnd(6)} humanSource=${(row.humanSource ?? '—').padEnd(10)} count=${row._count._all}`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
