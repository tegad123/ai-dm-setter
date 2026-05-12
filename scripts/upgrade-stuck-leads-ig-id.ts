/* eslint-disable no-console */
// Bulk upgrade Lead.platformUserId from handle → IG numeric user ID for
// every daetradez lead currently stored with a non-numeric
// platformUserId. Resolves via ManyChat's `findByInstagramUsername`
// API so we don't need to know each lead's ManyChat subscriber ID.

import prisma from '../src/lib/prisma';
import { getCredentials } from '../src/lib/credential-store';
import {
  extractInstagramNumericId,
  findSubscriberByInstagramUsername
} from '../src/lib/manychat';

const ACCOUNT_SLUG = 'daetradez2003';
const NUMERIC_IG_ID = /^\d{12,}$/;
// Backfill needs a wide window since some stuck leads may have been
// silent for weeks. The runtime path uses the default 7-day window.
const WINDOW_DAYS = 365;

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: ACCOUNT_SLUG },
    select: { id: true }
  });
  if (!account) throw new Error(`account ${ACCOUNT_SLUG} not found`);

  const creds = await getCredentials(account.id, 'MANYCHAT');
  if (!creds?.apiKey || typeof creds.apiKey !== 'string') {
    throw new Error('no ManyChat API key for account');
  }

  // Pull every IG lead on this account whose platformUserId isn't a
  // usable IG numeric ID. Filter in JS — Prisma doesn't have a regex
  // operator we can lean on portably here.
  const allIgLeads = await prisma.lead.findMany({
    where: { accountId: account.id, platform: 'INSTAGRAM' },
    select: { id: true, handle: true, platformUserId: true }
  });
  const candidates = allIgLeads.filter(
    (l) => !NUMERIC_IG_ID.test((l.platformUserId || '').trim())
  );
  console.log(
    `[upgrade] scanned ${allIgLeads.length} IG leads on ${ACCOUNT_SLUG}; ${candidates.length} have non-numeric platformUserId`
  );

  let upgraded = 0;
  let skippedNoHandle = 0;
  let skippedNoSubscriber = 0;
  let skippedNoIgId = 0;
  let skippedFailed = 0;

  for (const lead of candidates) {
    const handle = (lead.handle || '').trim();
    if (!handle) {
      skippedNoHandle += 1;
      console.log(`  skip ${lead.id}: no handle`);
      continue;
    }
    let sub;
    try {
      sub = await findSubscriberByInstagramUsername(creds.apiKey, handle, {
        windowDays: WINDOW_DAYS
      });
    } catch (err) {
      skippedFailed += 1;
      console.log(`  skip @${handle}: API threw (${(err as Error).message})`);
      continue;
    }
    if (!sub) {
      skippedNoSubscriber += 1;
      console.log(`  skip @${handle}: no subscriber found in ManyChat`);
      continue;
    }
    const igNumeric = extractInstagramNumericId(sub);
    if (!igNumeric) {
      skippedNoIgId += 1;
      console.log(
        `  skip @${handle}: subscriber found (id=${sub.id}) but ig_id missing/invalid`
      );
      continue;
    }
    await prisma.lead.update({
      where: { id: lead.id },
      data: { platformUserId: igNumeric }
    });
    upgraded += 1;
    console.log(
      `  ✓ @${handle} ${lead.platformUserId} → ${igNumeric} (lead ${lead.id})`
    );
  }

  console.log('[upgrade] ─────────────────────────────────────────────');
  console.log(`[upgrade] candidates:                 ${candidates.length}`);
  console.log(`[upgrade] upgraded to numeric ig_id:  ${upgraded}`);
  console.log(`[upgrade] skipped (no handle):        ${skippedNoHandle}`);
  console.log(
    `[upgrade] skipped (subscriber not in MC): ${skippedNoSubscriber}`
  );
  console.log(`[upgrade] skipped (no ig_id field):   ${skippedNoIgId}`);
  console.log(`[upgrade] skipped (API error):        ${skippedFailed}`);
  console.log('[upgrade] ─────────────────────────────────────────────');
  console.log(
    `[upgrade] done. The next heartbeat tick will be able to deliver AI replies to the ${upgraded} upgraded lead(s).`
  );
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
