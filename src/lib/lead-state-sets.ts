// ---------------------------------------------------------------------------
// Canonical Lead.stage sets — single source of truth for analytics, funnels,
// list filters, and any "what counts as qualified / booked / showed" question.
//
// Why: every analytics route used to hand-roll its own stage array, so the
// Conversations tab said one thing, the Funnel chart said another, and the
// Dashboard Pie chart said a third. Closes the F8 / QD-032 → QD-041 cluster
// (see ANALYTICS_AUDIT.md). New analytics work imports from here; do not add
// new literal stage arrays in route files.
//
// LeadStage enum (14 values):
//   NEW_LEAD → ENGAGED → QUALIFYING → QUALIFIED → CALL_PROPOSED → BOOKED
//   → SHOWED|NO_SHOWED|RESCHEDULED → CLOSED_WON|CLOSED_LOST
//   plus terminal side-buckets: UNQUALIFIED, GHOSTED, NURTURE
// ---------------------------------------------------------------------------

import type { LeadStage } from '@prisma/client';

/**
 * "Qualified" = past the capital gate, still in flight, or already closed-won.
 *
 * Excludes terminal non-revenue (CLOSED_LOST, UNQUALIFIED, GHOSTED, NURTURE,
 * NO_SHOWED) — those have their own buckets. Excludes RESCHEDULED because a
 * reschedule means we lost the slot and are re-pitching; the lead is back to
 * "qualified, not yet booked" semantically (use BOOKED_LEAD_STAGES if you
 * want every-lead-with-a-scheduled-call).
 *
 * This is the Conversations tab's documented qualified set
 * (api/conversations/route.ts ~line 49); all other surfaces conform to it.
 */
export const QUALIFIED_LEAD_STAGES: readonly LeadStage[] = [
  'QUALIFIED',
  'CALL_PROPOSED',
  'BOOKED',
  'SHOWED',
  'CLOSED_WON'
] as const;

/**
 * "Booked" = has (or had) a scheduled call. Includes downstream stages where
 * the call already happened or was rescheduled. Note RESCHEDULED is included
 * because a reschedule still counts as "lead was on the calendar at some
 * point" for booking-rate metrics.
 */
export const BOOKED_LEAD_STAGES: readonly LeadStage[] = [
  'BOOKED',
  'SHOWED',
  'NO_SHOWED',
  'RESCHEDULED',
  'CLOSED_WON'
] as const;

/**
 * "Showed up" = lead actually attended the call. CLOSED_WON implies a show.
 * Excludes NO_SHOWED (definitionally) and RESCHEDULED (the call did not
 * happen yet).
 */
export const SHOWED_LEAD_STAGES: readonly LeadStage[] = [
  'SHOWED',
  'CLOSED_WON'
] as const;

/**
 * Terminal stages — the lead is closed for any reason (won, lost, unqualified,
 * ghosted, nurture queue, no-show). Everything else is in flight.
 */
export const TERMINAL_LEAD_STAGES: readonly LeadStage[] = [
  'CLOSED_WON',
  'CLOSED_LOST',
  'UNQUALIFIED',
  'GHOSTED',
  'NURTURE',
  'NO_SHOWED'
] as const;

/**
 * "Active" = not terminal, still moving through the funnel. SHOWED is here
 * because a lead that attended the call but hasn't yet closed (won/lost) is
 * still in flight. Together with TERMINAL_LEAD_STAGES this must cover every
 * LeadStage enum value (the reconciliation test asserts this).
 */
export const ACTIVE_LEAD_STAGES: readonly LeadStage[] = [
  'NEW_LEAD',
  'ENGAGED',
  'QUALIFYING',
  'QUALIFIED',
  'CALL_PROPOSED',
  'BOOKED',
  'SHOWED',
  'RESCHEDULED'
] as const;

/**
 * Everything except the entry point — used wherever we ask "did this lead
 * actually move past the front door?" Replaces ad-hoc null checks on the
 * `Conversation.stage*At` timestamp columns for that specific question.
 */
export const STAGES_WITH_STAGE_DATA: readonly LeadStage[] = [
  'ENGAGED',
  'QUALIFYING',
  'QUALIFIED',
  'CALL_PROPOSED',
  'BOOKED',
  'SHOWED',
  'NO_SHOWED',
  'RESCHEDULED',
  'CLOSED_WON',
  'CLOSED_LOST',
  'UNQUALIFIED',
  'GHOSTED',
  'NURTURE'
] as const;

/**
 * Cold-pitch / SPAM tag exclusion. Cold-pitch leads are inbound DMs from
 * other agencies (Omar-style pitches) that the cold-pitch detector tags
 * `cold-pitch` and sets outcome=SPAM on. They count as their own bucket
 * and must not pollute organic funnel metrics.
 *
 * Spread into the `where` clause of any aggregate query that should reflect
 * organic lead behavior:
 *
 *   prisma.lead.count({ where: { accountId, ...EXCLUDE_COLD_PITCH } })
 *
 * Policy (post-F8 reconciliation, 2026-05-30): excluded from every main-
 * funnel aggregate (Overview KPIs, Funnel chart, Lead-Distribution pie,
 * Dashboard Actions feed). NOT applied to raw list views (Leads page) so
 * cold-pitch leads remain visible and filterable by tag.
 */
export const EXCLUDE_COLD_PITCH = {
  tags: { none: { tag: { name: 'cold-pitch' as const } } }
} as const;

// Mutable copies for routes that need to spread into Prisma `in` filters.
// Prisma's typegen rejects readonly arrays in some positions, so we export
// both shapes — use the *_ARR variant inside `{ in: ... }`.
export const QUALIFIED_LEAD_STAGES_ARR: LeadStage[] = [
  ...QUALIFIED_LEAD_STAGES
];
export const BOOKED_LEAD_STAGES_ARR: LeadStage[] = [...BOOKED_LEAD_STAGES];
export const SHOWED_LEAD_STAGES_ARR: LeadStage[] = [...SHOWED_LEAD_STAGES];
export const TERMINAL_LEAD_STAGES_ARR: LeadStage[] = [...TERMINAL_LEAD_STAGES];
export const ACTIVE_LEAD_STAGES_ARR: LeadStage[] = [...ACTIVE_LEAD_STAGES];
export const STAGES_WITH_STAGE_DATA_ARR: LeadStage[] = [
  ...STAGES_WITH_STAGE_DATA
];
