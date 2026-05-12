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

_None yet — v1 ships with a single passing scenario._
