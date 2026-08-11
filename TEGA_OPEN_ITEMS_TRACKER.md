# Tega Open-Items Tracker — daetradez (Convlo)

**Purpose:** single source of truth for everything Tega requested across the last two days (2026-07-28 → 07-30). Nothing is marked ✅ COMPLETE until it is **live-verified on prod**, not just deployed. Work items are done ONE AT A TIME: build → test live → mark complete.

**Standing verification rules (Tega's):** conv ID + commit hash + before/after on real production data; trace-checked not transcript-only; "deployed" ≠ "verified"; the person who ran it doesn't grade it (Ali verifies independently where required).

**Key facts:**
- daetradez account: `cmpy59zy50000ju04u6fs5o2r` · low-ticket persona: `cmpy59zz30002ju04v1bjdwzw`
- Shazim verification conv (baseline): `cms0ic2xg0003kt04wsbri1qg`
- Build identity: `GET /api/version` (public). Distress/classifier probe: `?account=<id>&classify=<text>`
- Anthropic key: distress classifier + generation now resolve the per-account **BYOK** key (Daniel's funded workspace ANTHROPIC credential). There is NO ANTHROPIC_API_KEY env var in Vercel. account.aiProvider='openai' with an active OPENAI credential drives main generation.

---

## GROUP A — DISTRESS BUG (Tega Msg 1, "top priority, ship today")

| # | Item | Status | Evidence / Notes |
|---|------|--------|------------------|
| A1 | Classifier authoritative on daetradez (yes/no) | ✅ COMPLETE | Live probe: `ok:true`. Default-on (`!== 'false'`), commit `0a5c496`. |
| A2 | Calibrate to funnel emotional register, not phrase list | ✅ COMPLETE | Classifier-first rewrite + low-ticket funnel context. `cca827e`. |
| A3 | Don't narrow to explicit-only (indirect phrasing stays) | ✅ COMPLETE | "what's the point of any of this" etc. still fire (live). |
| A4 | Six-phrase test still catches all six after recalibration | ✅ COMPLETE | Live: ideation `suicidal_ideation`, caregiving `caregiving_crisis` both fire; slang doesn't. |
| A5 | Full 8-step run, no distress misfire anywhere | ✅ COMPLETE | Ran end-to-end on `cms0ic2xg…` 07-30. Step 4 = Tega's exact phrase → normal reply, `distressDetected=false`. |
| A6 | **Send shadow-log fire rate with the fix** | ⬜ OPEN | 0 shadow rows exist (DISTRESS_SHADOW_MODE never enabled in prod). Owe Tega the honest "no historical data" note — cannot fabricate a rate. Decide: enable shadow mode to accumulate, or state plainly it's N/A. |
| A7 | Root-cause writeup (BYOK key, not env) | ✅ COMPLETE | classifier read a different/unfunded env key; fixed to BYOK. `c30dc0f`. |
| A8 | Safety-degraded loud alert on classifier credit/auth failure | ✅ COMPLETE | `cca827e` — logs SAFETY DEGRADED (bonus hardening). |

Distress commits: `cca827e`, `c30dc0f`, `0a5c496` (+ diagnostics `6596ae5`, `3a8e189`, `bf8cc17`).

---

## GROUP B — MANYCHAT / BRANCH-LOCK BUG (Tega Msg 2)

| # | Item | Status | Evidence / Notes |
|---|------|--------|------------------|
| B1 | Confirm mechanism before fixing | ✅ COMPLETE | Confirmed + corrected Tega's read (empty ManyChat fields → lock-coverage gap, not dual-detection). Tega agreed. |
| B2 | Single source of truth: branch resolves to exactly ONE (or explicit smart-mode), never "all" | ✅ COMPLETE | `selectBranchesForPrompt` returns ≤1, never "all". Invariant test `test-branch-serializer.ts`. `0b19ce8`. |
| B3 | Serializer emits at most one branch per step | ✅ COMPLETE | Same commit; step-1 collapses to one default, steps 2-8 → smart-mode. |
| B4 | Live-verify single opener (dual-opener gone) | ✅ COMPLETE | Full run 07-30: step 1 shipped exactly ONE opener (warm=1, cta=0). |
| B5a | Store the ManyChat native question | ✅ COMPLETE | Schema column `manyChatNativeQuestion` + migration `20260730000000` + payload field + all 3 handoff write paths. Verified: column reads in prod. `ebe6e3b`. |
| B5b | Dedup the CTA re-ask (AI must not re-ask what ManyChat asked) | ⚠️ RESOLVED AS FIX-D SCOPE + CONFIG (decision 07-31) | 6 commits removed every scripted source; the model still regenerates the question from few-shot examples + discovery-bridge scaffolding. Prose can't beat prose. **Decision (option 2+3):** (a) the clean fix is CONFIG — Daniel's ManyChat automation should hand off at step 2 (goal), not step 1, so there's no step-1 experience question to re-ask; (b) the code-level behavioral dedup is Fix D scope (a machine that knows which question is answered) — now written as Fix D's 3rd case (`d829d42`). The storage half (B5a) is done and correct; the dedup instruction is deployed (harmless, helps once handoff is at step 2). NOT chasing patch #7. |
| B6 | Single-wrong-branch case (confident lock on wrong branch, condition is prose not gate) | ✅ ANSWERED | Out of scope for minimal patch → Fix D runtime-condition model. Tega agreed. |
| B7 | Add branch-lock/serializer as 3rd Fix D case | ✅ COMPLETE | FIX_D_STATE_MACHINE_PROPOSAL.md updated, `d829d42`. |
| B8 | Step 8 delivers Daniel's real URL, not placeholder | ✅ COMPLETE | Full run 07-30: shipped `daetradingaccelerator.com/landing-page`, placeholder=false. |
| B9 | "3 months" divider | ✅ CLOSED | Cosmetic `Math.floor(days/30)` (pipeline-view.tsx:78, lead-detail.tsx:77). Tega: no action needed. |

Branch-lock commit: `0b19ce8`.

---

## GROUP C — MULTI-TENANT LEAK AUDIT (criterion 6)

| # | Item | Status | Evidence / Notes |
|---|------|--------|------------------|
| C1 | Run audit + report findings (8 classes, file:line, diagnose-only) | ✅ COMPLETE | `MULTI_TENANT_LEAK_AUDIT_2026-07-28.md`, commit `e209909`. 3 CRITICAL / 4 HIGH / 9 MEDIUM. |
| C2 | Ali verifies findings independently | ⬜ BLOCKED (not ours) | Ali reports repo paths / trace tooling not accessible in his workspace tier. Access issue for Tega/Shazim to resolve. |
| C3 | Fix the CRITICAL findings (each with commit + before/after) | ⬜ OPEN | Diagnose-only was correct. Fixes queued pending Ali verify + Tega M4/M5 classification. 5-1 (team-role escalation) is fix-first. |
| C4 | Classify findings M4 (isolation defect) vs M5 (architectural) | ⬜ OPEN | My read: all isolation-defect → M4. Tega's call. |

---

## GROUP D — CLEANUP / HOUSEKEEPING (ours, not asked but owed)

| # | Item | Status | Evidence / Notes |
|---|------|--------|------------------|
| D1 | Remove temporary `/api/version` debug probe | ✅ COMPLETE | Stripped, endpoint returns build identity only. `d829d42`. |
| D2 | Step-7 personalization variable-render gap ("breathing room, wanting ,") | ⬜ OPEN (flagged) | Seen in full run 07-30. Same class as F3 variable binding. Queued, not blocking. |
| D3 | Vercel env-var / redeploy gotcha documented | ✅ NOTED | Env changes only apply to NEW deploys; env-var save redeploys the OLD commit. |

---

## WORK ORDER (one at a time, test before marking complete)

1. **B5** — ManyChat native-question storage + CTA re-ask dedup (the one unbuilt piece Tega scoped). Build → test via real ManyChat handoff → verify no redundant re-ask → mark complete.
2. **D1** — strip the `/api/version` debug probe.
3. **B7** — add the branch-lock case to the Fix D doc.
4. **A6** — resolve the shadow-log fire-rate question with Tega (enable shadow mode or state N/A honestly).
5. **C3/C4** — leak-audit fixes, starting 5-1, once Ali verifies + Tega classifies.
6. **D2** — step-7 variable-render gap (queued).

**Do NOT report "all done" to Tega until B5, D1, B7 are complete and the ManyChat path is live-verified.**

---

## SESSION LOG 2026-08-06/07 (pre-interrupt state)

DONE + deployed: 500 root-caused (empty JSON body mid-wiring) + hardened to 400 (`cd23753`); Fix D dated schedule v3 posted (start Aug 6, M4-ready ~Sep 3) (`cae2a1e`); sentinel sanitization (`79a7354`); FB handoff schema fix (`37e35ec`); loud rejection notifications (verified: 3×400 @21:15/21:21/21:25 → 1 notification by 30-min throttle design).

INTERRUPTED BY NEW TEGA P0 (2026-08-07 00:53): dual "stall" on cmrzgulcs turns 70/80 —
1. verbatim_repeat/repeated_question suppressed ENTIRE multi-bubble replies (one good bubble + one repeat) → retries exhausted → SILENT awaitingHumanReview (no notification).
2. Legacy adherence checks (mandatory_ask_skipped / step_distance_violation / capital_question_premature) validating against OLD high-ticket script — my Jul-26 scriptMaxStepNumber clamp is NUMERIC; today's step-split grew active script 10→14 steps, putting dead steps 9-13 back under the ceiling. Gate re-prompts told model to resume dead script → drove the repeats.
3. Step re-entry lands same-step Default (Fix D scope, noted).
4. cmrzgulcs contaminated (81 turns/16 resets/2 script eras) — fresh leads only for verification.
5. Addendum: disableLeadStageProgression overloaded (~30 sites), hard-modes verbatimRepeatGuard (~ai-engine:4162) = the actual suppressor.

FIX PLAN (Tega's asks): (a) script-identity/anchor-based adherence checks, (b) partial-ship (strip failing bubble, ship siblings), (c) loud escalation on every gate-exhaustion hold. Phase 0 of Fix D pauses until this ships.

STATUS 2026-08-07: ALL THREE SHIPPED in `d3b4321`.
- (a) legacy checks (capital_premature / mandatory_ask_skipped / step_distance_violation) gated on `activeScriptHasAnchors` — script identity by construction, numeric ceiling gone.
- (b) partial-ship: [bubble=N]-scoped repeat-family fails strip the failing bubble and ship clean siblings (≥1 clean bubble must remain; any non-repeat or non-bubble-scoped fail still suppresses everything).
- (c) awaitingHumanReview conversations (distress excluded, 7-day activity window) now an URGENT Action Required item, dismissible, first in the urgent array. Root cause of invisibility: realtime hold path CANCELS pending reply rows, so the FAILED_QUALITY_GATE section never saw them.
- CORRECTION for Tega on record: bell notifications DID fire for both holds (19:12:36 and 19:41:53, "AI generation failed quality gate — manual response required") but were buried under 11 hourly "Health check FAILED" + 8 "ManyChat handoff rejected" notifications that same day. The panel gap was real; "fully silent" was not.
- NOISE FOLLOW-UP (open): hourly Health-check-FAILED spam is why real alerts drown. Also 8 handoff rejections through Aug 6 = ManyChat flow STILL sending bad payloads after the wiring fix — tell Tega/Daniel.
- Suites green: harm gate 36/36, branch-router, branch-serializer. TSC clean.
- VERIFIED 2026-08-07 on FRESH lead, conv `cmsig91ii0003jl046n7pfzrb` (old Shazim test lead cleaned first, so this was a true first-touch lead):
  - 27 turns, steps 1→14 of the new 14-step script, every per-turn check green (AI replied every turn, never silent, never held, position never regressed).
  - 28 GenerationTurnTrace rows: capital_question_premature=0, mandatory_ask_skipped=0, step_distance_violation=0, old-script citations ("Belief Break"/"step 8 ask")=0. Steps 9-14 (the old dead-zone) clean.
  - Gate retries did fire on later steps (repeated_opener/msg_verbatim/booking_language families, VoiceQualityFailure rows 05:30-05:36 UTC) but a passing attempt always shipped — no whole-reply suppression, no hold. Partial-ship path did not need to trigger.
  - Fix (c) proven end-to-end: set awaitingHumanReview on the test conv, feed query returned it (then reset the flag).
- NEW FINDING from (c) verification: daetradez has 40 conversations sitting awaitingHumanReview, 10 with activity in the last 7 days (now panel-visible), incl. real leads unanswered since June and at least one who asked for the purchase link on Jul 25 ("nvm im good, just send me the link"). Backlog triage decision needed from Tega/Daniel: reply manually or clear the hold.
- Footnote (honest, persona-induced): my test persona pushed for a call; the AI shipped "you're locked in for 2pm eastern" on a no-call funnel (gate blocked several booking-language attempts but a passing attempt still carried it). Known adherence class, not the P0 — flag to Tega as M5-queue.
- drive-prod-funnel.ts hardened: withRetry on all prod DB reads (pooler drops) + --resume mode (continues mid-conversation instead of re-sending the canned opener).

## TEGA RESPONSE LOG + CURRENT WORK (2026-08-08)

TEGA (Aug 8, 8:52 PM, after reading the full P0 report): "Yes I did, ready to presume with fix D. Let me know when you're ready for me to test."
- READ: Fix D resumption approved. He wants a ping when there is something HE can test hands-on. No pushback on the M5 classification of the booking-language footnote (stands as M5). No answer yet on: backlog triage direction (A/C bucket releases), PSID dashboard check, junk "undefined" lead deletion.

WORK QUEUE (in order):
1. ✅ Backlog triage list prepped — `HELD_BACKLOG_TRIAGE.md` (41 convs, buckets A-F, window math). NO holds released; awaiting Tega/Daniel. Time-sensitive: bucket A's Aug-2 group exits the 7-day human-agent window Aug 9; the two purchase-intent leads (Chad Mcauley, Troy Fullwood) should get a human reply before then.
2. ✅ Health-check notification spam FIXED (`8e66ff9`): state-change alerting. Root: the sole failing check was distress_handled ("8 distress conversation(s) still aiActive >1h" = triage bucket B), re-alerted hourly = 42 identical notifications in 48h. Now: unchanged failure signature re-alerts at most daily ("STILL failing"), changed signature alerts after 1h flap floor, CRITICAL→healthy fires a one-time RECOVERED notice. NOTE: clearing bucket B is what actually clears the health FAIL.
3. 🔨 Fix D Phase 0 IN PROGRESS — skeleton SHIPPED (`20ca85a`), shadow-only, zero behavior change:
   - `src/lib/state-machine/` — types (4 typed holds, MachineEvent vocabulary, pure transition() with F1 terminal-state semantics: operator reply releases all holds EXCEPT distress, which needs explicit release), can-send.ts (canSend verdict: hold block / AI_OFF / unresolved-variable artifact; deriveMachineState bridges boolean-era columns with hold precedence), shadow.ts (fire-and-forget compare at sendDM/sendAudioDM choke point).
   - EgressShadowLog table + migration (auto-applies on Vercel build). FIX_D_EGRESS_SHADOW default ON, log-only. agreed=false rows = shadow diff = Ali's sign-off packet.
   - scripts/test-state-machine.ts: 21/21 green.
   - REMAINING for Phase 0: lastGenerationClaim cdp cleanup; let shadow accumulate 1-2 days of live traffic; review diff; build sign-off packet; cutover ~Aug 13 (canSend authoritative + typed holds surfaced in UI).

## SHIPPED 2026-08-10/11 (M4 sprint)

- `714fcff` F1 distress-responder fix: both distress layers now skip the automated supportive send when aiActive=false (operator owns the conversation) or when already responded to that lead message; flags + escalation always still run. Root: first Fix D egress-shadow finding (3 disagreement rows, other-tenant conv, AI-off + distress hold, repeated send attempts).
- `0f282d3` ALL 3 leak-audit CRITICALs closed: 5-1 (PATCH /api/team/[id] ADMIN-only + shared role allowlist src/lib/team-roles.ts + no self role/isActive edits; DELETE gated too), 1-1 ("marcus's 1-on-1" → config-resolved mainOffer, fallback "the main program"), 1-2 ("anthony will be ready" ×2 → configured closer or name dropped). Audit doc updated with remediation status. Evidence: grep the literals — only comments remain.
- `6d9a62c` Phase 0 lastGenerationClaim cleanup: claim moved from capturedDataPoints to Conversation.generationClaimMessageId/At columns, migration strips legacy key.
- Phase 0 BUILD COMPLETE. Remaining: shadow accumulation on live traffic → diff review → self-serve packet to Tega → cutover (canSend authoritative + typed holds in UI). SHADOW STATUS 2026-08-11: only the 3 pre-fix AI_OFF rows so far (the distress loop that generated them is now fixed in `714fcff`); no new choke-point sends overnight. Packet waits for real volume — will not build a cutover packet on 3 stale rows.
- `2434167` Phase 1 INTERRUPT LAYER shipped: src/lib/interrupt-layer.ts — price + scam-objection + time-objection detected pre-routing, answered from the persona's own configured branch copy (never hardcoded), applied as a leading bubble post-generation. Position-safe (writes no branch-selection event). Replaces the 2026-07-28 temporary price-only inline patch. 12/12 tests.
- Phase 1 NO-BACKWARD-MOVEMENT: assessed as ALREADY ENFORCED, not rebuilt — F5 monotonic step floor (script-state-recovery.ts:4748, unconditional position guard) + durable branch-history floor + +1/turn advance cap, plus content-level earlier_step_ask_regression hard-fail (voice-quality-gate.ts:2071). Honest note: this is real coverage today; the transition()-based replacement is a Phase 1 CUTOVER migration (shadow-compared), sequenced AFTER Phase 0 cutover, not a from-scratch rebuild to force now.

## PERSONNEL CHANGE (2026-08-09, from Shazim)

Ali is OFF the project (Tega let him go). Tega now does ALL testing/verification himself. Team = Shazim (build) + Tega (verify).
- Every "Ali verifies / Ali packet" item re-routes to Tega directly. The runner-doesn't-grade rule survives with two people: Shazim runs, Tega grades.
- C2 (leak-audit independent verification, was BLOCKED on Ali's repo access) — blocker dissolved. Ask Tega: does he verify the audit findings himself, or accept evidence-based review? C3/C4 classification still his call.
- Phase 0 shadow-compare sign-off packet goes to Tega, not Ali. Packet must be fully self-serve (conv IDs, ready-to-run queries, before/after) since there is no second verifier to lean on.
- All other Ali-tagged items in this file: read "Ali" as "Tega" from here on.
- Post-fix hold observed working as designed: Kingsley Ese conv `cmsjild690003ie049oihq8e4` (Aug 7 23:44) — single-bubble verbatim_repeat exhaustion at step 14, partial-ship correctly N/A (no clean sibling), hold set AND panel-visible. This is the new loud behavior, not a regression.
