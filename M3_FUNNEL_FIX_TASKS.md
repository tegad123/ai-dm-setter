# M3 Priority 1 — Conversation-Flow Root-Cause Fix (F5.1) — Task Tracker

> Working checklist. Update `[ ]` → `[x]` as each task lands + passes its verification gate.
> Full rationale: `/Users/apple/.claude/plans/cheeky-bubbling-newt.md`. Scope: **Option 1 + Option 3** (fix position lag + never-silent + de-hardcode funnel). Out of scope: two-model unification.

## Goal
The AI must run any account's script from opener → terminal stage **without getting stuck, going silent, or mis-qualifying** — verified end-to-end, not patched.

> ## ⚠️ CRITICAL — read before trusting any "green tests" (discovered 2026-06-07)
> The existing 21 conversation fixtures **ALL PASS today — yet production still got stuck.** They are **single-turn snapshots** (feed one history + one draft, assert one reply). The real bug is **stateful, accumulating over ~15 turns** (`prepareScriptState` persists `currentScriptStep`, `maxAdvanceSteps:1` lag compounds turn-over-turn). The single-turn suite **physically cannot see it.**
>
> **Therefore "21/21 green" does NOT mean fixed.** We only call this fixed when:
> 1. A NEW **multi-turn reproduction test** goes **red on current code → green after the fix**, AND
> 2. The **prod-replay** of a real stuck conversation reaches BOOKING (not parks at step 7 / awaitingHumanReview), AND
> 3. A **live-LLM end-to-end** funnel completes on both a DAE and a non-DAE script.
> This is the discipline that stops us being falsely reassured a third time.

---

## Phase 0 — Setup & baseline (before any change) ✅ DONE
- [x] Branch off prod `main` for M3 funnel work → branch `m3-funnel-fix`
- [x] Capture BASELINE: `npm run test:conversations` → **21/21 green**
- [x] Capture BASELINE: unit → **0 failures** (script-state-recovery + script-step-progression)
- [x] **Built the multi-turn reproduction FIRST** (`tests/multi-turn-fixtures/` + `tests/run-multi-turn-fixtures.ts` + `repro-01-step-parking.fixture.ts`). **CONFIRMED RED on current code** — position PARKS on step 5, lag grows to 3, never reaches terminal. Reason: `first_incomplete_step_from_history` (paraphrased ask not recognized as complete). This is Tega's exact bug, now reproduced deterministically.
- [ ] Confirm local DM harness works: `reset-local-test.ts` + `simulate-ig-dm.sh` (deferred to Phase 5 live-E2E)
- [x] Baseline: **21/21 single-turn, 0 unit failures, multi-turn repro = RED (expected)** ✓

---

