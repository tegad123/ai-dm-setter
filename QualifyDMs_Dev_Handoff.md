# QualifyDMs — Developer Handoff

A technical implementation guide for the engineer (or AI) about to start coding the $7,000 / 5-week QualifyDMs engagement. Read this *after* skimming the reference files listed in §1.

> **This is the build plan, not the business plan.** Pricing negotiation, client comms, and Upwork context live elsewhere. This document is about *what to build, in what order, with what approach, against which files.*

---

## 1. Folder Contents — Read These First

This document expects to live in a folder alongside these reference files (provided by the client and the prior analysis chat):

| File | Purpose | How to use it |
|---|---|---|
| `HANDOFF.md` (or `handoff-ai-not-delivering-2026-05-06.md`) | The client's original architectural handoff describing the platform | Read fully. Source of truth for *intended* architecture. Some drift exists vs the actual code — when in doubt, trust the code. |
| `QualifyDMs_SOW_v2.pdf` | The 9-feature Statement of Work | Read fully. F1–F9 are the feature inventory. Phase 1 covers parts of F2 + F5; Phase 2 covers F1, F3, F4, F6, F7, F8, F9. |
| `GMT20260516-151135 Recording.txt` | Transcript of the discovery call with the client | Read once. Source of the launch criterion + the "AI looping / placeholder leak / gates pausing" narrative that drives the AI reliability work. |
| `QualifyDms QA - Bug Tracking Sheet.csv` | 61-bug QA spreadsheet (QD-001 → QD-061) | Reference. Bug-ID mapping below tells you which 10 are Phase 1, which ~30 are Phase 2, which are deferred. |
| `QualifyDMs_Proposal_Shazim.md` / `.pdf` | The proposal sent to the client | Reference for scope language. Pricing is stale ($8.5K → renegotiated to $7K); scope/approach/file references are accurate. |
| **`QualifyDMs_Dev_Handoff.md`** (this file) | The build plan | What you're reading. |

**Codebase location:**
```
/Users/apple/Orbiqon/Development/ai-dm-setter/
```
Git: `main` is the trunk. Working out of git worktrees under `.claude/worktrees/`.

---

## 2. The Single Launch Criterion

From the client's own words on the discovery call:

> *"The AI needs to close a lead end to end without interruption."*

Operationalized as the Phase 1 acceptance test:

> A new lead sends a DM to a connected Instagram account → AI auto-replies → AI progresses the lead through the full qualification script without operator intervention → AI books a call on the operator's connected calendar → lead receives a confirmation DM. **All without a human touching the conversation.**

Every Phase 1 trade-off is judged against this. If a task doesn't move this needle, it's Phase 2 or deferred.

---

## 3. Tech Stack (Locked — Do Not Change)

| Layer | Tech | Notes |
|---|---|---|
| Frontend | Next.js 16 (App Router), React 19, TypeScript strict | |
| UI | shadcn/ui, Radix, Tailwind, react-hook-form, zod, recharts | Patterns established in `src/features/` |
| Backend | Next.js API routes | Lives under `src/app/api/` |
| Cron | Vercel cron (11 jobs already wired) | See `vercel.json` |
| DB | PostgreSQL (Supabase) | ~80 Prisma models, ~70 migrations |
| ORM | Prisma 6 | Migrations via `bun db:migrate-safe` |
| Auth | Clerk | Google social provider currently broken — see QD-001 |
| AI | Dual provider: OpenAI `gpt-5.4-mini` + Anthropic Claude | Per-account API keys encrypted via `IntegrationCredential` |
| Delivery | ManyChat (primary outbound), Instagram Graph API, Facebook Messenger | |
| Voice | ElevenLabs | Library + slot binding + trigger engine all built |
| Observability | Sentry | |
| Package manager | bun | `bun.lock` is authoritative |
| Deploy | Vercel | |

**Hard rules:**
- No stack migration. No architectural rewrites. Additive changes only.
- All new Prisma migrations are append-only. Use the existing `bun db:migrate-safe` wrapper (drift-detection around `prisma migrate deploy`).
- Multi-tenant invariant: every query scopes by `accountId`. Conversation reads also scope by `personaId`. RLS exists (`20260405120100_enable_rls_prisma_migrations`) — treat as defense-in-depth, not the primary guard.

---

## 4. Codebase Map — What Already Exists

This is the single most important section. Half the work has already been done; the trap is rebuilding instead of finishing. Below is the inventory of what's live, with file paths.

### 4.1 AI engine

| File | What it does | State |
|---|---|---|
| `src/lib/ai-engine.ts` | Top-level `generateReply()` — provider routing, suggestion generation, multi-bubble extractor | Built; needs placeholder-leak hardening |
| `src/lib/ai-prompts.ts` | `buildDynamicSystemPrompt()` — master + per-account prompt merge. R-rules: `R_OBJECTION_PUSH`, `R9` (stage-interruption resume), `R37` (pause-and-probe), `HAS_MENTOR`, `NOT_READY` counter-pitch | Built; stage-output contract needs tightening |
| `src/lib/ai-dedup.ts` | Suggestion deduplication | Built |
| `src/lib/active-persona.ts` | Per-account active persona resolution | Built |

