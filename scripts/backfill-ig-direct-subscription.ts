/**
 * Backfill webhook subscription via the Instagram Login API direct path
 * for IG-Login-only accounts (no linked Facebook Page).
 *
 * Why this exists: The OAuth callback's existing subscribeInstagramWebhooks()
 * only knows the FB Page route (POST graph.facebook.com/{pageId}/subscribed_apps),
 * which requires a Facebook Page linked to the IG account. Accounts that
 * connected via Instagram Business Login WITHOUT a linked FB Page (e.g.
 * nickdoesfutures) silently skip subscription — no webhooks ever arrive.
 *
 * Meta supports a direct path on Instagram Login API tokens (IGAA…):
 *   POST https://graph.instagram.com/v21.0/{ig-user-id}/subscribed_apps
 *   ?subscribed_fields=messages,messaging_postbacks,messaging_seen,messaging_referral
 *   &access_token={IGAA token}
 * No Facebook Page required. The {ig-user-id} here is the 17841… IG
 * Business Account ID (same value Meta sends as entry.id in webhooks).
 *
 * Usage:
 *   pnpm tsx scripts/backfill-ig-direct-subscription.ts --username nickdoesfutures
 *   pnpm tsx scripts/backfill-ig-direct-subscription.ts --username nickdoesfutures --dry-run
 *   pnpm tsx scripts/backfill-ig-direct-subscription.ts --all              (all INSTAGRAM creds missing igBusinessAccountId)
 *   pnpm tsx scripts/backfill-ig-direct-subscription.ts --all --dry-run
 *
 * Idempotent: existing subscription is reported, metadata only updated when changed.
 */

import { config as loadEnv } from 'dotenv';
loadEnv();
import prisma from '../src/lib/prisma';
import { getCredentials } from '../src/lib/credential-store';

const IG_GRAPH_API = 'https://graph.instagram.com/v21.0';

// Superset of fields the IG Login API supports for messaging.
// POST /subscribed_apps replaces the existing field set, so include
// everything we want to keep — `message_reactions` was previously subscribed
// on at least one prod account and is preserved here.
const SUBSCRIBED_FIELDS = [
  'messages',
  'messaging_postbacks',
  'message_reactions',
  'messaging_seen',
  'messaging_referral'
].join(',');

interface ProcessResult {
  username: string;
  accountId: string;
  credentialId: string;
  resolvedIgBusinessAccountId: string | null;
  previousIgBusinessAccountId: string | null;
  metadataUpdated: boolean;
  subscriptionStatus: 'ok' | 'failed' | 'dry-run' | 'skipped';
  subscriptionDetail?: string;
}

function parseArgs(): {
  username?: string;
  all: boolean;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let username: string | undefined;
  let all = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--username') username = args[++i];
    else if (a === '--all') all = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  if (!username && !all) {
    console.error('Must pass --username <name> or --all');
    printUsage();
    process.exit(2);
  }
  return { username, all, dryRun };
}

function printUsage() {
  console.error(
    'Usage:\n' +
      '  pnpm tsx scripts/backfill-ig-direct-subscription.ts --username <name> [--dry-run]\n' +
      '  pnpm tsx scripts/backfill-ig-direct-subscription.ts --all [--dry-run]'
  );
}

