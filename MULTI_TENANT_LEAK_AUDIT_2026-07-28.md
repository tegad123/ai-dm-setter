# Multi-Tenant Data Leakage Audit — Findings Report

**Run date:** 2026-07-28
**Build audited:** commit `73e076f` (verifiable via `/api/version`)
**Method:** four parallel read-only sweeps across the eight scoped vulnerability classes; every finding's `file:line` independently re-verified against source before inclusion. **Diagnose-only — no fixes applied.**
**Grading rule:** this report is the output of the run; independent verification by Ali per standing process (the person who ran it does not grade it).

Tenant boundary = `Account.accountId`; within an account, `AIPersona.personaId`. Platform operators (`SUPER_ADMIN`, `MANAGER` via `isPlatformOperator`, `auth-guard.ts:12`) have by-design cross-account access.

---

## HEADLINE

The audit is **reassuring on structure, pointed on residue.** The systems built in the last two weeks (trace viewer, reset/baseline/archive, health-sweep, notifications, SSE), the ~140 dashboard API routes, the query layer, and the Meta webhooks are **tenant-scoped by design** — Class 4 and Class 8 returned **zero** findings, the Meta webhooks verified strict and fail-loud, and `Conversation.personaId` **is** `NOT NULL` (the original Phase-1 item did land — confirmed at `schema.prisma:1134`).

Every finding falls into one of two buckets, and **neither is architectural**:

1. **Single-tenant-era residue** — hardcoded `Anthony` / `Marcus` / `$497` / `session liquidity` in deterministic fallback messages and detection regexes, written when daetradez was the only tenant. Fix = parameterize on existing persona config. This is the exact class the original audit was triggered by (the hallucinated-URL / "Anthony" leak).
2. **Shared-secret ingestion webhooks** — CRM and Typeform authenticate with one global secret instead of per-account credentials (Meta already uses per-account). Fix = per-account secrets, the pattern LeadConnector already follows.

**Totals (deduplicated):** 3 CRITICAL, 4 HIGH, 9 MEDIUM.

**REMEDIATION STATUS (2026-08-11):** all 3 CRITICAL fixed — 1-1 (main-offer label config-resolved, generic fallback "the main program"), 1-2 (closer name config-resolved at both sites, name dropped when unconfigured), 5-1 (PATCH /api/team/[id] now ADMIN-only, role validated against the shared invite allowlist in `src/lib/team-roles.ts`, self role/isActive changes forbidden; DELETE also ADMIN-gated as the same class).

**REMEDIATION STATUS (2026-08-16):** 4 of 5 HIGH fixed —
- 1-3: `buildStep10DeepWhyDirective` no longer ships daetradez's verbatim Step-10 lines. The deep-why ASK now resolves from the persona's own script anchor (`resolveDeepWhyAsk` over `scriptAskAnchorsForTurn`), the MSG is a generic acknowledgment, and the forbidden list is described by class (capital question / obstacle re-ask / belief-break / call proposal) instead of "cars and materialistic stuff" / "call with anthony" / "99% of traders".
- 1-4: removed the `anthony` closer literals from every regex in `script-step-progression.ts` (generic closer terms retained). The STEP_PATTERN_MAP adherence checks are ALSO already gated on `activeScriptHasAnchors` (P0 fix `d3b4321`), so they don't run for multi-tenant personas at all. `99% of traders` kept as a generic belief-break trading phrase (not a tenant identifier).
- 1-5: removed `anthony`, `session liquidity` / `session liquidity model`, `whop` / `whop.com` literals from all detection regexes in `script-state-recovery.ts`; generic closer/commerce terms retained.
- 7-1: the `'497'` price fallback is gone from both `ai-prompts.ts` and `ai-engine.ts`. Unconfigured price now → null; the prompt strips the price clause and the outbound downsell message renders "the course" (product name only, whitespace-folded) instead of asserting daetradez's real $497. Configured tenants unchanged.
- 6-1/2-1 (CRM webhook cross-tenant write) — STILL OPEN, being assessed next; it is a genuine cross-tenant MUTATION path (shared secret + unscoped `leadId` write), arguably the most serious HIGH.

Suites green after 1-3/1-4/1-5/7-1: harm gate 36/36, branch-router, interrupt 12/12, answered-ledger 4/4, script-state-recovery. TSC clean.

---

## CRITICAL