### 4.2 Script / stage progression

| File | What it does | State |
|---|---|---|
| `src/lib/script-step-progression.ts` | Advances `Lead.stage` based on AI output | Built; **looping cause** |
| `src/lib/lead-script-tracker.ts` | Tracks which step the lead is on | Built |
| `src/lib/stage-progression.ts` | Helper for stage transitions | Built |
| `src/lib/script-state-recovery.ts` | Rolls back to prior step on mismatch | Built; **over-eager recovery is the loop cause** |
| `src/lib/script-variable-resolver.ts` | Resolves `{{name}}` / `{{day_and_time}}` etc. | Built; called too late in the gate path |

### 4.3 Quality gates / escalation

| File | What it does | State |
|---|---|---|
| `src/lib/voice-quality-gate.ts` | Placeholder leak detection + confidence-score gate | Built; **currently silent-blocks instead of resolving or escalating** |
| `src/lib/quality-gate-escalation.ts` | Escalation routing | Built |

### 4.4 Inbound / outbound delivery

| File | What it does | State |
|---|---|---|
| `src/lib/webhook-processor.ts` | Inbound IG/FB DM orchestration | Built; **QD-004 root-cause candidate** |
| `src/lib/instagram.ts` | IG Graph API client | Built |
| `src/lib/facebook.ts` | FB Messenger client | Built |
| `src/lib/manychat.ts` | ManyChat client | Built |
| `src/lib/manychat-handoff.ts` | ManyChat → AI takeover handoff loop | Built |
| `src/lib/manychat-message.ts` | Outbound message via ManyChat | Built |
| `src/lib/manychat-complete.ts` | Handoff completion | Built |
| `src/lib/manychat-resolve-ig-id.ts` | IG ID resolution | Built |
| `src/lib/leadconnector-webhook.ts` | LeadConnector webhook handler | Built |

### 4.5 Calendar / booking

| File | What it does | State |
|---|---|---|
| `src/lib/calendar-adapter.ts` | Provider router: Calendly, Cal.com, LeadConnector branches | Built — **Google Calendar MISSING** (Phase 1 work) |
| `src/lib/booking-info-extractor.ts` | Extracts time/date/name/email from DM | Built |
| `src/lib/booking-predictor.ts` | Booking-intent classifier | Built |
| `src/lib/call-confirmation-sequence.ts` | Post-booking confirmation flow | Built |
| `src/lib/call-reminders.ts` | Reminder scheduling | Built |

### 4.6 Follow-up / cadence

| File | What it does | State |
|---|---|---|
| `src/lib/follow-up-sequence.ts` | **Hardcoded 12h cascade**, max-3-attempts cap, soft-exit, lead-reply suppression | Built; Phase 2 makes per-operator configurable (F4) |
| `src/lib/keepalive-generator.ts` | Keep-alive messages | Built |

### 4.7 Persistence model (Prisma)

`prisma/schema.prisma` has ~80 models. The launch-critical ones:

- `Account` — tenant
- `AIPersona` — per-account persona (with objection-handling JSON field)
- `Lead` — qualification target (has `stage` field — central to the loop bug)
- `Conversation` — DM thread (`aiEnabled` flag — central to QD-059/060)
- `Message` — individual DM
- `AISuggestion` — generated reply (with `wasSelected`, `wasEdited`, gate decision fields — leverage these for the diagnostic trace)
- `ScheduledMessage` — queued outbound (drives reminders + delays)
- `IntegrationCredential` — encrypted API keys per account per provider
- `CalendarConnection` — provider connection (add Google branch in §6.4)
- `Booking` — call booking record

### 4.8 Cron jobs (11 already wired in `vercel.json`)

- `process-scheduled-replies` (the AI auto-reply tick — currently every 1 min for debounce)
- `process-follow-ups` (the 12h cascade)
- `recover-stale-bubbles`
- `silent-stop-recovery`
- `meta-health` (the source of QD-005 false positives)
- `window-keepalive` (IG 24h window keep-alive)
- ...plus 5 more — read `vercel.json` to be exhaustive

### 4.9 Tests

| Path | Purpose |
|---|---|
| `tests/persona-harness/runner.ts` | **AI quality regression suite — must stay green**. Highest-signal bar. |
| `tests/` (other) | Playwright e2e + integration smokes |

### 4.10 Audit

| Path | Purpose |
|---|---|
| `audit/2026-05-03-multi-tenant-leak-audit.md` | Multi-tenant leak audit. Phase 1 of the audit is done; **Phases 2–6 have 5 CRITICAL findings**. Explicitly out-of-scope for this engagement, but read for context — your new code must not add to the list. |

### 4.11 Docs to skim

```
docs/ARCHITECTURE_RESPONSE_PIPELINE.md
docs/ROADMAP.md
docs/handoff-ai-not-delivering-2026-05-06.md
docs/diagnostic-numeric-ig-id-bug.md
docs/manychat-complete-webhook.md
docs/manychat-message-webhook.md
docs/response-delay-fix-plan.md
docs/nav-rbac.md
docs/themes.md
docs/admin-dashboard-phase-1-plan.md
docs/admin-dashboard-phase-2-plan.md
docs/clerk_setup.md
```

