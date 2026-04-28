# Super-Admin Dashboard — Phase 1 Plan

## Scope (today)
Foundation only: schema, auth gate, accounts overview, account detail (Sections A/B/C). Phases 2-4 are separate.

## Open questions before implementing
1. **`User.role` enum** today is `ADMIN | CLOSER | SETTER | READ_ONLY`. Spec says `USER | ADMIN | SUPER_ADMIN`. Pragmatic path: **add `SUPER_ADMIN` to existing enum**, leave the others; existing `ADMIN` ≈ tenant owner. OK to proceed?
2. **`Account.plan` enum** today is `FREE | PRO | ENTERPRISE`. Spec wants `STARTER | GROWTH | SCALE`. Phase 1: leave as-is (rename in Phase 4 with billing). OK?
3. **Tega's user record** — confirm exact email I should bump to `SUPER_ADMIN`. Memory says `tegad8@gmail.com`.

## Schema changes (`prisma/schema.prisma`)
- `enum Role` add `SUPER_ADMIN`
- `Account` add: `planStatus` (`TRIAL|ACTIVE|PAST_DUE|CANCELLED`), `trialEndsAt`, `monthlyApiCostUsd` (Decimal), `healthStatus` (`HEALTHY|WARNING|CRITICAL`), `lastHealthCheck`, `onboardingStep` (Int default 0)
- New model `AdminLog`: `id, adminUserId, targetAccountId, action, metadata Json?, createdAt @default(now())`, indexes on `adminUserId`, `targetAccountId`, `createdAt`
- `prisma db push` after edit; regenerate client

## Backfill script
`scripts/promote-tega-super-admin.ts` — finds `User` by email, sets `role='SUPER_ADMIN'`, dry-run by default, `--apply` to commit.

## Auth + routing
- `src/lib/auth-guard.ts` — add `requireSuperAdmin(req)` wrapper that calls `requireAuth` then asserts `role==='SUPER_ADMIN'`; throws `AuthError(403)` otherwise
- `src/middleware.ts` (or new `/admin` layout) — redirect non-SUPER_ADMIN traffic on `/admin/**` to `/dashboard`
- `src/app/admin/layout.tsx` — server component, runs the guard, renders `AdminSidebar`

## API routes
- `GET /api/admin/accounts` — returns table data: account meta + leadsTotal + leadsToday + aiMessagesToday + callsBookedMonth + revenueMonth + lastActive + healthStatus
- `GET /api/admin/accounts/[id]` — section A (account info), section B (computed health checks), section C (30-day stats)
- Health-check helper `src/lib/admin-health.ts` — runs the 8 checks listed in spec Section B; returns `{check, status, lastError, lastCheckedAt}[]`

## UI
- `src/app/admin/page.tsx` — summary cards + accounts table; filters (All/Healthy/Warning/Critical); per-row [View] [Pause AI] [Edit Plan] (Phase 1: only [View] wired; others disabled with "Phase 3" tooltip)
- `src/app/admin/accounts/[id]/page.tsx` — sections A+B+C; D/E/F deferred
- `src/features/admin/components/admin-sidebar.tsx`, `accounts-table.tsx`, `health-badge.tsx`, `account-info-card.tsx`, `health-monitor.tsx`, `activity-stats.tsx`

## Tests (`scripts/test-admin-phase1.ts`)
1. `requireSuperAdmin` rejects non-super
2. `requireSuperAdmin` admits super
3. `/api/admin/accounts` returns row count == `Account.count()`
4. Health-check helper produces 8 result objects per account
5. Tega backfill script flips role + writes `AdminLog`

## Out of Phase 1
- Onboarding wizard (Phase 2)
- Impersonation (Phase 3)
- Emergency AI pause (Phase 3)
- Cost tracking section D (needs `AISuggestion.estimatedCostUsd` plumbing — Phase 3)
- Section E recent issues (Phase 3)
- Section F destructive actions (Phase 3)
- Billing (Phase 4)

## Estimate
~3 hours wall-clock for Phase 1 once Q1-Q3 above are confirmed.