### FINDING 1-1 — "marcus's 1-on-1" ships to any tenant's lead
**Severity:** CRITICAL
**File:** `src/lib/ai-engine.ts:6464`
**Description:** A deterministic R24 recovery message (below-threshold lead, natural fallback still routed to booking) hardcodes the founding tenant's high-ticket product owner by name. Price and product name are config-resolved; "marcus's 1-on-1" is a raw literal shipped to the lead.
**Evidence:** `` const downsellMsg = `i hear you bro. the capital for marcus's 1-on-1 is a bit higher than what you've got right now... ${downsellProductName} covers the full system...` ``
**Exploitability:** Fires for ANY tenant when a lead is confirmed below the capital threshold and the LLM fallback still pitched a booking (`r24LastResult.reason === 'answer_below_threshold'`). No daetradez gating. A second tenant's lead literally receives "the capital for marcus's 1-on-1…".
**Recommendation:** Replace with a config-resolved main-offer label (`persona.promptConfig.mainOffer` / mirror the `downsellProductName` resolution two tokens later), fallback "the main program".

### FINDING 1-2 — "anthony will be ready for you" ships to any tenant's lead
**Severity:** CRITICAL
**File:** `src/lib/ai-engine.ts:6264` and `:7067`
**Description:** Two identical deterministic booking-confirmation fallbacks (post-booking-email hallucination exhausted / detected) hardcode the founding tenant's closer name.
**Evidence:** `parsed.message = "you're all locked in bro, anthony will be ready for you at that time";`
**Exploitability:** Fires for ANY tenant when the post-booking-email guard trips and exhausts. A second tenant's lead is told "anthony will be ready for you" regardless of their configured closer.
**Recommendation:** Interpolate the resolved closer label (`closerName || 'your coach'`); if none configured, drop the name.

### FINDING 5-1 — tenant user can self-promote to platform operator
**Severity:** CRITICAL
**File:** `src/app/api/team/[id]/route.ts:52-82`
**Description:** `PATCH /api/team/[id]` copies `role` straight from the request body into `prisma.user.update` with no caller-role gate and no value allowlist. The sibling invite route (`invite/route.ts:24,30`) has BOTH — `ADMIN`-only, and a whitelist that deliberately excludes `MANAGER`/`SUPER_ADMIN`. This PATCH has neither.
**Evidence:** `const allowedFields = ['name','email','role','isActive']; ... if (body[field] !== undefined) data[field] = body[field];`
**Exploitability:** Any authenticated tenant user PATCHes a user in their own account and sets `role: "SUPER_ADMIN"` (a valid enum member). `isPlatformOperator()` then returns true, flipping every cross-tenant guard in the app (traces, reset, baseline, archive, conversation detail, `/admin/*`) into its cross-account branch. Result: full cross-tenant read of every account's conversations/prompts/leads, plus cross-tenant reset/archive (evidence destruction). **This single flaw defeats every other tenant guard in the codebase.**
**Recommendation:** (1) gate `if (auth.role !== 'ADMIN') return 403`; (2) validate `role` against the invite allowlist (reject `MANAGER`/`SUPER_ADMIN`); (3) forbid changing one's own `role`/`isActive`. Factor the allowlist into a shared constant so invite and PATCH cannot drift.

---

## HIGH

### FINDING 1-3 — daetradez Step-10 script copy injected into any persona's prompt
**Severity:** HIGH
**File:** `src/lib/ai-engine.ts:190` (`buildStep10DeepWhyDirective`), invoked at `:3800`, `:5898`
**Description:** A regen directive embeds daetradez's verbatim Step-10 lines as REQUIRED model output — "I respect that bro, I truly do. I hear so many people talk about cars and materialistic stuff…" — plus daetradez-specific forbidden examples ("99% of traders", "call with anthony"). Fed to the LLM for any persona when income-goal is captured but deep-why isn't; not tenant-scoped.
**Exploitability:** A second tenant's model is instructed to emit Dae's exact "cars and materialistic stuff" line verbatim.
**Recommendation:** Source the deep-why MSG/ASK from the persona's own parsed script step (the ask anchor already exists); generic paraphrase if none configured.

### FINDING 1-4 — step-inference map hardcodes daetradez numbering/labels/phrasing
**Severity:** HIGH
**File:** `src/lib/script-step-progression.ts:1352-1425` (`STEP_PATTERN_MAP`) → regen directive at `voice-quality-gate.ts:2032`
**Description:** The step-inference map hardcodes daetradez's 22-step script (labels "Step 13 — Belief Break", patterns `\b99%\s+of\s+traders\b`, `anthony`, `from trading`) as universal; the matched label is injected into the LLM regen directive.
**Exploitability:** The cross-script clamp (`:1491`) only suppresses inference when `scriptMaxStepNumber` is passed AND the other tenant's script has fewer steps. A second tenant with a ≥18-step script (or when the clamp arg is absent) gets daetradez step labels attributed and fed into their regen directive; the `anthony`/`99%` alternates also mis-fire on their content.
**Recommendation:** Derive step numbers/labels from the active persona's own parsed script (`scriptAskAnchors` already exists); remove `anthony`/`99% of traders` literals.