`ARCHITECTURE_RESPONSE_PIPELINE.md` and `handoff-ai-not-delivering-2026-05-06.md` are the highest-yield for the Phase 1 AI reliability work.

---

## 5. The 4-Milestone Build Plan

**Engagement: $7,000 USD / 5 weeks. 4 milestones. No upfront. Termination either-side with 7 days notice; client pays accepted milestones + WIP at $45/hr.**

| # | Milestone | Trigger | Timing | Amount |
|---|---|---|---|---|
| M1 | Phase 1 Mid — Stabilization | Inbound DMs reliably hit dashboard; AI auto-responds end-to-end; gate-pause + loop fixed; recorded demo | End Wk 1 | **$1,500** |
| M2 | Phase 1 Acceptance — Launch | Google Calendar live; autonomous booking; confirmation DMs; all 10 Phase-1 bugs closed; production E2E demo | End Wk 2 | **$1,700** |
| M3 | Phase 2 Mid — Feature Wave 1 | F1 + F3 + F8 + ~15 Phase-2 bugs | End Wk 4 | **$1,800** |
| M4 | Phase 2 Acceptance — Final | F4 + F6 + F7 + F9 + remaining ~15 bugs | End Wk 5 | **$2,000** |
| | **Total** | | **5 weeks** | **$7,000** |

Buffer: 6 weeks acceptable, 8 weeks at the outer edge. Don't volunteer slip but it's there if needed.

---

## 6. Phase 1 — In Depth (M1 + M2)

Phase 1 is split into **4 work streams**. M1 = Streams A + B (the AI loop has to be sound first). M2 = Streams C + D (calendar + hardening on top of a working AI).

### 6.1 Stream A — Inbound Loop & AI Auto-Response

**Why first:** If inbound DMs aren't landing and the AI isn't auto-firing, nothing else matters.

**Bugs covered:** QD-004, QD-005, QD-059, QD-060

#### 6.1.1 QD-004 (Critical) — Inbound IG DMs not reaching dashboard

**Approach:** **Day-1 diagnostic spike, 4-hour budget.** Don't commit to a fix path until you've reproduced and isolated.

Root cause candidates (in priority order):
1. **Meta webhook signature mismatch** — check `webhook-processor.ts` for the `x-hub-signature-256` validation. Verify the `META_APP_SECRET` env var matches the app the webhook is registered against.
2. **`INSTAGRAM_ACCOUNT_ID` mis-routing** — the webhook payload's recipient ID may not be resolving to the right `Account` / `AIPersona`. Check `webhook-processor.ts::resolveRecipient()` or equivalent.
3. **IGAA-vs-EAA token routing mismatch** — IG Graph API tokens come in two flavors (Instagram Account Access tokens vs Extended App-scoped Access tokens). One code path may be expecting the wrong type. See `docs/diagnostic-numeric-ig-id-bug.md` and `docs/handoff-ai-not-delivering-2026-05-06.md` for prior incident context.
4. **Silent throw in the recipient → Account/AIPersona resolution** — uncaught promise rejection swallowed by the webhook handler. Add Sentry breadcrumbs and inspect.

**Reproduction strategy:**
- Capture a real webhook payload from Meta (sandbox IG account → real production endpoint, body logged via Sentry).
- Replay locally against `webhook-processor.ts` via a test harness.
- Step through resolution; identify where the chain breaks.

**Escalation rule:** If after 4 hours the cause points to Meta infrastructure (outage, app-review revocation, account permissions) rather than code, **escalate to client immediately with logs**. Don't burn the timeline on something outside our control.

#### 6.1.2 QD-005 (Critical) — Meta credential health false positives

**Symptom:** `meta-health` cron reports "credential invalidated" when the connection is actually fine.

**Root cause:** Transient Meta `OAuthException ((#2) Service temporarily unavailable)` is being treated as a permanent revocation.

**Fix:**
- Add retry-with-backoff (3 attempts, exponential 1s/2s/4s) before flagging unhealthy.
- Suppress the operator notification when revalidation passes within 60 seconds.
- Differentiate error codes: code `2` (transient) vs code `190` (token revoked) — only the latter should trigger the unhealthy flag.

**Test:** Inject a fake transient error in dev; confirm no notification fires; inject a real revocation; confirm notification fires.

#### 6.1.3 QD-059 (High) — AI not auto-responding

**Symptom:** Operator toggles AI ON in the conversation, AI auto-response works for a session, then silently stops. Refresh page → toggle shows OFF.

**Root cause:** The conversation `aiEnabled` flag is being silently reset to false on page refresh. Client-side state (React) is diverging from server state. When the cron `process-scheduled-replies` checks `Conversation.aiEnabled`, it correctly sees `false` and skips. Operator perceives it as "AI broken."

**Fix:**
- Server-side `Conversation.aiEnabled` is the single source of truth.
- Remove any client-side `useState` that defaults to `false` on mount.
- All toggle changes write through `PATCH /api/conversations/[id]` with optimistic UI revert on failure.
- On mount, hydrate from server (`useSWR` or React Query — match existing pattern in the file).

