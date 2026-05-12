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