### FINDING 1-5 — detection regexes hardcode daetradez closer/product
**Severity:** HIGH
**File:** `src/lib/script-state-recovery.ts:4830` (`call with (my right hand|anthony)`), `:4850` (`session liquidity`), `:2402` (`session liquidity model`)
**Description:** Step-inference / downsell-detection regexes hardcode `anthony`, `session liquidity`, `whop.com` for every persona.
**Exploitability:** A second tenant whose closer isn't Anthony and whose downsell isn't Session Liquidity has soft-pitch and downsell deliveries mis-classified → silent state-recovery corruption (wrong inferred state, not a direct outbound leak).
**Recommendation:** Parameterize on the persona's configured closer names + downsell product/URL; remove the literals.

### FINDING 7-1 — daetradez's real $497 price leaks into unconfigured tenants' prompts
**Severity:** HIGH
**File:** `src/lib/ai-prompts.ts:2046-2051` (mirror `ai-engine.ts:3334`)
**Description:** The downsell price fallback resolves to the literal `'497'` — daetradez's real price — when no downsell config exists, then substitutes into `{{downsellPrice}}` throughout the master prompt's example copy.
**Evidence:** `const downsellPriceStr = resolveDownsellPrice(...) ?? resolveDownsellPrice(...) ?? '497';`
**Exploitability:** Fires for any persona with no configured downsell price (an unconfigured/partially-onboarded second tenant). The prompt then asserts "the course is $497 one time" — daetradez's price presented as the second tenant's offer. (ProductName fallback is safely generic; only the price leaks.)
**Recommendation:** Resolve to null and conditionally strip the price clause, or gate the downsell example block behind "downsell configured".

