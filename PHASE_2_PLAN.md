# QualifyDMs Phase 2 — Execution Plan (v2, re-prioritized 2026-06-05)

## Where we are

- **Phase 1 (M1 + M2): DONE, signed off, paid.** See PHASE_1_PLAN.md header. AI auto-reply, autonomous booking, Google Calendar OAuth, calendar tab, and the M2 bug batch are live on `main`/production.
- **Analytics already done early:** F8 reconciliation (QD-032→QD-041, 10 bugs) was pulled into M2. **F8 is closed — removed from M3 below.**
- **Now starting: Phase 2 = M3 ($1,800) + M4 ($2,000), ~15 working days (Weeks 3–5).**
- Client milestone dates (from approval): **M3 ≈ Jun 18, M4 ≈ Jun 23.**

## What changed from v1 of this plan

1. **F5.1 (funnel / stage-progression root cause) is now M3 priority #1**, not spread across the milestone. This is the cluster blocking the client right now (AI stalling, wrong stage, wrong UNQUALIFIED). v1 front-loaded F1/Voice Notes; v2 front-loads the root-cause fix because I committed to the client that core conversation behavior would be solid in the first ~2–3 days of M3.
2. **F8 analytics removed from M3** — already delivered in M2.
3. **Sequencing reordered** so the highest-severity, client-blocking, shared-root-cause work lands first; isolated UI/feature work follows.

## The single most important M3 insight (root cause)

The conversation bugs the client keeps hitting are **one shared root cause**, documented as **F5.1**:

- **Two stage models that don't reconcile.** A 7-stage SOP model (`conversation-state-machine.ts`) drives `systemStage` + the UI + qualification, while a 25-step `Script`/`ScriptStep` model drives the actual conversation. They're bridged by brittle name-matching.
- **`LeadScriptPosition` advancement is unreliable / effectively dead.** The position parks on the first step the AI "skips" by judgment and never advances; `stageMismatchCount` climbs into the dozens account-wide.
- **The funnel prerequisite model is hardcoded to the DAE script** across 6 files, so any account's own script can drift and trip gates.

Symptoms this produces (all reported by client): AI goes silent mid-convo, stage bar stuck/inaccurate, lead shows UNQUALIFIED despite qualifying. The M2-transition hotfixes (gate-exhaustion → best-effort, capital-waterfall label fix) treated the **symptoms** and stopped the silence; **F5.1 fixes the cause** so the symptoms can't recur and the stage/qualification display becomes accurate.

---

## M3 — Milestone 3 ($1,800, target ~Jun 18)

### ✅ Progress snapshot (updated 2026-06-10)

**M3-A (F5.1 funnel root cause): DONE + live.** Shipped in layers over commits `356ec9b`→`5dea3c2` (`fb50993`, `4fa04d9`, `97cf3d4`, `da5d99b`, `84187c1`, `bafea6d`, `4241120`, `5dea3c2`). Script-derived prereq gate (de-hardcoded from DAE), step advancement via any suggestionId, judgment-type step completion, Stage Progression panel reconciled to real position, volunteered income/capital captured mid-discovery, QUALIFIED/capital-threshold bypass.

**Booking flow (F5.1 booking half / M3 headline): DONE + verified live on prod.** Commits `8196c6e` (re-connect auto-book — AI proposes real slots), `88ec1ea` (auto-book overrides script send-link when slots present), `c67b871` (live-update Call Details + Stage Progression). Plus calendar/timezone supporting work: `22c4147`, `e3e7167`, `e7544eb` (FullCalendar rewrite — fixes tz off-by-one/flip class of bugs), `3077bde` (account-level timezone SoT), `0668f6b` (full 24h grid + readable colors).

