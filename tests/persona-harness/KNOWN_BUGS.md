# Known Production Bugs Surfaced by the Persona Harness

Entries here are scenarios where the harness reproduces a real
production bug. Each entry records what fails, the persona/scenario, a
short repro, and a link to the prod-side fix branch (when one exists).

**Rule:** the fix for any bug listed here ships on a separate branch.
This harness is read-only with respect to production source.

## Template

```
### <slug>/<scenario-id> — <short title>

- Discovered: YYYY-MM-DD
- Persona file: tests/persona-harness/personas/<slug>.persona.ts
- Failing assertion: <type + value>
- Symptom: <one-line description>
- Root cause: <best understanding; "unknown" is allowed>
- Prod fix branch: <branch name or "not started">
- Re-evaluate: when the prod fix lands, flip
  `expected: 'fail'` off and re-run the harness.
```

## Active entries

### bug-001 — persona-b-capital-disqualified / call-proposal stage — prereq gate uses snake_case keys but script captures camelCase; AI ships unresolved `{{...}}` template literals on fallback

**Status: PARTIAL FIX (2026-05-12).** Codex shipped 8c6ccc4 + eaaf17a
on `main` adding the `beliefBreakDelivered → belief_break_delivered`
mapping and template-variable resolution in the self-recovery
fallback. Re-running the harness with the fix confirms
`belief_break_delivered` is no longer reported missing. However the
companion mapping for `incomeGoal → income_goal` was not added, so
the same deadlock recurs at Step 16 with one prereq still missing —
tracked separately as **bug-001b** below.

- Discovered: 2026-05-12
- Persona file: [tests/persona-harness/personas/persona-b-capital-disqualified.persona.ts](personas/persona-b-capital-disqualified.persona.ts)
- Discovered at: turn 13 (Step 16 — Call Proposal)
- Run cost when discovered: 53 LLM calls, $0.13, 297s
- Failing assertions: scenario halted with `HARNESS_ERROR` before
  step 16 assertions could fire; downstream assertions (steps 18, 19
  — LINK_SENT `whop.com/checkout`, `$497`, NO_FABRICATED_URL) never
  executed.

#### Symptom

The voice quality gate exhausts its 3-attempt retry budget and refuses
to ship, blocking the call proposal at Step 16. Two distinct gate
failures stack on the same generation:

```
[bubble=1] call_proposal_prereqs_missing:
  missing=step 9 (income_goal), step 13 (belief_break_delivered).

[bubble=0] r34_metadata_leak: matched "{{obstacle}}" via /\{\{[^}]+\}\}/
[bubble=1] r34_metadata_leak: matched "{{income_goal}}" via /\{\{[^}]+\}\}/
```

#### Root cause analysis

This appears to be **two coupled bugs**:

**1. Naming convention mismatch between captured data and prereq check.**

The script-state recorder stores captured data in camelCase. From
the harness log at turn 13:

```
script-debug current step selection:
  capturedKeys: [
    'deep_why',           ← snake_case (mixed convention)
    'obstacle',           ← single word
    'incomeGoal',         ← camelCase
    'workDuration',       ← camelCase
    'monthlyIncome',      ← camelCase
    'workBackground',     ← camelCase
    'replaceOrSupplement',← camelCase
    'beliefBreakDelivered', ← camelCase
    'tradingExperienceDuration', ← camelCase
    ...
  ]
```

The call-proposal prereq check at Step 16 looks for snake_case
identifiers:

```
missing=step 9 (income_goal), step 13 (belief_break_delivered)
```

`incomeGoal` IS captured. `beliefBreakDelivered` IS captured. The
prereq gate can't see them because it's checking for `income_goal`
and `belief_break_delivered`. The convo gets stuck at Step 16
indefinitely even though every prerequisite is satisfied.

The mixed convention in capturedKeys (`deep_why` + `obstacle` +
camelCase others) suggests this drift accumulated over time as
different code paths wrote captured data with different naming
styles.

**2. Template-variable leak in self-recovery fallback.**

When the voice quality gate exhausts retries and the deterministic
matched-branch fallback ships, it embeds `{{obstacle}}` and
`{{income_goal}}` literals into the outbound message:

```
[bubble=0] r34_metadata_leak: matched "{{obstacle}}" via /\{\{[^}]+\}\}/
```