### FINDING 6-1 / 2-1 — CRM webhook: cross-tenant lead write behind one shared secret
**Severity:** HIGH (raised from the sweeps' MEDIUM — a shared secret across all tenants + arbitrary `leadId` write is a genuine cross-tenant mutation path, not just theoretical)
**File:** `src/app/api/webhooks/crm/route.ts:11,26,32,62-74`
**Description:** Authenticates with one platform-wide `CRM_WEBHOOK_SECRET`, then resolves the lead from a caller-supplied `leadId` with NO account scope: `prisma.lead.findUnique({ where: { id: leadId } })`, then writes a `CrmOutcome`, forces a stage transition, and sets `revenue`/`closedAt`.
**Exploitability:** Any holder of the shared secret (every tenant's CRM integration uses the same value) can POST an arbitrary `leadId` and mutate ANY other tenant's lead — force `CLOSED_WON`, set arbitrary revenue, contaminate the victim's analytics and stage automation.
**Recommendation:** Per-account CRM secret stored in `IntegrationCredential(accountId,'CRM')`; resolve accountId from the secret and scope `where: { id: leadId, accountId }`; 404 on mismatch.

---

## MEDIUM

- **3-1** `src/lib/distress-classifier.ts:54,59` — module-level classification cache keyed by `sha1(text)` only, no accountId. Low impact (pure function of text, no read endpoint), but namespace the key with accountId.
- **3-2** `src/lib/calendar-adapter.ts:412` — timezone cache keyed by bare LeadConnector `locationId`. Low sensitivity; key by `accountId:locationId`.
- **5-2** `src/app/api/conversations/[id]/traces/route.ts:58` — trace query has no `accountId` filter, relies on the ownership gate 30 lines up. Not exploitable today (gate 404s first) but the sensitive query (`promptSent`, PII) should self-guard. Add the accountId filter for non-operators.
- **5-3** `src/lib/ai-engine.ts:2560` → `distress-detector.ts:263` — the ai-engine `detectDistress` call omits conversationId/accountId, so `DistressShadowLog` PII rows land with `accountId = null`. No reader today; thread the ids through.
- **1-6** `src/lib/script-state-recovery.ts:1155,4830,2402` — `anthony` / `session liquidity model` alternates in call-proposal/downsell detection. Detection-only; drop the tenant literals.
- **1-7** `src/lib/voice-quality-gate.ts:3558` — `anthony('?ll| will)` literal in a "deferred to call" detector; use the `closerNames[]` already threaded into this file.
- **1-8** `src/lib/webhook-processor.ts:4045` — `anthony` alternate in booking-pitch detection; redundant with generic alternates, remove.
- **1-9** `src/lib/ai-engine.ts:6256,6446,6477,9163+` — ~31 hardcoded "bro"-voice deterministic fallback strings assume Dae's casual tone + the trading vertical. A formal-brand or non-trading tenant ships Dae's slang. Move to persona-configurable templates.
- **7-2** `src/lib/persona-breakdown-prompts.ts:133` — the script-breakdown few-shot example uses daetradez's real "Session Liquidity Breakdown" / "session liquidity model" terminology; biases any new tenant's script parse. Replace with vertical-neutral placeholder.
- **6-2** `src/lib/typeform-webhook.ts:173` — Typeform webhook falls back to a global `TYPEFORM_WEBHOOK_SECRET` and takes `accountId` from the query string; a secret-holder can inject a lead into any account. Require a per-account credential; drop the env fallback.
- **2-2** `src/lib/script-state-recovery.ts:5165,6507,6579` — `prepareScriptState` / `scanForPassiveCapitalQualification` / `persistPassiveCapital` load & mutate a conversation by bare `conversationId` without cross-checking the `accountId` they also hold. Not exploitable today (all callers pass account-scoped pairs); add `where: { id: conversationId, lead: { accountId } }` as a permanent invariant.

---

## AREAS AUDITED CLEAN (no findings)

- **Class 4 (operator/dashboard access control):** ~140 API routes enumerated; all either `auth.accountId`-scoped via the guard-then-mutate idiom or intentional platform-operator routes (`requireSuperAdmin`/`requirePlatformAdmin`). No route accepts an unscoped body/query `accountId`; no `[id]` route mutates before an account-filtered ownership fetch. Full route coverage list retained in the audit working notes.
- **Class 8 (export/reporting):** no CSV/export/download endpoints exist; all 20 analytics routes scope every aggregate by `auth.accountId`. No cross-account totals.
- **Meta webhooks (Class 6):** resolve tenant from the page/IG id against `IntegrationCredential` with NO default-tenant fallback; unknown page id is rejected + logged loudly. No input can steer a write to another tenant.
- **Query layer (Class 2):** no raw SQL anywhere; `Conversation.personaId` is `NOT NULL`; all `[id]` routes guard-then-mutate; all 12 cron jobs derive accountId per-row.
- **Prompt assembly / caches (Class 3):** few-shot/training retrieval is `{accountId, personaId}`-scoped; the judge-branch cache is request-local; no credential cache; no path where one conversation's history/CDP enters another's prompt.

---

## THE NEW-ACCOUNT INGESTION INCIDENT (Class 6 diagnosis)

The webhook audit resolves last night's "new test account DMs never appeared" question: an unknown **sender** to a known page correctly **creates a lead** (no sender allowlist) — so that's not the cause. The likely cause is a known page whose account holds a **META credential but no active INSTAGRAM credential**: the gate at `instagram/route.ts:251` does a log-only `console.log(... skipping)` + `continue` and the DM is **silently dropped**. This is both the incident's answer and a finding: **elevate that skip-gate (and the sibling META-missing gate) to a loud, alertable `console.error`** so a missing/inactive IG credential on an otherwise-known page is operator-visible instead of a silent drop.

---

## MAPPING TO THE ORIGINAL FIVE (May 2026)

The original document is unretrievable, so this maps against what's identifiable from code/commit history:

- **Phase 1 — `Conversation.personaId NOT NULL`:** reported merged-pending in May → **CONFIRMED LANDED** (`schema.prisma:1134`, non-nullable, `onDelete: Restrict`). Closed.
- **The "Anthony" hardcoded-fallback class** (original trigger): **STILL OPEN and newly enumerated** — findings 1-1, 1-2, 1-3, 1-4, 1-5, 1-6, 1-7, 1-8. The prior de-hardcoding pass fixed the closer-name *substitution* in prompts (`closerName || 'the closer'` — verified clean) but missed the deterministic fallback *messages* and detection *regexes*, where the literals still live.
- **Newly discovered vs original scope** (didn't exist in May): 5-1 (team-role escalation on a route pattern built since), the CRM/Typeform shared-secret webhooks, and the Class-3/5 cache + shadow-log hygiene items — all in infrastructure added this sprint or adjacent to it.

Two of the eight classes (4, 8) are clean; the query layer and Meta ingestion are clean. The open surface is concentrated, enumerable, and fixable by parameterization + per-account secrets — no re-architecture identified.