**Test:** Toggle ON, refresh, confirm still ON in DB and UI.

#### 6.1.4 QD-060 (Medium) — AI toggle reset

**Same root cause as QD-059.** Fixing QD-059 closes QD-060.

#### 6.1.5 Stream A Acceptance

- Send DM from external IG account → appears in dashboard within 5 seconds.
- AI auto-replies within the configured debounce window (currently 1 min via `process-scheduled-replies`).
- AI toggle stays ON across page refreshes.
- No false health-check notifications fire.

---

### 6.2 Stream B — AI End-to-End Reliability

**Why second:** Inbound works, but the AI itself pauses mid-conversation due to over-strict gates and loops on stage advancement. This is **not** in the bug sheet — it surfaced in the discovery call.

#### 6.2.1 Placeholder-leak fix

**Symptom:** AI generates output like `"Hi {{name}}, see you {{day_and_time}}"` — the `voice-quality-gate.ts` correctly catches the unresolved Mustache placeholder, but currently just blocks the send and leaves the AI silent. Operator sees "AI stopped responding."

**Files:**
- `src/lib/voice-quality-gate.ts` — currently silent-blocks
- `src/lib/ai-engine.ts` — the multi-bubble extractor
- `src/lib/script-variable-resolver.ts` — has the actual `{{*}}` → value mapping

**Fix:** Convert silent-block path into either:
- **(a) Successful resolve-and-send:** When the gate detects `{{*}}`, call `script-variable-resolver.resolve(output, lead, persona)` first. If all placeholders resolve, send the resolved string. This should handle the common case.
- **(b) Re-prompt with tightened system message:** If resolution fails (the placeholder has no value in context), re-prompt the model once with an explicit instruction not to use placeholder syntax. Use the existing prompt-tightening pattern in `ai-prompts.ts`.
- **(c) Structured escalation:** If (a) and (b) both fail, emit a `QualityGateEscalation` record (existing `quality-gate-escalation.ts`) AND send a soft handoff message to the operator. Never silent-fail.

**Test:** Force a `{{name}}` leak (mock the LLM); confirm one of (a)/(b)/(c) fires; confirm conversation does not go silent.

#### 6.2.2 Loop / repetition fix

**Symptom:** AI asks the same question turn after turn instead of advancing the lead through the script.

**Root cause:** The LLM's `current_stage` output (in the structured JSON response) doesn't match what's stored in `Lead.stage`. `script-state-recovery.ts` is over-eagerly rolling back to the prior step on each turn because it interprets the mismatch as "the AI went off-script."

**Files:**
- `src/lib/script-state-recovery.ts` — over-eager recovery (the bug)
- `src/lib/script-step-progression.ts` — should be advancing
- `src/lib/lead-script-tracker.ts` — tracks position
- `src/lib/ai-prompts.ts` — R-rules govern stage output contract

**Fix:**
1. **Tighten the stage-output contract** in `ai-prompts.ts`. The R-rules already partially cover this — add an explicit rule that `current_stage` MUST equal one of the canonical stage IDs from the script, and that the model must echo back the stage it's *advancing to* (not the one it just left).
2. **Add a `Lead.sameStageTurnCount` counter** (new Prisma field, additive migration). Increment on each turn that ends in the same stage; reset on advance.
3. **Force-advance after 2 consecutive same-step generations.** When `sameStageTurnCount >= 2`, override `script-state-recovery.ts` and advance to the next stage regardless of the LLM's `current_stage` output.
4. **Demote the recovery logic** from "always rolls back on mismatch" to "rolls back only if confidence is high AND mismatch is large (e.g., skipping >2 stages)."

**Test:** `tests/persona-harness/runner.ts` is your bar. Run before any change; capture baseline. Every Phase 1 change to the AI pipeline must keep this green. Add a new test case: an 8+ turn conversation that reaches the booking stage without looping or going silent.

#### 6.2.3 Diagnostic instrumentation

**Why:** Client must be able to debug post-launch without you.

**Fix:** Add per-conversation trace logging. For each AI turn, record on `AISuggestion`:
- `wasSelected` (already exists)
- `wasEdited` (already exists)
- `gateDecision` (NEW field — enum: `passed`, `placeholder_resolved`, `re_prompted`, `escalated`, `silent_blocked_legacy`)
- `stageInput` / `stageOutput` (NEW string fields — for loop debugging)

Surface in the conversation detail view (`src/app/.../conversations/[id]`) under a "Debug" collapse panel visible only to admins.

#### 6.2.4 Stream B Acceptance

- An 8+ turn test conversation reaches the booking stage without going silent, without repeating the same question more than once, without leaking placeholders.
- `tests/persona-harness/runner.ts` passes.
- Debug panel shows per-turn gate decisions for admin operators.

---

### 6.3 Stream C — Calendar Integration & Self-Serve Booking

**Bugs covered:** QD-014. Plus the Google Calendar adapter (new build).

#### 6.3.1 Google Calendar adapter (NEW)

**Why now:** Calendly/Cal.com/LeadConnector exist; Google was missing. Client explicitly wants Google.

