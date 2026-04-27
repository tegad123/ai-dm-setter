/* eslint-disable no-console */
// Probes daetradez's META credential and reports which webhook fields
// are subscribed for the connected Page. If `message_echoes` is missing,
// re-subscribes the page to the full required field set so Daniel's
// phone-sent messages start hitting our webhook.
//
// Usage:
//   pnpm tsx scripts/probe-and-fix-message-echoes.ts            # report only
//   pnpm tsx scripts/probe-and-fix-message-echoes.ts --apply    # subscribe if missing

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';
import { getMetaAccessToken } from '../src/lib/credential-store';

const GRAPH_API = 'https://graph.facebook.com/v22.0';
const REQUIRED = ['messages', 'message_echoes', 'messaging_postbacks'];

async function main() {
  const apply = process.argv.includes('--apply');

  // Resolve the daetradez account. Slug match first, fall back to a
  // workspace-name LIKE so a renamed workspace still resolves.
  const account =
    (await prisma.account.findFirst({
      where: { slug: { contains: 'daetradez', mode: 'insensitive' } }
    })) ??
    (await prisma.account.findFirst({
      where: { name: { contains: 'daetradez', mode: 'insensitive' } }
    }));

  if (!account) {
    console.error('No daetradez account found.');
    process.exit(1);
  }
  console.log(`Account: ${account.name} (${account.id}) slug=${account.slug}`);

  const cred = await prisma.integrationCredential.findFirst({
    where: { accountId: account.id, provider: 'META', isActive: true }
  });
  if (!cred) {
    console.error('No active META credential row.');
    process.exit(1);
  }
  const meta = (cred.metadata as Record<string, unknown> | null) ?? {};
  const pageId = meta.pageId as string | undefined;
  if (!pageId) {
    console.error('META credential has no pageId in metadata.');
    process.exit(1);
  }
  console.log(`Page ID: ${pageId}`);

  const accessToken = await getMetaAccessToken(account.id);
  if (!accessToken) {
    console.error('No access token resolvable for this account.');
    process.exit(1);
  }
  console.log(`Access token: ${accessToken.slice(0, 12)}…`);

  const appId = process.env.META_APP_ID;
  if (!appId) {
    console.error('META_APP_ID env var missing — cannot identify our app.');
    process.exit(1);
  }

  // ── 1. GET subscribed_apps ───────────────────────────────────────
  const url = `${GRAPH_API}/${pageId}/subscribed_apps?access_token=${accessToken}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    console.error(`subscribed_apps GET failed (${res.status}): ${body}`);
    process.exit(1);
  }
  let parsed: { data?: Array<{ id?: string; subscribed_fields?: string[] }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    console.error(`Could not parse subscribed_apps response: ${body}`);
    process.exit(1);
  }
  const apps = parsed.data ?? [];
  const ourApp = apps.find((a) => a.id === appId);
  const fields = ourApp?.subscribed_fields ?? [];

  console.log('\n── Current subscription state ──');
  console.log(`  App subscribed: ${ourApp ? 'yes' : 'NO'}`);
  console.log(`  Subscribed fields: ${JSON.stringify(fields)}`);
  const missing = REQUIRED.filter((f) => !fields.includes(f));
  console.log(
    `  Missing required: ${missing.length === 0 ? 'none' : JSON.stringify(missing)}`
  );

  if (missing.length === 0) {
    console.log('\nAll required fields subscribed — nothing to do.');
    await prisma.$disconnect();
    return;
  }

  if (!apply) {
    console.log(
      '\nRe-run with --apply to subscribe the missing fields (will POST to /subscribed_apps).'
    );
    await prisma.$disconnect();
    return;
  }

  // ── 2. POST to (re)subscribe with the full required field set ───
  // Meta's API replaces the entire subscribed-fields array on each
  // POST, so we send the complete list (REQUIRED + anything already
  // subscribed) to avoid losing existing subscriptions.
  const merged = Array.from(new Set([...REQUIRED, ...fields]));
  const postUrl = `${GRAPH_API}/${pageId}/subscribed_apps`;
  const params = new URLSearchParams({
    subscribed_fields: merged.join(','),
    access_token: accessToken
  });
  const postRes = await fetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const postBody = await postRes.text();
  console.log(`\nPOST status: ${postRes.status}`);
  console.log(`POST body: ${postBody}`);

  if (!postRes.ok) {
    console.error('Subscription update FAILED.');
    process.exit(1);
  }

  // ── 3. Re-GET to confirm ─────────────────────────────────────────
  const confirmRes = await fetch(url);
  const confirmBody = await confirmRes.text();
  let confirmParsed: {
    data?: Array<{ id?: string; subscribed_fields?: string[] }>;
  };
  try {
    confirmParsed = JSON.parse(confirmBody);
  } catch {
    console.error('Could not parse confirmation response.');
    await prisma.$disconnect();
    return;
  }
  const confirmApp = (confirmParsed.data ?? []).find((a) => a.id === appId);
  const confirmFields = confirmApp?.subscribed_fields ?? [];
  const stillMissing = REQUIRED.filter((f) => !confirmFields.includes(f));
  console.log('\n── Post-subscribe state ──');
  console.log(`  Subscribed fields: ${JSON.stringify(confirmFields)}`);
  console.log(
    `  Still missing required: ${stillMissing.length === 0 ? 'none' : JSON.stringify(stillMissing)}`
  );

  await prisma.$disconnect();
  process.exit(stillMissing.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
