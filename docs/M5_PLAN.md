# M5 — Fix D Compiler + Unified Gate + Script-Independence (Convlo / QualifyDMs)

## Context

M4 is closed and paid ($2,000, approved 2026-08-30). M5 ($5,000) is scoped and dated: 7 items due **Tue Sept 29 2026**, payment on M5 close funded from first-client revenue, backstop **Sat Nov 28 2026** regardless of revenue. Verification goes to **Tega alone** (Ali is off the project — any "Ali/Tega sign-off" language from design drafts is corrected to Tega-only).

**Why this plan exists — the client-two blocker.** Tega stated plainly (2026-08-30): there is no second paying client until a full conversation runs perfectly end-to-end on **any** script, not just the daetradez one we hand-debugged for a month. The engine works on daetradez because we found every disagreement between the script and the engine by hand. Client two arrives with a script nobody has adversarially tested. **The compiler is what makes the next script work without that month.** So M5's north star is *script-independence*, and every design choice is tested against: *would this survive a script Tega uploads that we have never seen?*

**The root cause we are removing.** Branch selection today lives in `ai-engine.ts:3184-3273` (token-scorer → LLM judge classifier) and returns **NULL** whenever a multi-branch step scores low-confidence and the classifier doesn't lock. NULL empties the required-message set → the gate goes blind → deterministic injections have nothing to inject → orphaned/wrong content ships. Step advancement lives in `computeSystemStage` (`script-state-recovery.ts:4435`), which re-scans history every turn through a 6-detector cascade riddled with **daetradez-hardcoded** step-numbers and phrase regexes (`MANDATORY_ASK_STEPS` :1110, `CALL_PROPOSAL_PREREQS` :453, `CAPITAL_QUESTION_PREREQS` :1264). Both consume the free-text `ScriptBranch.conditionDescription` — there is no machine-evaluable predicate anywhere. **A code-owned FSM compiled from the script at upload time is the fix**: it owns branch selection and step advancement generically, makes the NULL case structurally unrepresentable, and validates a script at upload so a broken one is rejected with a readable error instead of silently misrouting a live lead.

**Standing decisions (from user, this session):** (1) fold the 5 known-bug standalone fixes into this plan; (2) replace the capital-answer classifier with structured extraction inside M5 — **no more one-off regex** (it already carries ~15 dated patches; the two R24 bugs are two more of that class); (3) prove script-independence on **three** accounts — live Apex, a self-seeded synthetic high-ticket fixture, and a genuinely fresh script Tega provides (the true never-debugged test); (4) this turn produces the plan; the Tega-facing message is a separate follow-up.

---

## Architecture at a glance

Three axes, each rolled out **shadow-first → per-account/per-platform authoritative** (mirroring the already-shipped egress `state-machine/{types,can-send,shadow}.ts` pattern: pure typed transition, log disagreements, flip only when the diff is clean, **daetradez flipped LAST** because it is the oracle):

1. **Routing/progression FSM** — compiled from the script at upload, owns branch selection + step advancement. (Tega items 2–4)
2. **Unified egress gate** — all content guards run at the one physical send choke point, on every path including crons + multi-bubble. (Tega item 7)
3. **Single prompt assembler** — one function, explicit precedence (script verbatim > verified facts > persona > R-rules). (Tega item 6)

Plus: the **Wait-boundary gate** (item 1, P0, due Sept 6), the **fact store** (item 5, which absorbs the capital-classifier rewrite), and the **verification harness** that proves all of it on any script without needing a live Meta window.

---

## Workstream 1 — Wait-boundary gate (Tega item 1, P0, due Sept 6)

**What:** the egress gate hard-fails any turn that ships copy from an action block sitting *after* a `wait_for_response`/`wait_duration` in the same step. (Evidence: Warm-Inbound blocks 1/2/4 shipped in one turn; lead got "That's awesome, I'm over in Texas" before answering the location question.)

