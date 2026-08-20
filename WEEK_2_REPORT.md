# Week 2 / Milestone 2 — Engagement Report

**Period:** 2026-05-22 → 2026-05-30
**Milestone:** M2 ($1,700) — Calendar + Hardening
**Branch:** `phase-1-implementation`
**Companion docs:** `FIX_LOG.md`, `PHASE_1_PLAN.md`, `PHASE_2_PLAN.md`, `ANALYTICS_AUDIT.md`

---

## Headline

Calendar layer end-to-end, autonomous booking live, four providers verified, the entire raw-JSON error class killed, the analytics inconsistency Tega flagged cleaned up across the board, and 8 SOW bugs from Phase 2 pulled forward and closed inside M2. **18 QA bugs closed this week.**

---

## What shipped

### Calendar — autonomous booking, four providers verified live
- **Google Calendar** ✅ — OAuth flow, FreeBusy availability, real event creation with auto-generated Google Meet link. Token auto-refresh.
- **LeadConnector (GoHighLevel)** ✅ — verified against Tega's Daetradez sub-account using a PIT token. Real contact + appointment created and cleaned up.
- **Cal.com** ✅ — migrated from the v1 API (which was decommissioned and returning HTTP 410) to v2. Verified with 153 real slots and a real booking + cancellation against the live key Tega provided.
- **Calendly** ✅ — fixed a real bug: the adapter was returning an empty string as the "booking link" because it looked for a field the connect flow never saved. Now mints a real single-use scheduling link via Calendly's `/scheduling_links` endpoint and returns it in link-mode (the lead self-books, the AI never fake-confirms).
- **"Active booking calendar" selector** added to Settings → Integrations so the operator picks which calendar the AI uses instead of relying on hidden precedence.

### Autonomous booking, guarded
The AI now books calls on its own at `BOOKING_CONFIRM`. The booking happens *before* the confirmation is sent, so a provider failure can never produce a phantom "you're locked in" message. On success: meet link appended, lead marked `BOOKED`, confirmation + reminder sequences scheduled. On failure: safe holding line, flagged for human review, never marked `BOOKED`. Plus all call-detail fields (timezone, source, confirmed flag) get persisted in the same write — addresses Tega's "AI should automatically save all call details" ask.

### Error handling — no more raw JSON anywhere
`src/lib/ai-error-handler.ts` classifies every OpenAI / Anthropic failure into a typed kind (quota / rate_limit / auth / overloaded / timeout). Operator-facing routes return a clean payload like *"Your AI provider account is out of credit. Add billing in Settings → Integrations, then try again."* instead of a raw provider error body. Applied across the test-message route, the persona editor (analyze / extract / script / section), training upload, voice-note processing, and the core ai-engine generate calls.

### Day 9 hardening
- **QD-014** — calls can no longer be scheduled more than 6 months out (server + client + native picker `max`).
- **QD-046** — the Leads tag picker was always empty. Root cause was a double-unwrap in the `useTags()` hook (the helper returned an array; the hook then read `.tags` off that array → always undefined). Fixed; account tags now show.

### F8 Analytics Reconciliation (pulled forward from Phase 2)
Tega bumped this from Week 3 into Week 2. Full audit lives in `ANALYTICS_AUDIT.md`. The short version:

- Every analytics route, the Conversations tab, the Leads page, and the Dashboard widgets now share a single source of truth (`src/lib/lead-state-sets.ts`) for what counts as "qualified," "booked," "showed up," and "active." Numbers reconcile across views.
- Cold-pitch policy is uniform now (excluded from every main-funnel aggregate; visible in the Leads list with the tag filter).
- "With Stage Data: 0" no longer appears on healthy accounts — the data-quality denominator is now AI-pipeline messages.
- "Cold Start Thresholds 0/50 0/30 0/20" no longer all return the same number — the helper's threshold parameter was silently being ignored. Now honored.
- "Conversation Funnel chart empty" — the chart now restricts to conversations that actually entered the SOP funnel and labels the excluded count ("showing N of M").
- A reconciliation test (`npm run test:analytics-reconciliation -- --seed`) seeds a known set of leads and asserts identical "qualified" counts across the Funnel and Conversations APIs. **The test caught a real bug during development** — `SHOWED` was missing from `ACTIVE_LEAD_STAGES` — which was fixed before the work was merged.

---

## Bugs closed this milestone (18 total)

### Closed by Day 6–9 work (8)
| ID | Title |
|---|---|
| QD-014 | Booking accepts year 2099 dates |
| QD-046 | Tags created in Settings don't appear in Leads |
| QD-003 | Raw API JSON visible when key depleted |
| QD-024 | Raw error on persona generation when out of quota |
| QD-043 | Raw error in training upload UI |
| QD-044 | Raw error in voice note processing |
| QD-045 | Raw error in test-message |
| QD-048 | Raw error in persona script edits |

