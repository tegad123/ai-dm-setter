# Addendum A triage: Final Discord Funnel

Reviewed 2026-09-24 against the Sept 18-20 Pre-Launch QA & Developer
Handoff, `docs/launch-tracker.json`, and the current code. The addendum is
evidence and requested acceptance criteria, not proof that a code change is
already deployed or a production conversation is fixed.

## Verified scope

- The production Sales Scripts editor shows **Final Discord Funnel** active:
  script `cmueln1ns0001l3040lwx9oaf`, seven steps, 117 action rows, and four
  warnings. The addendum leaves `[V3 SCRIPT ID]` unfilled. Capture the script's
  `updatedAt` and/or immutable version in every acceptance trace before sign-off.
- Production `/api/version` reported `bba4336a1fdd6c3fed0f35527acf4a965d43b9bc`
  during this review. This is a release identifier, not a script version.
- The Sept 23 `mr.cocoabutter` trace is a reused test lead. It cannot close
  any item without a fresh sender and a real inbox result. Do not reset a live
  conversation or replay real messages to manufacture a fresh case.
- Direct production database reads failed with a connection error during this
  review. The editor confirms activation, but the trace rows and script
  `updatedAt` remain unverified here.

## What changes from the original handoff

| Original item | v3 disposition | Tracker action |
| --- | --- | --- |
| P0.0, P0.1, P0.3, P0.4, P0.11, P0.12, observability | Engine requirements unchanged | Keep open; record v3 ID/version on new proof. |
| P0.2 | Step 1 Solicitation / non-lead must send nothing | Retarget acceptance. |
| P0.5 | Step 4 YES must not become Hesitant | Retarget acceptance. |
| P0.7 | Discord, Typeform waitlist, Apex/Lucid resources | Replace old YouTube/Playbook URLs. |
| P0.8 | Discord resend only if missing or broken | Retarget acceptance. |
| P0.9 | Step 4 to 5 to 6, delivered-action state | Retarget acceptance; A5/A6 add live evidence. |
| P0.6 and Step 14 investigation | No purchase or Step 14 in active v3 | Retire as current release gates; preserve old incidents for reliability review. |
| P1 goal acknowledgment and obstacle diagnosis | Old steps absent | Retire script-specific checks. |
| P1 offer before price and verbatim repeat | Step 6 price question; v3 duplicate turns | Retarget acceptance. |

The four retired criteria are not marked verified. They can return if a later
active script restores those steps.

## Addendum findings and implementation order

The tracker contains A1-A12 as separate tasks with the addendum priorities.
The immediate safety batch is A1, A2, A3, A5. Keep A4, A6, A7 next. A8-A12
follow; A8/A9 must be regression-tested with the immediate batch because
they can trigger retries and progression errors on the active script.