async function fetchProfileUserId(
  igAccessToken: string
): Promise<{ userId: string | null; raw: string }> {
  const url = `${IG_GRAPH_API}/me?fields=user_id,username&access_token=${igAccessToken}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    return { userId: null, raw: `HTTP ${res.status}: ${body.slice(0, 300)}` };
  }
  try {
    const data = JSON.parse(body) as { user_id?: string; username?: string };
    return { userId: data.user_id ? String(data.user_id) : null, raw: body };
  } catch {
    return { userId: null, raw: `parse error: ${body.slice(0, 300)}` };
  }
}

async function fetchExistingSubscription(
  igUserId: string,
  igAccessToken: string
): Promise<string> {
  const url = `${IG_GRAPH_API}/${igUserId}/subscribed_apps?access_token=${igAccessToken}`;
  try {
    const res = await fetch(url);
    return `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`;
  } catch (err) {
    return `fetch threw: ${(err as Error).message}`;
  }
}

async function postSubscription(
  igUserId: string,
  igAccessToken: string
): Promise<{ ok: boolean; detail: string }> {
  const url =
    `${IG_GRAPH_API}/${igUserId}/subscribed_apps?` +
    new URLSearchParams({
      subscribed_fields: SUBSCRIBED_FIELDS,
      access_token: igAccessToken
    });
  try {
    const res = await fetch(url, { method: 'POST' });
    const body = await res.text();
    return { ok: res.ok, detail: `HTTP ${res.status}: ${body.slice(0, 400)}` };
  } catch (err) {
    return { ok: false, detail: `fetch threw: ${(err as Error).message}` };
  }
}

async function processCredential(
  cred: {
    id: string;
    accountId: string;
    metadata: unknown;
  },
  dryRun: boolean
): Promise<ProcessResult> {
  const md = (cred.metadata as Record<string, unknown>) || {};
  const username = String(md.username ?? '<unknown>');
  const previousIgBusinessAccountId =
    (md.igBusinessAccountId as string | undefined) ?? null;

  const result: ProcessResult = {
    username,
    accountId: cred.accountId,
    credentialId: cred.id,
    resolvedIgBusinessAccountId: null,
    previousIgBusinessAccountId,
    metadataUpdated: false,
    subscriptionStatus: 'failed'
  };

  const decrypted = await getCredentials(cred.accountId, 'INSTAGRAM');
  if (!decrypted?.accessToken) {
    result.subscriptionDetail = 'No accessToken in credentials';
    result.subscriptionStatus = 'skipped';
    return result;
  }
  const igAccessToken = decrypted.accessToken as string;

  // Resolve the 17841… IG Business Account ID from /me?fields=user_id.
  // Token-exchange returns App-Scoped 26… ID; only /me?fields=user_id
  // returns the 17841 ID Meta puts in webhook entry.id.
  const profile = await fetchProfileUserId(igAccessToken);
  if (!profile.userId || !/^17841\d+$/.test(profile.userId)) {
    result.subscriptionDetail =
      `Could not resolve 17841… IG Business Account ID from /me. ` +
      `Got: ${profile.raw}. ` +
      `Token may lack instagram_business_basic scope.`;
    result.subscriptionStatus = 'skipped';
    return result;
  }
  const igUserId = profile.userId;
  result.resolvedIgBusinessAccountId = igUserId;

  console.log(
    `\n  → Resolved IG Business Account ID: ${igUserId} (was: ${previousIgBusinessAccountId ?? 'unset'})`
  );

  if (dryRun) {
    const existing = await fetchExistingSubscription(igUserId, igAccessToken);
    result.subscriptionDetail = `Dry-run. Current subscription: ${existing}`;
    result.subscriptionStatus = 'dry-run';
    console.log(`  ↳ ${result.subscriptionDetail}`);
    return result;
  }

  // POST subscription
  const sub = await postSubscription(igUserId, igAccessToken);
  result.subscriptionDetail = sub.detail;
  result.subscriptionStatus = sub.ok ? 'ok' : 'failed';
  console.log(
    `  ↳ POST /subscribed_apps → ${sub.ok ? 'OK' : 'FAILED'}: ${sub.detail}`
  );

  // Persist igBusinessAccountId on metadata if missing or wrong
  if (sub.ok && previousIgBusinessAccountId !== igUserId) {
    await prisma.integrationCredential.update({
      where: { id: cred.id },
      data: { metadata: { ...md, igBusinessAccountId: igUserId } }
    });
    result.metadataUpdated = true;
    console.log(`  ↳ Patched metadata.igBusinessAccountId = ${igUserId}`);
  }
  return result;
}

async function main() {
  const { username, all, dryRun } = parseArgs();

  // Find candidate INSTAGRAM credentials.
  // Prisma JSON-field equality on metadata.username works in Postgres
  // via path-based query. Use a broader fetch + JS filter for portability.
  const allInstagramCreds = await prisma.integrationCredential.findMany({
    where: { provider: 'INSTAGRAM', isActive: true },
    select: { id: true, accountId: true, metadata: true }
  });

  let targets = allInstagramCreds;
  if (username) {
    targets = allInstagramCreds.filter((c) => {
      const md = (c.metadata as Record<string, unknown>) || {};
      return md.username === username;
    });
    if (targets.length === 0) {
      console.error(
        `No active INSTAGRAM credential found with metadata.username="${username}". ` +
          `Available usernames: ${allInstagramCreds
            .map((c) => (c.metadata as any)?.username ?? '?')
            .join(', ')}`
      );
      await prisma.$disconnect();
      process.exit(1);
    }
  }

  console.log(
    `\n${dryRun ? '[DRY-RUN] ' : ''}Processing ${targets.length} INSTAGRAM credential(s)...`
  );

  const results: ProcessResult[] = [];
  for (const cred of targets) {
    const md = (cred.metadata as Record<string, unknown>) || {};
    console.log(
      `\n=== @${md.username ?? '?'} (accountId=${cred.accountId}, credId=${cred.id}) ===`
    );
    try {
      results.push(await processCredential(cred, dryRun));
    } catch (err) {
      console.error(`  ✗ Threw: ${(err as Error).message}`);
      results.push({
        username: String(md.username ?? '<unknown>'),
        accountId: cred.accountId,
        credentialId: cred.id,
        resolvedIgBusinessAccountId: null,
        previousIgBusinessAccountId:
          (md.igBusinessAccountId as string | undefined) ?? null,
        metadataUpdated: false,
        subscriptionStatus: 'failed',
        subscriptionDetail: (err as Error).message
      });
    }
  }

  const ok = results.filter((r) => r.subscriptionStatus === 'ok').length;
  const dry = results.filter((r) => r.subscriptionStatus === 'dry-run').length;
  const failed = results.filter(
    (r) => r.subscriptionStatus === 'failed'
  ).length;
  const skipped = results.filter(
    (r) => r.subscriptionStatus === 'skipped'
  ).length;
  const updated = results.filter((r) => r.metadataUpdated).length;

  console.log(
    `\n=== SUMMARY ===\n` +
      `Processed:                ${results.length}\n` +
      `Subscribed OK:            ${ok}\n` +
      `Dry-run inspections:      ${dry}\n` +
      `Failed:                   ${failed}\n` +
      `Skipped (missing token):  ${skipped}\n` +
      `Metadata patched:         ${updated}`
  );

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
