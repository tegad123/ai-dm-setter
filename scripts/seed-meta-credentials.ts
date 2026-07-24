/**
 * One-off dev seed: wires the IG/FB credentials from .env into a real
 * IntegrationCredential row for the local "shazim's Workspace" account.
 *
 * Why this exists:
 *   The webhook router (src/app/api/webhooks/instagram/route.ts) refuses
 *   to process any inbound DM whose entry.id doesn't match an existing
 *   IntegrationCredential row. With an empty table, every webhook gets
 *   rejected with "REJECTED entryId=... no IntegrationCredential matched."
 *
 *   Going through the OAuth UI flow ("Connect Instagram") would normally
 *   create these rows, but that requires ngrok + Meta App redirect-URI
 *   whitelisting. Since we already have valid tokens in .env, just write
 *   the rows directly.
 *
 * Run: bun tsx scripts/seed-meta-credentials.ts
 */

import { setCredentials } from '../src/lib/credential-store';
import prisma from '../src/lib/prisma';

const TARGET_ACCOUNT_ID = 'cmpa60h9c0000gs4l85idlaby'; // shazim's Workspace

async function main() {
  // ── Sanity checks ──────────────────────────────────────────────
  const account = await prisma.account.findUnique({
    where: { id: TARGET_ACCOUNT_ID },
    select: { id: true, name: true, slug: true }
  });

  if (!account) {
    console.error(
      `[seed] Account ${TARGET_ACCOUNT_ID} not found. Run prisma seed first.`
    );
    process.exit(1);
  }

  console.log(`[seed] target account: ${account.name} (${account.slug})`);

  // Required env vars
  const required = {
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,
    FACEBOOK_PAGE_NAME: process.env.FACEBOOK_PAGE_NAME ?? 'ScaleVault AI',
    INSTAGRAM_ACCESS_TOKEN: process.env.INSTAGRAM_ACCESS_TOKEN,
    INSTAGRAM_PAGE_ID: process.env.INSTAGRAM_PAGE_ID,
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`[seed] missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // ── 1. META credential (Facebook Page) ─────────────────────────
  await setCredentials(
    TARGET_ACCOUNT_ID,
    'META',
    {
      accessToken: required.META_ACCESS_TOKEN!
    },
    {
      pageId: required.FACEBOOK_PAGE_ID,
      pageName: required.FACEBOOK_PAGE_NAME,
      // Cross-reference IG account so the webhook router can find this
      // credential via either the FB page entry.id or the IG entry.id.
      instagramAccountId: required.INSTAGRAM_PAGE_ID,
      igBusinessAccountId: required.INSTAGRAM_PAGE_ID,
      seededFromEnv: true,
      seededAt: new Date().toISOString()
    }
  );
  console.log(
    `[seed] META credential set — pageId=${required.FACEBOOK_PAGE_ID}`
  );

  // ── 2. INSTAGRAM credential ────────────────────────────────────
  await setCredentials(
    TARGET_ACCOUNT_ID,
    'INSTAGRAM',
    {
      accessToken: required.INSTAGRAM_ACCESS_TOKEN!
    },
    {
      igUserId: required.INSTAGRAM_PAGE_ID,
      instagramAccountId: required.INSTAGRAM_PAGE_ID,
      igBusinessAccountId: required.INSTAGRAM_PAGE_ID,
      pageId: required.FACEBOOK_PAGE_ID, // for cross-matching
      seededFromEnv: true,
      seededAt: new Date().toISOString()
    }
  );
  console.log(
    `[seed] INSTAGRAM credential set — igUserId=${required.INSTAGRAM_PAGE_ID}`
  );

  // ── 3. Activate the persona (currently isActive=false) ─────────
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId: TARGET_ACCOUNT_ID }
  });
  if (persona && !persona.isActive) {
    await prisma.aIPersona.update({
      where: { id: persona.id },
      data: { isActive: true }
    });
    console.log(`[seed] activated persona ${persona.id}`);
  } else if (persona?.isActive) {
    console.log(`[seed] persona ${persona.id} already active`);
  } else {
    console.warn(
      `[seed] no AIPersona row found for account ${TARGET_ACCOUNT_ID} — AI generation will skip this tenant`
    );
  }

  // ── 4. Verify ──────────────────────────────────────────────────
  const creds = await prisma.integrationCredential.findMany({
    where: { accountId: TARGET_ACCOUNT_ID },
    select: { id: true, provider: true, isActive: true, metadata: true }
  });
  console.log(`[seed] verification — ${creds.length} credentials now exist:`);
  for (const c of creds) {
    const m = c.metadata as any;
    console.log(
      `       ${c.provider} (active=${c.isActive}) pageId=${m?.pageId} igUserId=${m?.igUserId}`
    );
  }

  await prisma.$disconnect();
  console.log('[seed] done.');
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
