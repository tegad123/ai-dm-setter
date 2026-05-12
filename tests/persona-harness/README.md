# Persona Testing Harness

End-to-end regression harness for AI personas. Drives the production
webhook pipeline (`processIncomingMessage` → classifier → `generateReply`
→ quality gates → scheduled-reply drain) against a real test database,
with `globalThis.fetch` stubbed so we don't actually DM anyone.

## Isolation

This harness is **additive only**. It lives entirely under
`tests/persona-harness/` and imports from production source as a
read-only consumer. Verification step 5 (`git diff --stat main...HEAD --
'src/**' 'prisma/**'`) must show zero changes.

## Quick start

1. Provision a Postgres test database. Apply the prod schema:
   ```bash
   TEST_DATABASE_URL=postgres://qdms:qdms@localhost:55432/qdms_test \
     npm run db:migrate-test
   ```
2. Set env in `.env.test.local`:
   ```
   TEST_DATABASE_URL=postgres://qdms:qdms@localhost:55432/qdms_test
   ANTHROPIC_API_KEY=sk-ant-...
   # optional
   OPENAI_API_KEY=sk-...
   HARNESS_OPENAI_MODEL=gpt-4o-mini
   PERSONA_HARNESS_MAX_COST_USD=0.50
   ```
3. Run:
   ```bash
   npm run test:personas
   ```

The harness will:
- refuse to start if `TEST_DATABASE_URL` is unset, byte-identical to
  `DATABASE_URL`, or shares host+db with prod;
- sweep any orphan rows prefixed `test-harness-` from a previous run;
- seed each persona's Account/AIPersona/IntegrationCredential;
- per scenario, seed a Lead + Conversation, then run the turns;
- after each persona, delete every row tied to it;
- after all personas, final-sweep + orphan-count report.

## Adding a persona

1. Copy `personas/_example.persona.ts` to
   `personas/<slug>.persona.ts` (the leading underscore on the template
   excludes it from auto-discovery).
2. Fill in `personaConfig` — at minimum `personaName`, `fullName`,
   `systemPrompt`.
3. Add `scenarios[]` with `turns: [{role:'lead'|'assertions'} ...]`.
4. Re-run `npm run test:personas`.

## Assertion vocabulary

See `types.ts → AssertionType`. Examples:

| type | use |
|---|---|
| `AI_REPLY_NOT_EMPTY` | AI actually responded |
| `AI_REPLY_MAX_CHARS` | enforce brevity, `value: 280` |
| `AI_MESSAGE_CONTAINS` / `PHRASE_PRESENT` | case-insensitive substring (alias) |
| `FORBIDDEN_PHRASE_ABSENT` / `PHRASE_ABSENT` | substring must NOT appear |
| `PHRASE_MATCHES` | `pattern: '\\bbook(ed|ing)\\b'` |
| `STAGE_IS` / `STAGE_ADVANCED` | `value: 'EXPERIENCE'` |
| `STEP_IS` / `STEP_REACHED` | `value: 14` (currentScriptStep == / >=) |
| `CAPTURED_DATA_HAS` | `field: 'monthlyIncome'` (or `key:`) |
| `CAPTURED_DATA_VALUE` / `CAPTURED_DATA_EQUALS` | `field`, `value` — compares `.value` of the CapturedDataPoint object |
| `BRANCH_SELECTED` | `step: 19, value: 'Below $1500 — Downsell'` |
| `BRANCH_HISTORY_HAS_EVENT` | `step: 15, eventType: 'step_skipped'` (aliases `conditional_skip_decision` w/ skipDecision='skip') |
| `LINK_SENT` | `urlContains: 'whop.com/checkout'` |
| `NO_FABRICATED_URL` | every URL in reply matches the persona's URL allowlist (freeValueLink, downsellConfig.link, promptConfig.{bookingTypeformUrl, downsellLink, ...}) |
| `NO_TEMPLATE_LEAK` | reply has no `{{...}}`, `${...}`, `<<...>>`, `[[...]]`, or stray "undefined" |
| `NO_QUALITY_GATE_FAILURE` | no ScheduledReply marked FAILED_QUALITY_GATE and no Notification created |
| `LEAD_INTENT_TAG` | `value: 'PRE_QUALIFIED'` |
| `INBOUND_QUALIFICATION_WRITTEN` | classifier fired on turn 1 |
| `SCHEDULED_REPLY_EXISTS` | AI reply actually persisted |
| `NOTIFICATION_CREATED` | quality-gate escalation happened |

Captured-data values come from the production `CapturedDataPoint` wrapper
(`{ value, confidence, extractionMethod, ... }`). `CAPTURED_DATA_VALUE`
compares the inner `.value`. `branchHistory` is read from
`Conversation.capturedDataPoints.branchHistory` — populated by
`script-state-recovery` and `ai-engine` during a turn.

## Real prod-persona scenarios

The shipped Persona B file (`personas/persona-b-capital-disqualified.persona.ts`)
encodes the real prod scenario but uses a placeholder `personaConfig`
so the harness compiles. Step- and branch-level assertions will only
produce reliable signal once you:

1. Dump the real persona row + parsed Script / ScriptStep / ScriptBranch
   into the test DB (see `scripts/dump-daetradez-persona.ts` and
   `scripts/dump-daetradez-script.ts` for prod-side dump helpers).
2. Paste the dumped values into the persona file's `personaConfig`
   (or wire up a future `loadFromTestDb` mode — not yet supported).

Until then, expect step- and branch-based assertions to FAIL. The
quality-gate, template-leak, and fabricated-URL assertions still
produce meaningful signal against any persona config.

The retired synthetic `dae-script` persona lives at
`personas/_dae-script.persona.ts` (leading underscore excludes it from
auto-discovery) for reference.

## Expected failures

If a scenario surfaces a production bug, **do not fix it from this
branch**. Instead:

1. Add an entry to `KNOWN_BUGS.md` describing the bug + repro.
2. Set `expected: 'fail'` on the scenario.
3. The runner will report it as `EXPECTED_FAIL` (not `FAIL`) and exit 0.

The production fix lives on its own branch.

## Cost + rate-limit handling

`network-stub.ts` wraps `globalThis.fetch`:
- Meta IG/FB Send API → returns synthetic success (no DM is sent).
- Audio transcription → stubbed (payloads should carry no audio).
- Anthropic / OpenAI → real calls, with token usage tracked and 429
  retries (exp backoff, max 60s, max 3 retries, then
  `RateLimitExhaustedError`).

A persona is flagged if it exceeds 60s wall-clock or
`PERSONA_HARNESS_MAX_COST_USD` (default `$0.50`).

## Verification

Run from `ai-dm-setter/`:

```bash
npx tsc --noEmit
npm run test:conversations
npx tsx --test tests/unit/*.test.ts
npm run test:personas
git diff --stat main...feature/persona-harness -- 'src/**' 'prisma/**'
```

The diff command must print **no output**. If it does, the harness has
violated isolation.

## Layout

```
tests/persona-harness/
├── README.md            # this file
├── KNOWN_BUGS.md        # expected-fail catalogue
├── runner.ts            # entrypoint
├── types.ts             # PersonaScenario / Assertion shapes
├── lib/
│   ├── safety-guard.ts  # DB URL guard — MUST import first
│   ├── errors.ts
│   ├── pricing.ts
│   ├── db-seed.ts
│   ├── db-cleanup.ts
│   ├── payload-factories.ts
│   ├── network-stub.ts
│   ├── invoke-pipeline.ts
│   └── assertions.ts
├── personas/
│   ├── _example.persona.ts
│   └── dae-script.persona.ts
└── fixtures/
    └── README.md
```
