/**
 * One-time auth helper for Playwright tests against a Clerk-protected
 * dashboard. Logs in with the test credentials in .env.test, captures
 * the resulting browser cookies + localStorage, and writes them to
 * tests/e2e/.auth/storage-state.json. Subsequent test runs reuse this
 * file via playwright.config.ts → projects[].use.storageState.
 *
 * Why a separate helper instead of beforeAll: Clerk's hosted login
 * page is rate-limited and gets cranky if every test worker logs in
 * fresh. One persisted session reused across the whole run is both
 * faster and quieter.
 *
 * Run manually:
 *   cp .env.test.example .env.test  (and fill in CLERK_TEST_EMAIL +
 *                                    CLERK_TEST_PASSWORD)
 *   npx tsx tests/e2e/helpers/auth.ts
 *
 * Re-run whenever:
 *   - The Clerk session expires (~7 days by default)
 *   - You rotate the test password
 *   - Clerk redirects to a new auth domain
 */
import { chromium } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

loadEnv({ path: '.env.test', override: true });

const STORAGE_PATH = 'tests/e2e/.auth/storage-state.json';
const EMPTY_PATH = 'tests/e2e/.auth/empty-state.json';
const APP_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

async function main() {
  const email = process.env.CLERK_TEST_EMAIL;
  const password = process.env.CLERK_TEST_PASSWORD;
  if (!email || !password) {
    console.error(
      'Missing CLERK_TEST_EMAIL / CLERK_TEST_PASSWORD in .env.test. Copy .env.test.example and fill in your test account.'
    );
    process.exit(1);
  }

  mkdirSync('tests/e2e/.auth', { recursive: true });
  // Always write a clean empty state so unauthenticated specs can
  // reference it explicitly with `test.use({ storageState: ... })`.
  writeFileSync(
    EMPTY_PATH,
    JSON.stringify({ cookies: [], origins: [] }, null, 2)
  );

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`→ navigating to ${APP_URL} (will redirect to Clerk)...`);
  await page.goto(`${APP_URL}/dashboard`);

  // Clerk's hosted sign-in form. Field selectors are stable across
  // Clerk versions but not guaranteed — if Clerk redesigns, update
  // these. We try identifier-first, then password-second since that's
  // Clerk's two-step flow.
  await page.waitForLoadState('domcontentloaded');
  const emailField = page.locator(
    'input[name="identifier"], input[type="email"]'
  );
  await emailField.first().waitFor({ timeout: 15_000 });
  await emailField.first().fill(email);
  await page
    .getByRole('button', { name: /continue|next|sign in/i })
    .first()
    .click();

  const passwordField = page.locator('input[type="password"]');
  await passwordField.first().waitFor({ timeout: 15_000 });
  await passwordField.first().fill(password);
  await page
    .getByRole('button', { name: /continue|next|sign in/i })
    .first()
    .click();

  // Wait for the dashboard to land. We don't care WHICH dashboard
  // route — just that we're past Clerk and inside the auth-gated zone.
  await page.waitForURL(/\/dashboard(\/|$)/, { timeout: 30_000 });

  await context.storageState({ path: STORAGE_PATH });
  await browser.close();

  console.log(`✓ stored auth state at ${join(process.cwd(), STORAGE_PATH)}`);
  console.log(
    '  Tests will now reuse this session. Re-run this script if Clerk redirects to login again.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
