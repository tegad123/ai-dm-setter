/**
 * Sanity-check selectDisplayTags against the real tegaumukoro_ tag set
 * (25 tags) so we can see exactly what the conversation header will show
 * before deploying.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/test-select-display-tags.ts
 */
import { PrismaClient } from '@prisma/client';
import { selectDisplayTags } from '../src/features/conversations/lib/select-display-tags';

const prisma = new PrismaClient();

async function main() {
  const lead = await prisma.lead.findFirst({
    where: { handle: 'tegaumukoro_' },
    include: { tags: { include: { tag: true } } }
  });
  if (!lead) {
    console.log('Lead not found.');
    return;
  }

  const allTags = lead.tags.map((lt) => ({
    id: lt.tag.id,
    name: lt.tag.name,
    color: lt.tag.color
  }));

  console.log(`Raw tags: ${allTags.length}`);
  for (const t of allTags) {
    console.log(`  ${t.color}  ${t.name}`);
  }

  const headerTags = selectDisplayTags(allTags, 4);
  console.log(`\nHeader (max 4): ${headerTags.length}`);
  for (const t of headerTags) {
    console.log(`  ${t.color}  ${t.name}`);
  }

  const summaryTags = selectDisplayTags(allTags, 8);
  console.log(`\nSummary (max 8): ${summaryTags.length}`);
  for (const t of summaryTags) {
    console.log(`  ${t.color}  ${t.name}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
