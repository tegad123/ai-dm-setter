import { defineConfig, devices } from '@playwright/test';

// ---------------------------------------------------------------------------
// Playwright config — end-to-end tests for QualifyDMs.
// ---------------------------------------------------------------------------
// Tests live in tests/e2e/. Auth-gated tests rely on a stored Clerk
// session at tests/e2e/.auth/storage-state.json — produced by
// tests/e2e/helpers/auth.ts (manual one-time login, not committed).
//
// Run locally:
//   npm run test:e2e        # headless
//   npm run test:e2e:ui     # Playwright UI
//   npm run test:e2e:headed # visible browser, useful for debugging
//
// First-time setup (per machine):
//   npx playwright install chromium     # downloads ~150MB browser binary
//   cp .env.test.example .env.test      # edit with Clerk test creds
//   npx tsx tests/e2e/helpers/auth.ts   # writes storage-state.json
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Tests run in parallel within a worker — one Next.js dev server hosts
  // them all. Keep workers low so the Clerk free-tier rate limits don't
  // get hit on the auth endpoint.
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Auth-gated tests pick up the stored session via this file.
        // Tests that don't need auth read from the no-auth state at
        // tests/e2e/.auth/empty-state.json (or omit the storage entry
        // entirely with `test.use({ storageState: { cookies: [], origins: [] } })`).
        storageState: 'tests/e2e/.auth/storage-state.json'
      }
    }
  ],
  // Auto-start the Next dev server so the test runner is one command.
  // Reuses an existing server when one's already on the port.
  webServer: {
    command: 'npm run dev',
    url: `${BASE_URL}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe'
  }
});