**OAuth caveat:** Google requires full OAuth — you cannot use API keys for Calendar. Client must provision a Google Cloud project and provide `client_id` + `client_secret` in Week 1. This also unblocks QD-001 (Google login) — same credentials.

**Files to create / modify:**
- `src/lib/calendar-adapter.ts` — add `google` branch following existing `calendly` / `calcom` / `leadconnector` patterns
- `src/lib/google-calendar.ts` — new file, Google Calendar v3 client
- `src/app/api/auth/google-calendar/callback/route.ts` — new OAuth callback handler
- `src/app/api/integrations/google-calendar/connect/route.ts` — new connect endpoint (initiates OAuth)
- Prisma: extend `CalendarConnection.provider` enum to include `google`

**Implement to existing interface:**
```ts
// calendar-adapter.ts already defines these — match them exactly
getAvailability(connection, dateRange): Promise<AvailabilityResult>
bookSlot(connection, slot, attendee): Promise<BookingResult>
```

**API endpoints used:**
- Google Calendar v3 Events API → `bookSlot()`
- FreeBusy API → `getAvailability()`

**Token refresh:** Google's access tokens expire in 1h. Store the refresh token (encrypted via `IntegrationCredential`). Add a refresh helper that's called by both `getAvailability` and `bookSlot` if the access token is within 5 min of expiry.

**Test:** Connect a real Google Calendar in dev; query availability; book a slot; confirm event appears in the operator's Google Calendar within 60s.

#### 6.3.2 Verify existing 3 providers end-to-end

Calendly, Cal.com, LeadConnector adapters exist but have "unfinished integrations" per the prior handoff. Walk each:

- Calendly: confirm `bookSlot()` actually creates an event, not just a placeholder.
- Cal.com: same.
- LeadConnector: same. Also verify `leadconnector-webhook.ts` receives booking confirmations.

Close any gaps so all four providers are functionally identical from the AI's perspective.

#### 6.3.3 Calendar tab in dashboard

**New route:** `/dashboard/calendar` (or wherever `src/features/dashboard/` lives — match existing convention).

**Content:**
- Connected calendar's upcoming slots (next 14 days, busy/free)
- Which leads have booked which slots (join `Booking` → `Lead`)
- Connect-calendar CTA if no connection exists

**UI:** shadcn/ui patterns from `src/features/`. Don't introduce a new design system.

#### 6.3.4 Autonomous AI booking

**Current state:** `booking-info-extractor.ts` and `booking-predictor.ts` classify booking intent but don't actually call `calendar-adapter.bookSlot()`. Operator currently has to click a button.

**Fix:**
- When `booking-predictor` confirms intent + extractor has all fields (time, date, name, email), call `calendar-adapter.bookSlot()` directly (no operator review).
- On success, emit confirmation DM via existing ManyChat / IG send path (template lives in `call-confirmation-sequence.ts`).
- Schedule reminders via existing `ScheduledMessage` rows: day-before, morning-of, pre-call (15 min). `call-reminders.ts` already has the patterns.

**Test:** End-to-end conversation that confirms a slot → calendar event created → confirmation DM sent → 3 `ScheduledMessage` rows queued.

#### 6.3.5 Basic reschedule

When the lead asks to reschedule:
- AI extracts the reschedule intent
- AI surfaces 3 next available slots from the calendar (`getAvailability()`)
- Lead confirms one
- Update existing `Booking` row; call `calendar-adapter.updateSlot()` (add this method if missing — mirror `bookSlot()`)

**Cancellation flow is Phase 2.** Don't build it in Stream C.

#### 6.3.6 QD-014 — Date validation

Reject call dates more than 6 months in the future. Inline form validation in the booking UI. No schema changes.

#### 6.3.7 Stream C Acceptance

- Operator connects Google Calendar via OAuth from Settings → Integrations.
- Calendar tab displays availability across all 4 providers.
- A test lead requests a call slot; AI books it on the real Google Calendar; confirmation DM sent with meeting link; calendar event visible in operator's Google Calendar within 60s.
- Reschedule with the lead works end-to-end.

---

### 6.4 Stream D — Launch Hardening

**Bugs covered:** QD-001, QD-046, plus the quota-error UX wrapper covering QD-003, QD-024, QD-043, QD-044, QD-045, QD-048.

#### 6.4.1 QD-001 — Google OAuth login

**Symptom:** "Continue with Google" returns 400 Missing `client_id`.

**Fix:** Wire `GOOGLE_OAUTH_CLIENT_ID` env var through to Clerk's social provider config. Same Google Cloud project as the Calendar work in §6.3.1 — 2-for-1. ~2 hours of work.

**Test:** Click "Continue with Google" → Google consent screen → redirect back → Clerk session created.

#### 6.4.2 QD-046 — Tags not appearing in Leads

**Symptom:** Tag creation in Settings appears to work, but the `Lead.tags` join doesn't return the created records.

**Root cause:** Multi-tenant data scoping issue. The tag create likely persists with the right `accountId`, but the tag *read* (from the Leads view) is either querying with the wrong `accountId` or joining on a stale value.

