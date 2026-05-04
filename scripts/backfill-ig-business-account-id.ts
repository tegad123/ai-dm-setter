/**
 * P0 hotfix: backfill `igBusinessAccountId` on every active INSTAGRAM /
 * META IntegrationCredential.
 *
 * Why this exists: Meta delivers IG webhooks with `entry.id` = the
 * Instagram BUSINESS Account ID (`17841...` format), but the IG Login
 * API (`graph.instagram.com/oauth/access_token`) returns `user_id` in a
 * different App-Scoped format (`26121...`). The two IDs identify the
 * SAME account but are not interchangeable. PR #9 removed the
 * "single-account fallback" that masked this mismatch — now every
 * webhook for accounts connected via IG Login is rejected.
 *
 * For each account that has BOTH a META credential (with pageId +
 * access_token) AND an INSTAGRAM credential, we call:
 *   GET /v21.0/{pageId}?fields=instagram_business_account
 * That returns `instagram_business_account.id` — the 17841 ID Meta
 * sends in webhooks. We persist it back to BOTH credentials so the
 * route.ts matching logic finds it.
 *
 * Idempotent: every credential is checked, only updated if missing.
 *
 * Run: pnpm tsx scripts/backfill-ig-business-account-id.ts
 */

import { config as loadEnv } from 'dotenv';
loadEnv();
import prisma from '../src/lib/prisma';
import { getCredentials } from '../src/lib/credential-store';

const FB_GRAPH_API = 'https://graph.facebook.com/v21.0';

interface PageWithIg {
  id: string;
  instagram_business_account?: { id: string };
}

async function discoverIgBusinessAccountId(
  pageId: string,
  pageAccessToken: string
): Promise<string | null> {
  const url = `${FB_GRAPH_API}/${pageId}?fields=instagram_business_account&access_token=${pageAccessToken}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      console.warn(
        `  ↳ Graph API returned ${res.status}: ${err.slice(0, 200)}`
      );
      return null;
    }
    const data = (await res.json()) as PageWithIg;
    return data.instagram_business_account?.id ?? null;
  } catch (err) {
    console.warn(`  ↳ fetch error: ${(err as Error).message}`);
    return null;
  }
}

async function main() {
  console.log('Fetching META + INSTAGRAM credentials...\n');

  const allCreds = await prisma.integrationCredential.findMany({
    where: { provider: { in: ['META', 'INSTAGRAM'] }, isActive: true },
    select: {
      id: true,
      accountId: true,
      provider: true,
      metadata: true
    }
  });

  // Group by account
  type CredRow = (typeof allCreds)[number];
  const byAccount: Record<string, CredRow[]> = {};
  for (const c of allCreds) {
    if (!byAccount[c.accountId]) byAccount[c.accountId] = [];
    byAccount[c.accountId].push(c);
  }

  let totalDiscovered = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const [accountId, creds] of Object.entries(byAccount)) {
    console.log(`\n=== Account ${accountId} (${creds.length} credentials) ===`);

    const meta = creds.find((c: CredRow) => c.provider === 'META');
    const instagram = creds.find((c: CredRow) => c.provider === 'INSTAGRAM');

    const metaMd = (meta?.metadata as Record<string, unknown>) || {};
    const igMd = (instagram?.metadata as Record<string, unknown>) || {};

    // If either credential already has igBusinessAccountId, propagate to both.
    let igBusinessAccountId: string | null =
      (metaMd.igBusinessAccountId as string | undefined) ??
      (igMd.igBusinessAccountId as string | undefined) ??
      // META callback writes the IG biz id under instagramAccountId — that
      // IS the 17841 format when it came from /me/accounts
      (metaMd.instagramAccountId as string | undefined) ??
      null;

    // Heuristic: if instagramAccountId starts with "17841" it's already correct
    if (igBusinessAccountId && /^17841\d+$/.test(igBusinessAccountId)) {
      console.log(
        `  ✓ Already have IG Business Account ID: ${igBusinessAccountId}`
      );
    } else {
      // Need to discover via Graph API. Requires META credential with pageId.
      igBusinessAccountId = null;
      const pageId = metaMd.pageId as string | undefined;
      let pageToken: string | undefined;
      if (meta) {
        const decrypted = await getCredentials(meta.accountId, 'META');
        pageToken = decrypted?.accessToken;
      }
      if (!meta || !pageId || !pageToken) {
        console.log(
          `  ⚠ No META credential with pageId+token — cannot discover IG Business Account ID for this account.`
        );
        totalSkipped++;
        continue;
      }
      console.log(`  → discovering via Graph API (pageId=${pageId})...`);
      igBusinessAccountId = await discoverIgBusinessAccountId(
        pageId,
        pageToken
      );
      if (!igBusinessAccountId) {
        console.log(
          `  ✗ No instagram_business_account linked to page ${pageId}`
        );
        totalFailed++;
        continue;
      }
      console.log(
        `  ✓ Discovered IG Business Account ID: ${igBusinessAccountId}`
      );
      totalDiscovered++;
    }

    // Patch META credential — add igBusinessAccountId if missing
    if (meta && metaMd.igBusinessAccountId !== igBusinessAccountId) {
      await prisma.integrationCredential.update({
        where: { id: meta.id },
        data: {
          metadata: { ...metaMd, igBusinessAccountId }
        }
      });
      console.log(`  ✓ Patched META credential ${meta.id}`);
      totalUpdated++;
    }

    // Patch INSTAGRAM credential — add igBusinessAccountId if missing
    if (instagram && igMd.igBusinessAccountId !== igBusinessAccountId) {
      await prisma.integrationCredential.update({
        where: { id: instagram.id },
        data: {
          metadata: { ...igMd, igBusinessAccountId }
        }
      });
      console.log(`  ✓ Patched INSTAGRAM credential ${instagram.id}`);
      totalUpdated++;
    }
  }

  console.log(
    `\n=== SUMMARY ===\n` +
      `Accounts processed:      ${Object.keys(byAccount).length}\n` +
      `IDs discovered via API:  ${totalDiscovered}\n` +
      `Credential rows updated: ${totalUpdated}\n` +
      `Skipped (no META+pageId): ${totalSkipped}\n` +
      `Failed (no IG link):     ${totalFailed}`
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