### Closed by F8 Analytics pull-in (10)
| ID | Title |
|---|---|
| QD-032 (Critical) | Analytics Overview vs Pipeline mismatch |
| QD-033 | Overview vs Funnel mismatch |
| QD-034 | Overview vs Team Performance mismatch |
| QD-035 | Overview vs Lead Distribution mismatch |
| QD-036 | Overview Calls Booked inconsistent |
| QD-037 | Overview Show Rate inconsistent |
| QD-038 | Overview Close Rate inconsistent |
| QD-039 | "With Stage Data: 0" despite 22 conversations |
| QD-040 | Cold Start Thresholds show 0/50 0/30 0/20 |
| QD-041 | Conversation Funnel chart empty |

---

## Acceptance run (2026-05-30)

Layered acceptance: static layers first, then runtime against the live local pipeline.

### Static — all green
- `npx tsc --noEmit` — clean across the full repo.
- `npm run test:conversations` — **21/21 pass** (40 ms).
- `npm run test:analytics-reconciliation -- --seed` — **14/14 pass** (10 helper invariants + 4 seeded cross-view).
- `next build` — **compiled successfully** in 14.8 s.

### Runtime — calendar layer
- All 4 providers connected on the test account; `activeCalendarProvider = GOOGLE_CALENDAR`.
- Calendly link-mode regenerated a real single-use scheduling URL (verified earlier this week, link resolves HTTP 200).
- Cal.com v2 end-to-end: 153 real slots, real booking created + cancelled cleanly (verified this week).
- LeadConnector / GHL end-to-end: real contact + appointment created and deleted on Tega's Daetradez calendar (verified this week).

### Runtime — quota error wrapper
Verified the classifier with 4 representative provider error shapes:

| Synthetic error | Classified | HTTP | Operator message |
|---|---|---|---|
| OpenAI `insufficient_quota` (status 429) | `quota` | 402 | "Your AI provider account is out of credit…" |
| Anthropic "credit balance is too low" (status 400) | `quota` | 402 | same |
| Anthropic `rate_limit_error` (status 429) | `rate_limit` | 429 | "AI provider is rate-limiting requests right now…" |
| 401 "invalid x-api-key" | `auth` | 401 | "AI API key is missing or invalid…" |

### Runtime — inbound webhook → AI gate
Drove a real Facebook DM through the local pipeline (`scripts/drive-fb-turn.ts`):
- Inbound webhook signature validated, message persisted, Lead row created at `NEW_LEAD`.
- AI did **not** auto-reply — and that's the **correct** behavior under Tega's QD-059 rule: a new lead with Away Mode off must NOT have AI auto-respond. This is the gate working as designed.
- After flipping `aiActive=true, autoSendOverride=true` on the conversation, the inbound path still showed the same behavior in this local-dev session. The conversation-fixture suite (which exercises the same AI generation code path through 21 distinct scenarios) is green, so the AI generation logic itself is verified — what's not yet repro'd locally is the webhook→AI bridge with the gate forced open. Worth a second look in the Day 10 production E2E.

### Runtime findings (resolved during acceptance)

**Finding 1 — Google "invalid_grant" / Disconnect 400 (RESOLVED, commit `911acbd`).** Acceptance surfaced two related Google reliability gaps:

- **Disconnect 400.** The Settings → Integrations "Disconnect" button for Google Calendar was returning HTTP 400. Root cause: `GOOGLE_CALENDAR` was missing from the dynamic provider route's `VALID_PROVIDERS` (the route I'd updated to add `CALCOM` earlier this week). Fixed.

- **`invalid_grant` on availability.** A live availability call returned `invalid_grant`. Confirmed the code does everything right (offline scope, refresh-token storage, `googleapis` SDK auto-refreshes the 1-hour access token transparently). `invalid_grant` is what Google returns when it has revoked the **refresh token itself** — which it does after 7 days for OAuth apps in "Testing" publishing status. **Resolution split:**
  - **Code-side enhancement (shipped):** when `invalid_grant` is detected, we now mark `IntegrationCredential.isActive = false` and create a SYSTEM notification ("Google Calendar disconnected — reconnect from Settings → Integrations…"). Verified live against the revoked token: integration flipped to inactive, notification row created with operator-facing copy.
  - **Tega-side fix:** publish the OAuth consent screen (Google Cloud Console → APIs & Services → OAuth consent screen → set publishing status to "In production"). Once published, refresh tokens stay valid indefinitely.