**Fix:**
- Verify all tag queries scope by `accountId` per the multi-tenant invariant.
- Fix the read path.
- **Audit the surrounding tag/lead join code for the same class of bug** — this is the kind of thing that could be silently affecting other related queries (leads → conversations, leads → bookings).

**Test:** Create tag in Settings; assign to a lead; confirm appears in Leads view; confirm does NOT appear in another account's Leads view.

#### 6.4.3 Quota-error UX wrapper

**Symptom:** Six bugs (QD-003, QD-024, QD-043, QD-044, QD-045, QD-048) all surface raw OpenAI / Anthropic 429 + credit-balance JSON directly to operators in the UI. The quota itself is the client's billing setup (not our bug) — but the raw `{"type":"error",...}` JSON appearing in the UI absolutely is.

**Files to wrap:**
- `src/lib/ai-engine.ts`
- `src/lib/training-data-analyzer.ts`
- `src/lib/script-parser.ts`
- `src/lib/voice-note-library.ts` (transcription)
- Any other file that directly calls OpenAI or Anthropic SDKs (grep for `openai` and `anthropic` imports)

**Fix:** One uniform error handler. Catches:
- HTTP 429 (rate limit)
- Anthropic `credit_balance_too_low`
- OpenAI `insufficient_quota`

Returns a clean operator-facing message: *"AI service temporarily unavailable. Please contact support if this persists."* Never leaks JSON.

One ~4-hour pass closes all six bugs.

#### 6.4.4 E2E launch demo on production

Manual run of the full Phase 1 acceptance flow on production with a real IG account and a real Google Calendar. Record video. Share with client as part of M2 sign-off.

#### 6.4.5 Stream D Acceptance

- No raw API JSON visible anywhere in the UI.
- Google login works.
- Tags created in Settings appear correctly in Leads.
- Complete launch flow recorded and demonstrated end-to-end on production.

---

### 6.5 Phase 1 Bug Coverage Map (10 bugs in Phase 1)

