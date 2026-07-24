# Path to M4 — Complete Plan

**For:** Tega · **Date:** 2026-07-24 · **Standard:** each item tested + independently verified before the next starts; per-item completion dates (not one date for all of M4).

> **On dates:** durations below are working-day estimates for one engineer. I've given a **duration and dependency for every item** and a proposed **sequence**, but deliberately not stamped absolute calendar dates until we agree the start date and how many of these run in parallel (i.e. whether it's one engineer or more). Give me a start date + headcount and every item gets a hard date. Putting fabricated dates on a plan you'll hold me to would be the wrong kind of confident.

---

## 0. Scope provenance (read this first)

Being straight about what was in the signed M1–M4 plan vs. what has been added on top, because "finish M4" now spans both. This isn't a pushback — it's so the plan and the commercial side line up.

| Workstream | In signed M1–M4 (`PHASE_2_PLAN.md`)? | Notes |
|---|---|---|
| **F9 Lead Memory** | ✅ **M4** (line 150) | original M4 feature |
| **F6 Objection Library** | ✅ **M4** (line 149) | original M4 feature |
| **F4 Follow-Up Picker / F7 Setter Goal** | ✅ **M4** (line 148) | original M4 features |
| **Adversarial-run remediation (F1–F6, health-check, classifier-first)** | ❌ **not in M1–M4** | your 2026-07-21 run; extra track, already delivered |
| **Fix D (state machine)** | ❌ **not in M1–M4** | "Sprint 7+ backlog" by prior labeling |
| **Multi-tenant leak audit (5 CRITICAL)** | ❌ **not in any milestone doc** | new; needs its own scope |
| **Data instrumentation / self-improvement / A/B / human-in-loop (Track 1)** | ⚠️ **not an M4 line item** | appears only as an unscoped far-future checklist; this is platform work, closer to Phase 3 |
| Conversation Takeover, Voice Notes (Track 5) | ✅ **M3** (lines 144–145) | **already built** — verified present in code |

**Plain read:** the genuine remaining *M4* scope is four features — F4, F6, F7, F9. Fix D, the leak audit, and Track 1 were not in M1–M4. I'll plan them all (as you asked), but they represent a real scope expansion beyond the original M4 SOW, and Track 1 in particular is a multi-week platform build. Worth a quick commercial alignment so nobody's surprised at sign-off.

---

## 1. Current status of each item (verified against the codebase today)

| Item | Status | Evidence |
|---|---|---|
| **F4 Follow-Up Picker** | 🟡 partial | `follow-up-sequence.ts` engine exists; no `followUpIntervalHours`/`followUpMaxAttempts` settings or UI |
| **F7 Setter Goal** | 🔴 not started | no `setterGoal` enum anywhere |
| **F6 Objection Library** | 🟡 partial | persona `objectionHandling` field + editor UI exist; no `objection-classifier.ts`, no seeded library |
| **F9 Lead Memory** | 🔴 not started | no `LeadMemory` model, no `lead-memory.ts` |
| **Fix D (state machine)** | 🟢 designed, approved in principle | `FIX_D_STATE_MACHINE_PROPOSAL.md` v2 — 4 questions answered, phased |
| **Multi-tenant leak audit** | ⚪ status unknown to me | the "5 CRITICAL findings" aren't in the repo docs I have — I need the audit source before I can date it |
| **Track 1 (instrumentation/self-improvement/A/B/HITL)** | 🔴 not started | only Sentry + `GenerationTurnTrace` exist; no harness/A-B/review infra |
| Conversation Takeover | ✅ done (M3) | `dashboard/leads/[id]/takeover/` |
| Voice Notes | ✅ done (M3) | `voice-note-*.ts` (8 modules) |

---

## 2. The plan — item by item, with dependencies

### A. Fix D — state machine (details in `FIX_D_STATE_MACHINE_PROPOSAL.md`)
Four phases, strictly sequential except Phase 0 is standalone. **~13–17 working days**, one engineer. Egress + holds (the F1 architectural fix) is **Phase 0 / first** (re-sequenced per your Q4). Each phase shadow-compared and **independently verified** (Ali/Tega) before cutover.

### B. Multi-tenant leak audit — 5 CRITICAL (hard prerequisite before client two)
**Blocking dependency for onboarding any second client.** I can't date this honestly yet because the 5 findings aren't in the docs I have.
- **Immediate (½ day):** you send me the audit / the 5 findings → I scope each with a fix estimate.
- **Then:** fix + independent re-verification per finding, same standard as F1–F6.
- **Rough placeholder:** security fixes are hard to timebox blind — assume **3–8 working days** pending the actual findings. This should run **before or in parallel with** the M4 features, since it gates client two, not after.

