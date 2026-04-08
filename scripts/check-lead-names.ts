/**
 * Inspect lead name resolution state.
 *
 * Lists the most recent leads and counts how many have unresolved
 * (numeric / placeholder) names so we can tell whether the username
 * fetch path is broken.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/check-lead-names.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const total = await prisma.lead.count();

  // Sample 25 most recent leads
  const recent = await prisma.lead.findMany({
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: {
      id: true,
      name: true,
      handle: true,
      platform: true,
      platformUserId: true,
      createdAt: true
    }
  });

  console.log(`Total leads: ${total}`);
  console.log(`\nMost recent 25 leads:`);
  console.log(
    '  status     | platform  | name                       | handle                     | platformUserId      | created'
  );
  console.log('  ' + '-'.repeat(140));
  for (const l of recent) {
    const isNumeric = /^\d+$/.test(l.name || '');
    const isUnresolved = l.name === l.platformUserId;
    const status = isNumeric || isUnresolved ? '⚠ NUMERIC' : '✓ OK     ';
    console.log(
      `  ${status} | ${l.platform.padEnd(9)} | ${(l.name || '').slice(0, 26).padEnd(26)} | ${(l.handle || '').slice(0, 26).padEnd(26)} | ${(l.platformUserId || '').padEnd(20)} | ${l.createdAt.toISOString().slice(0, 19)}`
    );
  }

  // Aggregate
  const allLeads = await prisma.lead.findMany({
    select: { name: true, platformUserId: true, platform: true }
  });
  const unresolved = allLeads.filter(
    (l) => l.name === l.platformUserId || /^\d+$/.test(l.name || '')
  );
  console.log(
    `\nUnresolved leads (name == ID or numeric): ${unresolved.length}/${allLeads.length}`
  );
  const byPlatform = unresolved.reduce((acc: Record<string, number>, l) => {
    acc[l.platform] = (acc[l.platform] || 0) + 1;
    return acc;
  }, {});
  console.log(`  By platform:`, byPlatform);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
