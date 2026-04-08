/**
 * Backfill Instagram lead names that were stored as raw IDs because
 * getUserProfile() was hitting the wrong host with an IGAA token.
 *
 * Walks every Instagram lead whose name == platformUserId, calls the
 * fixed getUserProfile, and updates the row when a real name comes back.
 *
 * Notes:
 *   - Meta only exposes profile data inside the 24-hour messaging window.
 *     Older leads will fail and stay as numeric IDs (the next inbound DM
 *     from them will fix the row automatically via processIncomingMessage).
 *   - Throttled at ~3 lookups/sec to stay clear of Instagram rate limits.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/backfill-instagram-names.ts
 */
import { PrismaClient } from '@prisma/client';
import { getUserProfile } from '../src/lib/instagram';

const prisma = new PrismaClient();

const SLEEP_MS = 350; // ~3 req/sec

async function main() {
  const leads = await prisma.lead.findMany({
    where: {
      platform: 'INSTAGRAM' as any
    },
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

  // Filter to numeric / unresolved
  const targets = leads.filter(
    (l) => l.name === l.platformUserId || /^\d+$/.test(l.name || '')
  );

  console.log(
    `Found ${targets.length} Instagram leads with unresolved names (out of ${leads.length} total).`
  );
  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  let resolved = 0;
  let failed = 0;
  let i = 0;

  for (const lead of targets) {
    i++;
    if (!lead.platformUserId) {
      failed++;
      continue;
    }
    process.stdout.write(
      `[${i}/${targets.length}] ${lead.platformUserId.padEnd(20)} … `
    );
    try {
      const profile = await getUserProfile(lead.accountId, lead.platformUserId);
      const isStillNumeric =
        profile.name === lead.platformUserId &&
        profile.username === lead.platformUserId;
      if (isStillNumeric) {
        process.stdout.write('still numeric (skipped)\n');
        failed++;
      } else {
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            name: profile.name,
            handle: profile.username
          }
        });
        process.stdout.write(`✓ ${profile.name} (@${profile.username})\n`);
        resolved++;
      }
    } catch (err: any) {
      process.stdout.write(
        `✗ ${err?.message?.slice(0, 80) || 'unknown error'}\n`
      );
      failed++;
    }
    await new Promise((r) => setTimeout(r, SLEEP_MS));
  }

  console.log(
    `\nDone. Resolved: ${resolved}, Failed (likely outside 24h window): ${failed}`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
