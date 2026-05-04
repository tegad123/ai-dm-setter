# Conversation Fixtures

Regression tests for QualifyDMs AI conversation behavior. Every
fixture pins one production bug pattern: the conversation that
triggered it, the recorded assistant reply, and the assertion that
catches its return.

## Run

```sh
npm run test:conversations
```

The runner prints PASS/FAIL per fixture with evidence and exits
non-zero on any failure.

## Adding a new fixture

When a new bug class lands in production, add a fixture so the
suite catches its return.

1. **Pick a bug number.** Next available integer past the highest
   `bug-NN-*.fixture.ts` filename.
2. **Choose a slug.** Short kebab-case noun phrase
   (`fabricated-stall`, `wrong-route-below-threshold`).
3. **Create `bug-NN-<slug>.fixture.ts`.** Copy the structure from
   any existing fixture. Include:
   - A header comment block: what the bug was, when it was found,
     which file/PR fixed it.
   - `conversationHistory` — the messages leading up to the bug.
   - `lastLeadMessage` — the message that triggered the bug.
   - `recordedAssistantReply` — the assistant reply (post-fix
     clean output, OR a buggy candidate when the assertion runs
     a stripping gate like R34 metadata-leak).
   - `expectedBehavior` + `forbiddenBehavior` — plain English,
     used by humans reading test failures.
   - `assertion` — pick one of the supported types in `types.ts`.
4. **Run the suite.** New fixture should pass against current
   `main`. If it fails, either the fix has regressed (open an
   issue) or the fixture is wrong (tighten it).

## Assertion types

Defined in [`types.ts`](./types.ts), implemented in
[`assertions.ts`](./assertions.ts):

| Type | What it checks |
|---|---|
| `FORBIDDEN_PHRASE_ABSENT` | Reply (after R34 strip if applicable) contains none of `forbiddenPhrases` / `forbiddenPatterns`. |
| `REQUIRED_URL_PRESENT` | Reply contains `personaConfig[requiredUrlField]` AND passes `replyDeliversArtifact`. |
| `URL_ALLOWLIST_CHECK` | Every URL in reply matches a persona-configured URL prefix. |
| `STAGE_CHECK` | `systemStage` is not in `forbiddenStages` (and matches `expectedStage` if set). |
| `DATA_POINT_CAPTURED` | After re-running `extractCapturedDataPointsForTest` over history+lastLeadMessage, the named key is captured. |
| `STAGE_ADVANCE` | `capitalThresholdMet === true` AND no re-ask phrases in reply. |
| `CONVERSATION_CONTINUES` | Reply is non-empty AND `forbiddenPhrases` absent. |
| `RESPONSE_GENERATED` | `recordedAssistantReply` is non-empty. |
| `TOPIC_ACKNOWLEDGED` | Reply contains at least one of `topicKeywords`. |
| `BURST_ACKNOWLEDGED` | Reply hits a topic keyword OR `acknowledgesEmotionally` returns true. |
| `CORRECT_ROUTE` | Reply contains the expected route's URL; no forbidden-route phrases. |
| `PREREQUISITE_GATE_ENFORCED` | When prerequisites unmet, `containsCallPitch` / `containsCallOrBookingAdvancement` is false on the reply. |
| `ACCEPTANCE_HONORED` | When `isExplicitAcceptance(lastLeadMessage)` is true, reply must contain the promised URL. |
| `INTENT_DEDUP_ENFORCED` | When prior AI message matched any `intentMatchPatterns`, current reply must not match the same patterns. |
| `POSITIVE_ACKNOWLEDGED` | Reply contains a positive-ack keyword or `acknowledgesEmotionally` returns true. |

## What the suite catches (and what it doesn't)

The runner exercises **gate code** (R34 metadata-leak strip, R37
acceptance/burst, capital-data-point extraction, stage prerequisite
checks) against fixture inputs. It does **not** call Anthropic — the
recorded reply stands in for a captured LLM output.

This means:

- ✅ Regressions in gates / state extraction / URL allowlist /
  prompt-side directives that ship as gate functions.
- ✅ Documented expectations for how the AI should behave in each
  scenario.
- ❌ Regressions in the LLM prompt itself — only caught when the
  recorded replies are re-captured. Re-record by running the real
  pipeline against each fixture's `conversationHistory +
  lastLeadMessage`, replacing the `recordedAssistantReply` field.

## CI

The suite runs on every PR via
[`.github/workflows/conversation-fixtures.yml`](../../.github/workflows/conversation-fixtures.yml).
No DB or Anthropic key required — fixtures are hermetic.
