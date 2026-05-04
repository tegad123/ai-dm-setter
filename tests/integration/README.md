# Smoke Tests — Real LLM, Real Pipeline

Substitute for sending DMs by hand. 17 scenarios run the full
generation pipeline against an isolated test database with real
Anthropic calls; Meta API calls are stubbed so nothing leaves the
test box.

## What this catches that hermetic tests don't

| Hermetic suite (`test:conversations`) | Smoke suite (`test:smoke`) |
|---|---|
| Gate logic regressions | LLM ignoring instructions |
| Regex changes | Prompt drift |
| Routing rule changes | Context window truncation |
| Phrase detection changes | New model behavior changes |
| 6ms, every PR | ~60s, nightly |

## One-time setup

### 1. Provision a Supabase test project

Go to https://supabase.com/dashboard → **New Project** →
name it `qdms-smoke-test` (or similar). Pick the same region as
prod for consistency. Wait for the project to provision.

Settings → Database → **Connection string** → URI. Copy it.

### 2. Configure environment

Create `.env.test.local`:

```
TEST_DATABASE_URL=<paste your Supabase test-project URI here>
ANTHROPIC_API_KEY=sk-ant-...
```

> Treat `ANTHROPIC_API_KEY` like a secret — rotate it in the
> Anthropic console if it ever lands in chat logs, screenshots,
> or commits.

The smoke runner + the migrate wrapper both refuse to start if
`TEST_DATABASE_URL` host equals your prod `DATABASE_URL` host.

### 3. Apply schema migrations to the test DB

```sh
npm run db:migrate-test
```

This wrapper loads `.env.test.local`, asserts `TEST_DATABASE_URL`
≠ `DATABASE_URL` host, and runs `prisma migrate deploy` against
the test DB. It exits non-zero if the safety check fails — never
runs against prod.

### 4. Seed the test account + persona

```sh
npm run test:smoke:seed
```

Output prints `SMOKE_TEST_ACCOUNT_ID` + `SMOKE_TEST_PERSONA_ID`.
The seed is idempotent — re-running upserts the same rows.

The runner resolves the persona by name, so you don't need to
copy the ID into env vars unless you want a fixed pin.

### Alternative: local Postgres via Docker

If you'd rather not provision a Supabase project, the repo
includes a `docker-compose.test.yml` that runs Postgres 16
locally on `localhost:55432`. Steps:

```sh
docker compose -f docker-compose.test.yml up -d
# .env.test.local:
#   TEST_DATABASE_URL=postgres://qdms:qdms@localhost:55432/qdms_test
npm run db:migrate-test
npm run test:smoke:seed
```

Requires Docker Desktop installed (`brew install --cask docker`).

## Running

```sh
npm run test:smoke
```

Per scenario the runner:

1. Creates a fresh Lead + Conversation + history Messages.
2. Inserts the trailing LEAD message.
3. Calls `scheduleAIReply(conversationId, accountId, { skipDelayQueue: true })` — the same entry the production webhook uses.
4. Drains any queued `ScheduledReply` rows synchronously.
5. Reads back the persisted AI Message + Conversation state.
6. Runs the scenario's `check()` against `ReplyStateSnapshot`.
7. Deletes the conversation tree (Lead/Conversation/Messages).

Test account + persona persist for re-runs.

## Reset

```sh
npm run test:smoke:cleanup    # drop only test leads/conversations (account+persona stay)
```

For a full wipe, drop the test Supabase project from the
dashboard and re-provision, or `docker compose -f
docker-compose.test.yml down -v` if you took the Docker path.

## CI

[`.github/workflows/smoke-tests.yml`](../../.github/workflows/smoke-tests.yml)
runs on a 06:00 UTC cron and `workflow_dispatch`. Required GitHub
secrets:

- `TEST_DATABASE_URL` — points at your CI test DB (separate Supabase
  project, hosted Postgres, etc.).
- `ANTHROPIC_API_KEY`
- `SMOKE_TEST_PERSONA_ID` — emitted by the seed script; persists
  across runs since the seed is idempotent.

The CI job runs migrations against `TEST_DATABASE_URL` (set as
`DATABASE_URL` in the workflow env so prisma picks it up), then
runs the suite. Add the seed step to the workflow if your CI
test DB doesn't pre-exist.

## Cost

~21 Anthropic calls per run × ~2k tokens each at Sonnet pricing
≈ $0.15/run. Nightly = ~$4.50/month.

## Adding a scenario

1. Append a new `Scenario` to `SCENARIOS` in `scenarios.ts`.
2. Pick the next `id` (`'18'`, etc.) and a kebab-case `name`.
3. Define `history`, `trailingLeadMessage`, optional
   `capturedDataPoints` / `systemStage`, and a `check()` that
   takes the `ReplyStateSnapshot` + `TEST_URLS` and returns
   `{ passed, evidence|reason }`.
4. Run `npm run test:smoke` against your local test DB to verify.

## How it differs from the hermetic suite

The hermetic suite (`tests/conversation-fixtures/`, `test:conversations`)
runs in 6ms with no DB and no LLM — it stores recorded LLM
outputs and asserts the gates would handle them correctly. Smoke
tests run the entire generation against real Claude through real
gates against a real DB, which is the only way to catch:

- LLM emitting forbidden phrases despite the prompt.
- LLM hallucinating URLs.
- New model versions changing structured output.
- Stage machine + state-write regressions that hermetic
  function-level tests cannot exercise.

The two suites are complementary: hermetic on every PR for fast
deterministic feedback, smoke nightly to catch what only real LLM
output can reveal.
