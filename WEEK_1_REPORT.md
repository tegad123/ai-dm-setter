# QualifyDMs — Week 1 Report (Phase 1, M1)

**Period:** 2026-05-18 → 2026-05-21
**Engineer:** Shazim
**Scope:** Phase 1, Week 1 — Stream A (inbound loop) + Stream B (AI reliability), toward the M1 milestone.

---

## 1. Executive summary

Week 1 closed the inbound-loop and AI-reliability bugs and stood up a full **local end-to-end test harness** (real Facebook + Instagram DM pipeline, real AI generation, real outbound delivery). That harness let us trace the autonomous funnel turn-by-turn — which surfaced the single most important finding of the engagement:

> **The autonomous funnel cannot yet book a call without a human for any account other than Daniel's** — the qualification funnel is hardcoded to Daniel's specific 25-step script (issue **F5.1**). This blocks the Phase 1 acceptance criterion and was previously mis-scoped as a minor onboarding nicety.

Everything that was a discrete bug is fixed and verified. The funnel blocker is a deeper, structural issue now fully diagnosed, with two model-independent fixes already landed and the remainder scoped into Phase 2 as top priority.

---

## 2. What we fixed (verified)

| ID | Title | Status | Evidence |
|---|---|---|---|
| **QD-059** | AI not auto-responding to new leads | ✅ Fixed | `Account.defaultAiActive` (default true) + 3 conversation-create sites; fresh inbound now creates `aiActive=true` |
| **QD-060** | AI toggle resets after refresh | ✅ Fixed + verified | Toggle reads server value; ON path now persists `aiActive` explicitly; UI click-test passed |
| **QD-005** | Meta credential-health false positives | ✅ Fixed | `meta-token-health.ts` retry+classify; 14/14 unit tests; live cron run shows no false alert |
| **QD-004** | Inbound IG DMs not in dashboard | ✅ Re-classified → **QD-004b** | Synthetic payloads always processed; real cause was the missing IG subscription (below) |
| **QD-004b** | IG-Login OAuth never subscribes webhooks | ✅ Fixed | New `subscribeInstagramDirectWebhooks()` on the IG graph + `webhookSubscribed` persistence |
| **Day 4** | AI placeholder leak ("{{name}}") | ✅ Fixed | `resolveEmittedPlaceholders()` resolves before strip; 6/6 unit tests. (Detect→strip→re-prompt→escalate chain already existed; no silent-block) |
| **Em-dash gate thrash** | Every reply burned 3 regens on em-dashes | ✅ Fixed | Demoted to soft signal; delivery sanitizer already strips them |

**Tests:** 14/14 (meta-health) + 6/6 (placeholder) + 10/10 (gate suite) + **21/21 conversation fixtures** all green.

---

## 3. What we identified (analysis)

### 3.1 Looping / repetition (planned Day 5 work) — already handled
The plan assumed the AI loops on the same question. Live multi-turn testing shows it **does not**: the AI advanced every turn, and the existing anti-loop layers all work — prompt rules (R8 / R30 / immediate-repeat / ASK-CAP), a deterministic near-duplicate **Jaccard block** at send time, and a live `Repetitive question pattern → forcing regen` guard. **No code change needed for looping.**

### 3.2 F5.1 — the autonomous funnel can't complete (the headline finding)
With shazim's own generic script, every warming conversation **hard-escalated to a human at the soft-pitch stage**. Root causes:
1. **The qualification funnel is hardcoded to Daniel's ~25-step script** across 6 files (`voice-quality-gate.ts`, `ai-prompts.ts`, `ai-engine.ts`, `script-state-recovery.ts`, `script-step-progression.ts`, `captured-data-keys.ts`). The gate enforces Daniel's steps (`work_background`, `income_goal`, `call_proposal_prereqs`, "Step 16 Call Proposal") against **every** account, ignoring that account's actual script.
2. **Script-position tracking is dead code** — `LeadScriptPosition` is never populated and `lead-script-tracker.ts` is called from nowhere, so the step tracker froze at "Step 1."

Daniel's production account works only because the hardcoded rules happen to match his funnel. Any non-Daniel account (i.e. every future customer) hits this.

### 3.3 It is NOT a model problem (Haiku vs Sonnet)
A natural question was "is cheap Haiku the issue — would Sonnet work?" We tested both. **Both fail identically** at the verbatim belief-break step (Haiku overlap 0.34, Sonnet 0.25). Since operators choose their own model, the fix must be **model-independent** — which is why we fixed the *system*, not the model.

### 3.4 Re-asks of volunteered data
Across the funnel the AI re-asked data the lead had just volunteered (job, income, replace-vs-supplement, obstacle — 4 of ~7 discovery steps). Root: script progression credits only a fired `[ASK]`, not volunteered data. Feels robotic to a lead. Same root as F5.1.

---

## 4. Fixes landed toward F5.1 (model-independent)

