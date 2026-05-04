/**
 * Manual IG Business Account ID setter — companion to
 * `backfill-ig-business-account-id.ts` for cases where the Graph API
 * `/{pageId}?fields=instagram_business_account` query returns no link
 * (e.g. when the IG account was connected via IG Login flow only, not
 * via FB Page → IG linking).
 *
 * Reads the desired value from the `entry.id` of a real Meta webhook
 * payload — operator should grab this from the `[instagram-webhook]
 * REJECTED entryId=…` log line that appeared when the bug fired.
 *
 * Usage:
 *   pnpm tsx scripts/set-ig-business-account-id.ts <accountId> <igBusinessAccountId>
 *
 * Example for the 2026-05-04 prod incident:
 *   pnpm tsx scripts/set-ig-business-account-id.ts cmnc6h63r0000l904c72g18aq 17841403104278070
 *
 * Patches BOTH the META and INSTAGRAM credentials (whichever exist)
 * for this account, adding `igBusinessAccountId` to metadata. The
 * webhook route's matching logic checks this field as one of four
 * candidate ID fields, so adding it unblocks routing immediately.
 */

import { config as loadEnv } from 'dotenv';
loadEnv();
import prisma from '../src/lib/prisma';

async function main() {
  const [, , accountId, igBusinessAccountId] = process.argv;
  if (!accountId || !igBusinessAccountId) {
    console.error(
      'Usage: pnpm tsx scripts/set-ig-business-account-id.ts <accountId> <igBusinessAccountId>'
    );
    process.exit(2);
  }
  if (!/^17841\d+$/.test(igBusinessAccountId)) {
    console.warn(
      `[warn] igBusinessAccountId="${igBusinessAccountId}" does not match the expected ` +
        `Meta-IG-Business-Account format (17841…). Continue anyway? (Ctrl-C to abort, 5s)`
    );
    await new Promise((r) => setTimeout(r, 5000));
  }

  const creds = await prisma.integrationCredential.findMany({
    where: {
      accountId,
      provider: { in: ['META', 'INSTAGRAM'] },
      isActive: true
    },
    select: { id: true, provider: true, metadata: true }
  });

  if (creds.length === 0) {
    console.error(
      `No active META/INSTAGRAM credentials for account ${accountId}.`
    );
    process.exit(1);
  }

  for (const c of creds) {
    const md = (c.metadata as Record<string, unknown>) || {};
    if (md.igBusinessAccountId === igBusinessAccountId) {
      console.log(
        `[skip] ${c.provider} ${c.id} already has igBusinessAccountId=${igBusinessAccountId}`
      );
      continue;
    }
    await prisma.integrationCredential.update({
      where: { id: c.id },
      data: { metadata: { ...md, igBusinessAccountId } }
    });
    console.log(
      `[ok] ${c.provider} ${c.id} → patched igBusinessAccountId=${igBusinessAccountId}`
    );
  }

  // Verify
  const after = await prisma.integrationCredential.findMany({
    where: {
      accountId,
      provider: { in: ['META', 'INSTAGRAM'] },
      isActive: true
    },
    select: { provider: true, metadata: true }
  });
  console.log('\nFinal metadata:');
  for (const a of after) {
    const m = a.metadata as Record<string, unknown>;
    console.log(
      `  ${a.provider}: pageId=${m.pageId ?? 'undef'}, ` +
        `igUserId=${m.igUserId ?? 'undef'}, ` +
        `igBusinessAccountId=${m.igBusinessAccountId ?? 'undef'}, ` +
        `instagramAccountId=${m.instagramAccountId ?? 'undef'}`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
