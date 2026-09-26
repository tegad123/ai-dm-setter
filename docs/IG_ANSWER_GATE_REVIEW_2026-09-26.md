# Instagram answer gate review, 26 September 2026

## Production failure before this change

- Production commit: `9ec9069`.
- Active script: Final Discord Funnel, `cmueln1ns0001l3040lwx9oaf`.
- Native window opener: @iamshazimkhan, 2026-09-26 11:35:09.475 UTC,
  conversation `cmugqvwbx000tlb04dav4jue9`.
- Controlled signed-webhook conversation: `cmuih4wsf003fkx04p46g2ahk`.
  The injected inbound turns were synthetic; its outbound messages received
  real Meta message IDs. This does not prove the synthetic inbound appeared in
  Instagram's native inbox.
- Turn 1 and turn 2 each sent the scripted message and ask as separate Meta
  bubbles. Turn 3 answered the either/or ask with “nah not yet, still in
  learning mode” and asked about the free community. The production cursor
  remained at Step 2. The next generation repeated the prior ask, and the
  quality gate held it after five attempts (`cmuih89bc004ukx04eef5e0q0`).
  `lastStepCompletionTrace.stepCompletionReason` was
  `ask_reply_did_not_answer`; the shadow FSM showed Step 3.

## Code review

`computeSystemStage` in `script-state-recovery.ts` owns the production cursor.
It now passes the scripted ask to `replyAnswersAsk`, but the old answer rule
treated every “not yet” as a deferral except for a trading-specific phrase.
The answered-question ledger in `ai-engine.ts` and anchored extraction in
`script-variable-resolver.ts` still called the same rule without that ask.
That could leave their view of an answered question behind the cursor.

The replacement rule considers the first declarative clause after “not yet”
when the script offers alternatives. It accepts a stated current state or a
word from the offered alternative; it rejects clarification questions that
only quote those words. The ledger and anchored extraction now pass their
matched scripted ask to the shared rule. This is still a deterministic
heuristic, not a general semantic understanding of every possible reply.

## Reproducible benchmark and checks

Run `NODE_PATH=$PWD/node_modules npx tsx
tests/benchmarks/answer-satisfaction-benchmark.ts` from the repo root. The 26
cases cover the live turn, other either/or asks, deferrals, price questions,
clarifications, location, capital, and goal answers. The deployed `9ec9069`
rule scores 22/26; the replacement scores 26/26. These are curated regression
cases, not a population accuracy estimate.

Targeted unit tests: 36/36. TypeScript: pass. The broader
`script-state-recovery.test.ts` suite has one existing failure in 57 tests:
`bug-58-target-income-must-be-captured-by-its-own-ask` stores 8000 instead
of leaving the income field undefined. The same 56/57 result was reproduced
on an isolated checkout of `9ec9069`. That issue remains open separately.

## Acceptance still needed

Commit `8ae38df` deployed and the controlled rerun used conversation
`cmuiigvvx0003l504j7mbdfek`. The Step 2 reply “nah not yet, still in the
learning phase” completed Step 2 and the next turn delivered the Step 3 bridge
and link offer as three distinct Meta-ID bubbles. That closes the specific
Step 2 repeat failure.

The same run exposed a separate link-routing defect: the lead said “definitely
send the link,” but the router locked Step 4 “Hesitant” and asked permission
again. After a second yes, it locked Step 5 “Not in yet” without having sent
the link. The Step 5 classifier trace recorded a high token score of 21 for
“Not in yet” versus 5 for the next branch, so it never called the model. The
token scorer had included two older replies containing “not yet.” A regression
test reproduced the Step 4 wrong choice on the deployed code. The candidate
change scores the latest reply only; earlier messages and the verified prior
branch remain available to the model when it needs context. In a local check
using the production Step 5 script, the model selected “Hesitant, now yes.”
The link-routing fix still needs its own production proof.

The test driver's database pooler connection dropped during Turn 5. The turn
itself finished and sent two Meta-ID messages. The driver's first attempt to
restore the temporary response delay also lost database access. Once the pooler
recovered, the delay was manually verified and restored from 0–0 to 0–250
seconds. The driver now retries restoration through a transient outage.

A clean native Instagram inbound and the full intended script path still
require separate acceptance evidence.
