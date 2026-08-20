# QualifyDMs Phase 1 — Fix Log

Running record of every diagnostic finding, fix, and decision made during
the Phase 1 engagement (2026-05-18 → 2026-06-01).

**How to read this file:** each entry is dated, references the task ID
(QD-XXX from the QA sheet, or a named work stream from
`PHASE_1_PLAN.md`), and is structured so the client can read it
end-to-end as an engagement report at any time.

**Companion docs:**
- `QualifyDMs_Dev_Handoff.md` — engagement-level build plan + scope
- `PHASE_1_PLAN.md` — codebase-verified day-by-day execution plan
  (check-the-box source of truth)

---

## Entry format

```
### YYYY-MM-DD — Day N — <TASK_ID(s)> — <Short title>

**Status:** Diagnosed / Fix in flight / Fixed / Blocked / Out of scope

**Symptom (what the client / QA saw):**
…

**Root cause (verified):**
…

**Fix shape:**
…

**Files touched / inspected:**
…

**Why this approach:**
…

**Verified by:**
…

**Follow-ups / dependencies:**
…
```

---

## Entries

### 2026-05-30 — Day 10 Acceptance — F5.1 layer-1 passive capital scan (resolver-side)

**Status:** Fixed (commit f9dbd11 on `phase-1-implementation`)

**Symptom (what the client / QA saw):**
During M2 acceptance E2E, the AI kept emitting discovery questions ("what does your job pay?", "how long you been doing the 9-5?") for 7+ turns even after the lead said "I have 5k saved up" and "yes let's hop on a call." The lead's `lead.stage` was stuck at `QUALIFYING` with `stageMismatchCount` climbing turn over turn. No booking ever fired despite the LLM's last turn emitting `llmEmitted: BOOKING`.

**Root cause:**
The resolver `applyStageOverride` in `script-state-recovery.ts` has a gate at line ~5721 that forces the lead back to `QUALIFYING` whenever the LLM emits a high-intent stage (BOOKING / CALL_PROPOSED / QUALIFIED / SEND_APPLICATION_LINK) AND `verifiedCapitalUsd === null`. The R24 path that writes `verifiedCapitalUsd` only fires when an explicit AI capital question is followed by a lead answer. Leads who mentioned their capital unsolicited (in answer to a different discovery question) had their amount sitting in message history but never extracted — so the gate fired forever.

**Fix shape:**
Added `scanForPassiveCapitalQualification` + `persistPassiveCapital` helpers above the resolver. When about to block at `cannot_be_qualified_without_capital_verification`, walk the recent LEAD messages for a positive capital signal phrase (`PASSIVE_CAPITAL_SIGNAL_PHRASES`), filter out negative contexts (`PASSIVE_NEGATIVE_CONTEXT` — "lost X", "made X last month", "my salary is X", etc.), parse with the existing `parseLeadCapitalAnswer`, compare against `persona.minimumCapitalRequired`. On a clean match, persist `verifiedCapitalUsd` + `capitalThresholdMet` and let the lead advance to the LLM-emitted high-intent stage.

**Files touched:**
- `src/lib/script-state-recovery.ts` (helpers added, `applyStageOverride` branched into the scan before the "cannot_be_qualified" return)

**Verified by:**
Direct unit call of `applyStageOverride` on a real conversation with "I have around 5k saved up" in history, persona threshold $497:
- Before fix: `finalStage='QUALIFYING'`, `reason='cannot_be_qualified_without_capital_verification'`
- After fix: `finalStage='BOOKING'`, `capitalOutcome='passed'`, `reason='passive_capital_scan_qualified'`, `capitalVerifiedAmount=$5000`, `capitalVerificationStatus='VERIFIED_QUALIFIED'`, `capitalThresholdMet.extractionMethod='passive_lead_message_scan'`
- `tsc --noEmit` clean, conversation fixtures 21/21 still pass

**Follow-ups / dependencies — F5.1 has a layer 2:**
The live E2E drive showed that even with this fix in place, the LLM-side stage emission still kept routing to discovery questions (`SITUATION_DISCOVERY`, `Job Acknowledgment`, `Monthly Income`) on lead messages like "yes lets do a call, tomorrow 3pm Karachi works, email shazim@test.com" — i.e. the LLM didn't emit `BOOKING` in the first place. That's prompt-routing work, separate from the resolver, and stays as **Phase 2 F5.1 layer 2**. With both layers fixed, the autonomous lead→BOOKED conversational path will work without any DB pre-population. Today's fix dramatically narrows the failure surface and makes the autonomous booking robust whenever the LLM does emit a high-intent stage.

---

### 2026-05-30 — Day 9 Extension — F8 Analytics Reconciliation [QD-032 → QD-041]

**Status:** Fixed (commit 3a08156 on `phase-1-implementation`)

**Symptom (what the client saw):**
> "Stage progression needs to be accurate and consistent across the board — the conversations tab, the analytics, and the pipeline tab all need to reflect the same data. Right now they are showing different numbers."

Plus a cluster of 8 follow-on QA bugs: Overview vs Pipeline mismatch (QD-032), six more Overview mismatches (QD-033 → QD-038), "With Stage Data: 0" despite 22 conversations (QD-039), Cold Start Thresholds showing 0/50 0/30 0/20 (QD-040), Conversation Funnel chart empty (QD-041).

**Root causes (audit in `ANALYTICS_AUDIT.md`):**
1. No shared definition of "qualified" / "booked" / "showed". Conversations tab said `[QUALIFIED, CALL_PROPOSED, BOOKED, SHOWED, CLOSED_WON]` (5 stages, documented inline); Analytics Funnel said `[QUALIFIED, BOOKED, SHOWED, NO_SHOWED, CLOSED_WON, NURTURE]` (6 stages); Dashboard Actions said `[QUALIFIED, CALL_PROPOSED, BOOKED]` (3 stages). Three answers to the same question.
2. Cold-pitch exclusion applied inconsistently — Overview excluded cold-pitch from `totalLeads` but NOT from `stageCounts` (internal asymmetry), Funnel didn't exclude at all, Lead-Distribution Pie didn't exclude.
3. `cold-start.ts` silently ignored its `_thresholdOverride` parameter (the underscore was an unused-parameter convention).
4. `data-quality` "With Stage Data" used every message as the denominator, but LEAD/supportive/handoff messages have `Message.stage = null` by design.
5. Conversation-funnel counted reached-stages across ALL conversations, so any account with pre-SOP imports saw a flat-zero chart.
6. AI's autonomous booking only wrote `scheduledCallAt` — `scheduledCallTimezone`, `scheduledCallSource`, `scheduledCallConfirmed`, and audit fields were left for a human to fill in.

**Fix shape:**
- New `src/lib/lead-state-sets.ts`: canonical `QUALIFIED_LEAD_STAGES`, `BOOKED_LEAD_STAGES`, `SHOWED_LEAD_STAGES`, `ACTIVE_LEAD_STAGES`, `TERMINAL_LEAD_STAGES`, `STAGES_WITH_STAGE_DATA`, plus `EXCLUDE_COLD_PITCH` filter. Every analytics route + the Conversations / Leads / Dashboard surfaces import from here.
- Funnel, Overview, Segments, Conversations, Lead-Distribution, Dashboard Actions: all refactored to the helper. Cold-pitch policy uniform across main-funnel aggregates; Leads list remains unfiltered (tag-visible).
- QD-039: data-quality denominator switched to AI-pipeline messages.
- QD-040: `cold-start.ts` honors the threshold parameter.
- QD-041: conversation-funnel restricted to in-SOP conversations + returns `funnelDenominator` / `excludedPreSop` for UI labeling.
- Autonomous booking persists every call-detail field the manual PUT path writes (`scheduledCallTimezone`, `scheduledCallSource: 'CALENDAR_INTEGRATION'`, `scheduledCallConfirmed: true`, audit timestamps).
- `tests/analytics-reconciliation-test.ts`: 10 helper-invariant tests + 4 seeded cross-view tests asserting Funnel and Conversations report the same numbers for a known seed. Caught one real bug (SHOWED missing from ACTIVE_LEAD_STAGES) before commit, fixed before merge.

