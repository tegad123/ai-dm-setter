/* eslint-disable no-console */
// Safety-guarded `prisma migrate deploy` for the smoke-test DB.
//
// Loads .env.test.local, asserts TEST_DATABASE_URL host differs
// from DATABASE_URL host, then runs `npx prisma migrate deploy`
// with DATABASE_URL set to TEST_DATABASE_URL. Refuses if the
// guard fails. Exits with prisma's exit code.
//
// Wraps the raw prisma command because `npx prisma migrate
// deploy` reads DATABASE_URL via prisma.config.ts → dotenv,
// which silently falls back to .env (= production) when a shell-
// prefix env var is malformed.

import { spawnSync } from 'child_process';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

const envFile = resolve(process.cwd(), '.env.test.local');
if (existsSync(envFile)) {
  config({ path: envFile, override: true });
} else {
  config();
}

function host(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

const PROD = process.env.DATABASE_URL ?? '';
const TEST = process.env.TEST_DATABASE_URL ?? '';

if (!TEST) {
  console.error(
    '[migrate-test] TEST_DATABASE_URL is unset. Add it to .env.test.local before running.'
  );
  process.exit(1);
}

if (host(TEST) === host(PROD) && PROD) {
  console.error(
    `[migrate-test] TEST_DATABASE_URL host (${host(TEST)}) matches DATABASE_URL host. Refusing — migrate would target production.`
  );
  process.exit(1);
}

console.log(
  `[migrate-test] running prisma migrate deploy against ${host(TEST)}`
);

// schema.prisma uses BOTH env("DATABASE_URL") and env("DIRECT_URL")
// (Supabase pooler vs direct). For migrations Prisma resolves directUrl
// when set, so we MUST also override DIRECT_URL — otherwise the prod
// .env value leaks through and migrations target production.
const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: TEST, DIRECT_URL: TEST }
});

process.exit(result.status ?? 1);
