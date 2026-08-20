Tega,

Responding to your second re-open. All four points addressed. Commit `80e4cc5`. Sign-off document attached.

---

**Item 1 — R24 opened the gate**

You were right. The previous fix (`asked_once_awaiting_answer`) returned `blocked=false`, which let the booking proceed with capital = unknown. The calendar adapter writes `scheduledCallAt` without checking `capitalVerificationStatus`. No gate existed between that return and BOOKED.

Fixed: `checkR24Verification` now returns `blocked=true, reason='asked_but_no_answer'` when capital was asked once and not answered. The existing `asked_but_no_answer` fallback fires: "just need that capital piece first bro, what are you working with right now?" — one more prompt before booking. No triple-ask: that function is only called when `isRoutingToBookingHandoff` is true, so capital is never re-raised during discovery or general chat — only at the booking handoff itself.

Original critical path you asked about (passing number): lead says "I've got £3k" on Daniel's account (threshold £1,000) → classified as `confirmed_amount`, amount ≥ threshold → `blocked=false, reason='confirmed_qualified'` → booking proceeds. That path bypasses the early-return entirely. No re-ask.

---

**Item 2 — Close trigger is directive not code**

Fixed: two code layers added in the retry loop in `ai-engine.ts`.

Layer 1 (retries 0-1): after generation, if all prereqs are met and the output is a discovery question (stage not SOFT_PITCH_COMMITMENT/BOOKING, message ends with ?), forces a regen with a tighter directive. This is post-generation code detection, same pattern as `detectAttemptedStepSkip` and `applyStageOverride` that already enforce other stage constraints.

Layer 2 (exhaustion, attempt 2): same condition — directly overwrites `parsed.message`, `parsed.messages`, and `parsed.stage = 'SOFT_PITCH_COMMITMENT'` with a deterministic soft-pitch. No additional LLM call. The model cannot escape to a discovery Q on exhaustion.

The directive remains as the first layer. Code enforcement is the second layer.

---

**Item 3 — Second account**

Code reads `minimumCapitalRequired` from `AIPersona` (per-account), not hardcoded. Close trigger reads prereqs from the account's active Script's `completionRule` fields. Ali needs to verify:

- Account with `minimumCapitalRequired = 3000` — capital block fires at right threshold
- Account with `minimumCapitalRequired = null` — no capital block, booking proceeds
- Account with different Script `completionRule` — soft-pitch fires when that account's prereqs are met

Record conversation IDs and add to sign-off.

---

**Item 4 — "Cars" line**

File: `src/lib/ai-engine.ts:177`, function `buildStep10DeepWhyDirective()`.

Not engine-global. Fires only when (a) the account's active Script includes Step 10 AND (b) the lead's income goal is captured but emotional reason is not yet captured. Daniel's 18-step script includes this step. Any account without this step in its Script never receives this directive.

Second reference at `src/lib/voice-quality-gate.ts:1868` — same text, used in quality gate recovery if the model jumps past Step 10.

---

All code changes are in `80e4cc5`. Test results: `tsc --noEmit` clean, 560/560 unit tests pass. Second account verification is outstanding — pending Ali.

Shazim
