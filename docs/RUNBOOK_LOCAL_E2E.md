# Runbook — running, verifying and debugging end to end from a laptop

Everything the previous engineer learned the hard way. If a step here is
skipped, you will lose hours. Commands assume the repo root and a `.env` with
`PROD_DATABASE_URL`, `META_APP_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`,
`CRON_SECRET` (names only listed here; values live in `.env` / Vercel).

## 0. The three rules that cause 80% of wasted time

1. **Two databases.** `DATABASE_URL` in `.env` is LOCAL Postgres.
   `PROD_DATABASE_URL` is Supabase prod. The app's singleton `@/lib/prisma`
   reads `DATABASE_URL`. Any script that imports `src/lib/*` therefore hits
   LOCAL unless you launch it with `DATABASE_URL="$PROD_DATABASE_URL"`.
   **ES imports are hoisted**: setting `process.env.DATABASE_URL` inside the
   script does nothing. Scripts under `scripts/verify/` build their own
   `new PrismaClient({ datasources: { db: { url: PROD_DATABASE_URL } } })` so
   they are safe; `generate-only-proof.ts enforce` is the exception (imports
   `src/lib/instagram`).
2. **Always `NODE_PATH=$PWD/node_modules npx tsx …`** for scripts (pnpm layout).
3. **The Supabase pooler (`:6543`) drops idle connections mid-run.** Wrap every
   read in a retry (all verify scripts do). Prisma "Can't reach database
   server" once is a blip, twice in a row is a retry loop you forgot.

## 1. Deploy & confirm

```
git push origin main                         # Vercel builds + runs prisma migrate deploy (safe-migrate)
curl -s https://qualifydms.io/api/version    # {"commit":"<sha>",…,"fixD":{"egressAuthoritativePlatforms":"FACEBOOK"}}
```
Poll `/api/version` until the SHA matches; ~2–4 min. Migrations are hand-written
SQL under `prisma/migrations/<timestamp>_<name>/migration.sql` (use
`IF NOT EXISTS`); run `npx prisma generate` locally after editing the schema
or TSC won't know the columns. **Saving a Vercel env var redeploys the OLD
commit** — push a real commit after env changes.

## 2. Vercel logs (the only way to see cron and `after()` failures)

```
vercel link --yes --scope dm-setter-team-developers --project ai-dm-setter   # once; creates .vercel/ (gitignored)
vercel ls --scope dm-setter-team-developers                                    # newest deployment URL first
vercel logs <deployment-url> --scope dm-setter-team-developers                 # STREAMS live only; run in background to a file, then grep
```
`vercel ls` **without** `--scope` shows a different team (orbiqon-com) — you
will stream the wrong project and see nothing. Logs are live-only: start the
stream, *then* trigger the thing, wait, grep. Cron invocations appear every
minute as `GET /api/cron/...`; `[cron] starting` followed by an error line is
a crash. Both the cron and the webhook `after()` log their failures here and
nowhere else.

## 3. Health checks (run these first when anything "didn't reply")

```
npx tsx scripts/verify/reply-pipeline-health.ts             # PROCESSING backlog, overdue, last SENT, last AI msg
npx tsx scripts/verify/ig-credential-health.ts [accountId]  # IG ids vs Meta, subscription, token validity, keys
npx tsx scripts/verify/watch-conversation.ts <convId>       # full chain for one conversation
```
Order of suspicion for "no reply": (1) reply pipeline stalled (cron crash /
`after()` killed), (2) webhook never resolved the workspace (id mismatch,
disconnected platform → now an operator notification), (3) Away Mode /
generate-only / `aiActive` state, (4) Meta rejected the send (24h window `#10`,
dead token `190`). Keys were never the problem so far; check them last.

## 4. Simulating inbound (prod) — the standard proof pattern

Meta only delivers real webhooks to prod. To exercise prod code paths you POST
a Meta-shaped payload, HMAC-signed with `META_APP_SECRET`, to
`https://qualifydms.io/api/webhooks/{instagram|facebook}`:

- Instagram: `{ object:'instagram', entry:[{ id:<ENTRY_ID>, messaging:[{ sender:{id}, recipient:{id:ENTRY_ID}, message:{ mid, text } }] }] }`
  where `ENTRY_ID` must equal a stored id on an active INSTAGRAM/META credential
  (`igProfessionalAccountId` for Instagram-Login accounts, `instagramAccountId`/
  `igBusinessAccountId` for page-linked ones). `scripts/verify/ig-inbound-proof.ts`.