**Files touched:**
- `src/lib/lead-state-sets.ts` (new), `src/lib/cold-start.ts`, `src/lib/webhook-processor.ts`
- `src/app/api/analytics/{funnel,overview,segments,lead-distribution,conversation-funnel,data-quality}/route.ts`
- `src/app/api/conversations/route.ts`, `src/app/api/dashboard/actions/route.ts`
- `tests/analytics-reconciliation-test.ts` (new), `package.json` (added `test:analytics-reconciliation`)
- Docs: `ANALYTICS_AUDIT.md` (new), `PHASE_1_PLAN.md` (F8 block added under Day 9 Extension)

**Verified by:**
- `npx tsc --noEmit` clean across the full repo.
- `npm run test:conversations` — 21/21 pass.
- `npm run test:analytics-reconciliation -- --seed` — 14/14 pass (10 helper invariants + 4 seeded cross-view).
- `next build` green via pre-push hook.

**Follow-ups / dependencies:**
- Visual sub-pages (Analytics Deep Dive / AB Tests / Optimizations / Team / Live / Predictions) read routes I've already mapped; if QA flags inconsistencies there during Week 2 acceptance, they inherit the same 3 root causes addressed by this commit.
- F5.1 (hardcoded DAE funnel) remains the gate for E2E on non-Daniel accounts; not affected by F8.

---

### 2026-05-30 — Day 10 prep — LeadConnector (GoHighLevel) verified live

**Status:** Fixed (verified)

**Symptom (what the client saw):**
LeadConnector / GoHighLevel was the 4th calendar option but had never been verified end-to-end. We had no GHL account to test against.

