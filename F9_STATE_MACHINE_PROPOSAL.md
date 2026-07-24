# F9 — Conversation State Machine: Design Proposal

**One-page design (not an implementation). For review; no code ships from this doc.**
Author: engineering · Date: 2026-07-24 · Status: proposal → awaiting Tega review + build-start date

---

## The principle (approved)

> **Code owns state. Models own language understanding.**

The LLM decides *what the lead meant* and *how to phrase the next message*. It must **never** decide *what step we are on*, *whether a step is complete*, *what value a variable holds*, or *whether a message is allowed to send*. Those are state transitions, and today the model can drive them by what it emits. That inversion is the root cause of the F1–F6 leaks.

## The problem, in evidence

Every P0 we just fixed was the **same shape**: a state decision was reachable from more than one place, so a guard added at one site was bypassed at another.

- **~9,100 lines** across `script-state-recovery.ts`, `stage-progression.ts`, `script-step-progression.ts`, `lead-stage.ts` all decide step/stage — plus the exhaustion `if/else-if` chain in `ai-engine.ts`.
- **Step completion** had ~7 independent paths; the answer-satisfaction gate was wired into 2 (leak-15 found the other 5).
- **Variable binding** had ~7 writer classes; the anti-fabrication gate covered 1 (leak-16 found the rest).
- **Low-ticket send-blocking** existed at generation but not at the drip-send path (leak-14 — the Anthony leak shipped *after* the gate passed).

The fixes are correct, but they are **guards bolted onto a machine with no single source of truth**. The next behavior change risks re-opening the same class of bug. F9 replaces the guards with a machine that *cannot* express the illegal transition.

## Proposed design

A single explicit state machine that owns every transition. Three pillars:

### 1. One transition function
```
transition(currentState, event) -> nextState        // pure, deterministic, total
```
- `currentState` = `{ step, stage, variables, holds }` (the whole conversation state).
- `event` = a **typed, validated** input: `LeadReplied{answersAsk, extracted}`, `DistressDetected`, `OperatorReplied`, `Timeout`. The model produces *candidate* events; **code validates them** (does the reply actually answer? did the value come from this message?) before they become real events.
- No other code writes `step`, `stage`, or `variables`. The four modules above become **readers** of state, not deciders.

### 2. States are data, transitions are a table
- The script (steps/branches) compiles to an explicit transition table, so "what completes step N" is one declaration, not seven code paths.
- Illegal transitions are **not representable**: a step cannot advance without a `LeadReplied{answersAsk:true}` event; a variable cannot bind without a source-message-validated `extracted` payload; `step` is monotonic by construction (no backward move, no floor-patch needed).

### 3. One egress gate
- Every outbound message passes through **one** `canSend(state, draft)` predicate before it leaves — generation, exhaustion fallback, drip-send, and recovery-cron all call the same function. (leak-14 already collapsed the low-ticket harm check to one predicate at three call-sites; F9 makes that the *only* way to send.)
- A held state (`distress`, `awaitingHumanReview`) is a terminal transition that `canSend` refuses to leave without an `OperatorReplied` event.

## What this buys us

| Today | With F9 |
|---|---|
| ~7 completion paths, gate on 2 | 1 transition table, illegal transition unrepresentable |
| Variable bound from any of 7 writers | 1 validated `extracted` event |
| Send-block at generation only | 1 `canSend`, every egress path |
| A fix is a guard; next change may bypass it | A fix is a table/validator change; can't be bypassed |
| Model emission can drive state | Model proposes; code decides |

## Scope & sequencing (for the build-start date)

- **Not a rewrite.** The machine wraps the existing modules: they keep their extraction/scoring logic but stop *writing* state — they emit candidate events. Migration is incremental, one transition class at a time, behind a flag, shadow-compared against current behavior before cutover.
- **Phase 0 (small):** define `State`, `Event`, `transition`, `canSend`; route step-completion through it in shadow mode; diff against `computeSystemStage` on live traffic.
- **Phase 1:** variable binding → validated `extracted` events. **Phase 2:** egress unification (make `canSend` the only send path). **Phase 3:** retire the redundant guards the machine now makes impossible.
- Each phase is independently shippable and reversible; none is a big-bang.

## The ask

Review the principle and the three pillars. If approved, set a **build-start date** on the calendar. The F1–F6 fixes hold production now; F9 is what stops this bug *class* from recurring for client two and beyond.