This means the fallback path is reading the raw scripted message
template and not running it through the variable resolver before
the R34 metadata-leak check. The R34 check then correctly rejects
the message — but the conversation deadlocks because there's no
path forward.

Bugs (1) and (2) compound: (1) prevents the AI from completing
Step 16, the gate forces self-recovery, self-recovery hits (2)
and is rejected by R34, no message ships, lead sees nothing.

#### Files likely involved (prod-side investigation starting points)

- `src/lib/script-state-recovery.ts` — captured-data point keys
- `src/lib/ai-engine.ts` — call-proposal prereq check + deterministic fallback
- `src/lib/script-variable-resolver.ts` — `{{...}}` resolution path
- `src/lib/voice-quality-gate.ts` — R34 metadata-leak detector +
  `call_proposal_prereqs_missing` rule

#### Repro

```bash
cd ai-dm-setter
npm run db:copy-daetradez              # one-time, populates fixture
npm run test:personas
```

Watch the log for the sequence:
1. Steps 1–14 fire normally with real AI replies (Dae voice intact).
2. Step 15 fires (Urgency / "is now the time").
3. Step 16 (Call Proposal) attempts generation 3 times.
4. Each attempt hits `call_proposal_prereqs_missing` + R34 leak.
5. Voice-gate-exhausted self-recovery fires, also rejected by R34.
6. `HARNESS_ERROR` — conversation deadlocks at step 16.

#### Prod fix branch

Not started. Handed off to Codex for fix on `main`.

#### Re-evaluate

When the prod fix lands and `npm run test:personas` reaches Step 19
(SLM downsell) without HARNESS_ERROR, the remaining 6 turns of the
scenario will fire and we'll get real signal on the `LINK_SENT`
(`whop.com/checkout`) and `$497` assertions. Until then,
HARNESS_ERROR at turn 13 is the expected output.

This is not a harness bug. The harness is doing its job: it
exercised the real production pipeline end-to-end against the real
persona + script + training data, and surfaced a deadlock that
would have shipped to leads.

### bug-001b — incomeGoal → income_goal mapping missing (companion to bug-001)

**Severity:** P0 — blocks all Persona B conversations at Step 16
(same deadlock symptom as bug-001).

**Discovered:** Persona B harness re-run after bug-001 partial fix,
2026-05-12.

**Status:** Awaiting fix on `main` branch.

#### Symptoms

After the bug-001 fix shipped (commits 8c6ccc4 + eaaf17a on `main`),
re-running the harness produces a single-prereq variant of the same
deadlock:

```
[ai-engine] Voice quality FAIL attempt 1/3: {
  hardFails: [
    "[bubble=1] call_proposal_prereqs_missing:
     missing=step 9 (income_goal).
     Resume the script from step 9 — lead's monthly income goal
     from trading. Do NOT propose a call until every prerequisite
     is captured."
  ]
}
```

And from the same turn's `script-debug current step selection`:

```
capturedKeys: [
  'obstacle',
  'incomeGoal',          ← IS captured, camelCase
  ...
  'beliefBreakDelivered' ← also camelCase; now recognized by 001 fix
]
```

`incomeGoal` is present in `capturedDataPoints` but the call-proposal
prereq check still looks for `income_goal`. After 3 retries the AI
escalates to human and the conversation deadlocks identically to
pre-fix bug-001.

#### Fix scope

Same normalization Codex added for `beliefBreakDelivered`. Add the
`incomeGoal → income_goal` entry to whichever map/normalizer was
introduced in commit 8c6ccc4 (`src/lib/script-step-progression.ts`).
Likely a single-line change. While there, audit the rest of
`capturedKeys` for any other camelCase keys the prereq check
references in snake_case — proactive coverage would prevent
bug-001c.

#### Files likely involved

- `src/lib/script-step-progression.ts` — where the bug-001 fix
  introduced the camelCase → snake_case map for captured-key prereq
  resolution. Add the `incomeGoal` entry here.
- `src/lib/voice-quality-gate.ts` — `call_proposal_prereqs_missing`
  rule that's still failing.

#### Reproduction

```bash
cd ai-dm-setter
npm run test:personas
```

Watch turn 13 (Step 16 — Call Proposal). Expected: 3 retries,
`call_proposal_prereqs_missing: missing=step 9 (income_goal)`,
`HARNESS_ERROR`, scenario halts.