**Fix shape:**
Tega supplied a Private Integration Token + Location ID + Calendar ID for his Daetradez location. Ran the unified adapter end-to-end: availability returned 11 real slots, a real contact + appointment were created in GHL (status `confirmed`, with the calendar's configured Zoom link as the meeting URL), then both were deleted so the live account stays clean. PIT token works directly with the Bearer + `Version: 2021-07-28` headers the adapter already uses; no code changes needed.

**Files touched:**
- Memory: `project_calendar_providers.md`, `project_m2_status.md`
- Dev test (untracked): `scripts/test-leadconnector.ts`

**Verified by:**
Live API: availability HTTP 200 (11 slots), contact create HTTP 201, appointment create HTTP 201, appointment delete HTTP 200, contact delete HTTP 200. Credentials are saved on the local account so the UI shows LeadConnector "Connected". Active calendar reset to Google.

**Follow-ups / dependencies:**
All 4 calendar providers (Google, Calendly, Cal.com, LeadConnector) now verified live. Only Clerk/QD-001 (Google login) remains parked on Tega's Clerk access. F5.1 hardcoded funnel still gates full lead→BOOKED E2E on non-Daniel accounts (Phase 2 HIGH).

---

### 2026-05-28 — Day 9 — Hardening: quota wrapper + QD-014 + QD-046

**Status:** Fixed (3 commits on phase-1-implementation: ba33bb8, 0d84eb3)

**Symptom (what the client / QA saw):**
- A wall of raw provider JSON appeared in the dashboard whenever an OpenAI/Anthropic key ran out of credit or hit a rate limit (QD-003/024/043/044/045/048).
- Operators could accidentally set a call date years out (QD-014).
- The tag picker on the Leads page never showed any account tags, even though tags created in Settings looked fine there (QD-046).

**Fix shape:**
- Created `src/lib/ai-error-handler.ts` with `safeOpenAI` / `safeAnthropic` / `classifyAIError` / `aiErrorResponse`. Classifier duck-types both SDKs' error shapes (status + code + message) into `quota | rate_limit | auth | overloaded | timeout | unknown` and returns operator-friendly messages with proper HTTP status. Applied to the operator-facing routes (test-message, persona analyze/extract/script/section, training upload + structure, voice-note process) and the two core ai-engine generate calls.
- QD-014: rejected `scheduledCallAt > now + 6 months` in the PUT handler at `api/conversations/[id]/call`, mirrored in `call-details-panel.tsx` with a toast plus a `max` attribute on the datetime input.
- QD-046 root cause: `useTags()` in `src/hooks/use-api.ts` read `.tags` off the response, but `getTags()` had already unwrapped to a `Tag[]` array — so the hook always returned `[]`. Fixed by using the array directly. Both the Leads tag picker and the Settings tag manager now show tags correctly.

**Files touched:**
- `src/lib/ai-error-handler.ts` (new), `src/lib/ai-engine.ts`
- `src/app/api/ai/test-message/route.ts`
- `src/app/api/settings/persona/{analyze,extract,script/route.ts,script/[id]/section}/route.ts`
- `src/app/api/settings/training/upload/route.ts`, `src/app/api/settings/training/upload/[id]/structure/route.ts`
- `src/app/api/voice-notes/[id]/process/route.ts`
- `src/app/api/conversations/[id]/call/route.ts`
- `src/features/conversations/components/call-details-panel.tsx`
- `src/hooks/use-api.ts`

**Verified by:**
`npx tsc --noEmit` clean, conversation fixtures 21/21 pass, `next build` green (pre-push hook). Classifier unit-tested against representative OpenAI `insufficient_quota`, Anthropic credit-balance-too-low, 429 rate limits, 401 invalid keys, 529 overloaded, and timeout error shapes.

**Follow-ups / dependencies:**
Reschedule flow (the last Day 9 plan item) deferred to Phase 2 alongside F5.1 — it depends on the funnel rework and can't be verified E2E on non-Daniel accounts until F5.1 is addressed. Operators can still reschedule manually via the call-details panel today.

---

### 2026-05-25 — Day 8 follow-on — Active calendar selector + Calendly real link + Cal.com v2

**Status:** Fixed (3 commits on phase-1-implementation: 3773a52, 3906c7f)

**Symptom (what the client saw):**
- With multiple calendars connected, there was no UX for the operator to choose which one the AI uses. The adapter just picked whichever had credentials in a hardcoded order, silently.
- Calendly's "booking link" was an empty string — the adapter looked for a `schedulingUrl` field that the connect flow never saved.
- Cal.com was a UI-less code path; once added, the adapter's v1 endpoints returned HTTP 410 because Cal.com decommissioned v1.

**Fix shape:**
- New `activeCalendarProvider` field on Account, "Active booking calendar" selector card in Settings → Integrations with Google flagged as Recommended and Calendly as Link-mode. When set, the adapter uses only that provider; when null, it falls back to precedence so existing accounts don't break.
- Calendly is now genuinely usable: mint a real single-use scheduling link via `POST /scheduling_links` against the stored `eventTypeUri`, and return `requiresLeadAction: true` so the webhook-processor drops the link and does NOT mark the lead BOOKED or claim "locked in." The booking-confirm path in webhook-processor handles link-mode as a separate branch from auto-book.
- Cal.com adapter migrated to v2 (Bearer auth + `cal-api-version` headers, event-type auto-detect, `/v2/slots` for availability, `/v2/bookings` for booking). Cal.com connect card added to Settings.

**Files touched:**
- Schema migration: `add_active_calendar_provider`
- `src/lib/calendar-adapter.ts`, `src/lib/webhook-processor.ts`
- `src/app/api/settings/calendar-provider/route.ts` (new), `src/app/api/settings/integrations/route.ts`, `src/app/api/settings/integrations/[provider]/route.ts`
- `src/app/dashboard/settings/integrations/page.tsx`

**Verified by:**
- Google: real event + Google Meet link created (verified earlier).
- Calendly: single-use scheduling link minted (`/d/cvsb-7h2-hkn`), resolves HTTP 200.
- Cal.com: 153 real v2 slots returned, real booking created (uid `mF7wuXRKfBUjEzCcNfdiKx`) with Meet link, then cancelled cleanly via `/v2/bookings/{uid}/cancel`.
- Build green, 21/21 conversation fixtures pass.

**Follow-ups / dependencies:**
LeadConnector was the only provider still unverified after this work; tracked separately and verified on 2026-05-30.

---

### 2026-05-23 — Day 8 — Autonomous booking re-enabled (guarded) + Google Calendar provider

**Status:** Built, tsc clean, 21/21 fixtures green. E2E (lead → BOOKED) needs a conversation to reach Stage 7 (gated by F5.1 funnel work / a Daniel-shaped script).

**Decision:** Tega (2026-05-23) — "I want the AI to fully book calls on its own (LeadConnector, Google, or whatever)." Server-side booking had been deliberately removed earlier because providers failed and leads got a phantom "you're locked in" with no calendar entry. Re-enabled now that Google Calendar is a reliable provider, with a guard that fixes the original problem.

**What shipped (Day 6-8 combined):**
- Google Calendar provider (`google-calendar.ts`) + OAuth connect/callback + Settings card (connected email shown, calendar-scope grant enforced). Verified live: connect → availability (40 real slots).
- `/dashboard/calendar` tab showing unified availability.
- **Guarded autonomous booking** in `sendAIReply` (`webhook-processor.ts`): at BOOKING_CONFIRM with a slot, `bookUnifiedAppointment` runs **before** the confirmation is delivered. Success → append Meet link, ship confirmation, mark lead BOOKED, schedule the call-confirmation sequence + reminders. Failure → ship a safe holding line (NOT a fake confirmation), flag `awaitingHumanReview`, never mark BOOKED. This is the fix for the phantom-confirmation problem that caused the original removal.

**Files touched:** `src/lib/webhook-processor.ts` (guarded booking in sendAIReply, replaced the old no-op block).

**Verified by:** tsc clean; conversation fixtures 21/21; booking primitive (bookUnifiedAppointment → Google events.insert) shares the verified availability/OAuth path.

**Follow-ups:** full lead→BOOKED E2E needs the funnel to reach Stage 7 (F5.1). Calendly server-side booking still a stub (link-drop only). Cal.com/LeadConnector booking unverified (no sandbox).

---

### 2026-05-23 — Placeholder leak — lowercase `[bracket]` placeholders reached a lead

**Status:** Code gap fixed + tested. The specific leak is also a per-account config fix (uncustomized opener).

**Symptom (found in QA):** a lead received the AI message *"Hey! Thanks for reaching out 🙌 What made you interested in [your offer]?"* — the literal `[your offer]` template placeholder was sent.

**Two causes:**
1. **Config:** a **script step `[MSG]`** on shazim's Workspace was an uncustomized template — `[your offer]` was never filled in. The script opener takes priority over the persona's (good) opener, so the templated one shipped.
2. **Code gap:** the placeholder guards only caught **ALL-CAPS** bracket tokens. `BRACKETED_PLACEHOLDER_REGEX = /\[[A-Z][A-Z0-9 _]{2,}\]/` and the metadata-leak pattern `/\[[A-Z][A-Z_\s]+\]/` both required an uppercase first letter, so lowercase `[your offer]` slipped through every check (and the Day-4 resolver only handles `{{curly}}` placeholders).

**Fix:** made both bracket patterns case-insensitive — `/\[[A-Za-z][A-Za-z0-9 _]{2,40}\]/` (letter-led, 3+ chars so `[9:30]`/`[ok]` don't false-trip). Now a lowercase `[placeholder]` is caught by `detectMetadataLeak`, which the messages route + ship-time guard use to **block any sender (AI or human)** from delivering a placeholder, and which routes AI generations through the R34 strip/re-prompt/escalate chain. Also broadened the `<angle>` placeholder pattern to lowercase for consistency.

**Files touched:** `src/lib/voice-quality-gate.ts` (METADATA_LEAK_PATTERNS + section-9b regex); `tests/unit/placeholder-leak-detection.test.ts` (new, 9 cases).

**Verified:** `tsc` clean; new test 9/9; 21/21 conversation fixtures + 6/6 placeholder-resolver tests still green; manual check confirms `[your offer]`, `[name]`, `[BOOKING LINK]` flagged while normal trading copy / times / "ok bet" are not.

**Config follow-up (shazim's Workspace, not Daniel's):** edit the Step 1 `[MSG]` to fill in the real offer (or rephrase to drop the placeholder) so the opener is correct, not just blocked.

---

### 2026-05-21 — QD-059 correction — restore Away Mode as the auto-send gate

**Status:** Fixed + verified live (both away-on and away-off paths). Raised by Tega on review.

**Tega's question:** *"The AI should only auto-respond when Away Mode is turned on. It should not auto-respond by default at all times. Did the fix respect the Away Mode toggle or remove that condition?"*

**Honest answer: the original QD-059 fix removed it.** The 2026-05-18 fix set `autoSendOverride: shouldEnableAI` (= true) on every new inbound conversation create. Since the delivery rule is `shouldAutoSend = aiActive && (awayMode || autoSendOverride)`, forcing `autoSendOverride=true` made the `awayMode` term irrelevant — every new lead auto-responded regardless of Away Mode. This also re-introduced the "@l.galeza" risk (a brand-new lead auto-replying before opt-in) that the create path is supposed to own.

**Root cause:** over-correction. QD-059's real bug was `aiActive: false` hardcoded (AI never responded even when Away Mode was on). The correct fix is `aiActive = defaultAiActive` so the AI is engaged; **`autoSendOverride` should stay false on create** so Away Mode gates auto-send. The 2026-05-18 change additionally mirrored `autoSendOverride=aiActive`, which is what broke the gate.

**Fix:** `autoSendOverride: false` on all three inbound conversation-create sites (`webhook-processor.ts` + two in `manychat-handoff.ts`). `aiActive` still honors `defaultAiActive`. `autoSendOverride=true` is now set ONLY by the operator's explicit per-conversation AI toggle (the documented purpose). The `shouldAutoSendReply` gate itself was already correct and is unchanged.

**Resulting behavior (verified live on shazim's local account):**
- Away Mode **OFF** → `aiActive=true awayMode=false autoSendOverride=false shouldAutoSend=false` → *"AI suggestion generated (not auto-sending)"* — AI does NOT auto-respond, generates an operator-review suggestion. ✅
- Away Mode **ON** → `aiActive=true awayMode=true autoSendOverride=false shouldAutoSend=true` → AI auto-replies. ✅
- Operator manually toggles AI on for a convo → `autoSendOverride=true` → auto-sends regardless of Away Mode (intended explicit-enable path). ✅

**Files touched:** `src/lib/webhook-processor.ts`, `src/lib/manychat-handoff.ts`.

**Verified by:** `tsc` clean; `should-auto-send-reply` unit tests 5/5; live drive on Instagram with Away Mode toggled OFF then ON.

**Follow-up tightening (same day, Tega):** the first pass above kept `aiActive=true` on new leads (suggestion mode) when Away Mode was off — and ManyChat-originated conversations were turning AI on regardless of Away Mode. Tega's requirement is stricter: **when Away Mode is off, NO new lead should have AI on at all** — only existing conversations the operator explicitly toggled on. Fixed by gating `aiActive` itself by Away Mode on all three create sites: inbound `shouldEnableAI = awayModeForPlatform && (defaultAiActive ?? true)`, and ManyChat `aiActive = account.awayModeInstagram && account.defaultAiActive`. The ManyChat **existing-lead** path never wrote `aiActive`, so operator-enabled threads are untouched. Verified live: new inbound lead with Away Mode OFF now creates `aiActive=false` (`AI=OFF`), with Away Mode ON `aiActive=true` (`AI=ON` → auto-send).

---

### 2026-05-21 — Day 5 — Looping NOT reproduced; found funnel-progression blocker (F5.1) + verbatim-MSG wall

**Status:** Diagnosed via live multi-turn testing. Looping: no fix needed. F5.1: written up in PHASE_2_PLAN (code fix deferred); M1 stopgap applied. Verbatim-MSG: new finding, open.

**Method:** Drove deep multi-turn conversations through the **real local pipeline** (signed webhooks → AI generation → outbound), after the operator re-opened the Meta 24h window on FB + IG. Built `scripts/drive-fb-turn.ts` / `drive-ig-turn.ts` to send a lead message, wait for the AI reply, and report new bubbles + stage. (IG path is backfill-free, so it gives clean conversations.)

**Finding 1 — looping (the planned Day 5 bug) does NOT reproduce.** Across multiple clean runs the AI advanced every turn (situation → goal → why → urgency) with no repeated questions. The existing anti-loop layers all work: prompt rules (R8 / R30 / immediate-repeat / ASK-CAP), the deterministic near-duplicate **Jaccard block** at send time (`ai-dedup.ts` → `webhook-processor.ts:4774`), and a live `Repetitive question pattern detected — forcing regen` guard. All 21 conversation-fixtures pass. **No code change needed for looping.**

**Finding 2 — the autonomous funnel can't complete (F5.1).** With shazim's own generic 10-step script, every warming conversation **hard-escalated to a human at soft-pitch**: the script-step tracker was frozen at "Step 1" (the gate's `currentScriptStep` never advanced) while the gate enforced Daniel's hardcoded ~25-step funnel (`work_background`, `income_goal`, `call_proposal_prereqs`, "Step 16 Call Proposal"). Two root causes: (a) the DAE funnel is hardcoded across 6 files and enforced regardless of the account's script; (b) `LeadScriptPosition` is never populated and `lead-script-tracker.ts` is dead code. Severity upgraded from the Day-1 audit's "blocks onboarding" to "blocks the M1 autonomous-booking criterion." Full writeup + fix shape in `PHASE_2_PLAN.md` (§F5.1).

**M1 stopgap (data-only, applied 2026-05-21):** cloned Daniel's "DAETRADEZ — B2C DM SETTING SCRIPT V3" (25 steps / 54 branches / 176 actions) from prod into shazim's LOCAL account via `scripts/clone-daniel-script-to-shazim.ts` (READ prod, WRITE local only; `voiceNoteId` nulled since shazim lacks Daniel's voice library). After the clone the step tracker advanced correctly (`currentStep` 1 → 13) and the funnel ran through 13 steps autonomously.

**Finding 3 — re-asks of volunteered data (a mild repetition pattern).** Across the funnel, when the lead volunteered an answer at/before the scripted `[ASK]`, the AI re-asked it anyway — observed at the job step, income step, replace-vs-supplement step, and obstacle step (4 of ~7 discovery steps). Root: script progression credits only a fired `[ASK]`, not volunteered data ("volunteered data does NOT mark a step complete"). Feels robotic to a lead ("I just told you that"). Candidate fix lives in the same F5.1 area.

**Finding 4 — verbatim-`[MSG]` wall at Belief Break (new).** With Daniel's script, the funnel reached the "Belief Break — Reframe" step (step 13) and escalated: the step requires an operator-authored verbatim reframe `[MSG]`, but Haiku **paraphrased** it (overlap 0.34 vs the required line) and added an em-dash → `msg_verbatim_violation` + `em_dash` failed 3× → `escalate_to_human`. So the funnel does not yet reach BOOKING on Haiku. Likely a model instruction-following limit (verbatim reproduction) compounded by the recurring em-dash issue — a candidate case where Sonnet may differ.

**Files added (dev tooling, NOT committed):** `scripts/drive-fb-turn.ts`, `scripts/drive-ig-turn.ts`, `scripts/clone-daniel-script-to-shazim.ts`.

**Sonnet diagnostic (resolved) — it is NOT a model problem.** Flipped the local model to `claude-sonnet-4-6` and re-ran the full funnel. Sonnet hit the **exact same** `msg_verbatim_violation` wall at the belief-break step — overlap **0.25** (worse than Haiku's 0.34); it even tried to skip straight to "lock in the call." So a more capable model does NOT fix it, and since the model is per-account configurable (operators pick their own, Tega wants cheap Haiku), the fix MUST be model-independent.

**Two model-independent fixes applied (2026-05-21):**
1. **Em-dash → soft signal** (`voice-quality-gate.ts`): `sanitizeDashCharacters` already strips em/en dashes on every delivery path, so hard-failing on them just burned 3 regens and escalated otherwise-good replies. Demoted to a -0.1 soft penalty. Kills the long-standing "em-dash gate thrash" for every model.
2. **Verbatim-`[MSG]` deterministic injection** (`ai-engine.ts`): when the only blocking hard fail is `msg_verbatim_violation` and the system has the operator's literal `[MSG]` text, inject it directly instead of escalating to a human (asking the LLM to reproduce a fixed string then checking overlap is fragile by design). Audit row `verbatim_msg_injected` written; no escalation.

**Verified:** `tsc` clean; 10/10 gate unit tests; **21/21 conversation fixtures still pass** (no regression).

**Honest status — autonomous BOOKING still not reliable on Haiku.** The two fixes are correct and remove two real escalation causes, but a re-run did NOT reach BOOKING: the funnel now stalls at a *different* step (Monthly Income, step 8), with Haiku emitting a repetitive off-script line 3× before escalating. Run-to-run variance is high (belief-break one run, income the next). Root cause is the deeper **script-progression rigidity** (volunteered data does not advance a step; each `[ASK]` must fire; a weak model navigating a 25-step funnel) — i.e. the core of F5.1. So: incremental escalation causes fixed; full autonomous end-to-end booking for a non-Daniel account requires the F5.1 refactor (Phase 2, now top priority). Captured in PHASE_2_PLAN §F5.1 and the Week 1 report.

---

### 2026-05-20 — Day 4 — AI placeholder leak: resolve-before-strip (chain was already built)

**Status:** Fixed (focused enhancement). 6/6 new unit tests pass, tsc clean.

**Symptom (discovery call):** *"The AI sometimes writes `Hi {{name}}, see you {{day_and_time}}` — the gate catches it but then the conversation goes silent."*

**Audit finding — the premise was outdated.** The current pipeline already handles metadata/placeholder leaks end-to-end in `ai-engine.ts` (~lines 3900-3967):
1. `detectMetadataLeak()` catches `{{...}}` (plus JSON, `stage:`, confidence fields, bracketed `[LINK]` tokens, etc.).
2. `stripMetadataLeaksFromMessages()` surgically removes the leak and re-scores.
3. On remaining attempts it re-prompts the LLM with an R34 metadata-leak directive.
4. The final fallback `buildR34BlockedFallbackParsed()` ships a safe holding line ("gimme a sec bro, looking into this") **and** sets `escalateToHuman: true`.

So 4 of the 5 planned items already existed and **there is no silent-block path** — the conversation either ships a stripped reply, re-prompts, or escalates with a holding line.

**The one real gap:** emitted `{{name}}`/`{{their goal}}` placeholders were *stripped* (deleting them → incoherent "Hi , see you") rather than *resolved* to the lead's real values. The codebase already builds a `gateVariableResolutionMap` for the LLM context but never applied it to the LLM's own emitted output.

**Fix shape:**
- New pure helper `resolveEmittedPlaceholders(messages, map)` in `src/lib/script-variable-resolver.ts` — maps `applyResolvedScriptVariables` over each generated bubble; reports whether anything changed.
- Wired into `ai-engine.ts` at the leak-check, **before** the strip: if generated bubbles contain `{{...}}` and the gate resolution map can resolve them, the reply ships personalized. Unresolvable placeholders stay literal and fall through to the existing strip → re-prompt → escalate chain, so a genuine unresolvable leak is still blocked. If resolution clears a parser-flagged leak, the stale flag is dropped so an already-fixed reply doesn't get needlessly stripped/escalated.

**Files touched:**
- `src/lib/script-variable-resolver.ts` — new `resolveEmittedPlaceholders()`.
- `src/lib/ai-engine.ts` — import + resolve-before-strip step at the R34 leak-check.
- `tests/unit/resolve-emitted-placeholders.test.ts` — new, 6 cases (resolvable / unresolvable / mixed / no-placeholders / no-map / multi-bubble).

**Why this approach:**
- Resolving salvages otherwise-good, on-script replies that happen to echo a `{{var}}` — better lead experience and one fewer needless human escalation — without weakening the leak guard (unresolvable tokens still block).
- Reuses the existing resolution map already computed for this turn — no extra LLM calls, no new I/O.
- Did NOT add the planned `AISuggestion.gateDecision` field — `recordR34MetadataLeakCatch()` already captures leak diagnostics, so it would be redundant.

**Verified by:** `bun test tests/unit/resolve-emitted-placeholders.test.ts` → 6/6. `tsc --noEmit` clean on both edited files. Full mocked-LLM end-to-end deferred to the Day 5 persona-harness pass.

---

### 2026-05-20 — QD-004b — Code fix: Instagram-Login OAuth now subscribes webhooks directly

**Status:** Fixed. tsc clean. Subscription mechanism already proven live against shazim's token.

**Symptom:** New Instagram connections made via the standalone Instagram-Login flow never received DM webhooks in production (diagnosed earlier today — see the entry below).

**Root cause:** `subscribeInstagramWebhooks()` only subscribed a **Facebook Page**; it never called the Instagram-graph `/me/subscribed_apps` endpoint, the only path that works for an Instagram-Login (`IGAA…`) token. Page discovery via `/me/accounts` fails for that token type, so the callback logged "configure manually" and left the account unsubscribed.

**Fix shape:**
- New helper `subscribeInstagramDirectWebhooks(igAccessToken)` in `src/app/api/auth/instagram/callback/route.ts`: `POST graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages` (Bearer IG token), then **reads back** `/me/subscribed_apps` to confirm `messages` is present before reporting success.
- Wired as the **primary** Step 5 action, ahead of the existing page-based subscribe (kept as a secondary path for IG accounts genuinely linked to a Facebook Page).
- Credential metadata now always persists `webhookSubscribed` (boolean) + `webhookSubscribedAt` on connect — even when page discovery fails (previously the metadata re-save only happened in the page-found branch). Gives an at-a-glance "is this account actually subscribed" signal.
- On failure, the callback logs an actionable warning instead of a silent give-up.

**Files touched:**
- `src/app/api/auth/instagram/callback/route.ts` — new `subscribeInstagramDirectWebhooks()`; Step 5 rewritten to call it first + always persist subscription state.

**Why this approach:**
- The Instagram-Login product requires the IG-host subscription; the page-based one is for the Meta/Facebook-Page connection model. Doing the direct subscribe first fixes the common case without removing page support for linked accounts.
- Read-back verification avoids false "subscribed" confidence — a 200 can still leave the account unsubscribed if the messaging permission is missing.

**Verified by:**
- `tsc --noEmit` clean on the callback.
- The exact API calls the helper makes were already run by hand against shazim's live token earlier today: `POST /me/subscribed_apps` → `{"success":true}`; read-back → `subscribed_fields:["messages"]`. The confirm-regex matches that real response shape.

**Follow-ups:**
- IG ID-mismatch investigation (token user_id vs `/me` user_id vs page-linked 17841…) — deferred; needs care before changing webhook routing.
- Settings UI surfacing of `webhookSubscribed:false`.
- Backfill script for any existing unsubscribed INSTAGRAM accounts (shazim already done manually).
- This rides to prod with the next deploy; no real new IG connection has exercised the code path yet.

---

### 2026-05-20 — QD-004b / QD-060 — Local end-to-end tracing: IG webhook never subscribed; QD-060 verified resolved + hardened

**Status:** QD-004b diagnosed + manually remediated for shazim (code fix pending). QD-060 verified non-reproducing; defensive hardening landed.

**Context:** Built a local harness that exercises the **full** inbound → AI → outbound pipeline for shazim's account against the real Meta tokens (FB + IG), with replies delivered to the real Messenger/Instagram inboxes. This surfaced two findings the synthetic-only Day-1 spike could not.

**Finding 1 — QD-004b: Instagram-Login OAuth never subscribes the IG account to webhooks (the real prod cause of "IG DMs don't appear").**
- Facebook DMs reach the webhook; Instagram DMs do not. `GET /me/subscribed_apps` for `@sk_trade17` returned `{"data":[]}`.
- Meta **stores** the DM (we can read it via `GET /me/conversations`) but only **pushes** a webhook for *subscribed* accounts. Pull ≠ push.
- Root cause in code: `subscribeInstagramWebhooks()` (`src/app/api/auth/instagram/callback/route.ts:250`) only subscribes a **Facebook Page** (`/{pageId}/subscribed_apps` on the FB graph). It never calls `POST /me/subscribed_apps` on `graph.instagram.com`, which is the only correct path for an Instagram-Login (`IGAA…`) connection. The page-discovery fallback fails because an IG-Login token can't list FB pages, so it logs *"configure manually"* and gives up — leaving the account silently unsubscribed.
- **Manual remediation applied:** `POST https://graph.instagram.com/v22.0/me/subscribed_apps?subscribed_fields=messages` → `{"success":true}`, verified `subscribed_fields:["messages"]`. This unblocks shazim's prod IG test; the code fix is tracked as **QD-004b** in `PHASE_1_PLAN.md`.

**Finding 2 — re-frames the Day-1 QD-004 "does not reproduce" conclusion.** The Day-1 spike used synthetic webhooks POSTed directly to the route, which **bypasses Meta's delivery layer** — so it could never have caught a missing subscription. QD-004's prod symptom for IG-Login accounts is real and now explained (QD-004b). The webhook *processing* code is fine; the *delivery* was never enabled.

**Finding 3 — QD-060 verified resolved (source audit) + hardened.**
- The AI toggle reads `conversation.aiActive` straight from server data (`conversation-thread.tsx:478`), with refetch-on-toggle + 8s poll + SSE. The live `toggle-ai` route persists `aiActive` on both ON and OFF. So QD-060 does not reproduce — it was a symptom of QD-059 (new convos defaulted to `aiActive:false`).
- **Fragility found + fixed:** the ON path persisted `aiActive:true` only as a *side-effect* of `handleAIHandoff`. Made it explicit in `toggle-ai/route.ts` so a future refactor of that helper can't silently re-introduce QD-060.
- **Dead code flagged:** `ai-toggle/route.ts` is unused (client calls `toggle-ai`); stale comment at `webhook-processor.ts:673` references the wrong route. Removal pending confirmation.

**Files touched / inspected:**
- `src/app/api/conversations/[id]/toggle-ai/route.ts` — ON path now writes `aiActive:true` explicitly.
- Inspected: `src/app/api/auth/instagram/callback/route.ts`, `src/app/api/webhooks/instagram/route.ts`, `src/lib/instagram.ts`, `conversation-thread.tsx`, `conversations-view.tsx`, `src/lib/api.ts`, `webhook-processor.ts` (`handleAIHandoff`).
- Dev tooling (not production, not committed): `scripts/clone-prod-to-local.ts`, `scripts/reset-local-test.ts`, `scripts/simulate-fb-dm.sh`, `scripts/simulate-ig-dm.sh`.

**Verified by:**
- FB: signed synthetic webhook → lead/conversation created (AI=ON) → Haiku reply delivered to real Messenger inbox.
- IG: signed synthetic webhook (sender IGSID `1474847644133208` pulled from `/me/conversations`) → lead created → reply delivered to real `@iamshazimkhan` IG inbox.
- QD-005 unit tests still green (14/14). `tsc --noEmit` clean on the toggle-ai edit.

**Follow-ups / dependencies:**
- **QD-004b code fix:** add IG-host `/me/subscribed_apps` as the primary subscribe path in the IG OAuth callback + persist subscription state + backfill existing unsubscribed accounts.
- **QD-060:** one UI click-test (no Anthropic needed) to formally close.
- **Prod IG note:** the manual subscription points at the prod callback (qualifydms.io), not localhost — local IG testing continues via the simulator.

---

### 2026-05-18 — Day 2 — QD-005 — Meta credential-health false positives (retry-with-backoff + error-code classification)

**Status:** Fixed, unit tests green (14/14 cases), verified live in dev.

**Symptom (client's voice):**
- *"I keep getting 'Meta credential invalidated — reconnect required' notifications spamming the dashboard, but when I check Settings → Integrations, the connection is actually fine."*

**Root cause:**
The `meta-health` cron ([src/app/api/cron/meta-health/route.ts](src/app/api/cron/meta-health/route.ts)) was calling Meta's `/debug_token` endpoint once and flagging the token as invalidated on any non-`is_valid: true` response. Two problems with that:
1. **No retry on transient errors.** A single Meta-side hiccup (`OAuthException code 2 "Service temporarily unavailable"`, `is_transient: true`, HTTP 5xx) caused a permanent-looking "credential invalidated" alert even though the next probe would have succeeded.
2. **No error-code differentiation.** Meta's error taxonomy distinguishes between codes that mean "token is permanently revoked, user must reconnect" (190, 463) and codes that mean "service is temporarily flaky, retry later" (2, 4, 613, anything with `is_transient: true`). The old code treated them identically.

**Fix shape:**
New helper module `src/lib/meta-token-health.ts` that:
1. **Classifies the response** via a pure function `classifyDebugTokenResponse(httpStatus, body)` into one of `valid | revoked | transient | unknown`. Reads inner `data.error` and outer `error` envelopes, checks `is_transient` flag, applies known-code tables.
2. **Retries with backoff** via `checkTokenHealth(...)`: up to 3 attempts with 1s / 2s / 4s delays on `transient` or fetch-throws. Stops immediately on `valid` or `revoked` (revocation is permanent — no point retrying).
3. **Returns a single typed result** so the cron only has three actions: ok (skip), revoked (alert), transient_exhausted (log + let next 15-min tick re-probe).

Cron route updated to call the helper instead of inline `fetch + parse`. Only `revoked` outcomes fire the operator-facing `'Meta credential invalidated'` notification. `transient_exhausted` is logged as a warning and counted in the cron summary (`transientSkipped`) but suppresses the alert.

**Files touched:**
- `src/lib/meta-token-health.ts` — new, 180 lines, classification + retry helper.
- `src/app/api/cron/meta-health/route.ts` — calls the new helper, suppresses transient alerts, adds `transientSkipped` counter to the JSON summary.
- `tests/unit/meta-token-health.test.ts` — new, 14 test cases covering valid / revoked codes (190, 463, 460-subcode) / transient codes (2, 4, 613, is_transient flag) / HTTP 5xx with unparseable body / retry-then-succeed / retry-then-give-up / fetch-throw network errors.

**Why this approach:**
- **Separate helper, not inline.** Pure-function classification + retry logic is unit-testable. The 14-case test table covers every Meta error shape we've seen documented or observed in production.
- **Suppress, don't disable.** The transient path doesn't *hide* the problem — it logs a warning and increments the counter in the cron summary, so operators (or a monitoring dashboard pulling the JSON) can still see when Meta is flaky. We just don't spam the dashboard with cry-wolf alerts that resolve themselves.
- **15-min cron tick is the durable retry.** Within a single cron invocation we retry 3 times (~7s total worst case). If all 3 fail, the next 15-min run probes again with another 3 retries. Total: 6 retries per 30 minutes before we decide Meta is truly unreachable — and even then, no false alert.
- **Don't touch the subscribed_apps check.** That's a separate Meta API call with its own (different) alert text. Phase 1 scope is the token-invalidated false-positive specifically. If subscribed_apps has the same noisy-alert pattern, we can revisit in a follow-up.

**Verified by:**
- **Unit tests:** `bun test tests/unit/meta-token-health.test.ts` → 14/14 pass in 115ms.
- **Live run on local dev:** Hit `GET /api/cron/meta-health` with `CRON_SECRET` bearer. Returned `{"ok":true,"checked":2,"tokenBad":0,"transientSkipped":0,"subscriptionBad":1,"alerted":1}`. Notification log inspection: no new `'Meta credential invalidated'` alert was created from this run — only a `'Webhook subscription broken'` alert (separate code path, unrelated to QD-005). The historical credential-invalidated alert from before the fix (11:37:50) sits in the table as evidence of the prior behavior.

**Follow-ups / dependencies:**
- The `subscribed_apps` check at the bottom of the route has the same single-fetch shape; if it ever produces false positives, the same `transient_exhausted` pattern can be applied. Not blocking Phase 1.
- The Notification model could use a `severity` or `category` field so we can group transient/permanent alerts in the UI. Out of scope for Phase 1; flagged for future polish.

---

### 2026-05-18 — Day 2 — Local dev: switched ANTHROPIC IntegrationCredential model to Haiku 4.5 (cost optimization per client preference)

**Status:** Configuration change. Verified live in dev.

**Symptom (client request):**
- Tega requested using a "cheap model" for local dev to minimize per-message Anthropic spend during the engagement.

**Change:**
Updated `scripts/seed-shazim-ai-credentials.ts` ANTHROPIC_MODEL constant from `claude-sonnet-4-6` → `claude-haiku-4-5-20251001` and re-ran the seed to update the IntegrationCredential row. Also refreshed `.env`'s ANTHROPIC_API_KEY with the new key Tega provided.

**Cost impact:**
- Sonnet 4.6: ~$3/MTok input, ~$15/MTok output
- Haiku 4.5: ~$0.80/MTok input, ~$4/MTok output (about 4-5x cheaper)
- For a typical DM (~3K input tokens prompt + 200 output tokens), this drops per-message cost from ~$0.012 to ~$0.003.

**Files touched:**
- `.env` — ANTHROPIC_API_KEY rotated to a new working key.
- `scripts/seed-shazim-ai-credentials.ts` — model constant changed to Haiku 4.5 with comment explaining trade-off.
- `IntegrationCredential` row for `(accountId=shazim's, provider=ANTHROPIC)` — updated `credentials.model` to `claude-haiku-4-5-20251001`.

**Why this approach:**
- Per-account DB config (already established by the seed pattern). No code changes needed.
- Easy to flip back to Sonnet if needed — change one constant, re-run the seed.
- Haiku 4.5 is the current cheapest Anthropic model that supports the JSON response format and the system prompt we're using.

**Verified by:**
Fresh synthetic webhook (lead `7777000077770001` with message *"Yo your content is fire, been stuck at 8k/mo selling ebooks. How do you scale this stuff?"*) → ScheduledReply queued → cron picked up → Haiku 4.5 generated multi-bubble reply: `["yo appreciate that bro 🔥 8k is solid foundation fr.", "what's been the biggest bottleneck — is it getting more eyeballs on the ebooks or converting the traffic you already got?"]`. Stage correctly advanced from OPENING to SITUATION_DISCOVERY because the lead revealed situation context in the opener. Quality gate scored **1.0 (perfect)** vs Sonnet's earlier 0.75 — Haiku 4.5 hits the persona voice more closely on this particular test, likely because the seeded training data is in casual lowercase slang and the Sonnet variant kept biasing toward more polished output.

**Follow-ups / dependencies:**
- Reliability test on higher-stakes stages. Days 4-5 work (placeholder leak + force-advance + persona harness) will surface whether Haiku 4.5 handles complex objection patterns, financial screening, and booking commitment as well as Sonnet. If gate-retry rate climbs > Sonnet baseline on those turns, flip back.
- Decision for Tega's production account: keep Sonnet (current default in `SONNET_46_MODEL` constant) vs switch his production IntegrationCredential to Haiku 4.5 too. Recommend deferring until after Phase 1 reliability work surfaces the trade-off behavior at scale.

---

### 2026-05-18 — Day 1 — Local dev: ANTHROPIC IntegrationCredential seeded for shazim's Workspace (per-account BYOK model + key)

**Status:** Dev-environment configuration only. No production code changes.

**Symptom (during dev validation):**
- AI generation returned `404 not_found_error: model: claude-sonnet-4-20250514`. Anthropic deprecated that dated model alias; calls fail.

**Root cause (not a product bug — a dev-environment gap):**
The local "shazim's Workspace" account had no `IntegrationCredential` row for `provider=ANTHROPIC`. `resolveAIProvider()` in `ai-engine.ts` reads the API key + model from the account's IntegrationCredential first (the BYOK path), then falls back to env-level `ANTHROPIC_API_KEY` + the `SONNET_46_MODEL` constant. The constant is the deprecated dated alias (see the 2026-05-05 revert comment), so without a DB-side model override the fallback path returns the broken alias to Anthropic.

The proper fix is **not** to chase the broken fallback across 14 hardcoded sites — it's to put the key + current model into the account's IntegrationCredential, where the codebase is already designed to read from. Daniel's production account works exactly this way.

**Fix shape (dev-only configuration):**
- New seed script `scripts/seed-shazim-ai-credentials.ts` (idempotent, follows the existing `seed-meta-credentials.ts` pattern).
- Inserts an `IntegrationCredential` row for shazim's account with:
  - `provider = ANTHROPIC`
  - `credentials.apiKey = <encrypted from .env's ANTHROPIC_API_KEY via credential-store.encrypt()>`
  - `credentials.model = 'claude-sonnet-4-6'`
  - `isActive = true`
- Flips `Account.aiProvider` from `'openai'` → `'anthropic'` so `resolveAIProvider()` routes generation through Anthropic.

**Files touched:**
- `scripts/seed-shazim-ai-credentials.ts` — new (dev-only, not production code).
- No changes to any production-path source files.

**Why this approach:**
- Mirrors the production pattern: per-account API key + model live in the DB; env-level keys exist only as a developer convenience.
- Zero scattered code edits. The `SONNET_46_MODEL` fallback constant remains deprecated in the codebase — accepted technical debt for accounts that never BYOK, but completely bypassed by any account with a real credential row. Daniel's production has the same fallback configuration unchanged.
- Idempotent. Re-running the seed is safe because `setCredentials()` uses merge upsert semantics.

**Verified by:**
- After running the seed: full end-to-end generation works.
- Re-fired synthetic webhook → fresh Lead/Conversation created with `aiActive=true` (from QD-059 fix) → ScheduledReply queued → cron picks up → `generateReply` calls Anthropic with `modelUsed='claude-sonnet-4-6'` (from DB) → quality gate passes on **first attempt** (score 0.75) → AISuggestion row persisted with multi-bubble output: `["hey!", "appreciate you reaching out 💪🏿 what's been working so far that's gotten you to where you're at?"]`.
- IG send still fails (Meta access token invalidated, separate from this fix).

**Follow-ups / dependencies:**
- The deprecated `claude-sonnet-4-20250514` fallback string in `ai-engine.ts:SONNET_46_MODEL` (and 13 other places it appears) is **knowingly left in place**. Production accounts work because they have DB-side credentials; any account that ever falls back to the env path will hit the 404 and surface it cleanly through the future quota-error wrapper (Day 9 / QD-024 et al.). A separate cleanup pass to centralize the constant + update its value is desirable but explicitly out of scope for Phase 1.
- For real production validation of Tega's account: he'll need an IntegrationCredential row for ANTHROPIC the same way Daniel does. The current production code path will use his row when present.

---

### 2026-05-18 — Day 1 — QD-059 / QD-060 — `Account.defaultAiActive` introduced; autonomous-AI default restored

**Status:** Fixed and verified end-to-end on local dev.

**Symptom (client's voice):**
- *"AI Setter is not auto-responding to new leads — they sit silent until I manually toggle AI on for each conversation."*
- Same root cause produces QD-060 ("AI toggle resets after page refresh"): refresh re-reads `Conversation.aiActive=false` from DB and the UI reflects it.

**Root cause:**
Two hardcoded `aiActive: false` sites on inbound Conversation create, plus a stale schema default, plus a vestigial computed variable that was no longer being used. All three were introduced in the 2026-05-06 review-first policy. The defensive intent contradicted the product's autonomous-from-first-DM value proposition (the launch criterion).

**Fix shape:**
- **New additive field:** `Account.defaultAiActive Boolean @default(true)` (migration `20260518104828_add_account_default_ai_active`). Backfills all existing accounts to `true`. Field controls AI autonomy on new inbound conversations.
- **3 Conversation-create sites flipped** to read `account.defaultAiActive` instead of hardcoding `false`. On create, BOTH `aiActive` and `autoSendOverride` are set to that value — auto-send no longer requires platform-wide Away Mode.
- **Stale comment removed** that claimed the schema default for `Conversation.aiActive` was `true` (the 2026-05-06 migration had silently changed it to `false`).
- **Vestigial `shouldEnableAI` compute** updated to use the new field; log line at line 1204 stays accurate.

**Files touched:**
- `prisma/schema.prisma` — `Account.defaultAiActive` field added.
- `prisma/migrations/20260518104828_add_account_default_ai_active/migration.sql` — auto-generated by `bun prisma migrate dev`; one `ALTER TABLE` adding the column with default `true`.
- `src/lib/webhook-processor.ts`:
  - Lines 1063-1075: account select extended with `defaultAiActive`; `shouldEnableAI` now reads it.
  - Lines 1182-1190: inbound Conversation create uses `aiActive: shouldEnableAI, autoSendOverride: shouldEnableAI`. Policy comment updated.
  - Lines 675-690: stale "schema default true" comment replaced with a history note pointing at this fix.
- `src/lib/manychat-handoff.ts`:
  - Lines 110-115: account select extended with `defaultAiActive`.
  - Lines 247-264: existing-lead → new-conversation create path uses `account.defaultAiActive` for both flags.
  - Lines 286-306: new-lead → nested-conversation create path uses `account.defaultAiActive` for both flags.

**Why this approach:**
- **One field, two flags.** Operators don't need to reason about the difference between "AI is on" and "AI auto-sends." If you want autonomous behavior, both flags must align; if you want review-first behavior, both should be off. A single account-level setting collapses the decision.
- **Default ON, not OFF.** Tega's product value prop is autonomous DM qualification. Defaulting to ON honors that; the per-account opt-out remains for any operator who genuinely wants manual review for new leads.
- **Per-conversation toggle untouched.** Operators can still flip an individual thread to AI off at any time, regardless of account-level setting. The existing toggle-ai route already handles this cleanly.
- **Additive migration.** No data migration of existing Conversation rows; the schema default for `Conversation.aiActive` stays `false` as a safety net for arbitrary creates from elsewhere in the codebase that don't explicitly pass a value. The three intentional create sites all pass an explicit value.

**Verified by:**
- `Account.defaultAiActive` backfilled to `true` for all existing accounts (DAE + shazim's Workspace verified).
- Synthetic IG webhook fired with a fresh `platformUserId`. With `Account.awayModeInstagram=false` (the realistic new-operator default), the new Lead/Conversation/Message rows persist with:
  - `Conversation.aiActive = true` (autonomous default applied)
  - `Conversation.autoSendOverride = true` (mirrors aiActive)
  - `Conversation.awaitingAiResponse = true` (downstream gate honored)
  - `ScheduledReply` row queued with status=PENDING for cron pickup
- Full request chain: inbound webhook → `processIncomingMessage` → `scheduleAIReply` → ScheduledReply persisted → cron picks up → `generateReply` → Anthropic API call (which fails only at the credit-balance step, a separate billing issue, not a code defect).
- `bun tsc --noEmit` clean on both edited files.

**Follow-ups / dependencies:**
- **Anthropic credits (client):** required for actual AI text to ship. Without credits, the entire pipeline runs but the final LLM call returns the credit-balance error. This is the next bottleneck and the only thing standing between the current code and a real end-to-end demo.
- **Settings UI toggle (engineering, Day 9):** add a "Auto-enable AI on new conversations" toggle in Settings → AI so operators who want review-first mode can flip it without touching the database. Default ON. Scoped together with QD-046 (tags) and the quota-error wrapper on Day 9.
- **QD-060 (page refresh):** likely closed by this fix because the persistent `aiActive=true` value now matches the operator's expectation. To be confirmed once we're past the Anthropic block and can test a real toggle in the UI.
- **Meta access token (client):** the seeded IG access token returns `OAuthException: The session has been invalidated because the user changed their password`. Synthetic-curl tests are unaffected, but real-payload IG testing requires a fresh long-lived access token from the Meta App dashboard.

---

### 2026-05-18 — Day 1 — Spike: QD-004 / QD-059 / AI reliability diagnosis

**Status:** Diagnosed. Fixes drafted, not yet landed.

**Symptom (what the client / QA saw):**
- QD-004: "Inbound IG DMs not reaching dashboard."
- QD-059: "AI Setter not auto-responding to new leads."
- Discovery-call narrative: "AI silently stops mid-conversation, gates pause, placeholders leak."

**Findings (in priority order):**

1. **QD-004's stated symptom does not reproduce against the current
   code with a synthetic IG webhook payload.** Lead, Conversation, and
   Message rows all persist correctly. Webhook signature validation
   works; F6.1 strict recipient-routing accepts payloads whose
   `entry.id` matches `IntegrationCredential.metadata` (pageId,
   igUserId, instagramAccountId, igBusinessAccountId). The original
   QD-004 reproduction may have been a different symptom (UI not
   surfacing the persisted row), or may have been **conflated with
   QD-059** below (operator perceives "no DM in dashboard" because
   the AI never replies and the conversation stays silent).
   Real-payload regression requires Meta App developer access; blocked
   on client provisioning until then.

2. **QD-059 root cause is conclusively confirmed in two sibling sites,
   both hardcoding `aiActive: false` on inbound conversation create.**
   - `src/lib/webhook-processor.ts:1182` (direct IG/FB inbound webhook
     path) — comment dated 2026-05-06: *"POLICY: new conversations
     are created with AI OFF. Operator must explicitly toggle AI on.
     This overrides the legacy awayMode-based default. Going forward
     awayMode no longer auto-enables AI on new inbound leads."*
   - `src/lib/manychat-handoff.ts:254` (and a sibling at the same
     file around line 290) — same hardcoded `aiActive: false` with
     similar comment.
   - The Prisma schema's `Conversation.aiActive @default(false)`
     was also changed to match, but the comment at
     `webhook-processor.ts:675-676` still claims the default is
     `true` — stale comment, schema/code divergence.
   - The intent (defensive: prevent AI replying to leads the
     operator hasn't acknowledged) directly contradicts the product's
     stated launch criterion (*"AI handles the lead end-to-end without
     operator intervention"*). The 2026-05-06 author solved a
     different bug by being overly cautious and broke the autonomous
     value prop.

3. **`webhook-processor.ts:1072` still computes `shouldEnableAI` and
   line 1204 logs it, but the actual write at 1182 ignores it.**
   Vestigial code from the pre-2026-05-06 policy. Worth a cleanup
   pass alongside the QD-059 fix.

4. **End-to-end pipeline validation: the AI pipeline works
   correctly all the way through to the LLM call.** Confirmed by SQL-
   flipping `Conversation.aiActive=true, autoSendOverride=true` plus
   `Account.awayModeInstagram=true`, then re-firing a synthetic
   webhook. The full chain executes:
   - Inbound webhook → Lead/Conversation/Message persist
   - `scheduleAIReply` runs through every diagnostic checkpoint
     (`sched.step0a` → `sched.step4.generateStart`)
   - `processScheduledReply` cron picks up the queued ScheduledReply
   - `ai-engine.generateReply` enters the Anthropic SDK call
   - Anthropic returns a real API response
   - **The only thing that fails today is the Anthropic credit
     balance being depleted on the key in `.env`.** Quota top-up is
     a client billing concern, not an engineering one.

5. **`ai-engine.ts` has a defensive `no-training-suppression` guard**
   at lines 2552-2602. If the persona has zero `TrainingMessage`
   rows, the AI refuses to generate to prevent the master prompt
   template's hardcoded DAE fixtures (legacy Anthony / Daniel /
   Session Liquidity Model branding) from dominating the reply in
   another tenant's account. This is **correct safety behavior**,
   not a bug — but it creates a real product UX gap: every new
   account that signs up has zero training data and sees "the AI
   does nothing" until they upload conversation transcripts. Should
   be addressed in Phase 1 by surfacing the suppression as an
   operator-facing notification ("AI paused — upload training data
   to enable") rather than silent inaction. Long-term (Phase 2 /
   future SOW): strip the DAE-specific fixtures from the master
   prompt template so a base persona works with thin training data.

6. **Critical product-side finding (production read-only inspection,
   2026-05-18):**
   - `daetradez's Workspace` (Daniel) — 1 active persona, **4,646
     training messages, 5,039 leads, 7 integrations, awayMode=ON**.
     Healthy reference account.
   - `Tega Umukoro's Workspace` — **persona exists but isActive=false,
     0 training messages, 0 leads, 0 integrations, awayMode=OFF.**
     Account is effectively empty.
   - This re-frames a portion of the QA backlog: some of what was
     reported as "bugs" is likely "product does not gracefully
     degrade when an account is empty." Phase 1 should include a
     clear onboarding path so a Tega-shaped account can get from
     empty → working without engineering hand-holding.

**Fix shape (drafted, not yet landed):**

- **QD-059 (Day 3 in plan; pulled forward):** Add additive Prisma
  field `Account.defaultAiActive Boolean @default(true)`. Change
  both inbound Conversation-create sites to read the account's
  default instead of hardcoding `false`. Also default
  `autoSendOverride=true` on the same create so auto-send fires
  without requiring `awayMode` to be on. Operator can flip the
  account-level toggle OFF if they want review-first mode.
- **QD-024 / QD-043 / QD-044 / QD-045 / QD-048 (Day 9 in plan):**
  Single shared error-handler module (`src/lib/ai-error-handler.ts`)
  with `safeOpenAI()` / `safeAnthropic()` HOFs. Catches HTTP 429,
  Anthropic `credit_balance_too_low`, OpenAI `insufficient_quota`.
  Returns typed `AIError` discriminated union. UI surface converts
  to operator-friendly message. Already reproduced the depleted-
  credit case locally — this is the reference test for the fix.
- **No-training-suppression UX gap (NEW, not in original plan):**
  When the guard fires, write a Notification row + flip the
  conversation to `awaitingHumanReview=true` so the operator sees
  *"AI paused — upload training data to enable"* in the dashboard
  rather than the conversation silently going dead. Small Phase 1
  add.

**Files touched / inspected (Day 1):**

- Inspected (read-only):
  - `src/lib/webhook-processor.ts` (lines 670-690, 1072, 1153-1206,
    1495-1540, 2288-2603, 5870-5912, 6280-6345)
  - `src/lib/ai-engine.ts` (lines 2540-2603)
  - `src/lib/manychat-handoff.ts` (lines 220, 252, 290)
  - `src/app/api/cron/process-scheduled-replies/route.ts`
  - `src/app/api/conversations/[id]/toggle-ai/route.ts`
  - `src/app/api/webhooks/instagram/route.ts`
  - `src/app/api/settings/training/upload/route.ts`
  - `prisma/schema.prisma` (Conversation, Account, AIPersona,
    TrainingConversation, TrainingMessage, TrainingUpload)
- Created (dev tooling, not production code):
  - `scripts/seed-shazim-training-data.ts` — idempotent training-data
    seed for the local dev account; mirrors the production daetradez
    structural shape (sender ratio, stage labels, outcome labels)
    with original synthetic high-ticket coaching content.
- Local DB modifications (test-data only):
  - `Conversation.aiActive`, `autoSendOverride` flipped on the
    seeded test conversation for isolated pipeline validation.
  - `Account.awayModeInstagram` flipped on shazim's Workspace.
  - 1 `TrainingUpload`, 3 `TrainingConversation`, 30
    `TrainingMessage` rows seeded via the script above.

**Why this approach:**

- We diagnosed before fixing. The 4-hour Day-1 spike budget was
  specifically to avoid committing to a fix path before
  reproducing — which would have been the wrong move here, since
  the QD-004 stated symptom doesn't reproduce against current
  code, and QD-059 turned out to be a sibling-site bug not just
  the documented manychat-handoff.ts location.
- We isolated the AI pipeline with SQL flips before changing any
  code, so when we land the policy fix we will know it works
  against a proven-good downstream pipeline.
- We used Daniel's production account as a read-only structural
  reference only (counts, lengths, stage labels) — no content was
  copied or modified. This let us seed realistic synthetic
  training data without touching live customer data.

**Verified by:**

- DB inspection of created Lead/Conversation/Message rows.
- Dev-server stdout matching expected `sched.step*` checkpoint
  chain end-to-end.
- Cron endpoint returns 200 with a delivered Anthropic round-trip
  (the only failure being depleted Anthropic credits, which is a
  client billing concern).

**Follow-ups / dependencies:**

- **Client (Tega):** top up Anthropic credits OR provide an
  `OPENAI_API_KEY` with credit balance so the AI can complete a
  real generation. Without one of these, the autonomous-from-first-
  DM launch criterion cannot be demoed end-to-end.
- **Client (Tega):** confirm decision to default `aiActive=true`
  AND `autoSendOverride=true` on new conversations (already
  confirmed verbally — capturing in writing here for the audit
  trail).
- **Client (Tega):** Meta App developer access (still blocked) is
  required for any real-payload IG webhook regression test of
  QD-004 beyond the synthetic-curl coverage we have.
- **Engineering (Day 2):** land the QD-059 code fix
  (`Account.defaultAiActive` field + flip both create sites) and
  the QD-005 meta-health retry-with-backoff hardening.

---

<!--
Append new entries above this marker, newest-first. Each entry
must reference task ID(s), state the symptom in the client's voice,
and document the fix shape *before* listing files touched.
-->
