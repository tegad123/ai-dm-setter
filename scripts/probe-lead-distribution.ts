/* eslint-disable no-console */
// Probes the per-stage breakdown for daetradez to confirm the new
// /api/analytics/lead-distribution data shape is sane.

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

  const grouped = await prisma.lead.groupBy({
    by: ['stage'],
    where: { accountId: account.id },
    _count: { _all: true }
  });

  const stages = grouped.map((row) => ({
    stage: row.stage,
    count: row._count._all
  }));
  const total = stages.reduce((acc, s) => acc + s.count, 0);

  console.log(`Account: ${account.name} (${account.id})`);
  console.log(`Total leads: ${total}`);
  console.log('Stages:');
  stages
    .slice()
    .sort((a, b) => b.count - a.count)
    .forEach((s) =>
      console.log(`  ${s.stage.padEnd(28)} ${s.count.toString().padStart(5)}`)
    );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