| Bug ID | Severity | Stream | Reason |
|---|---|---|---|
| QD-001 | High | D | Google OAuth login — 2-for-1 with Calendar OAuth |
| QD-003 | Critical | D | Covered by quota-error wrapper |
| QD-004 | Critical | A | Direct blocker (client's explicit ask) |
| QD-005 | Critical | A | Direct blocker (client's explicit ask) |
| QD-014 | Medium | C | Booking flow data integrity |
| QD-024 | High | D | Covered by quota-error wrapper |
| QD-043 | High | D | Covered by quota-error wrapper |
| QD-044 | High | D | Covered by quota-error wrapper |
| QD-045 | High | D | Covered by quota-error wrapper |
| QD-046 | Critical | D | Multi-tenant scoping — could affect leads / conversations |
| QD-048 | High | D | Covered by quota-error wrapper |
| QD-059 | High | A | Direct blocker (client's explicit ask) |
| QD-060 | Medium | A | Same root cause as QD-059 |
| **AI gate-pause + loop work** | n/a | B | Required for "end-to-end without interruption" per the call |

### 6.6 Phase 1 Day-by-Day (Suggested)

| Day | Focus | Deliverable |
|---|---|---|
| 1 | Repo onboarding, env setup, QD-004 diagnostic spike (4h budget) | Diagnostic findings + go/no-go on QD-004 fix path |
| 2 | QD-004 fix + QD-005 (Meta credential health) | Inbound IG DMs landing reliably |
| 3 | QD-059 + QD-060 (AI toggle persistence + auto-response) | AI auto-responds end-to-end on fresh conversation |
| 4 | AI placeholder-leak fix in voice-quality-gate + ai-engine | No `{{*}}` leaks; gate no longer leaves AI silent |
| 5 | Script step progression + loop fix; persona-harness pass | Test conversation reaches booking stage without looping |
| **— M1 ($1,500) — End of Week 1 —** | | |
| 6 | Google Calendar OAuth + adapter | Operator connects Google Calendar from Settings |
| 7 | Calendar tab UI; verify Calendly / Cal.com / LeadConnector | Calendar tab shows availability across providers |
| 8 | Autonomous booking + confirmation DM | AI books a real slot end-to-end |
| 9 | Reschedule flow; QD-014, QD-046, quota wrapper, QD-001 Google login | All Phase-1 bugs closed |
| 10 | E2E acceptance run on production; recorded demo; sign-off | Phase 1 ships |
| **— M2 ($1,700) — End of Week 2 —** | | |

---

## 7. Phase 2 — In Depth (M3 + M4)

**Optional in the contract sense** — kicks off only after the client signs off on Phase 1 and onboards first paying clients. Practically, plan to roll straight in.

### 7.1 M3 — Feature Wave 1 (End Wk 4, $1,800)

Three features + ~15 bugs.

#### 7.1.1 F1 — Conversation Takeover

**Problem:** An operator already had a DM thread with a lead before adopting QualifyDMs. They want to paste the prior thread, let the platform parse where in the script the lead is, and have the AI take over mid-thread.

**Build:**
- Operator-facing UI to paste a prior IG DM thread for an existing `Lead`. Plain textarea + parser.
- Parser extracts stage state: walks the thread, calls the existing script-step-progression logic in "replay mode," sets `Lead.stage` to whatever step the conversation has reached.
- AI resumes mid-thread without restart (no "Hi, I'm Tega's AI assistant" intro — pick up where the operator left off).

**Files:**
- New UI under `src/features/leads/` (match existing patterns)
- New parser in `src/lib/conversation-takeover-parser.ts`
- Reuse `script-step-progression.ts` in replay mode

#### 7.1.2 F3 — Voice Notes Polish

Fixes QD-025 (duration estimation), QD-026 (play/pause toggle), QD-027 (dropdown state), QD-028 / 029 / 030 / 031 (validation on Suggested Moments + Min/Max delays).

Mostly UI work in the Voice Note Library page.

#### 7.1.3 F8 — Analytics Number Reconciliation

Fixes QD-032 through QD-041. Symptom: "Analytics shows X but Pipeline shows Y" for the same metric (lead count, booking count, etc.).

**Root cause:** Inconsistent stage filtering across queries. Different queries include / exclude different stages of the lead lifecycle.

**Fix:** Define a single canonical "lead state set" in one helper module (e.g., `src/lib/lead-state-sets.ts`); refactor all analytics + pipeline queries to use it. Then chase down remaining discrepancies.

#### 7.1.4 ~15 Phase-2 bugs (M3 slice)

Functional blockers from the QA sheet — pick from:
QD-009, QD-010, QD-015, QD-016, QD-017, QD-018, QD-022, QD-023, QD-053, QD-054

Plus UI polish triage (QD-002, QD-006, QD-007, QD-011, QD-012, QD-013) as time permits.

---

### 7.2 M4 — Final (End Wk 5, $2,000)

Four features + remaining ~15 bugs + production sign-off.

#### 7.2.1 F4 — Follow-Up Picker

Replace the hardcoded 12h cascade (`follow-up-sequence.ts`) with a per-operator silence-window picker in Settings.

**Build:**
- New field on `Account` (or new `FollowUpConfig` model) — silence window in hours, max attempts cap, escalation pattern.
- Settings UI to configure per operator.
- Inject prior-conversation context into follow-up message bodies (the current cascade is templated; add a "summary of last 3 exchanges" prefix generated via the existing AI engine).
- Dashboard view of pending follow-ups (which leads, when next message fires).

#### 7.2.2 F6 — Objection Handling Library

**Build:**
- Top-10 default objection responses, seeded.
- Per-account custom responses managed in the Persona Editor (the `objectionHandling` JSON field on `AIPersona` already exists — surface it in UI).
- Structured classifier on top of the existing prompt-based detection. Build a thin `objection-classifier.ts` that runs alongside the existing R-rules, returns a typed objection class (price / time / mentor / trust / other), and the prompt-merge in `ai-prompts.ts` injects the right response.

#### 7.2.3 F7 — Setter Goal

**Build:**
- New `Account.setterGoal` field (enum: `book-call` | `collect-email` | `route-to-funnel`). Additive Prisma migration.
- Wired into prompt assembly (`ai-prompts.ts::buildDynamicSystemPrompt()`) — changes the AI's terminal CTA.
- Wired into CTA logic in `script-step-progression.ts` (the "terminal stage" varies by goal).
- Settings UI to select the goal per account.

#### 7.2.4 F9 — Lead Memory

**Build:**
- New `LeadMemory` Prisma model (additive migration). Fields: `leadId`, `accountId`, `key`, `value` (JSON), `source` (manual / extracted), `createdAt`, `updatedAt`.
- Retrieval at conversation start: load all memory rows for the lead, inject into the system prompt under a "What we know about this lead" section.
- Post-conversation update: after each AI turn, run a lightweight extraction pass to update memory (e.g., if the lead mentioned their business, store it).
- Operator-facing UI: a panel on the conversation detail view to view / edit / delete memory entries.

#### 7.2.5 Remaining ~15 bugs + UI polish

Whatever's left from the QA sheet that survived M3 triage. Plus the QD-002, QD-006, QD-007, QD-011, QD-012, QD-013, QD-019, QD-020, QD-021 polish work.

#### 7.2.6 Production sign-off

Final E2E run with all Phase 2 features live. Recorded demo. Client signs off.

---

## 8. Explicitly Out of Scope

| Item | Why out | Notes |
|---|---|---|
| Multi-tenant leak audit Phases 2–6 | Separate workstream | `audit/2026-05-03-multi-tenant-leak-audit.md` — 5 CRITICAL findings. Flag for separate SOW. |
| Sprint 3 Parser Overhaul | In-progress structured `ScriptSlot` replacement | Separate effort. |
| Onboarding wizard | `Account.onboardingStep` is scaffolded; full UI build is separate | Flag for separate SOW. |
| `qualifydms.io` domain migration | Hardcoded refs in Meta webhook URLs, ManyChat URLs, OAuth callbacks | Separate ~6-8h pass. |
| OpenAI / Anthropic billing restoration | Client's billing | We wrap raw errors; quota itself is client's responsibility. |
| Stack / infrastructure migration | Stack is locked | n/a |
| Lead-facing (end-user) UI changes | Engagement is operator dashboard + backend only | n/a |

---

## 9. Conventions & Gotchas

1. **Multi-tenant invariant.** Every query scopes by `accountId`. Conversation reads also by `personaId`. RLS is defense-in-depth. New code must not violate this — read `audit/2026-05-03-multi-tenant-leak-audit.md` before writing any data-access code.

2. **Migrations are append-only.** Use `bun db:migrate-safe` (existing wrapper around `prisma migrate deploy` with drift detection). New models in Phase 2 (`LeadMemory`, possibly `FollowUpConfig`, optional `SetterGoal` table) must be additive — zero data migration risk on existing rows.

3. **Tests.** Run `tests/persona-harness/runner.ts` as your baseline before AI pipeline changes. Capture pass/fail. Every Phase 1 change to the AI pipeline must keep it green. Playwright e2e + integration smokes on each milestone.

4. **Google Calendar requires OAuth — not API keys.** This was a real point of confusion early on. Google's policy mandates OAuth for Calendar. Calendly / Cal.com / LeadConnector use API keys; only Google needs OAuth. The same Google Cloud project also fixes QD-001 (Google login) — get both `client_id` and `client_secret` from client in Week 1 and use them for both.

5. **Don't remove the AI quality gates.** They're correctly blocking low-confidence outputs. The work is to (a) make the AI succeed more often and (b) convert silent-blocks into either successful retries or explicit escalations. The gates themselves are the *right* design.

6. **Webhook signature validation.** Don't disable it to "make QD-004 work." If the signature doesn't match, the env var or app config is wrong — fix that, don't bypass.

7. **No upfront commits to a fix path before reproducing.** Especially for QD-004 — the diagnostic spike is budgeted at 4h for a reason.

8. **Daily end-of-day update during Phase 1.** Committed in the proposal. Keep it short: what landed, what's next, what's blocked. Don't over-engineer the format.

9. **Worktree workflow.** The project uses git worktrees (`.claude/worktrees/`). Honor it.

10. **bun, not npm.** All scripts run via `bun`. Package install: `bun install`. Migrations: `bun db:migrate-safe`. Tests: `bun test` (or whatever the project script is — check `package.json`).

---

## 10. Open Technical Questions (Resolve Before / During Day 1)

| Question | Where to find answer |
|---|---|
| Exact GitHub repo URL | Client (proposal cites `github.com/tegad123/ai-dm-setter` — verify) |
| `META_APP_SECRET` value in production | Client (Vercel env vars) |
| Whether the IG webhook is registered against the right Meta App ID | Meta App dashboard |
| Whether there are partially-built Google Calendar OAuth flows already in the repo | `grep -r "google" src/lib/calendar*` and `src/app/api/auth/` |
| Whether `bun db:migrate-safe` actually exists as a script | `package.json` scripts |
| Which page route currently houses the Calendar tab (if any scaffold exists) | `src/app/` and `src/features/` |
| Whether `IntegrationCredential` already has a generic encrypted-secret-storage pattern usable for Google refresh tokens | `prisma/schema.prisma` + `src/lib/credential-store.ts` |
| Current Sentry project name / DSN for the worktree env | Vercel env vars |

---

## 11. Day-1 Setup Checklist (Technical, Not Client-Side)

Before touching code:

- [ ] Clone repo. `git clone <repo-url>` → `cd ai-dm-setter`.
- [ ] `bun install`.
- [ ] Copy `env.example.txt` → `.env.local`, fill in:
  - Database URL (Supabase staging — get from client)
  - Clerk publishable + secret keys (client)
  - OpenAI + Anthropic API keys (client)
  - `META_APP_ID` + `META_APP_SECRET` (client)
  - `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` (Week 1, blocks Stream C and QD-001)
  - Sentry DSN (client)
- [ ] `bun db:migrate-safe` to apply migrations against staging DB.
- [ ] `bun dev` — confirm the app boots locally, hit `localhost:3000`, log in via Clerk, reach the dashboard.
- [ ] `bun test tests/persona-harness/runner.ts` — capture baseline (note pass / fail count).
- [ ] Read `audit/2026-05-03-multi-tenant-leak-audit.md` and `docs/handoff-ai-not-delivering-2026-05-06.md` end-to-end.
- [ ] Skim the 10 Phase-1 bug entries in the QA CSV — note any extra context not captured in this dev handoff.
- [ ] Start Day-1 QD-004 diagnostic spike.

---

## 12. The Single Most Important Thing

If you remember nothing else from this document:

> **Phase 1 is the entire game.** Every choice — what to fix, what to skip, what to defer — is judged against: *"Does this get a real lead from inbound DM to booked call without a human in the loop?"* If yes, ship it in Phase 1. If no, it's Phase 2 or out-of-scope.
>
> The platform is **mostly built**. The trap is rebuilding. Read the existing code (§4) before writing new code.

---

**End of dev handoff. Companion files in this folder: original `HANDOFF.md` from client, `QualifyDMs_SOW_v2.pdf`, the meeting transcript, the bug-tracking CSV, and the proposal artifacts. Read those for primary-source context; come back here for the build plan.**
