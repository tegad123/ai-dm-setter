# Super-Admin Phase 2 — Onboarding Wizard

## Scope (today)
6-step onboarding wizard at `/admin/onboard`, end-to-end. No new schema (Phase 1 added `onboardingStep`). Some steps are intentionally minimal in this phase — full functionality flagged inline.

## Architecture

- `/admin/onboard` — landing: lists in-progress wizards + "Start new" button
- `/admin/onboard/new` — Step 1 form (creates account on submit)
- `/admin/onboard/[accountId]/step/[n]` — Steps 2-6, n in {2,3,4,5,6}
- Progress is `Account.onboardingStep` (0=not started → 6=complete). Increments on each step's "Save & continue".
- Step 6 sets `onboardingComplete=true`, `awayModeInstagram/Facebook=true` (default opt-in), creates AdminLog row, redirects to `/admin/accounts/[id]`.
- Resume: visiting `/admin/onboard/[accountId]` redirects to the step matching `onboardingStep`.

## Step-by-step scope

| Step | Action | Phase 2 fidelity |
|---|---|---|
| 1 | Create Account + initial admin User + empty AIPersona | **Full** |
| 2 | Connect Meta (IG / FB credentials) | **Status display + Skip** — actual OAuth is tenant-side via `/dashboard/settings/integrations` |
| 3 | Configure persona — core fields only | **Medium** — ~10 fields covering call handoff, capital threshold, downsell URLs |
| 4 | Upload training data | **Minimal — links out** to `/dashboard/settings/training` after impersonation |
| 5 | Test 3 lead types (qualified, below-threshold, distress) | **Medium** — runs real `generateReply` against the new persona |
| 6 | Activate | **Full** — toggle awayMode, mark complete, AdminLog, welcome notification |

Phase 3 expansions (later): full 5-test runner, training-CSV upload, send-real-welcome-email integration, billing setup.

## APIs

- `POST /api/admin/onboard/account` — create Account + User + AIPersona, return new accountId
- `GET  /api/admin/onboard/[accountId]/status` — onboardingStep, persona-configured-flag, IG/FB cred status, training count
- `POST /api/admin/onboard/[accountId]/persona` — update AIPersona core fields
- `POST /api/admin/onboard/[accountId]/test` — run N test scenarios; return AI replies + pass/fail per scenario
- `POST /api/admin/onboard/[accountId]/activate` — flip awayMode, set onboardingComplete, AdminLog, return ok

All 4 are super-admin-gated.

## Components

- `WizardShell` — step indicator (1-6), title, body slot, Back / Save & Continue / Skip buttons
- Step components: `Step1CreateAccount`, `Step2Meta`, `Step3Persona`, `Step4Training`, `Step5Test`, `Step6Activate`
- Reused: `HealthBadge`

## Tests (`scripts/test-admin-phase2.ts`)
1. POST /onboard/account creates Account + User + AIPersona; returns accountId
2. POST /onboard/persona updates the right AIPersona row
3. POST /onboard/test runs all 3 scenarios and returns 3 result rows (mock-mode if no LLM key)
4. POST /onboard/activate flips awayMode + onboardingComplete + writes AdminLog
5. /onboard/status returns correct step counters
