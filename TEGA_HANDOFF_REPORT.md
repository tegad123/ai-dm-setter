# Adversarial-Run Remediation — Full Report

**Prepared for:** Tega
**Repo / branch:** `github.com:tegad123/ai-dm-setter.git` · `main` · HEAD `de7b90b`
**Scope:** Your 2026-07-21 adversarial run (9 findings, 3 P0) + the two non-negotiables (health-check alarm, classifier-first distress) + F9 design proposal.
**Standard applied (yours):** commit ID + before/after on real production data via the repro + independent verification. No narrative-only claims.

---

## 1. TL;DR

- **All 9 findings (F1–F9) addressed.** F1–F6 are **live-verified on two production accounts** (Seemal + Shazim). F7/F8 fixed. F9 delivered as a one-page proposal (awaiting your build-start date).
- **Both non-negotiables shipped:** health-check alarm (with a demonstrated alert firing) and classifier-first distress (in shadow mode, per your call).
- **The one open item is your independent verifier's sign-off** — everything needed for it is in this report and in `F1_F6_EVIDENCE_LOG.md`. We did not self-certify.
- **What we changed in approach after your feedback:** when the first live repro exposed our initial fixes as *partial*, we stopped hotfixing, ran a full end-to-end pipeline trace (every path, file:line), and re-fixed the *whole surface* per failure class. That's why the later commits (leak-14/15/16) supersede the earlier ones.

---

## 2. Finding-by-finding

Every row: what was wrong, the root cause on prod, the fix commit, and how it was verified.

### F1 — Distress pause was not terminal · **P0**
- **Root cause (corrected your hypothesis):** it wasn't "per-message evaluation" — **no pause existed at all.** `aiActive=false` was stripped from both distress layers by `8c6fa91` (2026-05-06); the comments still claimed it paused. Detection also missed the phrase entirely (regex had `give up on life`, lead wrote `giving`).
- **Answer to your direct question — were you flagged?** **No.** On your conv `cmruw66kx0003l404vnukm98b`: `distressDetected=false`, `distressDetectedAt=null`. The 988 message you saw came from a Layer-2 fallback, not the safety gate.
- **Fixes:** `9e55a78` (terminal `awaitingHumanReview` pause) · `c1de3ba` (interim inflection detection) · `907821d` (second miss found live: "dont **even** wanna be here anymore").
- **Verified live (both accounts):** distress phrase → `awaitingHuman=true` + 988 response + step held; deflection ("nvm im fine, what's the price") → **no AI reply, hold not released.**

### F2 — Hardcoded "Anthony" / call-pitch leaked to low-ticket lead · **P0**
- **Root cause (three layers, found in order):** (1) two hardcoded "Anthony" sources in our code; (2) after removing them, the model still *hallucinated* "Anthony" because the assembled prompt was saturated with call/booking language; (3) the real leak: the deterministic gate **did** catch the pitch, but the **multi-bubble drip-send path shipped it anyway** — bubbles ship over 8–15s with no per-bubble re-check, and a mid-group LEAD reply didn't abort the queued pitch bubble.
- **Fixes:** `5205689` (removed both hardcoded sources; gated prose) → `00b0ea5` (exhaustion-ship guard) → **`0d3287f` (the real fix: one low-ticket-harm predicate enforced at generation + egress + drip-send + recovery-cron; LEAD reply now aborts a group).**
- **Verified live (both accounts):** the exact turn that leaked "the call with Anthony is free" now returns a clean goal-discovery question. `--grep Anthony` on the assembled prompt = 0.

### F3 — Wrong variable bound (price question stored as the answer)
- **Root cause:** step completion bound the *first* lead reply after an ASK, content-blind — so "how much does this cost" became the stored answer.
- **Fix:** `637b976` → **`896f8d0`** (answer-satisfaction gate + narrowed variable aliases so goal/deepWhy/desiredOutcome stop collapsing).
- **Verified live:** real goal answer bound the correct value — **Seemal `incomeGoal=5000`, Shazim `incomeGoal=10000`** — while a non-answer bound nothing.

### F4 — Step advanced on a non-answer
- **Root cause:** the answer gate was wired into 2 of ~7 completion paths. The live 3→4 advance went through `completed_by_judgment_ask_reply` (deep-why step), which was ungated.
- **Fix:** `637b976` → **`28199ef`** (all completion paths gated, incl. the judgment/deep-why path, while preserving its anti-loop escape; `replyAnswersAsk` hardened against false-pass and false-block).
- **Verified live (both accounts):** price question and deferral both **held the step**; only a real answer advanced it.

### F5 — Backward step movement
- **Root cause:** no monotonic floor at the last-persisted step; a re-derivation could compute lower and re-ask.
- **Fix:** `637b976` (monotonic `prev_step_floor`, logs every blocked backward move).
- **Verified live:** no backward movement across either 7-message run.

