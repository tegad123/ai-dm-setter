# Playwright e2e tests

Twelve smoke tests across the core app surface — dashboard, conversations, safety gates, settings.

## First-time setup (per machine)

```bash
# 1. Install the chromium binary (one-time, ~150MB download).
npx playwright install chromium

# 2. Set up a dedicated Clerk test account, then:
cp .env.test.example .env.test
# edit .env.test → fill in CLERK_TEST_EMAIL + CLERK_TEST_PASSWORD

# 3. Capture an auth session. Reads .env.test, drives a real Clerk
# login, writes tests/e2e/.auth/storage-state.json (gitignored).
npm run test:e2e:auth
```

## Run

```bash
npm run test:e2e          # headless, full suite
npm run test:e2e:ui       # Playwright UI for debugging
npm run test:e2e:headed   # visible browser, useful when a selector breaks
```

The dev server auto-starts via `webServer` in `playwright.config.ts` — no
need to run `npm run dev` separately. If a server is already on port 3000
it gets reused.

## Suites

| File | Tests | What it covers |
|---|---|---|
| `dashboard.spec.ts` | 1, 2, 3 | Dashboard load, Action Required polling, Qualified/Unqualified filter tabs |
| `conversations.spec.ts` | 4, 5, 6, 7 | List, thread open, AI toggle persistence, manual HUMAN send |
| `safety.spec.ts` | 8, 9, 10 | Bracketed-placeholder block, capital-pass call routing, capital-fail downsell |
| `settings.spec.ts` | 11, 12 | Persona Editor sections, Notification Settings groups + email display |

Tests 8-10 hit `/api/ai/test-message` — that endpoint runs the real
generation pipeline (system prompt, voice gate, retry loop) without
making Meta API calls or persisting message rows. Generations take
8-25s each, so the safety suite takes ~1 minute end-to-end.

## When tests fail

- **All tests fail at Clerk redirect** → storage-state.json expired or
  was never created. Re-run `npm run test:e2e:auth`. Sessions last ~7d
  by default.
- **Test 6 (AI toggle) flakes** → the seed data has zero conversations.
  Add at least one to the test workspace.
- **Tests 8-10 fail intermittently** → the test workspace's persona
  config doesn't have a downsell ($497 course) configured. Tests assume
  the daetradez-style setup; adjust the persona in the test workspace
  or relax the assertion in safety.spec.ts.

## Adding more tests

Drop new specs into `tests/e2e/`. They auto-pick-up the auth state
and the running dev server. Keep selectors loose (substrings,
case-insensitive) — copy changes faster than tests do.
