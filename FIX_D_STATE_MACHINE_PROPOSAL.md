# Fix D — Conversation State Machine: Design Proposal (v2)

**Design + phased plan. No code ships from this doc.**
Author: engineering · Date: 2026-07-24 · Status: approved in principle (Tega) → answering the four open questions + dating each phase before build-start.

> **Naming:** this is **Fix D** (Sprint 7+ backlog), not F9. F9 = per-lead Lead Memory (M4, Track 4) and stays that everywhere. The v1 of this doc mislabeled it F9; corrected here.

---

## The principle (approved)

> **Code owns state. Models own language understanding.**

The LLM decides *what the lead meant* and *how to phrase the next message*. It must **never** decide *what step we are on*, *whether a step is complete*, *what value a variable holds*, or *whether a message is allowed to send*. Those are state transitions, and today the model can drive them by what it emits. That inversion is the root cause of the adversarial-run leaks (F1–F6).

## The problem, in evidence

Every P0 fixed in the remediation was the **same shape**: a state decision reachable from more than one place, so a guard at one site was bypassed at another.

- **~9,100 lines** across `script-state-recovery.ts`, `stage-progression.ts`, `script-step-progression.ts`, `lead-stage.ts` decide step/stage — plus the exhaustion `if/else-if` chain in `ai-engine.ts`.
- **Step completion** had ~7 independent paths; the answer-satisfaction gate reached 2 (leak-15 found the other 5).
- **Variable binding** had ~7 writer classes; the anti-fabrication gate covered 1 (leak-16 found the rest).
- **Low-ticket send-blocking** existed at generation but not at drip-send (leak-14 — the Anthony leak shipped *after* the gate passed).
- **Step and stage are two clocks that don't share a gear** (SQA run-2, Ali Hassan, 2026-07-24): on his ALi Raza test conversation, `currentScriptStep` stayed at **1** across 14 messages while the emitted stage advanced OPENING → SITUATION_DISCOVERY → GOAL_EMOTIONAL_WHY. The step walker and the stage emitter are separate writers with no shared transition — each can move without the other. (That test conversation has since been removed by test-lead cleanup; the same decoupling class is still queryable live on the daetradez account: `cmruf7wk4004gju04d3clr2wc` sits at step 8 of the 8-step website funnel with `systemStage="Funnel to Website"` — correct — while `llmEmittedStage=BOOKING`, a stage that *does not exist* in that funnel; `cmruemj6a0003ju0484k0r09a` shows `systemStage="Life Impact — What It Changes"` at step 5 with `llmEmittedStage=GOAL_EMOTIONAL_WHY`.) Under Fix D there is one position, one transition function, and the stage vocabulary is *derived from* script position — a stage the script doesn't contain is unrepresentable.

The fixes are correct but they are **guards on a machine with no single source of truth**. Fix D replaces the guards with a machine that *cannot express* the illegal transition.

## Proposed design — three pillars

### 1. One transition function
```
transition(currentState, event) -> nextState        // pure, deterministic, total
```
- `currentState` = `{ step, stage, variables, holds }`.
- `event` = a **typed, validated** input: `LeadReplied{answersAsk, extracted}`, `DistressDetected`, `OperatorReplied`, `Timeout`. The model produces *candidate* events; **code validates them** before they become real events.
- No other code writes `step`, `stage`, or `variables`. The existing modules become **readers**.

### 2. States are data, transitions are a table
- The script compiles to an explicit transition table: "what completes step N" is one declaration, not seven code paths.
- Illegal transitions are **not representable**: no step advance without `LeadReplied{answersAsk:true}`; no variable bind without a source-message-validated `extracted` payload; `step` monotonic by construction.

### 3. One egress gate
- Every outbound message passes through **one** `canSend(state, draft)` before it leaves — generation, exhaustion fallback, drip-send, recovery-cron all call it. `canSend` is the *only* way to send.
- A held state (`distress`, `awaitingHumanReview`) is terminal: `canSend` refuses to release it without an `OperatorReplied` event.

---

## Answers to the four open questions

### Q1 — What happens when a candidate event FAILS validation? (production behavior, not just "won't compile")

Two distinct failure modes, both explicit and observable:

