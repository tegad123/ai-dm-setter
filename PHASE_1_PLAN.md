# QualifyDMs Phase 1 — Detailed Execution Plan

> ## ✅ PHASE 1 COMPLETE — M1 + M2 signed off & paid (2026-06-05)
>
> **Status:** Both milestones closed. M1 ($1,500) and M2 ($1,700) approved & paid by client. All deliverables live on production (`main`).
>
> **M1 (Inbound loop + AI reliability) — delivered:**
> - QD-004 / QD-004b (IG-Login webhook subscribe), QD-005 (meta-health retry/classify), QD-059 (default aiActive ON), QD-060 (toggle persistence), placeholder-leak resolve, looping mitigation.
>
> **M2 (Calendar + booking + hardening) — delivered:**
> - Google Calendar OAuth + `google-calendar.ts` + adapter `google` branch; Calendar tab (`/dashboard/calendar`, week-grid + booked-call overlay); active-calendar selection; autonomous booking + confirmation DM; QD-001 (Google login), QD-046 (tags), QD-014 (date validation); quota-error wrapper (`ai-error-handler.ts`) closing QD-003/024/043/044/045/048.
> - **Pulled forward from Phase 2 (at client request):** F8 analytics reconciliation — 10 bugs QD-032→QD-041 (`lead-state-sets.ts` canonical sets).
>
> **Post-sign-off hotfixes shipped during M2→M3 transition (all on prod):**
> - `b959227` Meta backfill leak + "clear conversation" reset durability
> - `b3c1f21` Facebook durable inline-reply path (AI no longer stalls mid-convo)
> - `986b887` / `49c94e6` ship best-effort on script-adherence gate exhaustion (AI no longer goes silent)
> - `dd0156f` no hard-pause on benign script-skip drift
> - `e1728a3` lead not marked UNQUALIFIED on entering capital waterfall
> - `e5c09ec` Revenue Growth chart "Invalid Date"; `9750036` deal-value capture on Closed Won
>
> **Known issue carried into M3 (scoped as F5.1, NOT a regression):** stage-progression / `LeadScriptPosition` advancement is unreliable (two unsynced stage models + dead position tracker + hardcoded DAE funnel). Documented below and in PHASE_2_PLAN.md §F5.1. **This is M3 priority #1.**
>
> Checkboxes below are the original working plan, left as historical record. The header above is the authoritative completion status.

## Context

We won the QualifyDMs Upwork engagement at **$7,000 total / 5 weeks**. This document is the **Phase 1 (Weeks 1–2, $3,200 of the $7K via M1+M2 milestones) execution plan**.

**Phase 1 goal (singular acceptance criterion from the discovery call):**
> *"A new lead can send a DM to a connected Instagram account, get auto-replied to by the AI, progress through the full qualification script without operator intervention, have a call booked to a connected calendar of the operator's choice, and receive a confirmation DM, all without a human touching the conversation."*

**Phase 1 covers:** 10 client-listed bugs (QD-001, 003, 004, 005, 014, 024, 043, 044, 045, 046, 048, 059, 060) + AI reliability fixes from the discovery call (placeholder leak, looping) + Google Calendar OAuth integration (genuinely greenfield — verified zero `googleapis`/`GOOGLE_OAUTH_*` references in repo).

This plan is **codebase-verified**, not assumed. Findings that contradict the original proposal are flagged inline. We work bug-by-bug with a checklist so progress is trackable.

---

## Pre-Flight (Day 0) — Access & Setup

Before Day 1, get these from the client:

