/**
 * Backfill script: resolve numeric IGSID handles on Lead records.
 *
 * Background: 56 leads were ingested with a numeric Instagram-Scoped User ID
 * (IGSID) as both `handle` and `name` — e.g. "1274526528083205" — because
 * ManyChat's {{contact.ig_username}} returned the raw IGSID during
 * subscriber-cache degradation windows (triggered by Instagram re-auth events).
 * See docs/diagnostic-numeric-ig-id-bug.md for full analysis.
 *
 * Strategy:
 *   For each broken lead, the IGSID is already stored in `platformUserId`.
 *   Call Meta's Graph API (getUserProfile) using that IGSID to get the real
 *   username and display name, then patch the lead.
 *
 * Usage:
 *   DRY_RUN=true  pnpm exec tsx scripts/backfill-numeric-handles.ts
 *   DRY_RUN=false pnpm exec tsx scripts/backfill-numeric-handles.ts
 *
 * Default is DRY_RUN=true — no DB writes until you explicitly set false.
 */

import prisma from '@/lib/prisma';
import { getUserProfile } from '@/lib/instagram';

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  console.log(`\n=== Backfill numeric IG handles (DRY_RUN=${DRY_RUN}) ===\n`);

  // 1. Find all broken leads
  const broken = await prisma.$queryRaw<
    Array<{
      id: string;
      name: string;
      handle: string;
      platformUserId: string | null;
      accountId: string;
    }>
  >`
    SELECT id, name, handle, "platformUserId", "accountId"
    FROM "Lead"
    WHERE handle ~ '^[0-9]{14,17}$'
    ORDER BY "createdAt" DESC
  `;

  console.log(`Found ${broken.length} broken records.\n`);
  if (broken.length === 0) {
    console.log('Nothing to fix.');
    return;
  }

  // 2. Group by accountId to minimise credential fetches
  const byAccount = broken.reduce<Record<string, typeof broken>>(
    (acc, lead) => {
      (acc[lead.accountId] ??= []).push(lead);
      return acc;
    },
    {}
  );

  let resolved = 0;
  let unresolvable = 0;
  let skipped = 0;

  for (const [accountId, leads] of Object.entries(byAccount)) {
    for (const lead of leads) {
      const igsid = lead.platformUserId || lead.handle;
      if (!igsid || !/^\d{12,}$/.test(igsid)) {
        console.log(
          `  SKIP ${lead.id}: no usable IGSID (platformUserId=${lead.platformUserId}, handle=${lead.handle})`
        );
        skipped++;
        continue;
      }

      try {
        // getUserProfile fetches credentials internally
        const profile = await getUserProfile(accountId, igsid);
        if (profile?.username) {
          const newHandle = profile.username.replace(/^@+/, '').trim();
          const newName = profile.name || newHandle;
          console.log(
            `  RESOLVE ${lead.id}: "${lead.handle}" → @${newHandle} (name: "${newName}")`
          );
          if (!DRY_RUN) {
            await prisma.lead.update({
              where: { id: lead.id },
              data: { handle: newHandle, name: newName }
            });
          }
          resolved++;
        } else {
          console.log(
            `  UNRESOLVABLE ${lead.id}: IGSID=${igsid} — Graph API returned no username`
          );
          unresolvable++;
        }
      } catch (err) {
        console.error(
          `  ERROR ${lead.id}: IGSID=${igsid} —`,
          (err as Error).message
        );
        unresolvable++;
      }
    }
  }

  console.log(`
=== Summary ===
  Resolved:      ${resolved}
  Unresolvable:  ${unresolvable}
  Skipped:       ${skipped}
  DRY_RUN:       ${DRY_RUN}
${DRY_RUN ? '\nRe-run with DRY_RUN=false to apply writes.' : '\nWrites applied.'}
`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
