# Fix D — Phase 0 Shadow-Compare Verification Packet

**For:** Tega (independent verification before Phase 0 cutover)
**Build:** commit `8fdbefc` live on prod (verify via `GET /api/version`)
**What Phase 0 is:** the `canSend` egress gate + four typed hold states become the single send path. This packet shows the gate ran in SHADOW (log-only, zero behavior change) alongside the live send path and never diverged.

Everything below is self-serve: conversation IDs, the exact queries, and expected results. Nothing here needs me to run it.

---

## 1. What was shadowed

Every real outbound send passes through one choke point (`facebook.ts sendMessage` for the FB funnel, `instagram.ts sendDM` for IG). At that point `canSend(deriveMachineState(conversation), draft)` is computed and logged to `EgressShadowLog`. The live code has ALREADY decided to send, so:

- **`agreed = true`** → the machine also said ALLOW (agreement).
- **`agreed = false`** → the machine would have BLOCKED a send the live path allowed (a divergence to investigate).

## 2. The allow-side result (does the machine wrongly block real sends?)

Window: FB hook live `2026-08-12 16:14Z` → `2026-08-13 06:18Z` (~14h of live funnel traffic).

```sql
-- total shadowed sends and any disagreements
SELECT
  count(*)                                   AS total_rows,
  count(*) FILTER (WHERE agreed = false)     AS disagreements,
  count(*) FILTER (WHERE "machineAllow")     AS machine_allowed
FROM "EgressShadowLog"
WHERE "createdAt" >= '2026-08-12 16:10:00Z';
```

**Result:** `total_rows = 154`, `disagreements = 0`, `machine_allowed = 154`.
On every one of 154 live sends the machine agreed. Zero false blocks.

## 3. The block-side result (does the machine actually block when it should?)

The allow side alone could pass with a trivially always-allow gate, so the block side is checked directly against live conversation state. `canSend` was evaluated against sampled prod conversations in each state:

| State sampled | Machine phase | canSend verdict | Sample conv IDs (last 6) |
|---|---|---|---|
| `awaitingHumanReview = true` | `HELD_OPERATOR_REVIEW` | **BLOCK** (HOLD) | epa2yt, p0rg67, i7hiux, xdkpsn, cgpm16 |
| `aiActive = false` | `AI_OFF` | **BLOCK** (AI_OFF) | 1bdnzh, eywsjt, d8djhn, mcehy3, 45juf7 |
| active, not held, no distress | `ACTIVE` | **ALLOW** | o10wx5, b7zj8i, qmln2p, li1lgw, 2yvzgg |

Reproduce: `deriveMachineState(conversation)` + `canSend(state, draft)` from `src/lib/state-machine/can-send.ts` against any conversation row. Held and AI-off block; active allows.

## 4. Typed holds (the awaitingHumanReview boolean → four reasons)

`deriveMachineState` maps today's boolean columns to a typed reason with documented precedence (distress > scheduling conflict > gate-exhausted > operator review):

- `distressDetected` → `HELD_DISTRESS`
- `schedulingConflict` → `HELD_SCHEDULING_CONFLICT`
- `awaitingHumanReview` + recent quality-gate failure → `HELD_GATE_EXHAUSTED`
- `awaitingHumanReview` (otherwise) → `HELD_OPERATOR_REVIEW`
- `aiActive = false` → `AI_OFF` (a mode, not a hold)

Unit-verified: `scripts/test-state-machine.ts` (21/21) covers transition semantics, the F1 terminal-distress rule (operator reply releases every hold EXCEPT distress, which needs an explicit release), and derivation precedence.

## 5. What cutover changes

At cutover `canSend` moves from shadow to authoritative — it becomes the one gate every send passes through — and the four typed holds replace the `awaitingHumanReview` boolean in the dashboard so a held conversation always shows WHY. The interim `awaitingHumanReview` patch is not removed; the machine subsumes it, and this shadow diff is the proof it matches before the flip.

## 6. Sign-off ask

If the two queries above reproduce (154/0, and the block-side table), Phase 0 is clear to cut over. Flag any `agreed = false` row you find and I'll trace it before we flip.
