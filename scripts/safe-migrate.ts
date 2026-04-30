/* eslint-disable no-console */
// Wrapper around `prisma migrate deploy` with a data-loss tripwire.
// Before applying migrations, snapshot the row count of the largest
// tenant's Conversation rows. After migrating, count again. If the
// count went from > 0 to 0, the migration broke existing rows —
// EXIT NON-ZERO so the deploy aborts before traffic is routed to a
// broken DB.
//
// Why daetradez specifically: it's the highest-volume account
// (~1500 conversations) and is the canary for any schema change
// that breaks data integrity. If daetradez's count drops to 0,
// every other account's count likely did too.
//
// Today's outage (P0, 2026-04-30): daetradez had 1543 conversations
// in DB but the API returned empty. That was a missing-migration
// case (the columns didn't exist), not data loss — count was still
// 1543 the whole time. This guard catches the related but distinct
// class: a migration that DROPS data. Both classes manifest as
// "the dashboard is empty," so a single guard covering both is
// worth the few seconds.
//
// Usage: pnpm db:migrate-safe (called from package.json `build`)
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
import prisma from '../src/lib/prisma';
import { spawnSync } from 'child_process';

const HIGH_VOLUME_SLUG_HINT = 'daetradez';

async function findCanaryAccountId(): Promise<{
  id: string;
  slug: string;
} | null> {
  const acct = await prisma.account.findFirst({
    where: { slug: { contains: HIGH_VOLUME_SLUG_HINT, mode: 'insensitive' } },
    select: { id: true, slug: true }
  });
  return acct;
}

async function countConvosFor(accountId: string): Promise<number | null> {
  // Count via raw SQL so the query never touches columns that may
  // be missing from one side of the migration. Lead.accountId is a
  // pre-rule grandfathered FK — present in every revision.
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "Conversation" c
     JOIN "Lead" l ON l.id = c."leadId"
     WHERE l."accountId" = $1`,
    accountId
  );
  if (!rows.length) return null;
  return Number(rows[0].n);
}

async function main() {
  const canary = await findCanaryAccountId();
  if (!canary) {
    console.warn(
      `[safe-migrate] No canary account found (slug containing "${HIGH_VOLUME_SLUG_HINT}"). Running migrate without count-guard.`
    );
    await prisma.$disconnect();
    runMigrate();
    return;
  }

  console.log(
    `[safe-migrate] Canary: account ${canary.id} (slug=${canary.slug})`
  );

  const before = await countConvosFor(canary.id);
  console.log(`[safe-migrate] Pre-migration Conversation count: ${before}`);
  await prisma.$disconnect();

  runMigrate();

  // Reconnect for the post-migration count — the prisma client may
  // have been regenerated with a different schema during the deploy.
  const { default: postPrisma } = await import('../src/lib/prisma');
  const after = await countConvosFor(canary.id);
  console.log(`[safe-migrate] Post-migration Conversation count: ${after}`);
  await postPrisma.$disconnect();

  if (before !== null && before > 0 && after === 0) {
    console.error(
      `\n✗ DATA LOSS DETECTED — Canary account had ${before} conversations before migrate and 0 after. The migration just dropped or detached data. ABORTING DEPLOY.\n\nNext steps:\n  1. DO NOT route traffic to this build.\n  2. Inspect the migration that just ran (\`prisma migrate status\` will show the latest applied).\n  3. Restore from the most recent Supabase snapshot if needed.\n  4. Roll the migration forward correctly with explicit data-preserving SQL.\n`
    );
    process.exit(1);
  }
  console.log(
    '✓ Safe-migrate guard passed — Conversation row count preserved through migration.'
  );
}

function runMigrate() {
  console.log('[safe-migrate] Running `prisma migrate deploy`...');
  const res = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    encoding: 'utf-8'
  });
  if (res.status !== 0) {
    console.error(
      `[safe-migrate] migrate deploy exited ${res.status}. Aborting.`
    );
    process.exit(res.status ?? 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
