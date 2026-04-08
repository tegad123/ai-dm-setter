/**
 * Check whether the duplicate tags showing up in the conversation header
 * are from duplicate LeadTag rows in the DB or from how the API maps them.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/check-conversation-tags.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find tegaumukoro_'s lead (the one in the screenshot)
  const lead = await prisma.lead.findFirst({
    where: { handle: 'tegaumukoro_' },
    include: {
      tags: { include: { tag: true } }
    }
  });

  if (!lead) {
    console.log('Lead not found.');
    return;
  }

  console.log(`Lead: ${lead.name} (@${lead.handle})`);
  console.log(`Total LeadTag rows: ${lead.tags.length}\n`);

  console.log('Raw LeadTag rows:');
  for (const lt of lead.tags) {
    console.log(
      `  leadTagId=${lt.id}  tagId=${lt.tag.id}  name="${lt.tag.name}"  color=${lt.tag.color}`
    );
  }

  // Count by name to see duplicates
  const counts = new Map<string, number>();
  for (const lt of lead.tags) {
    counts.set(lt.tag.name, (counts.get(lt.tag.name) || 0) + 1);
  }
  console.log('\nDuplicate tag names:');
  let hasDupes = false;
  counts.forEach((count, name) => {
    if (count > 1) {
      console.log(`  ${name}: ${count}x`);
      hasDupes = true;
    }
  });
  if (!hasDupes) {
    console.log('  (none — duplicates are from the API mapping, not the DB)');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