## What's left to close M2

| Item | Status |
|---|---|
| Day 10 — full happy-path E2E acceptance run | Pending — Shazim |
| Recorded demo video | Pending — Shazim |
| Production deploy (merge `phase-1-implementation` → `main`) | Pending — needs Tega's go |
| **M2 client sign-off ($1,700)** | Pending — Tega |

## Parked / not blocking sign-off

- **QD-001 (Sign in with Google via Clerk)** — pending Tega's Clerk access ("I will sort Clerk in a day" — 2026-05-30). Calendar OAuth uses the same Google Cloud project, so it's ready the moment Clerk is granted.
- **Reschedule conversational flow** — deferred to Phase 2 alongside F5.1 (the hardcoded DAE funnel). Operators can reschedule today via the call-details panel; the *conversational* reschedule depends on the funnel rework and can't be verified end-to-end on non-Daniel accounts until F5.1 lands.

## Known issue flagged for Phase 2

- **F5.1 — hardcoded DAE funnel.** Non-Daniel accounts can't reach `BOOKED` through the full conversational funnel because pieces of Daniel's persona / pitch are hardcoded in prompts. Won't block M2 sign-off (the demo uses the DAE account), but it's the gating item for any new client onboarding in Phase 2.

---

## Commit summary (M2 work, `phase-1-implementation` branch)

| Commit | Day | What |
|---|---|---|
| `f284af6` | 1–3 | Placeholder leak + em-dash quality gate + verbatim-MSG injection (carry-over) |
| `4b3c7dc` | 4 | IG-Login subscribe-direct fix [QD-004b] |
| `b552b90` | 5 | `aiActive` persistence on AI toggle-on [QD-060] |
| `2c34014` | 5 | Meta health retry on transient errors [QD-005] |
| `2b222b3` | 6 | Helper judgments routed through openai fallback |
| (multiple) | 6–7 | Google Calendar adapter, OAuth, Settings card, dashboard tab |
| `76e0d90` | 8 | Guarded autonomous booking |
| `3773a52` | 8 | Active booking-calendar selector + harden all providers |
| `3906c7f` | 8 | Cal.com v2 migration (v1 decommissioned) |
| `ba33bb8` | 9 | Quota error wrapper [QD-003/024/043/044/045/048] |
| `0d84eb3` | 9 | QD-046 (tag picker) + QD-014 (call date >6mo) |
| `3a08156` | 9-ext | **F8 Analytics Reconciliation [QD-032 → QD-041]** |
| `911acbd` | 10 (accept.) | Google Disconnect 400 + invalid_grant auto-deactivate + SYSTEM notify |

Everything pushed. Build green throughout. Conversation fixtures 21/21 pass. Analytics reconciliation tests 14/14 pass.

---

## Phase 1 ↔ Phase 2 ledger

### Phase 1 — Status: M1 + M2 in progress

| Stream | Status |
|---|---|
| QD-059 Away Mode autonomy gating | ✅ |
| QD-060 aiActive persistence | ✅ |
| QD-005 Meta health retry-with-backoff | ✅ |
| QD-004 / 004b Instagram routing | ✅ (id-mismatch routing fix deferred — code path identified, not impacting M2) |
| QD-001 Google login via Clerk | ⏸ Parked — pending Clerk access |
| QD-014 Call date ≤ 6 months | ✅ |
| QD-046 Tag picker | ✅ |
| Quota error wrapper (QD-003/024/043/044/045/048) | ✅ |
| Google Calendar OAuth + autonomous booking | ✅ |
| Cal.com / Calendly / LeadConnector adapters | ✅ all verified live |
| **F8 Analytics Reconciliation (QD-032 → 041)** | ✅ (pulled from Phase 2) |
| Day 10 E2E + demo + deploy + sign-off | Pending |

### Phase 2 — Status: F8 done early, rest pending

| Feature / cluster | Status |
|---|---|
| F1 Conversation Takeover | Pending — Phase 2 |
| F3 Voice Notes polish (QD-025 → QD-031, 7 bugs) | Pending — Phase 2 |
| F4 Follow-Up Picker | Pending — Phase 2 |
| F5.1 Hardcoded DAE funnel | Pending — Phase 2 HIGH |
| F6 Objection Library | Pending — Phase 2 |
| F7 Setter Goal | Pending — Phase 2 |
| **F8 Analytics Reconciliation** | ✅ done early in M2 |
| F9 Lead Memory | Pending — Phase 2 |

Net effect: Phase 2 backlog is ~10 bugs lighter than the original plan, and arrives with the reconciliation foundation already in place — every new analytics widget added in Phase 2 will import from `lead-state-sets.ts` from day one.
