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
| B5 | **Store the ManyChat native question + dedup the CTA re-ask** | ⬜ OPEN — NOT BUILT | Tega explicitly scoped this. No schema field stores the ManyChat native question; nothing suppresses the CTA branch re-asking it. Typeform path has this dedup; ManyChat doesn't. **This is the next build item.** |
| B6 | Single-wrong-branch case (confident lock on wrong branch, condition is prose not gate) | ✅ ANSWERED | Out of scope for minimal patch → Fix D runtime-condition model. Tega agreed. |
| B7 | **Add branch-lock/serializer as 3rd Fix D case in the proposal doc** | ⬜ OPEN | Said I would; FIX_D_STATE_MACHINE_PROPOSAL.md not yet edited. |
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
| D1 | Remove temporary `/api/version` debug probe (`?classify`, distress diag block) | ⬜ OPEN | Added during distress debugging; must strip before calling distress fully closed. |
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
