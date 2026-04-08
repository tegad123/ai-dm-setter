/**
 * Smoke-test the fixed getUserProfile() against the most recent
 * unresolved Instagram lead. Logs each strategy attempt so we can see
 * exactly which path Meta is letting through.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/test-getUserProfile.ts
 */
import { PrismaClient } from '@prisma/client';
import { getUserProfile } from '../src/lib/instagram';

const prisma = new PrismaClient();

async function main() {
  // Pick the most recent Instagram lead with an unresolved name
  const lead = await prisma.lead.findFirst({
    where: { platform: 'INSTAGRAM' as any },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      accountId: true,
      name: true,
      handle: true,
      platformUserId: true,
      createdAt: true
    }
  });

  if (!lead || !lead.platformUserId) {
    console.log('No Instagram leads found.');
    return;
  }

  console.log(`Testing on most recent IG lead:`);
  console.log(`  ID:              ${lead.id}`);
  console.log(`  Stored name:     ${lead.name}`);
  console.log(`  Stored handle:   ${lead.handle}`);
  console.log(`  platformUserId:  ${lead.platformUserId}`);
  console.log(`  Created:         ${lead.createdAt.toISOString()}`);
  console.log('');

  try {
    const profile = await getUserProfile(lead.accountId, lead.platformUserId);
    console.log('\n✓ getUserProfile returned:');
    console.log(JSON.stringify(profile, null, 2));
  } catch (err: any) {
    console.error('\n✗ getUserProfile threw:', err?.message || err);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