#### Re-evaluate

When the second-half fix lands, the Step 16 deadlock should resolve
fully and turns 14–20 (capital question, SLM downsell, `LINK_SENT
whop.com/checkout`, `$497`, `NO_FABRICATED_URL`) will fire for the
first time, producing real signal on the SLM downsell path.

### bug-002 — Step 10 verbatim drift: `$1k` substitution missing OR opening verbatim phrase not rendered

**Severity:** P1 — Persona B turn 14 produces a Step 10 reply that
neither preserves the required opener verbatim nor carries the
substituted income-goal variable. Lead-facing voice survives but
operator-authored copy is silently dropped.

**Discovered:** 2026-05-12, persona-b harness rebased onto main
(bug-001 partial fix applied).

**Status:** Awaiting fix on `main`.

#### Symptoms

Step 10 (Desired Outcome — Deep Why) has a required verbatim
opener and a templated `$1k` ASK pulled from the lead's captured
`incomeGoal`:

```
[MSG] REQUIRED MESSAGE (send verbatim, do not paraphrase or reorder):
  "I respect that bro, I truly do. I hear so many people talk
   about cars and materialistic stuff so it's refreshing to hear
   this haha."
[ASK] REQUIRED QUESTION (ask immediately after the preceding [MSG]):
  "But why is $1k so important to you though? Asking since the
   more I know the better I'll be able to help."
```

Both harness assertions failed on turn 14:

```
× turn 14: "I respect that bro" missing from reply
× turn 14: "$1k" missing from reply
```

This is despite `capturedKeys` already containing `incomeGoal:1000`
at turn 7, and the serializer log on turn 7 (Step 10 entry) showing
the script editor pre-substituted `$1k` into the canonical message
text. So the script-side substitution worked, but the reply that
shipped didn't match either the substituted ASK or the verbatim
[MSG] opener.

The voice-quality-gate logs for turn 14 show `aiGen=8.0s` with
`Stage override applied ... -> Desired Outcome — Deep Why` but no
verbatim-violation hard fail at the gate. The gate accepted a
paraphrase.

#### Fix scope hint

Two possibilities, both worth investigation:

1. The verbatim check at Step 10 may not be enforcing the
   [MSG] field as strictly as it does at Steps 1 / 13 where
   verbatim violations DO trigger retries. Check whether Step 10's
   `RUNTIME MESSAGE DIRECTIVE` form (vs. `REQUIRED MESSAGE`
   verbatim form) accidentally relaxes the gate.
2. The `$1k` substitution may have happened in the prompt the LLM
   saw, but the LLM-generated reply chose its own number wording
   that didn't survive the no-verbatim-enforcement at this step.

#### Files likely involved

- `src/lib/voice-quality-gate.ts` — `msg_verbatim_violation` rule;
  check whether Step 10's [MSG] is opted out
- `src/lib/script-variable-resolver.ts` — `$1k` substitution in the
  required [ASK] text
- `src/lib/ai-engine.ts` — the regen loop that successfully forces
  verbatim retries at other steps

#### Reproduction

```bash
cd ai-dm-setter
npm run test:personas
```