## Phase 1 (Day 1) — Robust step-completion detection [1a] ✅ DONE (commit on m3-funnel-fix)
File: `src/lib/script-state-recovery.ts` → `stepCompletionFromHistory()` + `branchHistorySelectionForStep()`
- [x] Added `suggestionId`-based completion: AI msg carrying step's suggestionId + lead reply after → `completed_by_ask_reply_suggestion`
- [x] Widened `branchHistorySelectionForStep` to also recognize `smart_mode_response` (smart-mode parity)
- [x] (Dropped the `inferStepFromReply` secondary — it's DAE-pattern-biased; the suggestionId path is account-agnostic and sufficient. inferStep stays out to avoid mis-attribution on non-DAE scripts.)
- [x] Verified the live flow writes the branch_selected event WITH suggestionId (`ai-engine.ts:6255`) + persists `Message.suggestionId` → fix fires in real prod, not just tests
- [x] Unit tests added (paraphrased ask completes via suggestionId; no-reply stays incomplete)
- [x] **GATE PASSED:** 21/21 fixtures green, 41/41 + 233/233 unit green, tsc clean; **multi-turn repro went RED→GREEN** (position tracked every turn → all_steps_complete, was parked at step 5)

## Phase 2 (Day 2) — Conditional advancement cap + dead-write removal [1b, 1c] ✅ DONE (commit afa94e0)
File: `src/lib/script-state-recovery.ts` → `computeSystemStage()`, `prepareScriptState()`
- [x] 1b: before capping a multi-step jump, check every intervening step has a `step_completed` event; all proven → don't cap; any gap → keep +1 cap (strictly stronger than old floor — no jump-to-last risk)
- [x] 1c: removed dead `LeadScriptPosition` upsert in `prepareScriptState` (zero live readers, verified)
- [x] Unit tests: proven-intervening → uncapped advance; unproven gap → still +1 (anti-skip)
- [x] Added multi-turn fixture `repro-02-catchup-after-gap`
- [x] **GATE PASSED:** cap unit tests pass; **bug-18 green** (anti-skip canary); 21/21 fixtures; 42/42 + 233/233 unit; **multi-turn repro stayed GREEN**; tsc clean.

## Phase 3 (Day 3) — Never-silent guarantee + gate-trusts-position guard [2, 4]
✅ DONE (commit a3f38d2). Files: `src/lib/ai-engine.ts`, `src/lib/voice-quality-gate.ts`, `src/lib/script-state-recovery.ts`
- [x] 2: both best-effort exhaustion branches force `escalateToHuman=false` — soft gates can never silence; only hard gates escalate. Fixed soft-branch audit label.
- [x] 2: empty+escalating holding-line safety confirmed intact (hard gates pause WITH a holding line, lead never silent)
- [x] 4: `positionJumpedThisTurn` added to snapshot (computed in prepareScriptState) → threaded into gate options → suppresses `step_distance_violation` on a legit catch-up turn
- [x] Unit tests: far-ahead reply WITHOUT jump generates step_distance_violation; WITH jump suppressed
- [~] vague-answer fixture: covered by never-silent unit guarantee + bug-10/16 staying green; dedicated live-LLM vague-answer run deferred to Phase 5 E2E (more meaningful with real model)
- [x] **GATE PASSED:** 21/21 fixtures (bug-10/16/04 green); 42+233+6 unit; 2/2 multi-turn; 0 src tsc errors

## Phase 4 (Day 4) — De-hardcode the funnel [3a, 3b]
✅ DONE (commit 40e3f03). Files: `src/lib/ai-engine.ts`, `src/lib/script-step-progression.ts`, `src/lib/ai-prompts.ts`
- [x] 3a: `incomeGoalStepNumber(script)` resolver (stateKey/requiredDataPoints → income-goal aliases); ai-engine uses `resolver ?? 9` (DAE byte-identical when unset)
- [x] 3b: downsell productName fallback chain → generic `"the course"` (never DAE name) in BOTH prompt builder + gate config; price keeps neutral default for grammatical prompt
- [x] New fixture: `repro-03-non-dae-script` (fitness-coaching funnel, income-goal at step 4) — tracks start→call, no parking
- [x] Unit: 4 `incomeGoalStepNumber` cases
- [x] **GATE PASSED:** bug-14/05/21/13 green; 21/21 fixtures; 237+42 unit; 3/3 multi-turn; 0 src tsc errors; DAE preserved where config absent

## Phase 5 (Day 5) — End-to-end verification + hardening [E2E]
### Automated (DONE — all green on branch `m3-funnel-fix`)
- [x] Full suite: 21/21 single-turn fixtures + 3/3 multi-turn fixtures + **ALL 16 unit test files (0 fail)** + `test:analytics-reconciliation` 10/10
- [x] **Full-codebase typecheck: 0 TS errors** (`tsc --noEmit`, incl. dev scripts — confirms dead-write removal left no dangling refs)

### Live-LLM E2E (NEEDS YOUR LOCAL ENV — DB + dev server + LLM keys; run when ready)
> The deterministic layers above PROVE the fix at the logic level (the repro went red→green). These live runs are the final real-model confirmation. Run on your machine:
- [ ] **E2E #1 (DAE shape):** `PLATFORM=IG npx tsx scripts/drive-funnel.ts` (existing harness, drives full DAE funnel with real LLM through webhook→engine→DB). Confirm: opener→booking, no silence, `systemStage` tracks (gap ≤1), lead QUALIFIED, booking lands.
- [ ] **E2E #2 (non-DAE script):** same harness against a test account with its OWN script → no gate fires from a script it never authored. (repro-03 already proves this at logic level.)
- [ ] **E2E #3 (stress):** replay the patterns that broke before — vague answer ("ez way to make money"), capital-then-booking, message burst → AI advances, never stalls.
- [ ] **Prod-replay (optional):** copy a real stuck conversation's transcript into `drive-funnel.ts` LEAD_TURNS → confirm it now reaches BOOKING instead of parking.

### Ship
- [ ] Final: PR `m3-funnel-fix` → review → merge to `main` → verify on prod with a real test DM

---

## End-to-End Test Mechanism (the "AI never gets stuck" proof) — 4 layers

> Why 4 layers: the existing single-turn suite was green while prod was broken. Real confidence requires testing the **stateful, multi-turn** path where the bug actually lives.

**Layer 1 — Single-turn fixtures (regression floor, every phase):** `npm run test:conversations` (21 fixtures) + unit tests. Fast, no LLM. Guards against breaking what works. **Necessary but NOT sufficient** — cannot see the stateful bug.

**Layer 2 — Multi-turn stateful harness (NEW — catches the real bug, CI-grade):** `tests/run-multi-turn-fixtures.ts` drives 15+ turn conversations through the REAL stateful path (`prepareScriptState`/`computeSystemStage` with state carried forward), recorded replies (no LLM → deterministic). Asserts `noStepParking`, `systemStageLagMax`, `mustNotEscalate`, reaches BOOKING. **The reproduction fixture must go red→green** — that transition IS the proof the core bug is fixed.

**Layer 3 — Prod-replay (NEW — proves the actual incident is fixed):** `scripts/replay-stuck-conversation.ts` replays a real stuck conversation's message sequence locally and asserts it now advances instead of parking. One-time, high-signal.

**Layer 4 — Live-LLM end-to-end (highest confidence, pre-deploy):** local prod-replica (`reset-local-test.ts` + `simulate-*-dm.sh` + `drive-funnel.ts`) drives real conversations through webhook→engine→DB with the actual LLM, on DAE + non-DAE scripts, replaying the inputs that broke before.

**Pass bar (all must hold):** multi-turn repro red→green; prod-replay reaches BOOKING; a fresh lead (DAE shape AND non-DAE custom script) runs opener→terminal stage with zero silent stalls, `systemStage` within 1 step of true, correct QUALIFIED/UNQUALIFIED, and (if qualified) a booking — across the exact inputs that previously broke it.

---

## Honest scope statement (for client comms)
- Fixes the **stuck / silent / mis-qualify cluster at root** — the launch blocker — and de-hardcodes the funnel so **new clients' scripts work**.
- Does NOT claim to close every individual conversation bug on the Phase-2 sheet (separate items). Makes the **core engine sound** enough to onboard.
- "Fixed" = multi-turn repro red→green + prod-replay + live E2E pass. Not "green single-turn tests."

---

## Progress log
- 2026-06-07 — Plan approved; tracker created.
- 2026-06-07 — **Critical discovery:** all 21 single-turn fixtures pass while prod was broken → added multi-turn + prod-replay + live-E2E layers; reproduction-test-first (red→green) is now the success criterion. Starting Phase 0.
- 2026-06-07 — Phases 0-4 implemented + committed (5 commits, m3-funnel-fix). Deterministic suites all green.
- 2026-06-07 — **Live-LLM bypass-send test (drive-engine-local.ts):** funnel drove all 16 turns to BOOKING, **zero stalls, zero escalations** — never-silent + content-flow PROVEN with real model. BUT first run showed `systemStage` parked at step 1 because the harness persisted AI messages WITHOUT suggestionId (the real delivery path DOES persist it — webhook-processor.ts:3668). Fixed harness to persist `result.suggestionId`; re-running to confirm position advances. **Lesson reinforced: the position-advance fix depends on Message.suggestionId being present, which only the real delivery path guarantees.**
- 2026-06-08 — **Phase 6 shipped (PR #28):** 6A judgment-step completion (deep-why loop) + 6B Stage Progression panel reconciliation (`stepToSopStage`). Stage progression panel = DONE (reads real position). Clean live prod FB test (backfill disabled via `DISABLE_META_BACKFILL=true`) ran the funnel: never silent, position advanced 1→8, qualified — but revealed the TRUE remaining bug.
- 2026-06-08 — **REAL ROOT CAUSE caught in clean prod test:** volunteered/bundled qualifying answers (income goal + capital) were NOT captured → call-proposal prereqs never filled → AI looped in discovery, never proposed the call. (incomeGoal/verifiedCapital `undefined` despite lead clearly stating "15k a month" + "5k saved".)
- 2026-06-09 — **Phase 7 implemented + committed (3 commits):** 7A volunteered incomeGoal capture (distance-gate, bug-58/53 kept green); 7B synchronous volunteered-capital capture every turn (negative-context guarded, idempotent); 7C verified prereqs clear leaving only AI-delivered gates. All suites green: 18 unit files, 21 fixtures, 4 multi-turn, 10 analytics, 0 src tsc errors. **Awaiting clean live DM (volunteer income+capital) to confirm the AI now advances to pitch/call instead of looping discovery.**

---

## Phase 7 — extraction fix status (the FINAL structural blocker)
- [x] **7A** volunteered incomeGoal captured via distance-gate + cue guard (own-ask not immediate-next → capture; stamp source step); lookahead widened 3→10. Commit `da5d99b`.
- [x] **7B** `extractVolunteeredCapital` runs every turn in `extractDataPoints` — captures unsolicited capital with PASSIVE_CAPITAL_SIGNAL + PASSIVE_NEGATIVE_CONTEXT guards, idempotent. Commit `84187c1`.
- [x] **7C** `checkCallProposalPrereqs` clears income_goal + capital from volunteered captures; residual = exactly {belief_break, buy_in} (AI-delivered, kept by design). Commit `bafea6d`.
- [x] Regression canaries green: **bug-58** (target-income own-ask), **bug-53** (current income), all suites.
- [ ] **Live verification:** clean fresh lead, volunteer income+capital mid-discovery → query prod confirms captured → AI proceeds to belief-break/buy-in → call proposal (not stuck re-asking).