**Approach:** this is naturally the *first guard* in the unified gate (Workstream 2) but ships standalone first. The FSM compiler (Workstream 4) already models wait boundaries in `CompletionSpec`; until it lands, add a deterministic ship-time guard: given the current step's compiled/serialized action sequence, any bubble whose content matches a post-wait block is blocked. Reuse `getStepActionShape` (`script-step-progression.ts:886`) to identify the wait index.

**Files:** new guard in `src/lib/state-machine/egress-guards.ts` (created here, extended in WS2); wire into `shadowEgressCheck` (`state-machine/shadow.ts:89`).

**Close:** hash + re-run on Tega's test account replying "been in the game" — one message ships, nothing after the Wait.

---

## Workstream 2 — Unified egress gate (Tega item 7, P3)

**Key finding:** `shadowEgressCheck` (`shadow.ts:89`) is *already* the single physical choke point — every AI send routes through `sendDM`/`sendMessage` (`instagram.ts:81`, `facebook.ts:88`) which call it, including all crons and the per-bubble drip. The gate is content-blind today (`canSend` enforces only AI_OFF/HOLD/UNSET_VARIABLE); all content guards live in `sendAIReply` (`webhook-processor.ts:4956-5692`) and never fire on cron/keepalive/recover paths.

**Design:**
- New `src/lib/state-machine/egress-guards.ts`: `EgressGuard { name, run(ctx): GuardVerdict }`, `GuardVerdict.action ∈ allow|strip|block`, ordered registry, `runEgressGuards` (strips accumulate + re-scan, first-block-wins, empty-after-strip → block). Guard helpers already exist as pure functions to wrap: `detectMetadataLeak` (`voice-quality-gate.ts:107`), `matchFailedCapitalBookingPitch` (`webhook-processor.ts:4119`), `lowTicketHarmCategory` (`voice-quality-gate.ts:4344`), `isVerbatimRepeatBubble`, `scoreVoiceQualityGroup`.
- **Gen-time vs ship-time split:** the retry loop stays the *message-shaper* (voice quality + the ~59 regen overrides — regen produces better content, can't be stripped). The gate is the deterministic *backstop*: R34 metadata leak → block; `[UPPER]` bracket placeholder → block; R24 failed-capital pitch backstop → block; low-ticket harm → block; verbatim repeat / emoji → strip; empty → block. Gen-time hardFails stay as defense-in-depth.
- Thread ship-context (`capitalOutcome`, `suppressBookingLanguage`) into `GuardContext` via the `opts` bag on `sendDM`/`sendMessage`; resolve `groupBubbles`/`priorAiMessages` inside the gate from `conversationId`.
- **Fix the two real bypasses:** `call-confirmation-sequence.ts:617,621` sends with no `conversationId`/`operatorInitiated` → heuristic fallback, content-unguarded. Thread both.

**Immediate independent hotfix (ship first, ahead of everything):** extend `UNRESOLVED_VARIABLE_RE` (`can-send.ts:34`) to also catch `\[[A-Z][A-Z0-9 _]{2,}\]` (first-char-uppercase to avoid false-firing on natural `[note]` asides). This closes the **[BOOKING LINK] leak (known bug #4) by construction** through the existing `UNSET_VARIABLE` reason — a one-line, independently deployable change. When the full gate consolidates, adopt the case-insensitive `detectMetadataLeak` pattern as the single source of truth so the ship-layer can't regress on lowercase.

**Rollout:** add nullable `guardAction`/`guardName`/`guardStripped` to `EgressShadowLog`; run guards in shadow (log-only) under `FIX_D_EGRESS_SHADOW`; soak; flip `FIX_D_CANSEND_AUTHORITATIVE` per platform (Facebook then IG); remove the redundant ship-time battery only *after* parity proven. Keep the fail-open invariant (guard *exceptions* fail open; clean *verdicts* enforce) + a per-account block-rate alarm. **ManyChat automations bypass `sendDM`/`sendMessage` entirely — explicitly out of scope; do not claim "every send."**

**Files:** create `egress-guards.ts`, `tests/unit/egress-guards.test.ts`; modify `shadow.ts`, `can-send.ts` (add `text` to verdict for strips), `instagram.ts`/`facebook.ts` (ship `gate.text ?? messageText`), `webhook-processor.ts` (thread context; later remove battery), `call-confirmation-sequence.ts`.

---

## Workstream 3 — Single prompt assembler (Tega item 6, P3)

**Sprawl confirmed:** 64 `systemPromptForLLM =` assignments (~59 in the retry loop, each `baseSystemPrompt + oneDirective`, last-writer-wins), 14 `baseSystemPrompt` appends (`ai-engine.ts:4114-4129`), 69 `.replace()` in `ai-prompts.ts`. No precedence anywhere.

**Design:** new `src/lib/prompt-assembler.ts` — `PromptAssembler` with typed `DirectiveSlot { precedence, key, text }` and an ordered `Precedence` enum (`SCRIPT_VERBATIM > VERIFIED_FACTS > PERSONA > R_RULES > REGEN_OVERRIDE`). Higher precedence emitted last (LLMs weight the final instruction) with an explicit `[PRECEDENCE: SCRIPT VERBATIM OVERRIDES PERSONA]` marker on conflict.

**Incremental migration (large — do in slices):** Slice 1 collapse the 59 retry overrides → `addSlot(REGEN_OVERRIDE)` + one `build()` (59→1, behavior-preserving). Slice 2 collapse the 14 appends. Slice 3 extract inline R-rules from the template into R_RULES slots. Slice 4 (depends on compiler) inject the compiler's verbatim script as precedence-0.

**Proving test:** `tests/unit/prompt-assembler.test.ts` — a PERSONA slot "always pitch the call" vs a SCRIPT_VERBATIM slot "say exactly X" → assert X wins and carries the precedence marker; CI grep-guard asserting exactly one `systemPromptForLLM =` in `ai-engine.ts`.

---

## Workstream 4 — Routing/progression FSM compiler (Tega items 2–4, P1, the core)

**Compiled FSM** (`src/lib/script-fsm/types.ts`): pure JSON graph — `nodes` (one per step: `deliverables`, `completion`, `edges`), `entryNodeId`, `diagnostics`. `CompiledPredicate` is a small typed AST (`always`, `verbatim_label`, `source_is`, `data_point_set/equals`, `judge_label_is{minConfidence}`, `and/or/not`) compiled **once at upload** from `conditionDescription` + `routingRules` + branch label + action shape — never re-derived from free text at runtime. `runtime_judgment` becomes an **advisory** input to `judge_label_is`, never the decider.

**Storage:** additive `Script.compiledFsm Json?` + `Script.compiledFsmVersion Int?` (nullable = "not yet compiled" → legacy fallback, the shadow safety net) + a process-level `Map` cache (`script-fsm/cache.ts`). No new rows-per-node model (would reintroduce per-turn multi-read). No revival of the dead `LeadScriptPosition`.

**Compiler** (`script-fsm/compiler.ts`): `compileScript(steps, forms)` → `{ fsm, diagnostics }`, accepts parser output *and* persisted rows. Per node: emit deliverables + `CompletionSpec` from the step's own actions using **generic** rules that replace the hardcoded detectors — `ask+wait → lead_reply_after_ask`; `runtime_judgment after wait → judgment_after_wait` (Tega items 4/5); `runtime_judgment no-ask no-wait → routing_only`; `requiredDataPoints/completionRule → data_points`. Per edge: compile a predicate, exactly one `isDefault`.

**Runtime** (`script-fsm/runtime.ts`): pure `selectEdge(node, facts)` — verbatim label match wins outright (Tega's rule); exactly-one-true → that edge; multiple → lowest sortOrder; **none-true + no default → explicit typed HOLD, never NULL** (the NULL-everything case is unrepresentable). `fsmTransition(cursor, event)` advances only when `completion` is met, monotonic, `maxAdvance:1` preserved. Branch-selection block `ai-engine.ts:3184-3273` collapses to `selectEdge`; `computeSystemStage`'s cascade → `fsmTransition`.

**Upload validator** (`script-fsm/validate.ts`, invoked in `compileScript`) — **rejects** (severity error, before persist, at `script-parser.ts:632` + the parse/reupload routes): unreachable branch/step (graph reachability), missing wait (ask/judgment with no wait → completion machinery can't credit), uncreditable completion (would stall forever), ambiguous multi-edge node with no default, duplicate branch labels / multiple defaults. Behind `FIX_D_ROUTING_REJECT_ON_INVALID` (advisory during shadow, enforcing at cutover). Warnings stay advisory as today.

**Ledger migration (no risky data migration):** add typed `fsmCursor` *inside* `capturedDataPoints` (same JSON column, additive). Shadow: derive `fsmCursor` each turn by folding the existing `branchHistory` through `fsmTransition` — every conversation migrates lazily on its next turn, zero backfill. Authoritative (per account): `fsmTransition` writes `fsmCursor` + `currentScriptStep` together; keep `branchHistory` append one release as read-shadow, then retire. `currentScriptStep` (the Int column, dashboard/trace-visible) is never removed.

**Rollout:** new `RoutingShadowLog` (mirror `EgressShadowLog`/`DistressShadowLog`): per turn `legacyBranchLabel` vs `fsmBranchLabel`, `legacyNextStep` vs `fsmNextStep`, `branchAgreed`/`advanceAgreed`, `fsmReason`. Flags `FIX_D_ROUTING_SHADOW` (default on) + `FIX_D_ROUTING_AUTHORITATIVE` (csv of accountIds). Best-effort awaited logging, fail-open-but-loud. **daetradez flipped last** — its hand-debugged behavior is the shadow's ground truth; parity there is the exit criterion.

**Retire the hardcoding (Phase 3, after shadow clean):** `MANDATORY_ASK_STEPS`, `CALL_PROPOSAL_PREREQS`, `CAPITAL_QUESTION_PREREQS`, step-9/10/12 detectors, `deriveCallProposalPrereqs` — all replaced by compile-time derivation. Factor `getStepActionShape` core for compiler reuse rather than duplicating.

**Riskiest parts:** predicate compilation from prose (mitigation: `judge_label_is` fallback keeps the LLM in the loop where prose can't compile confidently; daetradez shadow is the acceptance oracle); completion-spec inference reproducing all 6 current detectors' effect (tripwire: `advanceAgreed=false` rows; keep `maxAdvance:1`); ledger fold idempotency (mitigation: legacy authoritative until per-account cutover + a `cursor-vs-currentScriptStep` mismatch alert); preserving the step-1 source-routing determinism (compile `source_is` ahead of `judge_label_is`; mandatory regression test on the dual-opener case).

---

## Workstream 5 — Fact store + capital-classifier rewrite (Tega item 5, P2; absorbs known bugs #1, #2)

**Fact store:** append-only lead facts (experience, location, work, income goal, capital) written once per source with timestamp + provenance; a later lead statement overrides an earlier classifier inference (evidence: lead said "I'm new" at 10:33, got experienced-trader copy at 10:38 — the correction never overwrote the misroute's inference). Close: same conversation re-run, experience fact reads "new" after correction, downstream step selects new-lead copy.

**Capital-classifier rewrite (user decision: no more regex).** The current `parseLeadCapitalAnswer` (`ai-engine.ts:10667`) is a ~15-patch regex tower; the two R24 bugs (#1 "Almost 4k" reads 4000 before the hedge is checked; #2 prop-firm coverage gaps in a hardcoded firm list) are more of the same class. Replace with **structured extraction** — an LLM-based capital-answer classifier (mirror the existing `capital-amount-classifier.ts` Haiku fallback, but make it the primary path) emitting a typed result `{ kind: amount|hedged|prop_firm|disqualifier|ambiguous, amountUsd?, confidence, provenance }`, whose output the fact store persists with provenance. Hedges ("almost/nearly/about") and prop-firm capital resolve to `ambiguous` by design, not by lexicon. Keep a thin deterministic guard only for unambiguous disqualifiers. This is the item where "no hardcoded regex, no one-script-bound" is realized for the money step.

**Known bug #3 (R24 default question instead of scripted ask) — partially closed here:** the FSM (WS4) closes the null-branch route so the scripted ask lands in scope; the residual is `buildR24BlockedFallbackMessage` (`ai-engine.ts:9732`) firing on plain retry-exhaustion and never being handed the operator's question. Thread the scripted step's verbatim ask + `capitalVerificationPrompt` into the builder (~0.5–1 day), mirroring the Step-18 guard that already enforces "use the script's [ASK] verbatim."

**Known bug #5 (timezone ask despite script removal):** the *wording* half (don't ask when the script has no tz step) is patchable now, same class as the urgency-phrasing resolver — gate the injection at `ai-prompts.ts:2747`/`373` on a `scriptAsksForTimezone` predicate. The *slot-labeling* half (calendar connected but script skips tz → the slot-fetch path physically needs a tz) is genuine design work + a default-tz config, and belongs here with the booking/fact context.

---

## Workstream 6 — Verification harness (the proof mechanism for every item)

**The key decomposition (solves the Meta #10 window-closed wall):** split **routing correctness** (compiler-shadow, provable on any script with **zero Meta dependency** via `RoutingShadowLog` + `GenerationTurnTrace`) from **delivery** (needs an open 24h window). Routing gets proven immediately; delivery is a separate, later item per checkpoint.

**Components (all `scripts/`, reusing the existing harness):**
1. `seed-verification-account.ts` — idempotent, config-driven fixture seeder (upsert on stable `manyChatWebhookKey`; deactivate sibling personas/scripts). Provisions a **synthetic high-ticket** account that differs from daetradez on every axis that stresses the compiler: standard funnel (`disableLeadStageProgression:false`), `minimumCapitalRequired` set, calendar-connected, deliberately different step count + branch topology + stage order. Absorbs a **Tega-provided third script** via `parseScriptMarkdown` as a config edit. Build the fixture script with the deterministic `seedDefaultScript` builder; mirror `populate-dae-tenant-data.ts` for `promptConfig`.
2. `drive-shadow-funnel.ts` — fork of `drive-prod-funnel.ts` that drives the seeded account's FSM through the engine **locally** (no Meta page/PSID/window needed), reuses the adaptive Haiku loop + `verifyTurn` checklist + `withRetry`, asserts `compiler == judge` per turn from `RoutingShadowLog`.
3. `emit-evidence.ts <convId>` — emits Tega's exact bundle: commit hash (`/api/version` `fullCommit`), conv ID + file:line, before/after `GenerationTurnTrace` (via `dump-trace-report.ts`/`inspect-turn-trace.ts`), routing-shadow disagreement count, unit-suite `PASS/FAIL` **with named pre-existing failures** (run the suite, capture the baseline — not a hardcoded string; extend `mark-verification-baselines.ts`), delivered-to-inbox confirmation (or `N/A — routing-shadow item`).
4. Add the missing `test:unit` npm script (`tsx --test tests/unit/*.test.ts`).

**Three accounts:** Apex/ScaleVault (already live — the delivered-downsell proof, no seeder needed); the synthetic high-ticket fixture (we own it, routing provable Meta-free); Tega's fresh third script (the true script-independence test — routed correctly on first contact).

**Needs Tega vs do-alone:** *alone now* — seeder + shadow driver + routing-shadow ledger + evidence runner + the Sept-6 routing proof. *Needs Tega* — open 24h window on Apex (Sept 13 delivery), a real page/PSID + calendar creds for the fixture's BOOKED path (Sept 20), and the raw text of a fresh never-debugged script (Sept 29).

---

## Checkpoint mapping (Tega's dates)

- **Sun Sep 6** — WS1 Wait-boundary gate closed **+** the `[BOOKING LINK]` bracket hotfix shipped (closes known bug #4) **+** WS6 fixture stands up and routing proven Meta-free on a genuinely different script. *Do-alone; no Tega blocker.*
- **Sun Sep 13** — WS4 items 2–3: compiler generates + validates the FSM (every existing script compiles, daetradez zero-error, validator rejects a broken fixture); compiler owns multi-branch routing in **shadow**. WS5 timezone-wording + R24-default-ask fixes. Apex delivery re-run.
- **Sun Sep 20** — WS4 item 4: judgment+wait completion; routing shadow diff clean on live daetradez traffic → begin per-account authoritative flips (daetradez last). WS5 fact store + capital-classifier rewrite + slot-labeling. High-ticket BOOKED path delivered (needs Tega page/calendar).
- **Tue Sep 29** — WS2 unified gate authoritative (per-platform) + WS3 prompt assembler slices 1–2 (compiler-independent) then 3–4. Fresh third script routed correctly on first contact (the thesis proof).

## Known-bugs triage (folded in, for the Tega message)

| Bug | Verdict | Where it lands |
|---|---|---|
| [BOOKING LINK] leak | closed by construction | WS2 bracket hotfix (Sep 6) + unified gate |
| Timezone ask despite removal | split | WS5: wording gate (Sep 13) + slot-labeling policy (Sep 20) |
| R24 default question vs scripted ask | partial | WS4 closes null-branch route; WS5 threads scripted ask into the fallback (Sep 13–20) |
| R24 "Almost 4k" false positive | needs own fix | WS5 capital-classifier rewrite (Sep 20) |
| Prop-firm answers pass R24 | needs own fix | WS5 capital-classifier rewrite (Sep 20) |

---

## Verification (how each item is proven end-to-end)

Every item closes on Tega's standard: **commit hash** (`/api/version` `fullCommit`) + **file:line** + **conv ID** + **before/after `GenerationTurnTrace`** on a real lead + **unit suite count with the pre-existing failures named** + **delivered-to-inbox** (or `N/A — routing-shadow item`). Concretely:
- Routing items: `seed-verification-account.ts` → `drive-shadow-funnel.ts` → `emit-evidence.ts`; assert `RoutingShadowLog.branchAgreed/advanceAgreed` clean and `selectEdge` never returns NULL/hold on a well-formed script.
- Gate items: shadow-diff `EgressShadowLog` clean per platform before flip; a per-guard unit test; re-run proving the guarded content is blocked/stripped on a real send.
- Compiler validation: upload the daetradez script (compiles zero-error) and a deliberately-broken fixture (rejected with a readable error) via the parse/reupload routes.
- Run `npx tsx --test tests/unit/*.test.ts`, record `PASS/FAIL` + the named pre-existing classifier failures as the dated baseline (currently 4; confirm from a clean run, don't quote).
- TSC clean; auto commit+push per repo convention (trailer `Co-Authored-By: Claude Opus 4.8`).

## Risk register (top)

1. **Predicate compilation from prose misroutes silently** → `judge_label_is` fallback + daetradez shadow oracle + daetradez flipped last.
2. **Completion-spec inference stalls or skips a step** → `advanceAgreed=false` tripwire, `maxAdvance:1`, reproduce all 6 detectors' effect before cutover.
3. **Gate authoritative flip hold-storms** → per-platform soak-clean gate, block-rate alarm, blocks are heartbeat-recoverable not permanent silence.
4. **Ledger fold mis-places a live daetradez lead** → lazy per-turn derivation, legacy authoritative until per-account cutover, mismatch alert.
5. **Capital rewrite regresses a currently-passing case** → keep the old classifier as a shadow comparator during soak; the fact store makes the decision auditable.
6. **Timeline:** the capital-classifier rewrite (user-chosen over patching) adds real scope to Sep 20 — flag to Tega the day it looks tight, per his "flag slips the day you know" rule.

---

## Status addendum — 2026-09-13 (compiler slices A–C live in shadow)

**Shipped (all deployed to prod, all in shadow unless stated):**

- Item 1 (Wait-boundary gate): closed live on FB conv `cmtws9qly0009l504abico3xr` (intro + ask delivered, "That's awesome, I'm over in here in Texas." withheld, reason `WAIT_BOUNDARY`). Guard registry `src/lib/state-machine/egress-guards.ts`; matcher extracted to `state-machine/copy-match.ts`.
- Item 2 (compiler + upload validation): `src/lib/script-fsm/{types,compiler,store}.ts`, `Script.compiledFsm/compiledFsmVersion` (migration `20260911150000_script_fsm_compiled`), 422 on `parse`/`reupload` when `FIX_D_ROUTING_REJECT_ON_INVALID`. Daniel compiles 14 nodes / 0 errors; Ali's junk script is rejected (empty step). `COMPILER_VERSION = 2`.
- Item 3 (routing): `runtime.ts selectEdge` (verbatim > structural > judge advisory > default > typed hold; never null). Shadowed in `ai-engine.ts` right after the single-branch determinism block; `RoutingShadowLog.branchAgreed`.
- Item 4 (advancement): position is a **pure fold of the full conversation history** through the machine (`foldHistory`). Credit rules: a lead reply counts only after we (AI/HUMAN, never ManyChat) spoke in the step; a branch with N wait boundaries needs N credited replies; routing-only / send-only complete on our outbound; branch = judge ledger → structural (source/always/data) → delivered-copy inference (exactly one owner) → default. Shadowed in `prepareScriptState`; `RoutingShadowLog.advanceAgreed`; cursor stashed at `capturedDataPoints.fsmCursor`.
- Flags: `FIX_D_ROUTING_SHADOW` (default on), `FIX_D_ROUTING_AUTHORITATIVE=<accountId,…|ALL>` (branch + position owned by the FSM; **not set for anyone yet**), `FIX_D_ROUTING_REJECT_ON_INVALID`.

**Evidence tooling (`scripts/verify/`, all read-only, run with `DATABASE_URL="$PROD_DATABASE_URL"`):**
`routing-shadow-status.ts` (migration/compiled state + agreement counts), `routing-disagreements.ts` (transcripts behind disagreements + step shapes, `--script` to list steps), `routing-fold-replay.ts` (fold every real conversation of an account and compare with legacy `currentScriptStep`, Meta-free).

**Replay on Daniel, last 7 days (2026-09-13, 255 conversations):** 232 were human-run / generate-only (legacy never evaluated them); of the 23 legacy-evaluated: 11 agree, 5 FSM ahead, 7 FSM behind.
- All 7 "behind" = the warm step-1 branch has TWO asks (location, then new/experienced); the script says two replies, legacy credits one and moves on. Legacy's shortcut is why `cmty12h1b000ol904lfj38qxy` (lead opened with "I'm a beginner") got routed into "Already in markets" at step 2. The FSM reading is the script's reading; keep it.
- "Ahead": ManyChat conversations where legacy lags a turn (`cmtx9x3aj0003l804lg0ir73z`), and one known limitation: `cmtws66km0003l504a5toczil`, where the engine freelanced a question at step 11 instead of the $200 qualification ask; both algorithms credit "any outbound + reply", legacy only held because of the Daniel-hardcoded capital-question detector. The generic fix is the required-ask egress guard (item 7), not a heuristic in the tracker.

**Not yet done:** authoritative flips (per account, daetradez last); fixture seeder + shadow driver (WS6) for a non-daetradez proof; items 5, 6, 7 consolidation; retiring the hardcoded detectors (Phase 3).