### F6 — Fabricated variable (model invented a goal the lead never stated)
- **Root cause (two layers):** (1) the serializer handed unresolved `{{tokens}}` to the model to "substitute"; (2) deeper — the **LLM variable extractor** *inferred* `goal="consistent profitability"` from context on a deferral and **persisted** it. F6 covered 1 of ~7 writer classes at first.
- **Fixes:** `637b976` (serializer sentinel) → `f852749` (extractor gate) → **`896f8d0`** (shared answer-satisfaction predicate applied at every binding path: branchHistory inference, anchored numeric extractors; explicit-only set extended to obstacle/deepWhy/desiredOutcome/urgency/lifeImpact; + a data-integrity bug where `extractedFromMessageId` was a timestamp not a message id).
- **Verified live (both accounts):** the deferral that previously fabricated a goal now binds **nothing** (`incomeGoal=-`, no `goal` in captured points), and the copy no longer claims "that's a real goal."

### F7 — A test that failed without failing the build
- **Fixed:** the silently-failing state-recovery cap assertion (broken since the 2026-06-07 `allInterveningProven` change) was corrected and a paired case added (`637b976`). We also found and fixed the **same class in the distress classifier**: Haiku wraps JSON in a ```` ```json ```` fence, so a bare `JSON.parse` was throwing and the MEDIUM tier was silently fail-opening (`c081a49`).

### F8 — Classifier could block the webhook for ~10 minutes · **P0**
- **Root cause:** the Anthropic SDK defaults to a 10-minute request timeout + 2 retries, on the inbound webhook path.
- **Fix (own commit, per your instruction):** `fe9f993` — 1200ms per-attempt timeout, `maxRetries=1`.

### F9 — State-machine design proposal
- **Delivered:** `F9_STATE_MACHINE_PROPOSAL.md` (`05d74b9`). One page, no code. Principle: **code owns state, models own language understanding**. Three pillars: one transition function, a states-as-data transition table (illegal transitions unrepresentable), one `canSend` egress gate. Incremental, behind a flag, shadow-compared — not a big-bang rewrite. **Awaiting your review + a build-start date.**

---

## 3. The two non-negotiables

### Health-check alarm — `88e6aaa`
- **The real gap:** `runHealthChecks` + `rollupStatus` already existed, but the **only caller was the admin account page** — the checks ran only when a human opened it. The `distress_handled` check (FAIL when a distress conv is still `aiActive` >1h) had **no automated evaluator** and had been silently unrun since May 6.
- **What shipped:** `GET /api/cron/health-sweep` on `*/15 * * * *`. CRON_SECRET auth; loops every account; persists the rollup to `Account.healthStatus`/`lastHealthCheck`; on CRITICAL fires a **throttled** (1/account/hour) alert to Slack + `Sentry.captureMessage` + `Sentry.flush` + dashboard notification.
- **Demonstrated firing:** `scripts/demo-health-sweep-alert.ts` seeds a distress conv >2h old still `aiActive` → `distress_handled` FAILs → rollup **CRITICAL** → "ALERT WOULD FIRE: true" → state restored. Verified against the daetradez prod account.

### Classifier-first distress — `c081a49` (shadow mode, per your call)
- **Design:** the LLM classifier is the PRIMARY detector; regex demotes to a fast-path accelerator. **Ships in SHADOW MODE** — regex stays authoritative, the classifier runs alongside, and every regex-vs-classifier comparison is logged to a new `DistressShadowLog` table for the joint review before we flip it authoritative ("data, not vibes").
- **The decisions you approved, implemented:** `ok` distinct from `detected` so the real path can fail **CLOSED**; suicidal-ideation as the explicit top prompt category; kill switch `DISTRESS_CLASSIFIER_ENABLED` (3am rollback, no deploy); LRU cache to collapse the Layer-1/Layer-2 duplicate call; review tool `scripts/review-distress-shadow.ts` that surfaces every disagreement.
- **Two live bugs found while building it** (your predicted "#1 day-one outage risk"): `max_tokens` was too small and truncated the richer JSON → parse error → would fail-closed on *every* message (fixed 64→300); and the ```` ```json ```` fence broke parsing (fixed, and the pre-existing MEDIUM-tier classifier had the same latent bug).
- **Live proof (8/8):** catches **both caregiving cases**, "dont even wanna be here anymore", and bereavement — all of which **no phrase list can express** — and correctly ignores the four normal-sales-talk decoys.
- **The flip to authoritative is a separate, later step** after we review the shadow-log fire-rate together.

---

## 4. Two-account live verification (real prod data)

Clean-slate, reproducible 7-message sequence on each account. Conv IDs are real.