- **Live prod proof (2026-06-10, Daniel Elumelu's Workspace):** drove a full conversation to booking via webhook → AI proposed REAL LeadConnector Strategy Call slots ("sat 10/11/2pm, mon 2/3/4pm EDT", correct tz, no YouTube/link) → lead picked → `bookUnifiedAppointment` created the appointment → lead `BOOKED`, `scheduledCallAt` = Sat Jun 13 2pm EDT, the 2pm slot is **consumed** on the LC calendar, Zoom confirmation + reminders scheduled.

**Open follow-ups found during the live test (uncommitted, holding for client feedback):**
- Auto-book success branch wrote `scheduledCallAt` but left `bookingId` / `selectedSlot` / `bookingUrl` null and didn't stamp `lead.bookedAt` → fixed in working tree, **not yet committed** (waiting on feedback).
- AI occasionally re-asks "which one works for you?" when the lead names a clearly-matching slot ("saturday at 2pm") → prompt hardening drafted in working tree, **not yet committed**.
- `lead.name` had been overwritten with a message body on the test lead (display showed the message as the title) → restored on prod; root cause was a test/seed artifact, not the live webhook path.

**Still open in M3:** M3-B (functional blocker bugs), M3-C (Voice Notes), M3-D (Conversation Takeover), M3-E (UI polish + draft-loss), M3-F (buffer/regression), M3-G (acceptance demo + sign-off).

### M3-A (PRIORITY 1, Days 11–13): F5.1 — Funnel / stage-progression root cause ✅ DONE

This is the client-blocking work; do it first. Ship in layers so value lands early and each layer is independently testable.

**Layer A1 — Make `LeadScriptPosition` actually advance (single source of truth).**
- [x] Decide one authoritative "current step" source: `LeadScriptPosition` (per-lead, per-script) over the stage→step inference. Document the decision.
- [x] Wire step advancement into the live generation flow so position advances every turn (`fb50993` complete a step via ANY suggestionId; `4fa04d9` complete judgment-type ask+wait+runtime_judgment steps).
- [x] Fix `computeSystemStage` (`script-state-recovery.ts`) so a step the AI legitimately SKIPS doesn't park the walker forever.
- [x] Derive `systemStage` (and the Stage Progression UI) FROM the authoritative position, so the panel stops lagging (`97cf3d4` reconcile panel + lead.stage to real position).

**Layer A2 — De-hardcode the funnel prerequisite model.**
- [x] Drive the gate's prerequisite/step model from the account's own `Script` + `ScriptStep` rows, not hardcoded DAE constants (`5dea3c2` script-derived call-proposal gate + qualified bypass; `40e3f03` de-hardcode income-goal step + downsell defaults).
- [x] `mandatory_ask_skipped` / `call_proposal_prereqs_missing` / `income_goal_overdue` read the account's required asks, or accept volunteered data as satisfying a step (`da5d99b`, `84187c1`, `bafea6d`, `4241120` capture volunteered income/capital, scope amount to capital clause).
- [x] Strip remaining hardcoded Daniel/Anthony/$497 fixtures from the master prompt (F1.5/F2.2 siblings).

**Layer A3 — Qualification correctness.**
- [x] Confirm `mapAIStageToLeadStage` only marks UNQUALIFIED on a real capital failure (already fixed in `e1728a3` — verified it holds under the new position model).
- [x] Lead.stage / pipeline column derive correctly from the authoritative position (`97cf3d4`).

**Files:** `script-state-recovery.ts`, `script-step-progression.ts`, `lead-script-tracker.ts`, `voice-quality-gate.ts`, `ai-prompts.ts`, `ai-engine.ts`, `captured-data-keys.ts`, `conversation-state-machine.ts`.

**Acceptance (the demo that closes the client's current complaint):**
- [x] A lead reaches a real **autonomous booking** end-to-end: AI proposes real calendar slots → lead picks → appointment created server-side → lead `BOOKED` (verified live on prod 2026-06-10; LC slot consumed, scheduledCallAt set, confirmation/reminders scheduled).
- [x] Stage Progression panel matches the actual conversation point throughout (`97cf3d4`; live-updates without refresh via `c67b871`).
- [x] A lead that gives a qualifying capital answer is marked QUALIFIED (never wrongly UNQUALIFIED at the capital question) — verified in the live run (5k → QUALIFIED → Booking).
- [x] A lead that gives a vague answer gets a forward-moving reply (no silent stall, no re-ask loop).
- [ ] **Remaining verification:** drive ≥2 full fresh conversations start→booking on a **non-DAE** test account (live run so far was on Daniel's workspace); re-check ~10 live conversations' systemStage vs llmEmittedStage gap shrinks to ≤1.

### M3-B (Days 14–15): Functional blocker bugs (clickability / input)

High-severity "can't use the UI" bugs. Independent, low-risk, good momentum after the heavy A block.
- [ ] **QD-009 (Critical)** — Lead row not clickable / can't open lead profile.
- [ ] **QD-010 (High)** — Message input mic/text not clickable.
- [ ] **QD-022 (High)** — Profile + Notification header buttons non-responsive.
- [ ] **QD-023 (High)** — Stage Progression arrows not clickable on Leads page.
- [ ] **QD-053 (High)** — Invite Member UI doesn't open after Done/Copy.
- [ ] **QD-054 (High)** — Update Password button not working (likely route via Clerk `<UserProfile/>`).
- [ ] **QD-015 (High)** — FB Priority/Unread empty state covers full screen.
- [ ] **QD-021 (High)** — 404 navigating back from Persona Editor sub-options.

### M3-C (Day 16): F3 — Voice Notes polish (7 bugs)
- [ ] QD-025 duration estimation; QD-026 play/pause icon; QD-027 dropdown visibility; QD-028 spaces in Suggested Moments; QD-029 Min Delay clearing; QD-030 field width; QD-031 decimal/digit validation.

### M3-D (Day 17): F1 — Conversation Takeover (paste prior DM thread → AI resumes)
- [ ] Parser (`conversation-takeover-parser.ts`, LLM-assisted) + importer (`conversation-takeover-importer.ts`, replay into `script-step-progression` — now reliable because A1 fixed advancement).
- [ ] Migration: `MessageSource.IMPORTED_TAKEOVER`, `Conversation.priorHumanHandoff`.
- [ ] UI: `/dashboard/leads/[id]/takeover` (paste → preview → import) + preview/import API routes.
- [ ] Note: F1 depends on A1 (replay needs working position advancement) — that's why it's after A, not before.

### M3-E (Day 18): UI polish + state-loss
- [ ] **QD-012 (Critical)** — draft message lost on convo switch/refresh → persist to localStorage keyed by conversationId.
- [ ] QD-011 bubble overflow; QD-013 pipeline column cut off; QD-016 filters not applied; QD-017 pipeline view auto-switches; QD-018 search cut off; QD-019 sidebar accordion; QD-020 copy-link breaks; QD-002 persona&context; QD-006/007 integrations.

### M3-F (Day 19): Buffer + regression
- [ ] Slip-buffer for A-block overrun (it's the riskiest).
- [ ] `bun test tests/persona-harness/` green; Playwright suites; manual smoke on all M1/M2 flows (no regression on booking/calendar).

### M3-G (Day 20): M3 acceptance demo + deploy
- [ ] Recorded demo: F5.1 funnel correctness (the headline), functional blockers closed, Voice Notes, Conversation Takeover.
- [ ] **M3 sign-off ($1,800).**

---

## M4 — Milestone 4 ($2,000, target ~Jun 23)

Remaining SOW features (each gated on the now-stable funnel from M3).

### Day 21 — F4 Follow-Up Picker + F7 Setter Goal
- [ ] **F4:** `Account.followUpIntervalHours` + `followUpMaxAttempts`; read in `follow-up-sequence.ts` (replace hardcoded 12h); Settings UI + `/dashboard/follow-ups` view; prior-context summary injected into follow-up bodies.
- [ ] **F7:** `Account.setterGoal` enum (`BOOK_CALL` | `COLLECT_EMAIL` | `ROUTE_TO_FUNNEL`) + `routeToFunnelUrl`; wire terminal stage per goal in prompts + `script-step-progression`; Settings dropdown.

### Day 22 — F6 Objection Library
- [ ] Seed top-10 default objection responses (migration data step).
- [ ] Settings → Persona → Objections UI (list/edit/add).
- [ ] `objection-classifier.ts` (keyword first, LLM fallback w/ quota wrapper); wire detected objection into prompt assembly.

### Day 23 — F9 Lead Memory
- [ ] `LeadMemory` model + `MemorySource` enum migration.
- [ ] `lead-memory.ts` (get / upsert / extractAndUpdate via Anthropic, rate-limited per N turns for cost).
- [ ] Wire into `ai-engine.ts` (load at start, async extract after reply); lead-detail memory panel + API.

### Day 24 — Remaining bug triage + polish
- [ ] Clear any M3 slip items; operator-reported bugs from M3 sign-off; remaining Phase 2 pool bugs by impact.
- [ ] Full Playwright + persona-harness green.

### Day 25 — M4 acceptance demo + final sign-off
- [ ] Recorded demo of F1/F3/F4/F6/F7/F8/F9 + ~30 Phase 2 bugs closed.
- [ ] **M4 sign-off ($2,000).** Hand off remaining ~21-bug backlog + Phase 3 recommendations.

---

## Bug coverage map (M3 vs M4)

| Bug / Feature | Milestone | Block | Severity |
|---|---|---|---|
| F5.1 funnel / stage-progression root cause | M3 | A (P1) | ✅ DONE — live |
| F5.1 booking flow (auto-book real slots → BOOKED) | M3 | A (P1) | ✅ DONE — verified live on prod |
| Calendar UI + account-level timezone (FullCalendar) | M3 | A (support) | ✅ DONE — live |
| QD-009, QD-010, QD-022, QD-023, QD-053, QD-054, QD-015, QD-021 | M3 | B | High |
| QD-025–QD-031 (Voice Notes ×7) | M3 | C | High/Med |
| F1 Conversation Takeover | M3 | D | Feature |
| QD-012 (draft loss, Critical) | M3 | E | Critical |
| QD-011, QD-013, QD-016–QD-020, QD-002, QD-006, QD-007 | M3 | E | Med/Low |
| F4 Follow-Up, F7 Setter Goal | M4 | — | Feature |
| F6 Objection Library | M4 | — | Feature |
| F9 Lead Memory | M4 | — | Feature |
| F8 Analytics (QD-032–041) | ✅ DONE in M2 | — | — |

---

## Risks / honest flags

1. **M3-A (F5.1) is the riskiest single piece in the whole engagement.** It touches core advancement logic that runs on every lead, every account. A wrong change regresses the funnel everywhere. Mitigation: ship in layers (A1→A2→A3), each independently tested; verify against ≥10 real conversations + 2 fresh end-to-end runs before the demo; keep the Day-19 buffer for overrun.
2. **Two-stage-model reconciliation may surface more sub-bugs** as we wire position advancement (e.g. steps whose completion signal the heuristic can't detect). Budget for iteration inside the A block, not as separate hotfixes.
3. **Client expectation set:** I told Tega core conversation behavior would be "solid early in M3 (~2–3 days)." A1 (advancement + de-lag) must land in that window even if A2/A3 polish continues. Sequence accordingly.
4. **Do NOT keep hot-fixing symptoms outside this plan.** Every reactive gate-patch this session was correct for stopping silence but masked the real F5.1 cause. From here, conversation bugs route into the A block, not one-off patches.
5. Persona-harness is the guardrail for all A-block + M4 AI-prompt changes — run after every AI-pipeline change, not just at milestone end.

---

**End of v2 plan. Source of truth for M3 + M4. Update inline as work progresses.**
