/* eslint-disable no-console */
// Detail view: every FB HUMAN message ever, plus the conversation's
// AI side-by-side timestamps so we can see the dedup miss.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } }
  });
  if (!account) process.exit(1);

  const rows = await prisma.message.findMany({
    where: {
      sender: 'HUMAN',
      conversation: {
        lead: { accountId: account.id, platform: 'FACEBOOK' }
      }
    },
    orderBy: { timestamp: 'asc' },
    select: {
      id: true,
      timestamp: true,
      humanSource: true,
      content: true,
      platformMessageId: true,
      conversationId: true,
      conversation: {
        select: { lead: { select: { name: true } } }
      }
    }
  });

  console.log(`All FB HUMAN messages (${rows.length}):\n`);
  for (const r of rows) {
    console.log(
      `${r.timestamp.toISOString()} humanSource=${(r.humanSource ?? 'null').padEnd(10)} ` +
        `pmid=${(r.platformMessageId ?? 'null').slice(0, 30).padEnd(32)} ` +
        `${r.conversation.lead.name.slice(0, 20).padEnd(22)} ` +
        `"${r.content.slice(0, 60)}"`
    );
  }

  // Bucket by humanSource value.
  const byHumanSource = new Map<string, number>();
  for (const r of rows) {
    const k = r.humanSource ?? 'null';
    byHumanSource.set(k, (byHumanSource.get(k) ?? 0) + 1);
  }
  console.log('\nhumanSource distribution:');
  Array.from(byHumanSource.entries()).forEach(([k, v]) =>
    console.log(`  ${k.padEnd(10)} ${v}`)
  );

  // Check: post-2026-04-21 (humanSource tagging shipped) HUMAN rows
  // with humanSource=null — those are the actual bug rows.
  const cutoff = new Date('2026-04-21T00:00:00Z');
  const postTaggingNullCount = rows.filter(
    (r) => r.timestamp >= cutoff && r.humanSource === null
  ).length;
  console.log(
    `\nPost-2026-04-21 with humanSource=null: ${postTaggingNullCount}`
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