| Finding | Existing gate / code boundary | Next proof |
| --- | --- | --- |
| A1 P0 fixed text regenerated | New scope, P0.7 principle. `ai-engine.ts` still has a recovery path that injects literal `[MSG]` only after a gate failure; the default path generates first. | Selected branch's literal `[MSG]` ships exactly, without model substitution. Placeholder actions alone generate. |
| A2 P0 hard fails ship anyway | P0.11 and section 06. `ai-engine.ts` has soft/catch-all best-effort paths and a strip path after retries. | Fixed-copy/off-script hard failure holds with a review item. Removed parts have trace reasons. |
| A3 P0 duplicate generations delivered | P0.1 and section 06. The queue has trace linkage, but one native inbound to one delivered operation must be proven across workers and partial sends. | Concurrent and replacement attempts yield one ordered reply and one link send. |
| A5 P0 step differs from delivery | P0.9. Current gate checks draft text and the state recovery rescans message history; their relationship to persisted Meta parts needs tracing. | Delivered ask alone controls Step 5 completion; next Yes goes to waitlist. |
| A4 P0 discarded draft unexplained | P0.0/P0.12. | Store coded discard/supersession reason and replacement generation link. |
| A6 P0 cursor overrun | P0.9. `script-state-recovery.ts` stores `fsmCursor` as shadow evidence and only overrides routing if `FIX_D_ROUTING_AUTHORITATIVE` names the account. | Determine production authority; clamp both trackers to seven steps and explain disagreement. |
| A7 P1 parser drops `[JUDGE]` | New. `script-parser.ts` uses model parsing and lacks a source-to-action completeness check for every judgment line. | Upload and Paste Text preserve all judgment lines, order and warnings. |
| A8 P1 scripted emoji banned | New. `voice-quality-gate.ts` emits `banned_emoji`; `ai-engine.ts` may strip. | Literal approved copy is exempt; generated emoji remains governed by policy. |
| A9 P1 no-question-mark ask | New. `voice-quality-gate.ts` counts `?` to decide if an ask was sent. | `[ASK] lmk once you're in` is treated as an ask action and delivered. |
| A10 P1 old stages | New. Legacy stage emission still has booking taxonomy. | v3 Step 5/6 emits active-script stages only. |
| A11 P1 reset variables | New. Reset route intends to clear captured data except two system flags; reported surviving `fallbackContentUrl_delivered` needs a trace, not an assumed patch. | Record variables before and immediately after reset and at fresh turn 1. |
| A12 P2 username as name | New. | No verified first name means omit `{{name}}`. |

### A1 implementation checkpoint, 24 September

For a selected branch, outbound messages now come from its ordered actions
before quality checks. Fixed messages, questions, and configured links are
inserted from the script. Runtime placeholder messages are generated in a
separate short call; a mismatch, wrong market role, or later mutation holds the
turn for review rather than sending incomplete or wrong-branch copy. Pure
routing branches do not inherit shared step copy. An unresolved link still
uses the existing link guard and operator alert path.

25 September local proof, using an active-script clone with Meta sends stubbed:
Instagram conversation `cmugndxoz00g49kbykkntp40f` and Facebook conversation
`cmugnjw2800js9kby743dw3lh` each completed Step 1 Futures, Step 2 Live
account, Step 3 Real goal, and Step 4 YES. Step 3 delivered the contextual goal
acknowledgment followed by the exact selected-branch fixed message and ask.
Step 4 delivered one Discord URL between the fixed opener and generated
Futures-role instruction, then the exact fixed follow-up and ask. The separate
Instagram Vague case `cmugm5096004u9kbyo1ha2yey` delivered its three fixed
bubbles without Real goal copy. The local driver now waits for the send cycle
to finish before advancing. These are local dry-run message IDs, not native
Meta delivery. A1 remains open for a production fresh-lead inbox trace on both
platforms and Tega's review; no client production settings or rows were changed.

## Questions before changing runtime code

1. Confirm the active v3 script version and whether `FIX_D_ROUTING_AUTHORITATIVE`
   names Daniel's account in production. The FSM overrun may be shadow-only;
   the persisted legacy cursor still needs its own check.
2. Define the action-order contract: judgment actions are decision inputs and
   should be evaluated before constructing branch messages, regardless of
   whether an author placed them after a wait. Confirm this against v3.
3. Define Reference Data detours: answering an Apex code question must not
   advance a script step unless the step's required action was delivered and
   satisfied. Record any explicit exception.
4. Capture the original v3 source and the current 117 editor actions before
   re-parsing. The four-warning banner and repaired-by-hand judgments should
   not be overwritten during parser testing.

## Release decision

The script is active, but Addendum A documents wrong-branch text, duplicate
parts and lost asks in a live test. Treat A1/A2/A3/A5 as a new immediate
release gate before claiming the active funnel is ready. Coordinate any
temporary auto-send/suggestions-only decision with Tega and Daniel; do not
change Daniel's production settings as a side effect of this triage.

Closure still requires commit and file:line, a fresh lead conversation and
before/after trace, native inbox delivery, test counts, script ID/version, and
Tega's independent sign-off.