- Facebook: `{ object:'page', entry:[{ id:<PAGE_ID>, messaging:[…] }] }`.
  Drivers: `scripts/drive-prod-funnel.ts` (adaptive Haiku lead, daetradez page
  `708196295710896`), `scripts/drive-apex-funnel.ts` (second account, page
  `1006770499175916`), `scripts/drive-dae-to-cap-q.ts`.

**Synthetic vs real senders.** A synthetic 16-digit sender (`9900…`) proves
resolution + generation; Meta can never deliver to it, so the ScheduledReply
ends `FAILED` with a Meta error — expected. **Delivery proof needs a real
sender**: the real PSID `27053194794302900` (Shazim, Facebook) or a real DM
from a real Instagram account, and the lead's **24h messaging window must be
open** (Meta `#10 outside allowed window` otherwise). Always delete synthetic
leads afterwards (every proof script has `--cleanup`/`restore`).

**Reply timing.** Daniel's workspace delay is 45–200s. ≤45s runs inline in the
webhook's `after()`; longer goes to the per-minute cron. Expect a reply
~1–4 min after the inbound. Poll the DB; don't `sleep` in the foreground.

## 5. Local pipeline (optional, for iterating on generation)

```
npx tsx scripts/clone-prod-to-local.ts      # copies creds + persona prod → local (same encryption key)
npx tsx scripts/reset-local-test.ts         # refuses unless DATABASE_URL is localhost; truncates + 1–3s delay
npm run dev                                  # localhost:3000
./scripts/simulate-fb-dm.sh "msg" | ./scripts/simulate-ig-dm.sh "msg"   # signed webhook → localhost; reply hits the REAL inbox
```
Local IG business id `17841445698923309` (SK Trades), FB page `1100557749811046`.
The local DB is behind prod on migrations — run `npx prisma migrate deploy`
against local before expecting new columns.

## 6. Tests

```
npx tsx --test tests/unit/*.test.ts            # ~26 files; 4 pre-existing failures in script-step-progression (classifier)
npx tsx scripts/test-state-machine.ts          # 25/25 egress state machine
npx tsx --test tests/unit/generate-only-mode.test.ts
NODE_PATH=$PWD/node_modules npx tsc --noEmit -p tsconfig.json   # must be clean before every commit
```
Name the 4 pre-existing failures in evidence; they belong to the compiler work.

## 7. Feature flags & switches you will touch

| Where | Flag | Meaning |
|---|---|---|
| Vercel env | `FIX_D_CANSEND_AUTHORITATIVE` (csv) | platforms where the egress gate BLOCKS; currently `FACEBOOK`; add `INSTAGRAM` after the shadow diff is clean |
| Vercel env | `FIX_D_EGRESS_SHADOW` | default on; log-only rows |
| Account row | `awayModeInstagram` / `awayModeFacebook` | new leads on that platform start AI-on and auto-send |
| Account row | `generateOnlyInstagram` / `generateOnlyFacebook` | AI generates + gates judge + shadow row, NOTHING delivers (`scripts/set-generate-only.ts <acct> <PLATFORM> on|off`) |
| Account row | `defaultAiActive`, `showSuggestionBanner` | AI opt-out per account; suggestion visibility |
| Conversation | `aiActive`, `autoSendOverride`, `awaitingHumanReview` | per-thread; `shouldAutoSendReply = aiActive && (awayMode || autoSendOverride)` and generate-only always forces suggestion |

## 8. Prod data hygiene

- Client rows (Daniel `cmpy59zy50000ju04u6fs5o2r`, Tega `cmod688i00000oa84aolhuk0j`,
  nick `cmosyitmk0000jv04jw87i8hl`): ask before writing settings; never leave
  synthetic leads behind (Daniel's dashboard is looked at daily).
- Shazim's own workspace `cmpb0knph00009kyx6tjzl4w1` is the safe place for
  proofs (IG token is dead there, which doesn't matter for resolution/generation).
- One INSTAGRAM credential per workspace (`@@unique([accountId, provider])`).
  Metadata merges on save — a bad id survives a reconnect unless the credential
  is deleted first.

## 9. Evidence tables

`GenerationTurnTrace` (one row per AI turn: step, branch, stages, reply,
hardFails, prompt), `EgressShadowLog` (gate verdict per send / dry run),
`ScheduledReply` (delivery queue; `lastError` tells the story),
`VoiceQualityFailure`, `BookingRoutingAudit`, `InboundQualification`,
`SilentStopEvent`. Readers: `scripts/verify/watch-conversation.ts`,
`scripts/inspect-turn-trace.ts`, `scripts/dump-trace-report.ts <convId>`.