- [ ] GitHub write access (`github.com/tegad123/ai-dm-setter` — verify exact URL)
- [ ] Vercel team invite (staging + production)
- [ ] Supabase invite (staging DB read access)
- [ ] Test Instagram + Facebook sandbox accounts (so we don't pollute prod)
- [ ] ManyChat sandbox access
- [ ] Active OpenAI + Anthropic API keys (required for retest of QD-003/024/043/044/045/048)
- [ ] **Google Cloud project created** with OAuth consent screen configured. Need `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. (Required for both QD-001 Google login AND the new Google Calendar adapter.)
- [ ] Client availability windows for end-of-week demos (Week 1 + Week 2)

Local setup:
- [ ] Clone repo, `bun install`
- [ ] Copy `env.example.txt` → `.env.local`, fill in all credentials
- [ ] `bun db:migrate-safe` against staging DB
- [ ] `bun dev` — confirm app boots, log in via Clerk, reach dashboard
- [ ] Baseline test run: `bun test tests/persona-harness/` — capture pass/fail counts
- [ ] Read `audit/2026-05-03-multi-tenant-leak-audit.md` end-to-end

---

## Codebase Reality (Verified Against Code, Not Proposal)

| Concern | Reality |
|---|---|
| Inbound webhook signature validation | **Already exists.** `src/app/api/webhooks/instagram/route.ts:131-144` + `facebook/route.ts:106-120` use `verifyWebhookSignature()`. QD-004 is *not* a signature bug. |
| Conversation AI on/off flag | **`Conversation.aiActive`** (schema line 928), NOT `aiEnabled`. Server-authoritative via `src/lib/api.ts:313-317`. |
| Why AI doesn't auto-respond (QD-059) | New ManyChat-handoff conversations are initialized with `aiActive: false` in `src/lib/manychat-handoff.ts:254` (and a sibling location). Comment: *"no longer auto-enables AI on new ManyChat handoffs."* This is the likely root cause. |
| Meta-health cron | **Exists** at `src/app/api/cron/meta-health/route.ts`. Checks `debug_token` for `is_valid=true`. Has throttled-alert dedup via `fireThrottledAlert()`. Missing: retry-with-backoff for transient failures, error-code differentiation (2 vs 190). |
| Voice quality gate | **Sophisticated.** `voice-quality-gate.ts` has `METADATA_LEAK_PATTERNS`, `detectMetadataLeak()`, `surgicalStripMetadataLeak()`. Already attempts to *strip* leaks. Question is what happens after strip fails. |
| Script state recovery | **Already exists.** `script-state-recovery.ts` has `RecoveryResult`, `ScriptStateSnapshot`, `appendBranchHistoryEvent`. The `Lead.stageMismatchCount` field exists (schema line 1012). The loop bug is about *how the recovery logic is triggered*, not absence of recovery infrastructure. |
| Calendar adapters | Calendly = **stub** (returns `[]`, no `bookCalendlyAppointment` function exists). Cal.com = functional. LeadConnector = most complete. Google = **0 references in codebase**, fully greenfield. |
| OpenAI SDK call sites | 7 files: `media-processing.ts`, `training-example-retriever.ts`, `script-parser.ts`, `ai-engine.ts`, `voice-note-context-matcher.ts`, `voice-notes/[id]/process/route.ts`, `ai/test-message/route.ts`. |
| Anthropic SDK call sites | 14 files including `keepalive-generator.ts`, `script-parser.ts`, `training-data-analyzer.ts`, `ai-engine.ts`, `voice-note-context-matcher.ts`, `distress-response.ts`, and 8 API routes under `settings/training`, `settings/persona`, `voice-notes`, `ai`. Wrapper scope is wider than proposal claimed. |
| Tag scoping | List route (`src/app/api/tags/route.ts:10-11`) correctly scopes by `accountId`. QD-046's bug is in the lead-tag assignment path (`src/app/api/leads/[id]/tags/route.ts`). |
| Google OAuth login (QD-001) | Truly missing — no `GOOGLE_OAUTH_*` env keys, no Clerk Google provider config in `docs/clerk_setup.md`. Same Google Cloud project will fix both QD-001 and the Calendar adapter. |

---

## Phase 1 Day-by-Day Plan

### Week 1: Stream A (Inbound Loop) + Stream B (AI Reliability) → **M1 ($1,500)**

#### Day 1 — Onboarding + QD-004 Diagnostic Spike
- [x] Complete pre-flight setup checklist (above)
- [x] Read `audit/2026-05-03-multi-tenant-leak-audit.md` — confirmed our QD-059 fix is multi-tenant clean; flagged F1.5/F2.2/F5.1 (Daniel/Anthony/$497 hardcoded in master prompt) as Phase 2 scope but the *reason* our no-training suppression guard exists
- [x] Read `docs/handoff-ai-not-delivering-2026-05-06.md` — silent-send-failure bug from 2026-05-06 is fixed (we see `lastError` populated correctly); confirms `autoSendOverride` model we built on
- [x] Skim `docs/ARCHITECTURE_RESPONSE_PIPELINE.md` — 11-stage pipeline confirmed; worst-case latency 15-25s matches observed 24.6s 3-retry run; voice gate's DANIEL_VOCAB confirmed as the reason for our `qualityGateAttempts=3` on first generation
- [x] **QD-004 4-hour diagnostic spike** (see §QD-004 detail below + full writeup in `FIX_LOG.md`)
  - [x] Reproduced inbound webhook with synthetic IG payload — Lead/Conversation/Message all persist correctly
  - [x] F6.1 strict recipient-routing accepts payload (entry.id matches IG credential metadata)
  - [x] Signature validation works (dev-mode bypass; prod uses verifyWebhookSignature)
  - [x] QD-004's "not in dashboard" symptom does NOT reproduce against current code with synthetic payload — re-frame: likely conflated with QD-059 (no AI reply → operator perceives nothing landed)
  - [x] QD-059 root cause **confirmed in two sites**: `webhook-processor.ts:1182` (the sibling) AND `manychat-handoff.ts:254` — both hardcode `aiActive: false` per 2026-05-06 policy
  - [x] AI pipeline validated end-to-end: SQL-flipped flags + seeded training data → full chain runs to Anthropic SDK
  - [x] Only blocker to end-to-end demo: Anthropic credit balance depleted on the key in `.env`
  - [x] Created `scripts/seed-shazim-training-data.ts` (idempotent) — 3 convos / 30 msgs, mirrors prod daetradez structural shape with original synthetic content
  - [x] Production read-only inspection revealed Tega's prod account is empty (0 active personas, 0 training, 0 integrations) — re-frames a portion of the QA backlog as "account not configured" rather than code bugs
- [x] End-of-day update to client: spike findings + Day 2 plan + Anthropic credit ask

#### Day 2 — QD-004 + QD-005
- [x] Implement QD-004 fix — re-classified during Day 1 spike (doesn't reproduce against current code with synthetic payload; likely conflated with QD-059 in original report). Real-payload regression test blocked on Meta App developer access; tracked in FIX_LOG.md
- [x] **QD-004b (NEW, found 2026-05-20):** Instagram-Login OAuth never subscribes the IG account to webhooks → IG DMs never reach prod. **Code fix landed 2026-05-20** — IG-host `/me/subscribed_apps` primary subscribe + `webhookSubscribed` persistence in `instagram/callback/route.ts`. Manual subscribe already applied for shazim. Remaining: ID-mismatch investigation + Settings status surfacing + backfill script (see §QD-004b). See §QD-004b detail.
- [x] Implement QD-005 meta-health hardening — new helper `src/lib/meta-token-health.ts` with retry-with-backoff (1s/2s/4s) + error-code classification (revoked 190/463 vs transient 2/4/613/is_transient); cron only alerts on `revoked`, suppresses `transient_exhausted`. 14/14 unit tests pass. Live cron run confirms no false-positive credential-invalidated alert
- [ ] Smoke test: send real DM from sandbox IG → confirm appears in dashboard within 5s — **blocked on Meta App developer access**
- [ ] Push to staging; verify with cron logs that `meta-health` is no longer false-positiving — **blocked on staging deploy decision**
- [x] End-of-day update to client — pending your review

#### Day 3 — QD-059 + QD-060 — **PULLED FORWARD to Day 1 (2026-05-18)**
- [x] Trace `aiActive` lifecycle in `manychat-handoff.ts` (lines 254, sibling) — found at 254 + 292; `webhook-processor.ts:1182` is the inbound IG/FB sibling
- [x] Decide & implement default-aiActive policy — `Account.defaultAiActive Boolean @default(true)` via migration `20260518104828_add_account_default_ai_active`
- [ ] Fix QD-060 page-refresh hydration (see §QD-060) — pending visual confirmation once Anthropic credits unblock the UI test
- [x] Verify across all `aiActive: false` flip-sites that flips are intentional — auto-pause on distress + quality-gate failure + escalation all remain `false` deliberately; the 3 inbound-create sites flipped to honor `defaultAiActive`
- [x] Smoke test: fresh inbound DM creates a Conversation with `aiActive=true, autoSendOverride=true, awaitingAiResponse=true` automatically with `awayModeInstagram=false`. ScheduledReply queued for cron pickup. Verified on local dev with synthetic webhook.
- [ ] End-of-day update to client — drafting

#### Day 4 — AI Placeholder Leak Hardening
**Audit finding (2026-05-20):** the plan's premise ("gate catches `{{name}}` but leaves the AI silent") is already false in current code. `ai-engine.ts` (lines ~3900-3967) already does detect → surgical strip → re-prompt → escalate, and the final fallback `buildR34BlockedFallbackParsed()` ships a safe holding line **with `escalateToHuman: true`** — there is no silent-block path. The one genuine gap was that emitted `{{placeholders}}` were *stripped* (→ incoherent) rather than *resolved*.
- [x] Audit current `surgicalStripMetadataLeak` path — done; confirmed wired via `stripMetadataLeaksFromMessages` in ai-engine.
- [x] Wire `script-variable-resolver` into the gate path BEFORE stripping — new `resolveEmittedPlaceholders()` runs at the leak-check using the already-built `gateVariableResolutionMap`; resolvable `{{name}}` → real value (ships personalized), unresolvable → falls through unchanged.
- [x] Re-prompt fallback when resolve+strip fail — **already existed** (R34 directive on remaining attempts).
- [x] Structured escalation as final fallback — **already existed** (`buildR34BlockedFallbackParsed` → holding line + `escalateToHuman:true`).
- [x] Replace any silent-block paths — **none found**; the existing fallback is not silent.
- [x] Add unit tests — `tests/unit/resolve-emitted-placeholders.test.ts` (6/6 pass).
- [ ] End-of-day update to client

#### Day 5 — Loop/Repetition Fix + Persona Harness Pass
- [ ] Read `script-state-recovery.ts` end-to-end (5.8K lines — chunk it)
- [ ] Investigate why `stageMismatchCount` (existing field, schema line 1012) doesn't have a force-advance consumer
- [ ] Tighten R-rule for stage output contract in `ai-prompts.ts` (canonical stage IDs, advancing-to vs leaving)
- [ ] Add "force-advance after 2 consecutive same-stage generations" using existing `stageMismatchCount`
- [ ] Demote `script-state-recovery` rollback to fire only on high-confidence + large mismatch
- [ ] Run `bun test tests/persona-harness/` — must match or beat Day-0 baseline
- [ ] Record 8+ turn test conversation to demonstrate no looping
- [ ] **End of M1: prepare recorded demo for client sign-off ($1,500 due)**

---

### Week 2: Stream C (Calendar) + Stream D (Hardening) → **M2 ($1,700)**

#### Day 6 — Google Cloud OAuth Setup + Google Calendar Adapter (Part 1)
- [ ] Confirm client has Google Cloud project provisioned with OAuth consent screen (External or Internal — recommend External for testing)
- [ ] OAuth scopes to request: `https://www.googleapis.com/auth/calendar.events`, `https://www.googleapis.com/auth/calendar.readonly`
- [ ] Add `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` to env.example.txt + Vercel env
- [ ] Install `googleapis` package via `bun add googleapis`
- [ ] Create `src/lib/google-calendar.ts` with `getAvailability()` (FreeBusy API) + `bookSlot()` (Events insert)
- [ ] Add `google` branch to `calendar-adapter.ts` (in `getUnifiedAvailability` and `bookUnifiedAppointment`)
- [ ] Extend `AvailabilityResult.provider` and `BookingResult.provider` union types to include `'google'`
- [ ] End-of-day update to client

#### Day 7 — Google OAuth Routes + Token Refresh + QD-001 Login
- [ ] Create `src/app/api/auth/google-calendar/connect/route.ts` (initiates OAuth flow with state CSRF token)
- [ ] Create `src/app/api/auth/google-calendar/callback/route.ts` (handles redirect, exchanges code for tokens, persists in `IntegrationCredential` encrypted)
- [ ] Implement access-token refresh helper (Google access tokens expire in 1h)
- [ ] Wire QD-001 (Clerk Google social provider) — same OAuth client_id, configure in Clerk dashboard
- [ ] Add "Connect Google Calendar" CTA in `src/app/dashboard/settings/integrations/` (find existing settings/integrations route)
- [ ] Smoke test: complete OAuth flow end-to-end; verify token in DB
- [ ] End-of-day update to client

#### Day 8 — Calendar Tab + Provider Verification + Autonomous Booking
- [ ] Build `/dashboard/calendar` page (new route under `src/app/dashboard/calendar/page.tsx`) showing connected calendar slots + busy/free for next 14 days
- [ ] Wire to `getUnifiedAvailability` so it works across all 4 providers
- [ ] Verify Cal.com booking works (functional in current code) — test against sandbox
- [ ] Verify LeadConnector booking works — test against sandbox
- [ ] **Add `bookCalendlyAppointment` function** (currently missing — Calendly is stub). Use Calendly v2 Scheduled Events API
- [ ] Wire `booking-info-extractor.ts` + `booking-predictor.ts` → `bookUnifiedAppointment()` for autonomous flow (no operator click needed)
- [ ] On success: trigger confirmation DM via `call-confirmation-sequence.ts` + queue 3 reminders via `call-reminders.ts`
- [ ] End-of-day update to client

#### Day 9 — Reschedule + QD-014 + QD-046 + Quota Wrapper
- [~] **Reschedule flow** — DEFERRED to Phase 2 with F5.1. Depends on the funnel rework; can't be verified E2E on non-Daniel accounts until F5.1 lands. Operators can reschedule today via the call-details panel (which now respects QD-014).
- [x] **QD-014**: inline + server-side validation rejecting call dates > 6 months out. Added in `api/conversations/[id]/call/route.ts` PUT handler, mirrored client-side in `call-details-panel.tsx` (toast + `max` on datetime input).
- [x] **QD-046**: root cause was NOT scoping — `useTags()` double-unwrapped the API response so the Leads tag picker was always empty. Fixed in `src/hooks/use-api.ts`.
- [x] **Quota error wrapper**: created `src/lib/ai-error-handler.ts` with `safeOpenAI()` / `safeAnthropic()` / `classifyAIError()` / `aiErrorResponse()`.
- [x] Applied wrapper to operator-facing routes (test-message, persona analyze/extract/script/section, training upload + structure, voice-note process) and the core `ai-engine.ts` generate calls.
- [x] Verified QD-003, QD-024, QD-043, QD-044, QD-045, QD-048 surface operator-friendly messages instead of raw JSON. Classifier unit-tested against representative OpenAI insufficient_quota, Anthropic credit_balance_too_low, 429, 401, 529 error shapes.
- [x] Client update sent.

#### Day 9 Extension — F8 Analytics Reconciliation (pulled from Phase 2 per Tega 2026-05-29)
Pulled forward from Phase 2 Days 14–15 into M2 because Tega flagged "stage progression accuracy across the conversations tab, the analytics, and the pipeline tab" as Week 2 priority. Full audit in `ANALYTICS_AUDIT.md`. Closes 10 Phase 2 bugs (QD-032 → QD-041) inside M2.

- [x] **Step 1**: created `src/lib/lead-state-sets.ts` with canonical constants (QUALIFIED/BOOKED/SHOWED/ACTIVE/TERMINAL/STAGES_WITH_STAGE_DATA + EXCLUDE_COLD_PITCH filter).
- [x] **Step 2 + Step 3**: refactored funnel, overview, segments, conversations, lead-distribution, dashboard/actions to import from the helper. Uniform cold-pitch exclusion across main-funnel aggregates. Fixed Overview's internal asymmetry (cold-pitch was applied to totalLeads but not stageCounts).
- [x] **Step 4 — QD-039**: data-quality "With Stage Data" denominator switched to AI-pipeline messages.
- [x] **Step 5 — QD-040**: cold-start.ts honors thresholdOverride (was silently ignored).
- [x] **Step 6 — QD-041**: conversation-funnel filtered to in-SOP conversations; returns funnelDenominator + excludedPreSop for UI labeling.
- [x] **Step 7**: autonomous booking now persists scheduledCallTimezone, scheduledCallSource (CALENDAR_INTEGRATION), scheduledCallConfirmed, audit fields — not just scheduledCallAt.
- [x] **Step 8**: `tests/analytics-reconciliation-test.ts` ships 10 helper-invariant tests + 4 seeded cross-view tests. Reconciliation test caught a real bug (SHOWED was missing from ACTIVE_LEAD_STAGES) before this work was committed; fixed before merge. 14/14 pass.
- [x] **QD-032, QD-033, QD-034, QD-035, QD-036, QD-037, QD-038, QD-039, QD-040, QD-041 closed** (10 bugs).

#### Day 10 — E2E Acceptance + Recorded Demo + Production Deploy
- [ ] Run full Phase 1 acceptance flow on production: send DM from real IG → AI auto-replies → walks through stages → books call on real Google Calendar → sends confirmation DM
- [ ] Record video of the full happy path
- [ ] Verify no raw JSON visible anywhere in UI (do error-injection test with depleted API key)
- [ ] Verify Google login (QD-001) works end-to-end
- [ ] Run `bun test tests/persona-harness/` one final time — green
- [ ] **End of M2: client sign-off demo ($1,700 due)**
- [ ] Hand off Phase 2 backlog for the optional M3+M4 window

---

## Per-Bug Detail

### QD-004 (Critical) — Inbound IG DMs not in Conversations dashboard
**Symptom:** DM sent to connected IG account doesn't appear in dashboard.

**Verified non-causes:** Signature validation works (`verifyWebhookSignature()`). Webhook route registered.

**Real candidates (in priority order):**
1. **Recipient-ID resolution failing silently.** `webhook-processor.ts` resolves `recipient.id` → `Account` → `AIPersona`. If the IG account in `IntegrationCredential.metadata` doesn't have the right `pageId`/`igUserId` shape, the lookup returns nothing and the webhook 200s without persisting.
2. **IGAA-vs-EAA token type mismatch.** IG Business accounts use Instagram-issued access tokens (IGAA) vs Page-issued (EAA). Token type may not match the API call.
3. **Numeric IG ID bug** — see `docs/diagnostic-numeric-ig-id-bug.md` for prior incident context.

**⚠️ VERIFIED PROD ROOT CAUSE (2026-05-20) — for Instagram-Login connections:** the webhook never fires at all because the IG account is **not subscribed**. `GET /me/subscribed_apps` returned `{"data":[]}` for `@sk_trade17`. Meta stores the DM (readable via `/me/conversations`) but never pushes a webhook. Confirmed the OAuth callback fails to subscribe IG-Login accounts — see **QD-004b** below. This is distinct from the resolution-chain candidates above (those assume the webhook arrives; here it never does).

**Spike plan (4h budget):**
- [ ] Capture real webhook payload from Meta via Sentry breadcrumb on production
- [ ] Replay locally against `webhook-processor.ts` entry point
- [ ] Add Sentry breadcrumbs at every resolution step
- [ ] Identify where chain breaks
- [ ] If cause is Meta infra (outage, app-review issue): escalate to client immediately with logs, do NOT burn timeline

**Fix:** Per spike findings. Most likely: explicit error throw + Sentry capture at every silent-return point in the resolution chain.

**Acceptance:** External account sends DM → appears in dashboard within 5 seconds.

**Files:** `src/lib/webhook-processor.ts`, `src/app/api/webhooks/instagram/route.ts`, `src/app/api/webhooks/facebook/route.ts`

---

### QD-004b (Critical) — Instagram-Login OAuth does not subscribe webhooks
**Discovered:** 2026-05-20 during local end-to-end tracing of shazim's account.

**Symptom:** A user connects Instagram via the standalone **Instagram Login** flow (`/api/auth/instagram`). DMs to their IG account never reach the webhook in production, so no lead/conversation is ever created. (Facebook works because the Page is subscribed.) This presents identically to QD-004 but the cause is upstream of all webhook processing.

**Root cause (verified in code):** `subscribeInstagramWebhooks()` in `src/app/api/auth/instagram/callback/route.ts:250` only knows how to subscribe a **Facebook Page**:
- *Approach 1* (`:272`): if a META credential with `pageId` exists → `POST /{pageId}/subscribed_apps` on the **Facebook** graph.
- *Approach 2* (`:304`): use the IG token to call `/me/accounts` on the **Facebook** graph to discover a linked page, then subscribe that page.

There is **no** call to `POST /me/subscribed_apps` on `graph.instagram.com` — the only correct way to subscribe a pure Instagram-Login connection. Approach 2 fails because an `IGAA…` token cannot list Facebook Pages via `/me/accounts`, so the code falls through to the `:353` warning *"Webhooks must be configured manually"* and gives up. Result: the account is silently left unsubscribed.

**Manual remediation already applied (2026-05-20):** subscribed shazim's account by hand — `POST https://graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages` (returned `{"success":true}`; verified `subscribed_fields:["messages"]`). This unblocks shazim's prod IG test but does NOT fix the code for future onboarding.

**Fix:**
- [x] Add an IG-host subscription as the **primary** path (new `subscribeInstagramDirectWebhooks()` in `instagram/callback/route.ts`): `POST https://graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages` using the IG token, run before the page-based approaches. (2026-05-20)
- [x] Verify success by reading back `GET /me/subscribed_apps` and persist the subscription state — `metadata.webhookSubscribed` + `webhookSubscribedAt` now written on the INSTAGRAM credential on every connect (even when page discovery fails). (2026-05-20)
- [ ] Fix the stored IG ID mismatch (credential metadata had igAcct `…830`; live account `…832`) so resolution/diagnostics line up. **Deliberately deferred** — three IG ID representations are in play (token user_id, /me user_id, page-linked 17841…); needs a focused investigation before changing routing, and shazim's case already routes via the META credential's `instagramAccountId`.
- [ ] Surface a clear connection-status error in Settings when subscription fails (today: server-log warning + `webhookSubscribed:false` persisted — UI surfacing still TODO).
- [ ] Backfill: one-off script to subscribe any existing INSTAGRAM-credential accounts currently unsubscribed. (shazim already subscribed manually 2026-05-20.)

**Acceptance:** New Instagram-Login connection → `GET /me/subscribed_apps` shows `messages` immediately after OAuth → a real DM creates a lead/conversation in the dashboard within 5s.

**Files:** `src/app/api/auth/instagram/callback/route.ts` (`subscribeInstagramWebhooks`, `subscribePageToWebhooks`), `src/app/api/webhooks/instagram/route.ts` (routing assumptions), `prisma/schema.prisma` (optional `metadata.webhookSubscribed`)

---

### QD-005 (Critical) — Meta credential health false positives
**Symptom:** `meta-health` cron reports "credential invalidated" even when connection is fine; spams operator with reconnect alerts.

**Current state:** `src/app/api/cron/meta-health/route.ts` checks `debug_token` for `is_valid=true`. Has throttled-alert dedup. Missing retry + error-code classification.

**Fix:**
- [ ] Add retry-with-backoff (3 attempts: 1s, 2s, 4s) before flagging unhealthy
- [ ] Parse Meta error codes: `2` (transient — *"Service temporarily unavailable"*) → don't flag. `190` (subcodes 460, 463, 467 — actual revocation) → flag.
- [ ] Suppress notification if revalidation passes within 60s window
- [ ] Add unit tests for transient vs revoked classification

**Acceptance:** Inject transient error in dev → no notification. Inject real revocation → notification fires.

**Files:** `src/app/api/cron/meta-health/route.ts`, `src/lib/webhook-processor.ts` (lines 241–280, the dedup logic)

---

### QD-059 (High) — AI Setter not auto-responding
**Symptom:** New leads come in; operator expects AI to respond; AI sits silent until operator manually toggles AI ON.

**Real root cause (verified):** `src/lib/manychat-handoff.ts:254` and a sibling location explicitly set `aiActive: false` on conversation creation. Comment: *"no longer auto-enables AI on new ManyChat handoffs."*

**This is the bug Tega is hitting.** The original design was intentional (defensive), but it contradicts Tega's product expectation. Question to confirm with Tega: should NEW conversations auto-enable AI?

**Decision (confirmed):** Default `aiActive` to ON. Add per-account override for future flexibility.

**Fix:**
- [ ] Add `Account.defaultAiActive` Boolean field (default `true`) — additive migration
- [ ] In `manychat-handoff.ts`, change all `aiActive: false` hardcodes → `aiActive: account.defaultAiActive` (verify both site at line 254 and the sibling)
- [ ] In every other Conversation create path, same change
- [ ] Add Settings UI toggle for `defaultAiActive` (operator-facing) under Settings → Persona or Settings → AI
- [ ] Backfill: existing accounts get `defaultAiActive: true` via migration default

**Acceptance:** Fresh inbound DM from a new lead → AI auto-replies without operator touch.

**Files:** `src/lib/manychat-handoff.ts`, `prisma/schema.prisma` (Account model + migration), settings UI under `src/app/dashboard/settings/`

---

### QD-060 (Medium) — AI toggle resets after page refresh
**Symptom:** Operator toggles AI ON, refreshes page, toggle shows OFF.

**Verified state (2026-05-20 source audit):** Current code does **not** reproduce this.
- The toggle reads `conversation.aiActive` directly from server data (`conversation-thread.tsx:478`), not a stale local `useState`.
- `handleToggleAI` (`conversations-view.tsx:186`) calls the API then `refetchList()`; an 8s poll + SSE realtime also keep it server-authoritative.
- The live route `POST /conversations/:id/toggle-ai` persists correctly: OFF writes `aiActive:false`; ON now writes `aiActive:true` explicitly (was relying on `handleAIHandoff` as a side-effect — hardened on 2026-05-20).
- **Conclusion:** QD-060 was almost certainly a *symptom of QD-059* — new conversations defaulted to `aiActive:false`, so the toggle "reset" because the server genuinely held `false`. With QD-059 fixed, the symptom disappears.

**Hardening done (2026-05-20):** `toggle-ai/route.ts` ON path now sets `aiActive:true` in the same update as `autoSendOverride:true`, so the fix no longer depends on a side-effect inside `handleAIHandoff`.

**Remaining:**
- [ ] **UI click-verification** (does NOT need Anthropic): toggle ON → refresh 3× → still ON; toggle OFF → refresh → still OFF.
- [ ] (Optional) Playwright e2e for the above.
- [ ] **Dead-code cleanup (in observation):** `src/app/api/conversations/[id]/ai-toggle/route.ts` (PATCH) is unused in-repo — dashboard calls POST `toggle-ai` (`api.ts:315`). External callers can't be ruled out, so instead of deleting we added a `[ai-toggle][LEGACY-ROUTE-HIT]` telemetry log (2026-05-20). **Action:** check prod logs after a reasonable window; if zero hits → delete the route + fix the stale comment at `webhook-processor.ts:673`. If hits → identify the external caller before any change.

**Acceptance:** Toggle ON, refresh 3 times, still ON. Toggle OFF, refresh, still OFF.

**Files:** `src/features/conversations/components/conversation-thread.tsx`, `src/features/conversations/components/conversations-view.tsx`, `src/app/api/conversations/[id]/toggle-ai/route.ts`, `src/lib/api.ts`

---

### AI Placeholder Leak (not in bug sheet — from discovery call)
**Symptom (as reported):** AI generates `"Hi {{name}}, see you {{day_and_time}}"`; gate catches the `{{*}}` but allegedly leaves the AI silent.

**Verified state (2026-05-20 audit) — premise was outdated:** the pipeline already does the full chain. `detectMetadataLeak()` catches `{{...}}`; `stripMetadataLeaksFromMessages()` surgically strips; remaining attempts re-prompt with an R34 directive; the final fallback `buildR34BlockedFallbackParsed()` ships a safe holding line **and** sets `escalateToHuman:true`. **There is no silent-block path.** The only real gap: emitted `{{name}}` was *stripped* (→ incoherent) instead of *resolved* to the lead's actual value.

**Fix (landed 2026-05-20):**
- [x] Wire `script-variable-resolver` BEFORE the strip path — new `resolveEmittedPlaceholders()` runs at the leak-check using the in-scope `gateVariableResolutionMap`; resolvable `{{name}}` → real value so the reply ships personalized.
- [x] If unresolvable placeholders remain → existing re-prompt with R34 directive (already present).
- [x] If re-prompt still fails → existing structured escalation (`escalateToHuman:true` + holding line; already present).
- [x] Replace all silent-block code paths — none existed; verified.
- [ ] ~~Add `AISuggestion.gateDecision` enum field~~ — **not needed**; `recordR34MetadataLeakCatch()` already records leak catches for diagnostics.

**Acceptance:** Unit tests cover resolve (resolvable → ships) vs. unresolvable (→ falls through to strip/escalate). Full mocked-LLM end-to-end left for the persona harness pass.

**Files:** `src/lib/ai-engine.ts` (leak-check resolve step), `src/lib/script-variable-resolver.ts` (`resolveEmittedPlaceholders`), `tests/unit/resolve-emitted-placeholders.test.ts`

---

### AI Looping / Stage Repetition (not in bug sheet — from discovery call)
**Symptom:** AI asks the same question turn after turn instead of advancing the lead.

**Verified state:** `Lead.systemStage`, `Lead.llmEmittedStage`, `Lead.stageMismatchCount` fields exist (schema lines 1010-1012). Recovery infrastructure exists in `script-state-recovery.ts`. The bug is that `stageMismatchCount` has no force-advance consumer.

**Fix:**
- [ ] Add R-rule in `ai-prompts.ts`: `current_stage` MUST be a canonical stage ID + represents stage advancing TO (not from)
- [ ] In `script-step-progression.ts`: when LLM emits same stage as `Lead.systemStage`, increment `stageMismatchCount`; on advance, reset to 0
- [ ] When `stageMismatchCount >= 2`: force-advance to next stage in canonical 7-stage sequence regardless of LLM output
- [ ] Demote `script-state-recovery.ts` rollback: only fire when confidence ≥ 0.85 AND mismatch skips > 2 stages
- [ ] Add persona-harness test: 8+ turn conversation reaches BOOKING without same-stage repeat

**Acceptance:** `tests/persona-harness/runner.ts` passes including new long-conversation test.

**Files:** `src/lib/ai-prompts.ts`, `src/lib/script-step-progression.ts`, `src/lib/script-state-recovery.ts`, `src/lib/lead-script-tracker.ts`

---

### QD-001 (High) — "Continue with Google" returns 400 Missing client_id
**Symptom:** Google social login button on /sign-in errors out.

**Fix:** Configure Google as OAuth provider in Clerk dashboard with `GOOGLE_OAUTH_CLIENT_ID` + secret. Same credentials as the Google Calendar adapter — 2-for-1.

- [ ] Verify Clerk Google provider is configured in Clerk dashboard
- [ ] Set env vars in Vercel (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`)
- [ ] Smoke test: click "Continue with Google" → Google consent → redirect → session created

**Acceptance:** Google login flow completes end-to-end.

**Files:** Clerk dashboard (no code change), `env.example.txt`, possibly `src/app/sign-in/`

---

### QD-003 / QD-024 / QD-043 / QD-044 / QD-045 / QD-048 — Quota Error JSON Leaks
**Symptom (consolidated):** Raw OpenAI 429 or Anthropic `credit_balance_too_low` JSON shown to operator in UI. Six bugs, one root cause.

**Fix:** Single shared error-handler module.

- [ ] Create `src/lib/ai-error-handler.ts` exporting `safeOpenAI()` and `safeAnthropic()` HOFs
- [ ] Handler catches: HTTP 429, OpenAI `insufficient_quota`, Anthropic `credit_balance_too_low`, network errors
- [ ] Returns typed `AIError` discriminated union: `quota_exceeded` | `network_error` | `auth_error` | `unknown`
- [ ] UI surface helper that converts `AIError` → operator-friendly message: *"AI service temporarily unavailable. Please contact support."*
- [ ] Apply wrapper to:
  - [ ] `src/lib/ai-engine.ts`
  - [ ] `src/lib/keepalive-generator.ts`
  - [ ] `src/lib/script-parser.ts`
  - [ ] `src/lib/training-data-analyzer.ts`
  - [ ] `src/lib/voice-note-context-matcher.ts`
  - [ ] `src/lib/distress-response.ts`
  - [ ] `src/lib/media-processing.ts`
  - [ ] `src/lib/training-example-retriever.ts`
  - [ ] `src/app/api/voice-notes/[id]/process/route.ts`
  - [ ] `src/app/api/ai/test-message/route.ts`
  - [ ] `src/app/api/settings/training/upload/route.ts`
  - [ ] `src/app/api/settings/training/upload/[id]/structure/route.ts`
  - [ ] `src/app/api/settings/persona/script/route.ts`
  - [ ] `src/app/api/settings/persona/script/[id]/section/route.ts`
  - [ ] `src/app/api/settings/persona/analyze/route.ts`
  - [ ] `src/app/api/settings/persona/extract/route.ts`

**Acceptance:** Inject depleted-quota key in staging → all six bug-reproductions show clean error string instead of JSON.

---

### QD-046 (Critical) — Tags created in Settings don't appear in Leads
**Verified state:** Tag LIST scope is correct. Bug is in lead-tag join path.

**Fix:**
- [ ] Audit `src/app/api/leads/[id]/tags/route.ts` (POST, GET, DELETE) for `accountId` scoping
- [ ] Verify `LeadTag.upsert` uses correct composite key
- [ ] Audit Lead list view query — does it `include` tags? Is the include scoped?
- [ ] Audit other Lead joins (conversations, bookings) for same class of bug per multi-tenant audit guidance

**Acceptance:** Create tag → assign to lead → tag shows in Leads view. Tag does NOT appear in another account's Leads view.

**Files:** `src/app/api/leads/[id]/tags/route.ts`, Lead list query (find via grep `prisma.lead.findMany`)

---

### QD-014 (Medium) — Booking accepts year 2099 dates
**Fix:**
- [ ] Find Call Details form (manual booking UI)
- [ ] Add `max` attribute on date input: today + 6 months
- [ ] Add server-side Zod validation: reject `scheduledFor > now + 6mo`
- [ ] Display inline error message
- [ ] Add Playwright e2e

**Files:** Manual booking form component, related API route

---

## Google Calendar OAuth + Adapter (Greenfield Build)

**Why this is real work, not "wire up a few endpoints":** Zero existing references (`grep -r "googleapis\|GOOGLE_OAUTH" src/` returns nothing). Calendly/Cal.com/LeadConnector use API keys; Google requires full OAuth per Google's published policy. Cannot use API keys for Calendar.

### Setup (Day 6)
- [ ] Client creates Google Cloud project (or we walk them through it)
- [ ] Enable Google Calendar API + Google Identity API
- [ ] Configure OAuth consent screen (External type, app name "QualifyDMs", support email, dev contact)
- [ ] Add scopes: `calendar.events`, `calendar.readonly`, `userinfo.email`, `userinfo.profile`
- [ ] Create OAuth 2.0 Client ID (Web application). Authorized redirect URIs:
  - `https://qualifydms.io/api/auth/google-calendar/callback`
  - `http://localhost:3000/api/auth/google-calendar/callback` (dev)
- [ ] Get `client_id` + `client_secret` → add to Vercel env vars
- [ ] `bun add googleapis google-auth-library`

### Implementation (Days 6–7)
- [ ] **`src/lib/google-calendar.ts`** (new):
  - `getAvailability(connection, dateRange)` → calls `freebusy.query` API
  - `bookSlot(connection, slot, attendee)` → calls `events.insert` API
  - Returns shapes matching `AvailabilityResult` / `BookingResult`
  - Internal `refreshAccessToken(connection)` helper (Google tokens expire in 1h)
- [ ] **`calendar-adapter.ts`** — add `google` branch:
  - Update `provider` union: `'leadconnector' | 'calendly' | 'calcom' | 'google' | 'none'`
  - Add to `getUnifiedAvailability` provider lookup chain
  - Add to `bookUnifiedAppointment` provider lookup chain
- [ ] **`src/app/api/auth/google-calendar/connect/route.ts`**:
  - Generate state CSRF token (signed)
  - Build OAuth authorize URL with offline access + force consent
  - Redirect to Google
- [ ] **`src/app/api/auth/google-calendar/callback/route.ts`**:
  - Verify state CSRF
  - Exchange code for tokens (access + refresh)
  - Encrypt + persist in `IntegrationCredential` (provider = `GOOGLE_CALENDAR`)
  - Redirect to settings success page
- [ ] Add `GOOGLE_CALENDAR` to `IntegrationCredential.provider` enum (Prisma migration)
- [ ] Add "Connect Google Calendar" CTA in `src/app/dashboard/settings/integrations/`

### Verification
- [ ] Connect Google Calendar from settings → OAuth consent → redirect back → token in DB
- [ ] `getAvailability` against connected calendar returns real busy/free slots
- [ ] `bookSlot` creates a real event visible in the connected Google Calendar within 60s
- [ ] Refresh token flow works after 1h (test by manually expiring access token)

---

## Verification Plan

### Per-bug verification (run after each fix)
- [ ] Reproduction steps from bug sheet → confirm bug is fixed
- [ ] Negative test: confirm fix didn't break adjacent functionality
- [ ] `bun test` for unit tests
- [ ] `bun test tests/persona-harness/runner.ts` after any AI-pipeline change

### M1 acceptance (end of Week 1)
- [ ] Send DM from external IG to connected sandbox IG → appears in dashboard within 5s
- [ ] AI auto-replies without operator toggle
- [ ] `aiActive` persists across page refresh
- [ ] No false "credential invalidated" alerts fire
- [ ] 8+ turn test conversation reaches BOOKING stage without looping or going silent
- [ ] Persona harness ≥ baseline pass rate
- [ ] Demo recorded; client signs off; M1 invoice ($1,500)

### M2 acceptance (end of Week 2)
- [ ] All M1 criteria still pass
- [ ] Google Calendar connects via OAuth from Settings
- [ ] Calendar tab displays availability across 4 providers
- [ ] Test lead requests slot → AI books on real Google Calendar → confirmation DM → reminders queued
- [ ] Reschedule flow works end-to-end
- [ ] Google login (QD-001) completes
- [ ] Tags appear correctly in Leads view, scoped per-account
- [ ] All 6 quota-error bugs show clean error strings (verified via key-depletion test)
- [ ] No raw API JSON visible anywhere in UI
- [ ] Recorded production demo; client signs off; M2 invoice ($1,700)

---

## Risks & Open Questions (to Resolve Before Day 1)

1. **Google Cloud project ownership.** Client should create + own it. We need credentials by start of Day 6 at the latest. If client wants us to create it under our account, the OAuth consent screen will show our app name — flag for branding.

2. **Quota wrapper scope creep.** We identified 17 SDK call sites (7 OpenAI + 14 Anthropic, some files overlap). Wrapping all may take longer than the proposal's stated "4 hours." Realistic: 6–8h for the shared module + applying to all sites + tests. Budget allocated in Day 9.

3. **`persona-harness` baseline.** If the suite is currently red (some tests failing pre-engagement), we need to agree which subset must be green for M1/M2 acceptance vs which were pre-broken. Capture baseline on Day 1.

4. **OAuth consent screen verification.** Google may require app verification if we list certain scopes or if the app is "External" production. For Phase 1 testing we can use unverified mode (consent screen shows "Google hasn't verified this app" warning) but client should be aware that production launch may require Google's verification process (1–4 weeks). Flag to Tega Day 6.

**Resolved decisions (confirmed by user during planning):**
- `aiActive` default → **ON** (with per-account override via `Account.defaultAiActive`)
- Calendly adapter → **Build in Phase 1** (full availability + booking via Calendly v2 API, ~3–4h on Days 8–9)

---

## File-Change Inventory (Estimated)

**New files (~6):**
- `src/lib/google-calendar.ts`
- `src/lib/ai-error-handler.ts`
- `src/app/api/auth/google-calendar/connect/route.ts`
- `src/app/api/auth/google-calendar/callback/route.ts`
- `src/app/dashboard/calendar/page.tsx`
- New Prisma migration(s) for `Account.defaultAiActive`, `AISuggestion.gateDecision`, `IntegrationCredential.provider` enum extension

**Modified files (~20):**
- `src/lib/calendar-adapter.ts` (add google branch + fix Calendly stub)
- `src/lib/manychat-handoff.ts` (aiActive default)
- `src/lib/voice-quality-gate.ts` (placeholder resolve+re-prompt+escalate)
- `src/lib/script-state-recovery.ts` (demote rollback)
- `src/lib/script-step-progression.ts` (force-advance)
- `src/lib/ai-prompts.ts` (stage R-rule)
- `src/lib/webhook-processor.ts` (QD-004 fix per spike)
- `src/app/api/cron/meta-health/route.ts` (retry + error-code classification)
- `src/app/api/auth/instagram/callback/route.ts` (QD-004b — IG-Login webhook auto-subscribe)
- All 17 OpenAI/Anthropic SDK call sites (apply wrapper)
- `src/app/api/leads/[id]/tags/route.ts` (QD-046)
- Conversation detail component (QD-060)
- Manual booking form (QD-014)
- `env.example.txt` (Google vars)
- `prisma/schema.prisma` (migrations)

---

**End of plan. This document is the source of truth — update checkboxes inline as work progresses.**
