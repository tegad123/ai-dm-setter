/* eslint-disable no-console */
// Smoke-suite environment + safety guards.
//
// MUST be imported before any module that touches `@/lib/prisma`. We
// rewrite process.env.DATABASE_URL to point at the test DB so the
// shared Prisma singleton picks up the right connection. If we let
// the production DATABASE_URL stay set, the entire suite would scribble
// over real lead data.
//
// Hard-fails when:
//   - TEST_DATABASE_URL is unset, OR
//   - TEST_DATABASE_URL host matches the original DATABASE_URL host.

import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

const envFile = resolve(process.cwd(), '.env.test.local');
if (existsSync(envFile)) {
  dotenvConfig({ path: envFile, override: true });
} else {
  dotenvConfig();
}

function host(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

const PROD_DATABASE_URL = process.env.DATABASE_URL ?? '';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

if (!TEST_DATABASE_URL) {
  console.error(
    '[smoke] TEST_DATABASE_URL is unset. Refusing to run against production.'
  );
  console.error(
    '       set TEST_DATABASE_URL=postgres://qdms:qdms@localhost:55432/qdms_test in .env.test.local'
  );
  process.exit(1);
}

if (host(TEST_DATABASE_URL) === host(PROD_DATABASE_URL) && PROD_DATABASE_URL) {
  console.error(
    `[smoke] TEST_DATABASE_URL host (${host(TEST_DATABASE_URL)}) matches DATABASE_URL host. Refusing to run.`
  );
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    '[smoke] ANTHROPIC_API_KEY is unset. Real LLM calls require it.'
  );
  process.exit(1);
}

// Swap so every prisma import resolves to the test DB. Override BOTH
// DATABASE_URL and DIRECT_URL — schema.prisma uses both (pooler vs
// direct). Leaving DIRECT_URL = .env's prod value lets prisma migrate
// / introspect silently target production.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DIRECT_URL = TEST_DATABASE_URL;

export const SMOKE_CONFIG = {
  testDatabaseUrl: TEST_DATABASE_URL,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  testPersonaId: process.env.SMOKE_TEST_PERSONA_ID ?? '',
  testAccountSlug: 'smoke-test-account',
  testPersonaName: 'Smoke Test Persona',
  testIgUserIdPrefix: 'smoke_test_lead_',
  testHandlePrefix: 'smoke_test_'
};

export const TEST_URLS = {
  downsell: 'https://test.qualifydms.io/downsell',
  applicationForm: 'https://test.qualifydms.io/apply',
  fallbackContent: 'https://test.qualifydms.io/youtube'
};