### C. Track 1 — data instrumentation / self-improvement / A/B / human-in-the-loop
This is **platform infrastructure, not a bug fix** — the largest single item.
- Self-improvement harness (capture → label → retrain loop), HITL review queue, A/B variant assignment + results tracking.
- Foundation partly exists (`GenerationTurnTrace`, Sentry). The rest is new.
- **Est. 3–4 weeks**, and it benefits from being **sequenced after** the funnel is provably stable (which the remediation + Fix D deliver) so the harness measures a stable baseline. Recommend this **last** in the M4 push, or split into its own phase.

### D. F9 Lead Memory (the real F9) + F6 Objection Library (Track 4)
Both original M4 features.
- **F9:** `LeadMemory` model + `MemorySource` enum; `lead-memory.ts` (get/upsert/extract via Anthropic, rate-limited); wire into `ai-engine.ts` (load at start, async extract after reply); lead-detail memory panel; dead-lead digest. **Est. ~3–4 days.**
- **F6:** seed top-10 objection responses; `objection-classifier.ts` (keyword → LLM fallback, quota-wrapped); wire into prompt assembly (the persona UI already exists). **Est. ~2–3 days.**
- These two are **independent of each other** and of Fix D — parallelizable.

### E. F4 Follow-Up Picker + F7 Setter Goal (Track 5, operational polish)
Original M4 features.
- **F4:** `followUpIntervalHours` + `followUpMaxAttempts` on Account; read in `follow-up-sequence.ts` (replace hardcoded 12h); Settings UI + `/dashboard/follow-ups`; prior-context summary in follow-up bodies. **Est. ~2 days** (engine exists).
- **F7:** `setterGoal` enum (`BOOK_CALL`|`COLLECT_EMAIL`|`ROUTE_TO_FUNNEL`) + `routeToFunnelUrl`; wire terminal stage per goal; Settings dropdown. **Est. ~2 days.**
- Independent of everything else — parallelizable.

---

## 3. Sequencing — what's parallel, what's sequential, and why

**Hard sequential constraints:**
- **Fix D phases 1→2→3** must be in order (each migrates state the prior phase now owns). Phase 0 first.
- **Leak audit gates client two** — must close before a second client onboards, so it can't be "after everything."
- **Track 1 benefits from a stable baseline** — best measured *after* Fix D stabilizes the funnel, so it's naturally later.

**What can run in parallel (given headcount):**
- The four M4 features (F4, F6, F7, F9) are independent of Fix D and of each other.
- The leak audit is independent of the M4 features.

**Recommended order (single engineer):**
1. **Leak audit** (gates client two — do it first once you send the findings).
2. **Fix D Phase 0** (egress/F1 architectural — highest-severity class, and the safety floor for everything after).
3. **M4 features F4 + F7 + F6 + F9** (interleave with Fix D phases 1–2 since they're independent).
4. **Fix D phases 1–3** (state migration).
5. **Track 1** (last — measures the now-stable system).

**With a second engineer:** the M4 features (D+E above) run fully in parallel with Fix D, roughly halving wall-clock to that point.

**Rough total (one engineer, sequential):** leak audit (3–8d) + Fix D (13–17d) + F9/F6 (5–7d) + F4/F7 (4d) + Track 1 (15–20d) ≈ **8–11 weeks**. That's the honest size of "finish M4 as now scoped" — which is why the scope-provenance table matters: a lot of this is beyond the original M4.

---

## 4. Verification standard (applies to every item, per your instruction)

- Each item: tested and **independently verified** before the next starts — implementer does not sign off their own work.
- Fix D + Track 1 + the leak audit each get a shadow/verification window with an expected-vs-actual writeup in the findings-doc format.
- Ali (or you) on the verification, same as F1–F6.

---

## 5. What I need from you to put hard dates on this

1. **The multi-tenant leak audit** (the 5 CRITICAL findings) — I don't have it. Send it and I'll scope + date each.
2. **A build-start date** + **headcount** (one engineer or two) — determines parallelism and absolute dates.
3. **Confirmation on scope/commercials** — several of these were outside M1–M4; a quick word on how they're being counted so the plan and the milestone accounting agree.

Give me those three and I'll return this same plan with a hard completion date on every single line.