After bug-001b is fixed and the conversation reaches Step 10
cleanly, the harness will surface this failure at turn 14. With
bug-001b still open, Step 10 fires on turn 7 of the harness (lead
message "honestly just like 1k extra a month would change
everything") — observe the AI reply generated at `aiGen=8.0s`
stage=`Desired Outcome — Deep Why` and verify it lacks `I respect
that bro` and `$1k`.

### bug-003 — Step 13 belief-break required verbatim phrases exhausted 3 retries and shipped paraphrase as best-effort

**Severity:** P0 — Persona B turn 20. The Belief Break is the
single most important emotional pivot in the daetradez script and
its required wording is shipping as paraphrase, meaning the
authority transfer (per the operator's [JUDGMENT] block: "shifts
their belief about what's actually wrong... authority perception
of you skyrockets") fails to land in production.

**Discovered:** 2026-05-12, persona-b harness rebased onto main
(bug-001 partial fix applied).

**Status:** Awaiting fix on `main`.

#### Symptoms

Step 13 — Belief Break — Reframe (branch: "Psychology / Discipline
symptom") has three required verbatim [MSG] blocks. Three harness
assertions failed on turn 20:

```
× turn 20: "99% of traders" missing from reply
× turn 20: "systems you have in place" missing from reply
× turn 20: "point A to point B" missing from reply
```

The voice quality gate exhausted retries with a `banned_phrase`
hard-fail that is *itself produced by the required verbatim*:

```
[ai-engine] Voice quality FAIL attempt 1/3: {
  score: '0.00',
  hardFails: [ '[bubble=0] banned_phrase: "let me explain"' ],
  message: "bro what if i told you 99% of traders that say that
            actually don't know what the real problem is? le..."
}
[ai-engine] Voice quality gate exhausted 3 attempts — sending best effort
```

The script's literal verbatim text contains "Let me explain." —
which is on the banned-phrase list. So the gate forbids a phrase
the operator-authored script REQUIRES. The two enforcement layers
are in direct conflict, and the gate wins by exhausting retries
and shipping a paraphrase that drops the rest of the Belief Break
content.

Two retry passes also tripped a `[JUDGE] branch mismatch — forcing
regen` against the same branch, suggesting the regen loop is
fighting itself.

#### Fix scope hint

Either:

1. Whitelist "let me explain" when it appears inside an
   operator-required [MSG] verbatim block (preferred — fixes the
   class of bug, not just this instance).
2. Edit the daetradez script to remove "Let me explain." from the
   Step 13 required text (single-script fix, doesn't address the
   underlying conflict).
3. Make verbatim [MSG] enforcement higher-priority than the
   banned-phrase list so verbatim wins when they collide.

Option 1 is the architectural fix. Codex should audit the
`banned_phrases` array for any other strings that appear in
operator-authored required [MSG] blocks across all live persona
scripts.

#### Files likely involved

- `src/lib/voice-quality-gate.ts` — `banned_phrase` rule; needs
  exemption for content inside operator-required verbatim [MSG]
  blocks
- `src/lib/ai-engine.ts` — the `[JUDGE] branch mismatch — forcing
  regen` loop that fires on top of the verbatim gate failure
- `src/lib/script-state-recovery.ts` — branch-history recording
  during retry-and-regen cycles

#### Reproduction

```bash
cd ai-dm-setter
npm run test:personas
```

(Once bug-001b is fixed, the harness will reach turn 20 cleanly.)
Observe turn 20 logs:
- `Voice quality FAIL attempt 1/3 ... banned_phrase: "let me explain"`
- `Voice quality gate exhausted 3 attempts — sending best effort`
- Three `AI_MESSAGE_CONTAINS` assertions failing on the canonical
  Belief Break phrases.

### bug-004 — Step 14 Lukewarm buy-in branch auto-advanced to Step 15 without waiting for lead reply

**Severity:** P0 — Persona B turn 22. The `[WAIT]` directive that
gates further progression on a lukewarm response was bypassed,
causing the script to advance into Step 15 (Urgency) prematurely.
Per the operator's [JUDGMENT] in Step 14: *"Do NOT proceed to call
proposal off a lukewarm response. You will burn the lead."* —
exactly the failure mode the script was authored to prevent.

**Discovered:** 2026-05-12, persona-b harness rebased onto main
(bug-001 partial fix applied).

**Status:** Awaiting fix on `main`.

#### Symptoms

The persona-b scenario expects Step 14 (Buy-In Confirmation) to
remain active across two lead turns: first asking the lukewarm
probe, then waiting for the real-yes response. The harness saw
the step jump from 14 to 15 between turns:

```
× turn 22: "ready" missing from reply
× turn 22: step expected 14, got 15
```

From `script-debug` on turn 22:

```
snapshotCurrentScriptStep: 15,        ← advanced
inferredStepNumberForGate: 15,
conversationTurnCount: 12,
currentStepTitle: 'Urgency (CONDITIONAL)',
```

The Step 14 lukewarm branch definition has:

```
IF Lukewarm buy-in:
    [MSG] REQUIRED MESSAGE: "bruh 😂 brother I'm genuinely trying
      to help you out... So what's really on your mind?"
    [WAIT] Wait for response       ← should hold the step
    [JUDGMENT] If they warm up... → proceed to STEP 15.
```

The branch fired the message but the [WAIT] directive did not
hold. Step advanced on the very next inbound (which in the
scenario is `"yeah man im ready..."` — the [JUDGMENT] would have
correctly promoted this to Step 15 *if read*, but the harness
shows advancement happens before the judgment runs).

#### Fix scope hint

Investigate whether [WAIT] step-hold is checked before [JUDGMENT]
re-evaluation in the script step-progression machinery. The
expected control flow is:

1. AI sends [MSG] from Step 14 lukewarm branch.
2. Lead replies.
3. [JUDGMENT] re-evaluates branch (warm-up → promote, real
   objection → stay, cold → exit).
4. Only if [JUDGMENT] says promote, advance to Step 15.

It looks like the advance is firing on step 3 inputs without
honoring the lukewarm [WAIT].

#### Files likely involved

- `src/lib/script-step-progression.ts` — [WAIT] honoring vs.
  step-advance logic
- `src/lib/branch-classifier.ts` — branch re-evaluation on the
  follow-up turn
- `src/lib/script-state-recovery.ts` — `step_completed` event
  emission that triggers the advance

#### Reproduction

```bash
cd ai-dm-setter
npm run test:personas
```

(Once bug-001b is fixed, the harness will reach turn 22 cleanly.)
Observe:
- Turn 21 (lead "yeah man im ready, im tired of being stuck"):
  the script should stay on Step 14 and re-evaluate the lukewarm
  branch's [JUDGMENT].
- Instead `snapshotCurrentScriptStep: 15` and the Urgency branch
  fires.

### bug-005 — Captured-data key non-determinism + classifier mis-selection on Step 14 buy-in

**Severity:** P1 — affects routing accuracy and assertion stability
across multi-run consistency. Two distinct sub-issues that both
surfaced in the same persona-b harness re-run.

**Discovered:** Persona B harness re-run after bugs 001b / 002 /
003 / 004 fixes, 2026-05-12.

**Status:** Awaiting fix on `main` branch.

#### Part A — Captured-data key naming is non-deterministic

The same conceptual data (the lead's emotional why) gets stored
under **different keys across otherwise identical runs**:

```
Run 1 (post bug-001 fix):
  capturedKeys: [..., 'deep_emotional_why', ...]

Run 2 (post commits e295922 + c492473, same scenario, same lead
       messages, same Step 12 → 13 flow):
  capturedKeys: [..., 'deep_why', ...]
```

The conversation path is identical, the lead message is identical
(`"i just want to be the dad i never had, be home for bath time
and story time"`), and the script step is identical (Step 12 /
Obstacle Identification). Only the extraction-output key name
differs.

**Symptoms:**

- Inconsistent key in `capturedDataPoints` across identical
  conversations.
- Any downstream code that reads by name (prereq checks, gates,
  prompt-variable substitution) silently passes on one run and
  fails on the next.
- Harness scenarios can't reliably assert
  `CAPTURED_DATA_HAS deep_why` (or any other variant). Commit
  e295922 changed the scenario to `deep_emotional_why` based on
  one log; the next run flipped back to `deep_why`. Commit 7
  reverts to `deep_why` to match the most recent run, but the
  underlying non-determinism remains.

**Fix scope:**

Captured-data extraction should write a **canonical key name**
regardless of LLM phrasing variation. Either:

1. Normalize all "why" extractions to a single key
   (e.g. always `deep_why`) inside the extraction pipeline.
2. Post-process extraction output through a canonical-name map
   that collapses LLM-produced variants (`deep_emotional_why`,
   `why`, `deep_motivation`, etc.) to a single key.

This is **generic across all clients** — applies to any captured
field where the AI extraction might produce variant key names.

**File pointers:**

- `src/lib/captured-data-extractor.ts` (or wherever extraction
  output is normalized before being written to
  `capturedDataPoints`)
- `src/lib/script-state-recovery.ts` (where `capturedDataPoints`
  is persisted; could also be the right layer to enforce
  canonical names)

#### Part B — Classifier mis-selects "Lukewarm buy-in" for clear conviction language

At Step 14 (Buy-In Confirmation), the lead message
`"honestly bro that would change everything for me and my family"`
was classified into the `Lukewarm buy-in` branch.

**Expected:** `Clear buy-in` branch. The script's branch
definitions for Step 14 distinguish:

```
IF Clear buy-in:
  [JUDGMENT] Clear buy-in = "yes bro that's exactly what I need"
    / "100%" / "that would change everything" / "man that's
    literally my problem" / any affirmative with real energy
    behind it.

IF Lukewarm buy-in:
  [JUDGMENT] Lukewarm = "yeah that could work" / "maybe" /
    "possibly" / "yeah that would help I guess" / anything
    without conviction.
```

The lead message uses *"would change everything for me and my
family"* — verbatim a Clear-buy-in indicator and explicit
emotional weight (family). The classifier picked Lukewarm.

**Symptoms (this harness run):**

- Turn 22 reaches Step 15 (Urgency) via the lukewarm probe
  instead of routing through Clear buy-in → Step 16.
- The conversation receives an unnecessary "is now the time"
  urgency push that the script explicitly says to skip when
  momentum is already strong.
- The `AI_MESSAGE_CONTAINS "ready"` assertion fails — the Clear
  buy-in branch contains *"you ready to do what it takes to
  actually fix this?"* but Lukewarm doesn't.

From the harness log:

```
[branch-classifier] LLM RESULT: {
  stepNumber: 14,
  success: true,
  selectedLabel: 'Lukewarm buy-in',
  ...
}

× turn 22: "ready" missing from reply
× turn 22: step expected 14, got 15
```

**Fix scope:**

Three options, not mutually exclusive:

1. Add training/example pairs that disambiguate emphatic
   conviction ("would change everything", "for my family")
   from hedging ("maybe", "could work") to the branch
   classifier prompt.
2. Strengthen the branch condition descriptions on the
   daetradez Step 14 script so the LLM has more explicit
   cues for Clear vs Lukewarm.
3. Raise the threshold for "Lukewarm" selection so emphatic
   language tips into Clear unless real hedging signals are
   present.

This is also **generic across all clients** — any branch
classifier that disambiguates positive emphasis from neutral
acceptance will hit the same edge.

**File pointers:**

- `src/lib/branch-classifier.ts` — the LLM classification prompt
  and threshold logic for `Step 14` (see
  `selectJudgeBranchForLead` or equivalent entry function)
- `src/lib/ai-engine.ts` — branch-selection orchestration

#### Reproduction

Run `npm run test:personas` twice on `feature/persona-harness`
(rebased onto `main`'s bug-001 fix). Observe:

1. The captured key for the lead's "why" alternates between
   `deep_why` and `deep_emotional_why` across runs (Part A).
2. Turn 22's `STEP_IS=14` assertion fails because the classifier
   picked Lukewarm; `aiHistoryLen=16` shows the lukewarm probe
   fired but Step advanced anyway (Part B compounds with
   bug-004's [WAIT] bypass).

#### Re-evaluate

When Part A is fixed, commit 7's `deep_why` field in
[persona-b-capital-disqualified.persona.ts](personas/persona-b-capital-disqualified.persona.ts)
should pass on every run (no longer brittle).

When Part B is fixed, turn 22's STEP_IS and `"ready"` assertions
should pass; the conversation routes Clear buy-in → Step 16
directly, skipping the unnecessary Step 15 urgency push.

### bug-006 — `incomeGoal → income_goal` mapping STILL missing after bug-001b fix

**Severity:** P0 — blocks all Persona B conversations at Step 16
(same call_proposal deadlock as bug-001 / bug-001b).

**Discovered:** Persona B harness run 3, after Codex shipped all
six prior fixes (bug-001, bug-002, bug-003, bug-004, bug-005A,
bug-005B). 2026-05-12.

**Status:** Awaiting fix on `main` branch.

#### Symptoms

After commit `9ed1158` on `main` shipped the bug-001b fix
(adding `incomeGoal → income_goal` to the captured-key
normalizer), the harness re-run **still surfaces the same
`call_proposal_prereqs_missing` for `income_goal` at Step 16**:

```
[ai-engine] Voice quality FAIL attempt 1/3:
  hardFails: [
    "[bubble=1] call_proposal_prereqs_missing:
     missing=step 9 (income_goal)"
  ]
```

And from `script-debug` at the same turn:

```
capturedKeys: [..., 'incomeGoal', ...]
```

`incomeGoal` IS in `capturedDataPoints`. The bug-001b fix
clearly added a normalization somewhere — but the lookup path
that the Step 16 prereq check uses didn't pick it up. The fix
covered one site; there's at least one more.

#### Fix scope

Audit **every place** in `src/lib/voice-quality-gate.ts` (and
adjacent prereq-check code) that reads captured-data prereq
fields. The bug-001b fix patched one lookup. Other lookups
(including the one Step 16 hits) still read the raw camelCase
key without normalization.

**Recommended:** factor out a single canonical normalization
function — `resolveCapturedKey(rawKey: string): string` — and
route every prereq lookup through it. This prevents bug-007a,
bug-007b, ... showing up the next time a new prereq field is
added.

#### File pointers

- `src/lib/voice-quality-gate.ts` — `call_proposal_prereqs_missing`
  rule and all other prereq checks; audit every `capturedDataPoints[...]`
  read for missing normalization
- `src/lib/script-step-progression.ts` — where commit 9ed1158
  added the first map; co-locate the canonical normalizer here
  if it isn't already centralized

#### Reproduction

```bash
cd ai-dm-setter
git fetch origin main
git checkout feature/persona-harness
git rebase main          # pull in 9ed1158
npm run test:personas
```

Watch turn 13 (Step 16 — Call Proposal). Expected: 3 retries,
`call_proposal_prereqs_missing: missing=step 9 (income_goal)`,
`HARNESS_ERROR`, scenario halts — same shape as bug-001b.

### bug-007 — Step 10 numeric substitution corrupted ($1k → $6)

**Severity:** P1 — breaks the call-proposal narrative; the
operator-authored Step 10 [ASK] is the emotional pivot ("why is
$1k so important to you?") and shipping `$6` instead destroys
the impact.

**Discovered:** Persona B harness run 3, 2026-05-12.

**Status:** Awaiting fix on `main` branch.

#### Symptoms

The script flow on this turn was:

1. Turn 7 (Step 9, Income Goal, Wants to supplement branch):
   captured `incomeGoal = 1000` from lead's `"1k extra a month"`.
2. Turn 8 (Step 10, Desired Outcome — Deep Why):
   `[ASK]` template = `"But why is $1k so important to you though?
   Asking since the more I know the better I'll be able to help."`

The template's `$1k` is a variable substitution token resolved
from `capturedDataPoints.incomeGoal`. What shipped was:

```
[ASK] REQUIRED QUESTION: "But why is $6 so important to you though?..."
```

`$6` is **not** any value in `capturedDataPoints`. `incomeGoal`
was correctly captured as `1000`. Something between resolver
input (`1000`) and rendered token (`$6`) corrupted the value.

#### Possible cause

Substring indexing instead of formatting:

- `Math.floor(1000 / 1000)` → 1, then formatted as `"$1k"` —
  the documented path that works elsewhere.
- A different code path may have done something like
  `String(amount)[0]` (returns `'1'`) plus `'k'` — correct
  ASCII collision but doesn't explain `$6`.
- More likely: a number-to-tier mapping (e.g. brackets) or a
  pricing/threshold lookup tripped a wrong index. `$6` is the
  6th element of *something*, or an off-by-one into a tier
  table.
- Or: a multiplier got mis-applied (`1000 / 167 ≈ 6`).

The harness can't distinguish these from logs alone — Codex
should add an instrumentation log of the raw and formatted
value at the moment of substitution.

#### Fix scope

Investigate `src/lib/script-variable-resolver.ts` numeric
formatting paths used by Step 10's `[ASK]`. Specifically:

1. What does the resolver receive for `incomeGoal` at this
   substitution call? (Add temporary debug log.)
2. What format function is applied? Is there a tier-bracket
   or pricing table that might mis-resolve to `$6`?
3. Confirm the `$1k` rendering used elsewhere (e.g. inside the
   capital-question copy at Step 18) goes through the same
   path or a different one.

If it's a divergent path, unify it on the canonical formatter
used by working steps.

#### File pointers

- `src/lib/script-variable-resolver.ts` — variable substitution
  and numeric formatting
- `src/lib/ai-engine.ts` — the call site that invokes the
  resolver for Step 10 [ASK]

#### Reproduction

Run the persona-b harness; observe the AI reply on turn 14
(Step 10, post-lead `"honestly just like 1k extra a month would
change everything"`). Expected: `"But why is $1k so important
to you though?"`. Actual: `"But why is $6 so important to you
though?"`.

### bug-008 — `{{their field}}` literal leak in Step 7

**Severity:** P1 — breaks Step 7 [MSG] delivery, fires R34
metadata-leak gate, escalates to operator pause (no platform
send). Affects every persona that uses `{{their field}}` (or
`{{their job}}` / `{{field}}`) as a variable. Also observed in
**earlier production conversations tonight**, not just the
harness — this is shipping to real leads.

**Discovered:** Persona B harness run 3 + concurrent production
session observation, 2026-05-12.

**Status:** Awaiting fix on `main` branch.

#### Symptoms

Step 7 (Monthly Income, Default branch) has:

```
[MSG] REQUIRED MESSAGE: "Yeah I feel you, I mean I'm not an
  expert in {{their field}} haha but I do know it's quite
  different than trading man."
```

Lead context: `workBackground = "retail"` (captured at Step 5).

**Expected:** `"Yeah I feel you, I mean I'm not an expert in
retail haha but I do know it's quite different than trading
man."`

**Actual:** Unresolved literal `{{their field}}` ships through
to the verbatim check, R34 metadata-leak rule fires, gate
exhausts retries, escalates to operator:

```
[ai-engine] Voice quality FAIL:
  hardFails: ['[bubble=0] r34_metadata_leak:
    matched "{{their field}}" via /\{\{[^}]+\}\}/']
[webhook-processor] r34_metadata_leak_at_ship — Pausing AI,
  notifying operator, no platform send.
```

#### Root cause

`{{their field}}` is not in the current variable-resolver alias
map. Compare to the alias added earlier tonight in commits
`8c6ccc4` + `eaaf17a` for `{{their stated goal}} → incomeGoal`.
Same class of fix needed for the work-related variables.

#### Fix scope

Add to `src/lib/script-variable-resolver.ts` aliases:

```ts
'their field' → workBackground
'their job' → workBackground
'field' → workBackground
'job' → workBackground
```

Same shape as the `{{their stated goal}}` → `incomeGoal` alias
already in place. Audit the daetradez script (and other live
scripts) for other natural-language variable references that
operators have authored but the resolver doesn't yet recognize.

This is **generic across all clients** — any persona script
that uses prose-style variable references (`{{their X}}`)
needs the alias map kept current. Long-term: consider an
extraction pass over the script that warns the operator at
edit time if a `{{...}}` token doesn't resolve to a known alias.

#### File pointers

- `src/lib/script-variable-resolver.ts` — alias map
- `src/lib/voice-quality-gate.ts` — R34 metadata-leak rule
  (the canary that surfaced this; not the fix site)

#### Reproduction

Run the persona-b harness. Turn 9 (Step 7 — Monthly Income):
observe `[ASK-BRANCH EVAL]` reply containing unresolved
`{{their field}}` literal, R34 fires, operator pause.
Production sessions tonight showed the same.

### Side note — banned_word vs operator-required verbatim conflict (also seen at Step 11)

Same class as **bug-003** ("Let me explain." on Step 13). At
Step 11 (Desired Outcome — Probe if Surface, "Surface — needs
second probe" branch), the operator-authored `[ASK]` contains
the word "specifically":

```
[ASK] REQUIRED QUESTION: "But like specifically is there
  something personal you're hoping trading will help you achieve?
  Something beyond just the money?"
```

The voice quality gate's `banned_word` list includes
"specifically". Gate exhausted 3 retries, shipped best-effort
paraphrase:

```
[ai-engine] Voice quality FAIL attempt 1/3:
  hardFails: ['[bubble=0] banned_word: "specifically"']
...
[ai-engine] Voice quality gate exhausted 3 attempts — sending
  best effort
```

This is the **same architectural conflict** documented in
bug-003. If Codex's bug-003 fix narrowly exempted only the
specific "Let me explain." occurrence, the same pattern recurs
here. The architectural fix — exempt the entire `banned_word`
and `banned_phrase` list when content sits inside an
operator-required verbatim `[MSG]` or `[ASK]` block — would
cover both Step 13 and Step 11 in one stroke.

If bug-003 was already fixed architecturally, this note is
informational only and turn 18 should pass on the next run.
