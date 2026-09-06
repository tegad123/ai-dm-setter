// Backfill `igProfessionalAccountId` on existing INSTAGRAM credentials.
//
// Why: for a standalone Instagram-Login connection, Meta delivers webhook
// `entry.id` as the PROFESSIONAL account id (graph.instagram.com
// /me?fields=user_id), but the connect callback historically stored only the
// app-scoped OAuth `user_id`. Rows connected before 2026-09-06 therefore
// never match an inbound DM (tegaumukoro_ in Daniel's workspace: delivered
// 17841400436427423, stored 26071428819190932 → F6.1 reject, silent drop).
// The callback now stores the professional id on connect; this script
// repairs rows that already exist so nobody has to reconnect.
//
// Read-only by default (prints what it WOULD write). Pass --apply to write.
// Never prints tokens. Rows whose token Meta rejects (expired / invalidated)
// are reported and skipped — they need a reconnect, not a backfill.
//
// Usage:
//   DATABASE_URL=$PROD_DATABASE_URL NODE_PATH=$PWD/node_modules \
//     npx tsx scripts/backfill-ig-professional-id.ts [--apply]

import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

import prisma from '../src/lib/prisma';
import { getCredentials, saveCredentials } from '../src/lib/credential-store';

const APPLY = process.argv.includes('--apply');

async function retry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw last;
}

async function main() {
  console.log(
    APPLY ? '=== APPLY mode: writing ===' : '=== DRY RUN (no writes) ==='
  );
  const rows = await retry(() =>
    prisma.integrationCredential.findMany({
      where: { provider: 'INSTAGRAM', isActive: true },
      select: {
        accountId: true,
        metadata: true,
        account: { select: { name: true } }
      }
    })
  );

  for (const row of rows) {
    const meta = (row.metadata as Record<string, unknown>) ?? {};
    const label = `${row.account.name} (${row.accountId}) @${meta.username ?? '?'}`;
    const stored = [
      meta.igUserId,
      meta.instagramAccountId,
      meta.igBusinessAccountId,
      meta.igProfessionalAccountId
    ]
      .filter(Boolean)
      .map(String);

    const creds = await retry(() => getCredentials(row.accountId, 'INSTAGRAM'));
    const token = creds?.accessToken as string | undefined;
    if (!token) {
      console.log(`SKIP  ${label}: no access token`);
      continue;
    }

    const res = await fetch(
      `https://graph.instagram.com/v21.0/me?fields=id,user_id,username,account_type&access_token=${encodeURIComponent(token)}`
    );
    const body: any = await res.json();
    if (!res.ok || body.error) {
      console.log(
        `SKIP  ${label}: token rejected by Meta (code ${body?.error?.code ?? res.status}) — needs reconnect`
      );
      continue;
    }

    const professionalId = body.user_id ? String(body.user_id) : null;
    if (!professionalId) {
      console.log(`SKIP  ${label}: /me returned no user_id`);
      continue;
    }
    if (meta.igProfessionalAccountId === professionalId) {
      console.log(
        `OK    ${label}: already has igProfessionalAccountId=${professionalId}`
      );
      continue;
    }

    const alreadyMatchable = stored.includes(professionalId);
    console.log(
      `${APPLY ? 'WRITE' : 'WOULD'} ${label}: igProfessionalAccountId=${professionalId} ` +
        `(account_type=${body.account_type}; stored ids ${stored.join(',') || 'none'}; ` +
        `inbound entry.id currently ${alreadyMatchable ? 'matches' : 'MATCHES NOTHING → dropped'})`
    );
    if (APPLY) {
      // Empty credentials object = keep the existing encrypted token as-is
      // (merge semantics); metadata is merged, so only the new key is added.
      await retry(() =>
        saveCredentials(
          row.accountId,
          'INSTAGRAM',
          {},
          {
            igProfessionalAccountId: professionalId
          }
        )
      );
    }
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
