/**
 * Inspect Meta credential records to debug the "Page <id>" display issue.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/inspect-meta-creds.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const creds = await prisma.integrationCredential.findMany({
    where: { provider: 'META' },
    select: {
      id: true,
      accountId: true,
      provider: true,
      metadata: true,
      isActive: true,
      verifiedAt: true,
      createdAt: true,
      updatedAt: true,
      account: { select: { name: true, slug: true } }
    },
    orderBy: { updatedAt: 'desc' }
  });

  console.log(`\nFound ${creds.length} META credential record(s):\n`);

  for (const c of creds) {
    console.log('─'.repeat(60));
    console.log(`Account:    ${c.account.name} (${c.account.slug})`);
    console.log(`Cred ID:    ${c.id}`);
    console.log(`Active:     ${c.isActive}`);
    console.log(`Created:    ${c.createdAt.toISOString()}`);
    console.log(`Updated:    ${c.updatedAt.toISOString()}`);
    console.log(`Verified:   ${c.verifiedAt?.toISOString() ?? 'never'}`);
    console.log(`Metadata:`);
    console.log(JSON.stringify(c.metadata, null, 2));
    console.log();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
