# Response delay fix — 2026-04-28

## Bug

User set delay = 2–10 min on the Settings → Account page. Production
shows AI replying in <60s consistently. Diagnostic confirms daetradez
Account row has `responseDelayMin=120, responseDelayMax=600` saved
correctly. **The setting is being silently overridden by the debounce cap.**

In `src/lib/webhook-processor.ts` ~line 2058:
```ts
const preferredFireAt = now + Math.max(debounceSec, delayRandomSec) * 1000;
const maxFireAt = earliestLeadInBatch
  ? earliestLeadInBatch.timestamp.getTime() + maxDebounceSec * 1000
  : preferredFireAt;
const fireAt = Math.max(now + 1000, Math.min(preferredFireAt, maxFireAt));
```

`maxDebounceWindowSeconds` (default 120s) is intended to bound the
DEBOUNCE phase — preventing infinite postponement when a lead keeps
typing. But it's used to cap the FINAL fire time, which clamps
`responseDelayMax=600` down to 120s.

Daetradez trace:
- delayRandomSec = random(120, 600) — say 240
- preferredFireAt = now + 240s
- maxFireAt = earliestLead + 120s ≈ now + 90s
- fireAt = min(240, 90) = **90s** ← bug

## Fix

Separate the debounce ceiling from the response-delay floor:
```ts
// Cap on how long we WAIT FOR MORE lead messages (debounce phase).
const debouncedFireAt = earliestLeadInBatch
  ? Math.min(
      now + debounceSec * 1000,
      earliestLeadInBatch.timestamp.getTime() + maxDebounceSec * 1000
    )
  : now + debounceSec * 1000;
// Response delay floor — operator-configured, always honored.
const responseDelayFireAt = now + delayRandomSec * 1000;
const fireAt = Math.max(now + 1000, debouncedFireAt, responseDelayFireAt);
```

Effect: debounce still caps how long we wait for more lead messages;
response delay is independent and always applied.

## Validation (API routes)

`/api/settings/account` POST: enforce min ≥ 30s, max ≥ min, max ≤ 3600s.
Mirror on `/api/settings/persona`.

## Defaults

`computeReplyDelaySeconds` + the inline path use `?? 0` fallback. With
Postgres `@default(300)` columns, existing rows have values, so the
fallback rarely matters — but safer to default to (45, 120) so a brand-
new account or missing column never produces a 0-second delay.

## Files

- `src/lib/webhook-processor.ts` — fix cap logic + sane defaults
- `src/app/api/settings/account/route.ts` — add validation
- `src/app/api/settings/persona/route.ts` — add validation (mirror)
- `scripts/test-response-delay-fix.ts` — pure-logic test of the
  new fireAt formula against the daetradez scenario + defaults

## Tests

1. With `delayMin=120, delayMax=600, debounce=45, maxDebounce=120` and
   first lead 30s ago, `fireAt - now >= 120` (response delay floor wins).
2. Same config + delay rolls 600 → `fireAt - now ≈ 600` (max delay).
3. With debounce=45, delay=10, maxDebounce=120, first lead 0s ago,
   `fireAt - now ≈ 45` (debounce wins).
4. Validation: `responseDelayMin=0` → 400 error.
5. Validation: `responseDelayMax < responseDelayMin` → 400 error
   (or normalized).
