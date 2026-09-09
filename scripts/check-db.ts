// DB connectivity diagnostic — run yourself to see what's actually wrong.
//   NODE_PATH=$PWD/node_modules npx tsx scripts/check-db.ts
//
// Loads PROD_DATABASE_URL from .env, then tries BOTH the pooler (:6543) and
// a derived direct connection (:5432) so you can see which layer is failing.
// Prints the real Prisma error code (P1001 = can't reach, P1000 = auth, etc).

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load .env manually (this script may run outside Next's env loading).
function loadEnv(): void {
  try {
    const raw = readFileSync(join(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* .env optional */
  }
}
loadEnv();

const POOLER = process.env.PROD_DATABASE_URL ?? '';

// Derive a direct :5432 URL from the pooler URL:
//  - swap port 6543 -> 5432
//  - drop the ?pgbouncer=true param (direct doesn't use pgbouncer)
//  - the pooler user is "postgres.<ref>"; direct is plain "postgres@db.<ref>.supabase.co"
function deriveDirect(url: string): string | null {
  try {
    const m = url.match(
      /^postgresql:\/\/postgres\.([a-z0-9]+):([^@]+)@[^/]+\/([^?]+)/
    );
    if (!m) return null;
    const [, ref, pass, db] = m;
    return `postgresql://postgres:${pass}@db.${ref}.supabase.co:5432/${db}?sslmode=require`;
  } catch {
    return null;
  }
}

async function tryConn(label: string, url: string): Promise<void> {
  const p = new PrismaClient({ datasources: { db: { url } } });
  const started = Date.now();
  const kill = setTimeout(() => {
    console.log(
      `  ${label}: TIMEOUT after 20s (socket opened, session never completed — pooler backend not answering)`
    );
    process.exit(0);
  }, 20000);
  try {
    await p.$queryRawUnsafe('SELECT 1');
    clearTimeout(kill);
    console.log(`  ${label}: OK (${Date.now() - started}ms)`);
  } catch (e: any) {
    clearTimeout(kill);
    const code = e?.errorCode ?? e?.code ?? '(none)';
    const msg = String(e?.message ?? e).split('\n')[0];
    console.log(`  ${label}: FAIL code=${code} — ${msg}`);
  } finally {
    await p.$disconnect().catch(() => {});
  }
}

async function main(): Promise<void> {
  if (!POOLER) {
    console.log('PROD_DATABASE_URL is not set in .env — nothing to test.');
    return;
  }
  // Show structure without leaking the password.
  const shape = POOLER.replace(/:([^:@/]+)@/, ':****@');
  console.log('Pooler URL:', shape);

  console.log('\nTesting pooler (:6543, pgbouncer):');
  await tryConn('pooler', POOLER);

  const direct = deriveDirect(POOLER);
  if (direct) {
    console.log('\nTesting direct (:5432):');
    await tryConn('direct', direct);
    console.log(
      '\nIf pooler FAILS but direct OK → set PROD_DATABASE_URL to the direct URL temporarily.'
    );
    console.log(
      'If BOTH fail with P1001 → Supabase is unreachable from here (their side or network); the app keeps running on its warm pool.'
    );
  } else {
    console.log(
      '\n(Could not derive a direct URL from the pooler URL shape — skipping.)'
    );
  }
}

main();
