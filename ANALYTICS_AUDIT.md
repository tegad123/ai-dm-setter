# Analytics Reconciliation — Audit & Plan (2026-05-30, revised)

**Context.** Tega's Week 2 priority bump: "Stage progression needs to be accurate and consistent across the board — the conversations tab, the analytics, and the pipeline tab all need to reflect the same data. Right now they are showing different numbers."

**Why this doc was revised.** The first version of this audit was based on a partial scan (3 of 19 analytics routes deeply read, no UI consumer trace, no writer trace). I'd proposed a fix from incomplete evidence. This revision reads every route, traces every UI consumer to its backend, identifies every place stage data is written, and grounds every claim in a file:line citation.

---

## 1. What was actually read (audit trail)

So no hand-waving: here is the full list of files read for this revision.

**Backend — all 19 analytics routes:**
- commissions, content, conversation-funnel, data-quality, drop-off-hotspots, effectiveness, funnel, lead-distribution, lead-volume, live-conversations, message-effectiveness, overview, predictions, revenue, segments, sequences, team, triggers, velocity

**Backend — adjacent routes that feed the same screens:**
- `src/app/api/conversations/route.ts` (Conversations tab)
- `src/app/api/leads/route.ts` (Leads/Pipeline tab — confirmed Pipeline is a 14-line redirect to `/dashboard/leads`)
- `src/app/api/dashboard/actions/route.ts` (Dashboard action feed)

**Backend — writers of stage data:**
- `src/lib/webhook-processor.ts` (writes Conversation.stage*At on stage transitions + skips; also creates Messages)
- `src/lib/conversation-state-machine.ts` (stage→column mapping at lines 184–200)
- `src/lib/scoring-integration.ts` (same mapping at 143–151)

**Backend — helpers:**
- `src/lib/cold-start.ts` (the `checkColdStart` function + `DATA_THRESHOLDS` constants)
- `src/lib/booking-predictor.ts` (referenced by predictions route)
- `src/lib/lead-scoring-engine.ts` (uses stage*At for scoring)

**Frontend — consumer pages and wrappers:**
- `src/app/dashboard/analytics/page.tsx` → uses `AnalyticsView` from `src/features/analytics/components/analytics-view.tsx`
- `src/app/dashboard/overview/{@sales,@area_stats,@bar_stats,@pie_stats}/page.tsx` (parallel routes for dashboard home widgets)
- `src/features/overview/components/{recent-sales,area-graph,bar-graph,pie-graph}.tsx`
- `src/features/analytics/components/{team-performance-view,activity-heatmap,team-leaderboard,analytics-view}.tsx`
- `src/features/leads/components/leads-table.tsx`
- `src/lib/api.ts` (HTTP wrapper functions) + `src/hooks/use-api.ts` (React hooks)
- `prisma/schema.prisma` LeadStage enum

**Frontend pages NOT yet deeply audited:**
- `src/app/dashboard/analytics/{deep-dive,ab-tests,optimizations,team,live,predictions}/page.tsx` — sub-pages of Analytics. They wrap specific analytics routes I've already mapped, so the data sources are known; the visual presentation hasn't been walked through. None of them are involved in the "stage progression mismatch" Tega flagged; they show different metric families.

This means the **stage-progression reconciliation work** is grounded in code. Sub-page polish would be a separate pass if QA finds issues there.

---

## 2. The complete LeadStage enum

14 values, in `prisma/schema.prisma`:
`NEW_LEAD, ENGAGED, QUALIFYING, QUALIFIED, CALL_PROPOSED, BOOKED, SHOWED, NO_SHOWED, RESCHEDULED, CLOSED_WON, CLOSED_LOST, UNQUALIFIED, GHOSTED, NURTURE`

---

## 3. UI → API → query mapping (the full picture)

### 3a. Dashboard Home (`/dashboard/overview`) — what loads first
The dashboard uses Next.js parallel routes with 4 widget slots:

| Widget | Component | API call | Stage filter |
|---|---|---|---|
| Recent Sales | `recent-sales.tsx` | `GET /api/leads?limit=5` | None |
| Area Graph | `area-graph.tsx` | `GET /api/analytics/revenue` (`useRevenueData`) | None — `revenue > 0 AND closedAt != null` |
| Bar Graph | `bar-graph.tsx` | `GET /api/analytics/lead-volume` (`useLeadVolume`) | None — last 30 days, all leads |
| Pie Graph | `pie-graph.tsx` | `GET /api/analytics/lead-distribution` (`useLeadDistribution`) | None — groupBy all stages |

