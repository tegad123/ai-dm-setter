/* eslint-disable no-console */
// MUST be imported before any module that touches `@/lib/prisma`.
// Rewrites process.env.DATABASE_URL to TEST_DATABASE_URL so the shared
// Prisma singleton binds to the test database. Refuses to load if any
// of these checks fail.

import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { PrismaClient } from '@prisma/client';
import { HarnessSafetyError } from './errors';

const envFile = resolve(process.cwd(), '.env.test.local');
if (existsSync(envFile)) {
  dotenvConfig({ path: envFile, override: true });
} else {
  dotenvConfig();
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function dbNameOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).pathname.replace(/^\//, '').toLowerCase();
  } catch {
    return '';
  }
}

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL ?? '';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

function fail(msg: string): never {
  console.error(`[persona-harness] ${msg}`);
  throw new HarnessSafetyError(msg);
}

if (!TEST_DATABASE_URL) {
  fail(
    'TEST_DATABASE_URL is unset. Refusing to run. Set it in .env.test.local before invoking npm run test:personas.'
  );
}

if (TEST_DATABASE_URL === ORIGINAL_DATABASE_URL && ORIGINAL_DATABASE_URL) {
  fail(
    'TEST_DATABASE_URL is byte-identical to DATABASE_URL. Refusing to run against production.'
  );
}

if (
  ORIGINAL_DATABASE_URL &&
  hostOf(TEST_DATABASE_URL) === hostOf(ORIGINAL_DATABASE_URL) &&
  dbNameOf(TEST_DATABASE_URL) === dbNameOf(ORIGINAL_DATABASE_URL)
) {
  fail(
    `TEST_DATABASE_URL host+db (${hostOf(TEST_DATABASE_URL)}/${dbNameOf(TEST_DATABASE_URL)}) match DATABASE_URL. Refusing to run.`
  );
}

const PROD_HOST_DENYLIST = ['supabase.co', 'rds.amazonaws.com', 'neon.tech'];
const testHost = hostOf(TEST_DATABASE_URL);
for (const denied of PROD_HOST_DENYLIST) {
  if (testHost.endsWith(denied) && !testHost.startsWith('test-')) {
    console.warn(
      `[persona-harness] WARNING: TEST_DATABASE_URL host (${testHost}) looks like managed cloud DB. ` +
        `Ensure this is a test instance, not production.`
    );
  }
}

if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
  fail(
    'Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set. The harness calls real LLM providers.'
  );
}

if (process.env.CI === 'true' && process.env.PERSONA_HARNESS_OK !== '1') {
  fail(
    'Detected CI=true without PERSONA_HARNESS_OK=1. Refusing to run the harness in CI without explicit opt-in.'
  );
}

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DIRECT_URL = TEST_DATABASE_URL;

export const HARNESS_CONFIG = {
  testDatabaseUrl: TEST_DATABASE_URL,
  testDatabaseName: dbNameOf(TEST_DATABASE_URL),
  testDatabaseHost: hostOf(TEST_DATABASE_URL),
  maxCostUsd: Number(process.env.PERSONA_HARNESS_MAX_COST_USD ?? '0.50'),
  rowIdPrefix: 'test-harness-'
};

// Lazy-imports prisma so any DATABASE_URL writes above land first.
let cachedPrisma: PrismaClient | null = null;

export async function getPrisma(): Promise<PrismaClient> {
  if (!cachedPrisma) {
    const mod = await import('../../../src/lib/prisma');
    cachedPrisma = mod.default as PrismaClient;
  }
  return cachedPrisma;
}

// Belt-and-braces — every DB write path calls this. If anything has
// somehow swapped DATABASE_URL back, refuse.
export async function assertTestDb(): Promise<void> {
  const prisma = await getPrisma();
  const result = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    'SELECT current_database() AS name'
  );
  const currentName = result?.[0]?.name?.toLowerCase() ?? '';
  if (currentName !== HARNESS_CONFIG.testDatabaseName) {
    fail(
      `assertTestDb: connected DB is "${currentName}", expected "${HARNESS_CONFIG.testDatabaseName}". Aborting before any write.`
    );
  }
}