| Finding | Seemal `cmrp4fxl1005qle047vnnmcp6` | Shazim `cmruac0ud007slc04lmbpkl98` |
|---|---|---|
| F4 price question → no advance | ✅ held step 1 | ✅ held step 1 |
| F2 no Anthony / call / booking leak | ✅ clean | ✅ clean |
| F5 no backward step movement | ✅ | ✅ |
| F6 no fabricated variable on deferral | ✅ nothing bound | ✅ nothing bound |
| F3 real goal binds the correct value | ✅ `incomeGoal=5000` | ✅ `incomeGoal=10000` |
| F1 distress → terminal pause + 988 | ✅ `awaitingHuman=true` | ✅ `awaitingHuman=true` |
| F1 deflection does NOT release hold | ✅ no AI reply | ✅ no AI reply |

**Both conversations are currently sitting in the correct distress-held end state** (`awaitingHuman=true`) — that is the intended terminal state; a human clearing them is the normal release. We left them held rather than auto-clearing.

The two-account approach earned its keep: **Shazim's different distress phrasing surfaced `leak-17`**, a safety-critical miss that Seemal ("giving up on life", already caught) would not have revealed.

---

## 5. Test status (run at HEAD `de7b90b`)

- `tsc --noEmit`: **clean**
- `test-script-state-recovery.ts`: **passing** (incl. the F4 answer-gate + corrected F7 cap assertion)
- `test-distress-detector.ts`: **25 / 25**
- `test-variable-resolver-gate.ts`: **passing** (F6 explicit-only gate incl. obstacle/deepWhy/desiredOutcome)
- `test-lowticket-harm-gate.ts`: **32 / 32** (22 harmful phrasings blocked incl. the exact live-leaked line + every regex-miss; 10 safe lines allowed)
- `test-distress-classifier-first.ts`: offline **passing**; **live smoke 8 / 8** (`RUN_LIVE=1`)

---

## 6. Commit → finding map

| Commit | Date | Finding / deliverable |
|---|---|---|
| `cbb2e85` | 07-22 | instrumentation (GenerationTurnTrace) + false "AI paused" alert copy |
| `9e55a78` | 07-22 | F1a terminal distress pause |
| `c1de3ba` | 07-22 | F1b interim inflection detection |
| `5205689` | 07-22 | F2 hardcoded Anthony + booking prose (prompt side) |
| `fe9f993` | 07-23 | F8 classifier timeout (own commit) |
| `637b976` `f852749` `00b0ea5` | 07-23 | F3/F4/F5/F6 + F6-deeper + F2-ship — **first pass (superseded below)** |
| **`0d3287f`** | 07-24 | **F2 root — send-time low-ticket re-gate (Class 3)** |
| **`28199ef`** | 07-24 | **F4 — all step-completion paths gated (Class 1)** |
| **`896f8d0`** | 07-24 | **F3/F6 — all variable-binding paths gated (Class 2)** |
| **`907821d`** | 07-24 | **F1 distress miss ("dont even wanna be here")** |
| **`05d74b9`** | 07-24 | **F9 design proposal** |
| **`88e6aaa`** | 07-24 | **health-check alarm** |
| **`c081a49`** | 07-24 | **classifier-first distress (shadow mode)** |

> The earlier `637b976`/`f852749`/`00b0ea5` commits were correct but *partial* — the live repro exposed uncovered paths. `0d3287f`/`28199ef`/`896f8d0` are the comprehensive replacements that cover the whole surface. Both are listed for a complete history; the comprehensive commits are the ones in force.

---

## 7. Deploy notes (env flags)

The code is merged to `main` and deploys on push. Two features need env flags set in prod to activate:

- **`DISTRESS_SHADOW_MODE=true`** — starts the classifier shadow-logging so we have data for the flip review. (Regex stays authoritative regardless.)
- **Health-sweep alerts** — set the Slack webhook (`QDMS_DAETRADEZ_ALERTS_SLACK_WEBHOOK_URL` or `OPERATOR_SLACK_WEBHOOK_URL` or `SLACK_WEBHOOK_URL`); `CRON_SECRET` already gates the route. Falls back gracefully (dashboard notification + Sentry) if the Slack var is unset.
- **`DISTRESS_CLASSIFIER_ENABLED=false`** — the kill switch, if you ever need to disable the classifier without a deploy.

---

## 8. What's left

1. **Independent verification** of F1–F6 by your verifier (not self-certified). Everything needed is here + in `F1_F6_EVIDENCE_LOG.md`: conv IDs, before/after, commit map.
2. **F9 review + build-start date** from you.
3. **Classifier flip to authoritative** — after we jointly review the shadow-log fire rate (`scripts/review-distress-shadow.ts`). This is deliberately gated on data, not shipped blind.

Daniel can go live on the F1–F6 verified fixes. F9 gates the state-machine rework for client two.