1. **Em-dash → soft** (`voice-quality-gate.ts`) — removes the thrash for all models.
2. **Verbatim-`[MSG]` deterministic injection** (`ai-engine.ts`) — when the only blocker is the model paraphrasing a required operator line, inject the operator's exact text instead of escalating.

Both verified safe (21/21 fixtures, tsc clean). They remove two real escalation causes but do **not** by themselves make autonomous booking reliable — see honest status below.

---

## 5. Honest status: autonomous booking not yet reliable

With Daniel's script cloned into the test account (data-only M1 stopgap) the step tracker advanced (1 → 13) and the funnel ran 13 steps autonomously — a big improvement over "stuck at step 1." But it still does not reliably reach BOOKING on Haiku: across runs it stalls at different steps (belief-break one run, income the next), sometimes repeating an off-script line before escalating. The remaining blocker is the **script-progression rigidity** at the heart of F5.1 (volunteered data doesn't advance a step; each `[ASK]` must fire; a complex 25-step funnel). **Reliable autonomous end-to-end booking for a non-Daniel account requires the F5.1 refactor — now the top Phase 2 priority** (full writeup in `PHASE_2_PLAN.md §F5.1`).

---

## 6. M1 acceptance status

| M1 criterion | Status |
|---|---|
| Inbound DM appears in dashboard within 5s | ✅ (FB live; IG fixed via QD-004b) |
| AI auto-replies without operator toggle | ✅ (QD-059) |
| `aiActive` persists across refresh | ✅ (QD-060) |
| No false credential-invalidated alerts | ✅ (QD-005) |
| 8+ turn conversation reaches BOOKING, no loop/silence | ⚠️ Advances autonomously but does **not** reliably book — blocked by F5.1 |
| Persona harness ≥ baseline | ✅ 21/21 conversation fixtures |

**Net:** 5 of 6 M1 criteria met. The 6th (autonomous booking end-to-end) is blocked by F5.1, which we recommend Tega prioritize at the top of Phase 2.

---

## 7. Test harness built (for ongoing proof)

Dev-only scripts (not committed to the shared repo) that drive the **real** local pipeline:
- `clone-prod-to-local.ts` — mirror prod credentials + persona into local
- `clone-daniel-script-to-shazim.ts` — clone Daniel's funnel (M1 stopgap)
- `reset-local-test.ts` — clean slate + fast reply delay
- `simulate-fb-dm.sh` / `simulate-ig-dm.sh` — single signed inbound DM
- `drive-fb-turn.ts` / `drive-ig-turn.ts` / `drive-funnel.ts` — multi-turn funnel driver

---

## 8. Proof transcript (autonomous funnel, Haiku, Instagram)

A representative clean run after the M1 stopgap clone (lead messages typed by us; AI replies fully autonomous; stages tracked live). Shows real autonomous progression through the funnel and the re-ask + escalation behavior described above.

```
[T1] LEAD: hey man saw your content, im a software dev but trading on the side and keep blowing accounts
     AI:  hey bro respect for reaching out! let's see if i can help you out here 💪🏿   [STEP_1_INBOUND]
[T2] LEAD: yeah man i really need help, i keep revenge trading after losses
     AI:  so are you new in the markets or have you been trading for a while?           [Intro]
[T3] LEAD: been trading like 2 years now but never really consistent
     AI:  2 years is solid experience tho. so how have the markets been treating you?   [Market Assessment]
[T4] LEAD: the main problem is my psychology, i abandon my strategy and revenge trade
     AI:  break that down for me, like what does that look like when you're in a trade?  [Market Response Routing]
[T5] LEAD: i panic, add to the losing position, then open revenge trades to win it back
     AI:  damn bro painful cycle. what do you do for work? just to understand your situation [Current Situation — Job]
[T6] LEAD: im a software engineer at a tech company, been there 4 years
     AI:  yeah i feel you... (re-asks) what do you do for work?                          [re-ask of volunteered data]
... funnel advances through income → goal → why → obstacle ...
[T13] AI escalates at "Belief Break — Reframe": msg_verbatim_violation (model paraphrased
      the required operator line, overlap 0.34) → escalate_to_human
```

**Sonnet, same script, same step:** `msg_verbatim_violation` overlap **0.25** — confirming the wall is model-independent.

---

## 9. Recommendation for Week 2

1. **Make F5.1 the first Phase 2 item** — derive the funnel from the account's own script, credit volunteered data toward step completion, and wire real script-position tracking. This is what unblocks autonomous booking for every customer.
2. Continue the planned Phase 2 features (Google Calendar, quota wrapper, QD-014/046, analytics) per `PHASE_2_PLAN.md`.
3. Deploy the Week 1 fixes to production (needs Vercel access).

---

*Companion docs: `FIX_LOG.md` (dated engineering log), `PHASE_1_PLAN.md`, `PHASE_2_PLAN.md` (§F5.1).*