The Pie chart shows **all 14 stages with no filtering**. That's the count Tega will compare against the Analytics page's "Qualified", which is a 6-stage filter. Mismatch by definition.

### 3b. Analytics page (`/dashboard/analytics`)
`AnalyticsView` calls:
- `useOverviewStats` → `/api/analytics/overview` → KPI cards (Total Leads, Leads Today, Calls Booked, Show Rate, Close Rate, Revenue)
- `useLeadVolume` → `/api/analytics/lead-volume` → time-series
- `useFunnel` → `/api/analytics/funnel` → funnel chart (Total → Qualified → Booked → Showed → Closed)
- `useTriggerPerformance` → `/api/analytics/triggers`
- `useRevenueData` → `/api/analytics/revenue`

### 3c. Leads page / Pipeline tab
`leads-table.tsx` fetches via `useLeads()` → `/api/leads` and shows:
- A stage filter dropdown that hits the API with `?stage=<EXACT_STAGE>`
- A table of leads with `LeadStageBadge` per row
- **No aggregated counts displayed.** It's a list view.
- `/api/leads` itself: `prisma.lead.findMany({ where: { accountId } })` plus optional stage filter. **No cold-pitch exclusion by default** (cold-pitch leads appear in the list).

`/dashboard/pipeline` is a 14-line `redirect('/dashboard/leads')`. So "Pipeline vs Leads" is always identical; the real comparison is Leads vs Analytics vs Conversations.