- **Malformed event** (the model proposed something structurally impossible — a step jump, a variable with no source message): the validator **rejects it, does not mutate state, logs a `rejected_event` with the reason + the candidate**, and the machine stays in `currentState`. The turn then re-drives from the unchanged state (same as a non-advancing step today). No silent drop — every rejection is a logged row, alertable, and surfaced in the shadow diff during migration.
- **Ambiguous event** (validator can't decide — e.g. the answer-satisfaction check is genuinely uncertain): resolves toward the **safe** transition, which for the safety path means *don't advance / don't bind / don't send*, and emits a `needs_review` signal. This is fail-safe by construction, not fail-open.

Rejections are a first-class output of `transition`, not an exception: `transition()` returns `{nextState, rejected?: {reason, candidate}}` so callers must handle the rejection path — it can't be ignored.

### Q2 — The READ side of F6 (the actual mechanism that stops "how much does this cost" shipping)

Pillar 2 covers *binding* a variable correctly. The read side lives in **Pillar 3 (`canSend`)**, and this is the mechanism that stops a draft referencing an unset variable:

- Before any draft sends, `canSend` **resolves every variable the draft references against `state.variables`**. If the draft references a variable that is **not bound** (or bound only non-authoritatively), `canSend` **blocks the send** and the draft is regenerated/repaired — it does not ship with a fabricated or empty value.
- This is the architectural version of the leak-16 serializer sentinel: today it's a guard in one serializer; under Fix D it's a precondition of *every* send. A message can't leave referencing a goal/why/capital the machine never recorded.
- Concretely: "how much does this cost" never becomes a bound answer (Pillar 2), AND a draft that somehow tries to echo it as the goal is blocked at `canSend` because the goal variable isn't set (Pillar 3). Two independent stops.

### Q3 — Why is egress unification (the F1 architectural fix) sequenced FIRST now, not third

**You're right — it was mis-sequenced.** v1 had egress as Phase 2. F1 (terminal distress pause) was the highest-severity finding, so its architectural version — `canSend` + terminal-state protection — comes **first**. Re-sequenced below: **Phase 0 is now egress + holds.** Rationale: the send gate is the last line of defense for *every* class of leak (a mis-bound variable, a wrong step, a distress release), so building it first means every subsequent phase migrates behind a gate that is already enforcing the safety floor.

**Is the interim `awaitingHumanReview` patch adequate coverage through the migration?** Yes, and here's the honest accounting: the remediation's F1 fix (`9e55a78` + the send-time re-gate in `0d3287f`) is live and was **verified against the code that is in production now** — not against code about to be replaced. Fix D Phase 0 does **not** remove that patch; it *subsumes* it — `canSend`'s terminal-state protection is built and shadow-compared **alongside** the existing patch, and the patch stays authoritative until Phase 0's shadow diff shows the machine matches or beats it. The interim patch is re-verified at Phase 0 cutover (that's the phase's exit criterion), not assumed. It is never the case that F1 protection is torn out before its replacement is proven.

### Q4 — Who verifies each phase's shadow-compare before cutover

Same standard as F1–F6: **independent verification, not the author's.** Each phase has a shadow-mode window where the machine runs alongside the current code and every disagreement is logged (like the distress `DistressShadowLog`). Cutover requires: (a) the shadow diff reviewed by someone other than the implementer — Ali or Tega — on real traffic, and (b) a written expected-vs-actual on the disagreements, same format as the findings doc. No phase flips authoritative on the implementer's say-so.

---

## Phased plan (dependencies + durations; absolute dates pending a start-date)

> Durations are working-day estimates for one engineer. They are **relative to a build-start date** — I've deliberately not stamped calendar dates because the start depends on how Fix D sequences against the other M4 workstreams (see the master plan). Give me a start date and I'll stamp each phase.

| Phase | Scope | Standalone? | Depends on | Est. | Exit criterion (verified by) |
|---|---|---|---|---|---|
| **0 — Egress + holds** (the F1 architectural fix, first) | `State`/`Event`/`transition` skeleton; `canSend` as the single send path incl. unset-variable block (Q2) + terminal-state protection (Q3); **typed hold states** — `HELD_DISTRESS`, `HELD_SCHEDULING_CONFLICT`, `HELD_OPERATOR_REVIEW`, `HELD_GATE_EXHAUSTED` replace the generic `awaitingHumanReview` boolean, each with its own entry event and release condition, so an operator always knows WHY a conversation is held (Tega 2026-07-26: explicit in the phase plan, not implied) | Yes | — | ~3–4 d | Shadow diff vs current send paths clean on live traffic; F1/F2 re-verified (Ali/Tega); every held conversation shows a typed reason |
| **1 — Step completion** | Route all ~7 completion paths through `transition`; rejection path (Q1) | No | Phase 0 | ~4–5 d | Shadow diff vs `computeSystemStage`; F4/F5 hold (independent) |
| **2 — Variable binding** | All ~7 writers → validated `extracted` events | No | Phase 1 | ~4–5 d | Shadow diff vs current binding; F3/F6 hold (independent) |
| **3 — Retire redundant guards** | Delete the guards the machine now makes unrepresentable | No | Phases 0–2 all cut over | ~2–3 d | No behavior change; full regression + persona-harness green |

- **Standalone:** only Phase 0 is standalone. 1→2→3 are strictly sequential (each needs the prior cut over, because they migrate the same state the prior phase now owns).
- **Total:** ~13–17 working days, sequential, one engineer. Parallelizable only by adding a second engineer on Phase 2's extractor-by-extractor migration once Phase 1 lands.
- **Reversibility:** each phase is behind a flag; a bad shadow diff means we don't cut over — the current code stays authoritative. No phase is a big-bang.

---

## The ask

The principle and pillars are approved. This v2 answers Q1–Q4 and re-sequences egress first. **Remaining input needed from you: a build-start date** (or Fix D's slot in the M4 sequence — see the master plan), after which I stamp a date on each phase. The remediation's F1–F6 fixes hold production today; Fix D is what stops this bug *class* from recurring.