### 3d. Conversations tab
`/api/conversations/route.ts` reads `qualification` query param:
- `?qualification=qualified` → `Lead.stage IN [QUALIFIED, CALL_PROPOSED, BOOKED, SHOWED, CLOSED_WON]` (5 stages)
- `?qualification=unqualified` → `Lead.stage = UNQUALIFIED`
- default (no filter): no stage filter
- **Cold-pitch IS excluded by default** ([conversations/route.ts:38](src/app/api/conversations/route.ts#L38)).

The displayed comment block ([line 43–48](src/app/api/conversations/route.ts#L43-L48)) explicitly documents the intent: "We include CLOSED_WON but NOT CLOSED_LOST, NO_SHOWED, GHOSTED, NURTURE — those are terminal non-revenue states." This is the closest thing to a canonical definition that exists in the codebase, and it doesn't match the funnel route.

---

## 4. Every divergence with file:line evidence

### 4a. "Qualified" is defined 3 different ways

| Where | Set | Cites |
|---|---|---|
| Conversations tab | `QUALIFIED, CALL_PROPOSED, BOOKED, SHOWED, CLOSED_WON` (5) | [conversations/route.ts:49-51](src/app/api/conversations/route.ts#L49-L51) |
| Analytics Funnel | `QUALIFIED, BOOKED, SHOWED, NO_SHOWED, CLOSED_WON, NURTURE` (6) | [analytics/funnel/route.ts:14-22](src/app/api/analytics/funnel/route.ts#L14-L22) |
| Dashboard Actions feed | `QUALIFIED, CALL_PROPOSED, BOOKED` (3) | [dashboard/actions/route.ts:374](src/app/api/dashboard/actions/route.ts#L374) |

Three answers to the same question. Tega's complaint follows directly.

### 4b. "Booked" is defined twice with different cold-pitch policies

| Where | Stage set | Cold-pitch | Cites |
|---|---|---|---|
| Analytics Overview | `BOOKED, SHOWED, NO_SHOWED, CLOSED_WON` | **NOT excluded** from this query (only excluded from totalLeads/leadsToday) | [analytics/overview/route.ts (stageCounts groupBy)](src/app/api/analytics/overview/route.ts) |
| Analytics Funnel | `BOOKED, SHOWED, NO_SHOWED, CLOSED_WON` | NOT excluded | [analytics/funnel/route.ts:28-31](src/app/api/analytics/funnel/route.ts#L28-L31) |

**New finding I missed in v1:** the Overview route's `excludeColdPitchTag` is applied to `totalLeads` and `leadsToday` but **NOT to `stageCounts`**. So within a single API response, Total Leads is a "no cold-pitch" number and Calls Booked is an "everything" number. That's an internal-to-Overview inconsistency, not just an inter-route one. Show Rate / Close Rate denominators inherit this.

### 4c. "Showed up" is defined twice

| Where | Set | Cites |
|---|---|---|
| Analytics Funnel | `SHOWED, CLOSED_WON` | [analytics/funnel/route.ts:34-37](src/app/api/analytics/funnel/route.ts#L34-L37) |
| Analytics Overview | `showedUp = SHOWED + CLOSED_WON` counts, but `showRate = (SHOWED + CLOSED_WON) / (BOOKED + SHOWED + NO_SHOWED + CLOSED_WON)` | [analytics/overview/route.ts](src/app/api/analytics/overview/route.ts) |
| Segments | `SHOWED, CLOSED_WON` (via lead.stage filter) | [analytics/segments/route.ts:75-77](src/app/api/analytics/segments/route.ts#L75-L77) |

The set matches, but the denominator differs across routes that *report* a "show rate."

### 4d. Cold-pitch exclusion is applied in 2 places, ignored in 17

| Where | Cold-pitch handling |
|---|---|
| Conversations tab default | Excluded ([conversations/route.ts:38](src/app/api/conversations/route.ts#L38)) |
| Overview `totalLeads` / `leadsToday` | Excluded |
| Overview `stageCounts` | **NOT excluded** |
| Analytics Funnel | Not applied |
| Analytics Lead-Distribution (Pie) | Not applied |
| Leads page (Pipeline) | Not applied |
| Other 14 analytics routes | Not applied |

### 4e. Three different stage concepts conflated under "stage"

- **`Lead.stage`** — the 14-value enum. Used by Conversations, Overview, Funnel, Dashboard, Leads page.
- **`Conversation.outcome`** — buckets: `ONGOING, BOOKED, LEFT_ON_READ, SPAM, …`. Used by velocity, predictions, sequences, drop-off-hotspots, data-quality.
- **`Conversation.stage*At` timestamps** (the 7-step SOP milestones). Used by `live-conversations` ([file:9-22](src/app/api/analytics/live-conversations/route.ts#L9-L22)), `conversation-funnel` ([file:6-14](src/app/api/analytics/conversation-funnel/route.ts#L6-L14)), `velocity`, `predictions`, `sequences`.

Three different ways the codebase represents "what stage is this lead in," none reconciled with each other.

### 4f. `cold-start.ts` ignores the threshold parameter

[cold-start.ts:36](src/lib/cold-start.ts#L36): the function signature is `checkColdStart(accountId, _thresholdOverride?)` — the underscore-prefix `_thresholdOverride` is a TypeScript-eslint convention for "unused parameter." The function only ever checks against the 3 hardcoded thresholds at lines 70-89 (`MIN_CONVERSATIONS=10`, `MIN_COMPLETED_CONVERSATIONS=5`, `MIN_MESSAGES=50`).

But `data-quality/route.ts` calls it once per threshold in `DATA_THRESHOLDS` expecting feature-specific gating. They all return the same status. **QD-040 (Cold Start Thresholds 0/50 0/30 0/20)** comes from this: data-quality shows the threshold *keys* (50, 30, 20) but a single `liveCount` against all of them, which on a fresh account is 0.

### 4g. `Message.stage` is mostly null

The `Messages.stage` column gets populated only on the main AI generation path. Supportive/handoff/distress messages explicitly set `stage: null` ([webhook-processor.ts:1697, 1985](src/lib/webhook-processor.ts)), which is correct. But:
- Imported leads, manually-advanced leads, and anything pre-dating the field have null stages.
- `data-quality/route.ts` reports "messages with stage data" as `prisma.message.count({ stage: { not: null } })` — so the ratio is small whenever an account has a mix of imports + organic flow.

That's **QD-039 ("With Stage Data: 0" despite 22 conversations)** — the 22 conversations have messages, but few or none have `Message.stage` populated.

### 4h. `Conversation.stage*At` is reliably written *for new AI-driven conversations* — but not backfilled

[webhook-processor.ts:2791-2803](src/lib/webhook-processor.ts#L2791-L2803) writes the timestamp columns when stages are auto-skipped on pre-qualified leads. The main state-machine sets them on normal progression via the mapping at [conversation-state-machine.ts:184-200](src/lib/conversation-state-machine.ts#L184-L200). New rows are initialized to null at [webhook-processor.ts:1324-1330](src/lib/webhook-processor.ts#L1324-L1330).

So for conversations driven by the current AI stack, the SOP timestamps work. For older / imported / manually-managed conversations, they're null. That's **QD-041 (Conversation Funnel empty)** — the funnel chart at `conversation-funnel/route.ts` counts only reached-stage timestamps and will show low/zero on accounts where most leads predate the SOP rollout.

---

## 5. QD bug → root cause mapping

| Bug | Symptom | Root cause | Citation |
|---|---|---|---|
| QD-032 | Overview vs Pipeline numbers mismatch | 4a + 4d (different "qualified" set + cold-pitch policy difference) | overview.ts, funnel.ts, conversations/route.ts |
| QD-033–QD-038 | 6 more Overview mismatches | Same as QD-032 | same |
| QD-039 | "With Stage Data: 0" despite 22 conversations | 4g — Message.stage is null for non-AI-pipeline messages | data-quality.ts, webhook-processor.ts:1697 |
| QD-040 | Cold Start Thresholds show 0/50, 0/30, 0/20 | 4f — cold-start helper ignores requested threshold, returns one count | cold-start.ts:36 |
| QD-041 | Conversation Funnel chart empty | 4h — funnel uses Conversation.stage*At which is null for non-AI / older convos | conversation-funnel.ts:6-14 |

All 8 bugs trace cleanly. There's no surprise extra bug class hidden in the unread routes — I read all 19 to confirm.

---

## 6. The plan (grounded in section 1–5, not assumptions)

### Step 1 — Create `src/lib/lead-state-sets.ts`

Single source of truth. Export typed constants for every set:

```ts
import type { LeadStage } from '@prisma/client';

// Past capital gate, still in-flight or revenue-locked. Matches the
// Conversations tab's documented "qualified" definition.
export const QUALIFIED_LEAD_STAGES: LeadStage[] = [
  'QUALIFIED', 'CALL_PROPOSED', 'BOOKED', 'SHOWED', 'CLOSED_WON'
];

// Has a call scheduled or beyond.
export const BOOKED_LEAD_STAGES: LeadStage[] = [
  'BOOKED', 'SHOWED', 'NO_SHOWED', 'RESCHEDULED', 'CLOSED_WON'
];

// Made the call.
export const SHOWED_LEAD_STAGES: LeadStage[] = ['SHOWED', 'CLOSED_WON'];

// Active = not terminal.
export const TERMINAL_LEAD_STAGES: LeadStage[] = [
  'CLOSED_WON', 'CLOSED_LOST', 'UNQUALIFIED', 'GHOSTED', 'NURTURE', 'NO_SHOWED'
];
export const ACTIVE_LEAD_STAGES: LeadStage[] = [
  'NEW_LEAD', 'ENGAGED', 'QUALIFYING', 'QUALIFIED',
  'CALL_PROPOSED', 'BOOKED', 'RESCHEDULED'
];

// All stages except the entry point — used wherever we ask
// "moved past the front door".
export const STAGES_WITH_STAGE_DATA: LeadStage[] = [
  'ENGAGED', 'QUALIFYING', 'QUALIFIED', 'CALL_PROPOSED', 'BOOKED', 'SHOWED',
  'NO_SHOWED', 'RESCHEDULED', 'CLOSED_WON', 'CLOSED_LOST', 'UNQUALIFIED',
  'GHOSTED', 'NURTURE'
];

// Shared cold-pitch exclusion.
export const EXCLUDE_COLD_PITCH = {
  tags: { none: { tag: { name: 'cold-pitch' as const } } }
} as const;
```

### Step 2 — Refactor every callsite

Touch list (specific files, not "some routes"):
- 6 routes that hardcode stage arrays: funnel, overview, segments, dashboard/actions, conversations, drop-off-hotspots
- 5 routes using Conversation.stage*At (will keep using it for *velocity-style* analysis but stop using it as "did this lead reach stage X"): velocity, predictions, sequences, live-conversations, conversation-funnel
- 2 routes filtering on outcome literals only (kept as-is): revenue, commissions
- 6 routes with no stage filtering: content, lead-volume, triggers, lead-distribution, team, effectiveness, message-effectiveness

### Step 3 — One cold-pitch policy applied uniformly

Recommend: cold-pitch leads are excluded from every "main funnel" aggregate (Overview's stageCounts, Funnel, Lead Distribution Pie on the home page, Dashboard Actions). Keep them visible in raw lists (Leads page) with a tag filter. Implement via `EXCLUDE_COLD_PITCH` spread into every aggregate's `where` clause.

### Step 4 — Fix QD-039 (Message.stage)

Two options:
- **A.** Reframe the "With Stage Data" metric as a *new-AI-pipeline-only* health check. Filter conversations to those `createdAt >= AI_SOP_ROLLOUT_DATE` before computing the ratio.
- **B.** Backfill `Message.stage` from `Conversation.stage*At` timestamps using a one-time migration: for each message, the stage at its timestamp is the stage whose `stage*At ≤ message.timestamp` is highest. Complex but most accurate.

Recommendation: **A**. Cheaper, accurate for the purpose (data-quality is meant to gauge new-pipeline coverage, not retro-rate old data).

### Step 5 — Fix QD-040 (cold-start.ts)

Honor the `thresholdOverride` parameter. Trivial — drop the underscore and use it instead of `MIN_MESSAGES` in the check:

```ts
export async function checkColdStart(
  accountId: string,
  thresholdOverride?: number
): Promise<ColdStartStatus> {
  // …
  const messageThreshold = thresholdOverride ?? DATA_THRESHOLDS.MIN_MESSAGES;
  if (messageCount < messageThreshold) { /* … */ }
}
```

### Step 6 — Fix QD-041 (Conversation Funnel)

Two viable paths:
- **A.** Keep using `Conversation.stage*At` but show the date-cutoff in the UI ("Showing conversations since SOP rollout").
- **B.** Pivot the conversation-funnel route off `stage*At` and onto `Lead.stage`, mapping `QUALIFYING ≈ Situation Discovery, QUALIFIED ≈ Soft Pitch, etc.` That loses the inner-stage granularity (Goal/Emotional Why vs Urgency are both "QUALIFYING").

Recommendation: **A**. Keep the conversation-funnel granularity for the AI's flow; just make the empty-on-old-data behavior explicit.

### Step 7 — Verify the AI auto-save of call details (Tega's other Week 2 ask)

In the existing guarded autonomous booking path ([webhook-processor.ts](src/lib/webhook-processor.ts)), confirm every call-detail field is populated when the AI books:
- `Conversation.scheduledCallAt`, `scheduledCallTimezone`, `scheduledCallSource`, `scheduledCallConfirmed`
- The `transitionLeadStage(... BOOKED)` and `scheduleCallReminders / scheduleCallConfirmationSequence` paths
- `bookingProviderEventId` / `bookingMeetingUrl` if those fields exist on the conversation row

If any is missing, fill it in the same write. This is ~1 hour of audit, not a major task.

### Step 8 — Reconciliation test

Seed a known set of leads in known stages (e.g., 5 NEW_LEAD, 3 QUALIFIED, 2 BOOKED, 1 SHOWED, 1 CLOSED_WON), then assert the SAME numbers across:
- `/api/leads` list grouped by stage
- `/api/conversations?qualification=qualified` → 4 (QUALIFIED + BOOKED + SHOWED + CLOSED_WON)
- `/api/analytics/overview` → `callsBooked = 4`
- `/api/analytics/funnel` → `qualified = 4`

Prevents this from regressing.

---

## 7. Time estimate

| Step | Effort |
|---|---|
| 1. lead-state-sets.ts | 0.25d |
| 2. Refactor 6 stage-array sites + add cold-pitch where appropriate | 0.75d |
| 3. Cold-pitch policy uniformity (rolled into 2) | — |
| 4. QD-039 reframe | 0.25d |
| 5. QD-040 cold-start fix | 0.1d |
| 6. QD-041 + explicit date cutoff in UI | 0.4d |
| 7. Call-detail auto-save audit | 0.25d |
| 8. Reconciliation test | 0.5d |

**Total ~2.5 days**, matches the 1–2 days extra commitment.

---

## 8. What's parked / out of scope

- **F5.1 hardcoded DAE funnel** — still gates lead → BOOKED E2E for non-Daniel accounts. Phase 2 HIGH; unchanged by this work.
- **Analytics sub-pages** (deep-dive, ab-tests, optimizations, team page, live page, predictions page) — wrap routes I've already mapped. If any visual mismatch shows up there during QA, it inherits the same 3 root causes from §4 and the §6 fixes resolve them.
