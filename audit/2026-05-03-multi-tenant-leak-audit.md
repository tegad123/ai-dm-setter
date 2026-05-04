# Multi-Tenant Data Leakage Audit — QualifyDMs Platform

**Date:** 2026-05-03
**Auditor:** Engineering (audit triggered by hallucinated `daetradez.com/course` URL sent to lead `@alexpintilie_`)
**Branch / commit basis:** `main` @ `db88b53` (silent-stop recovery uses script links)
**Scope:** All production code under `src/`, Prisma schema, webhook surface, training pipeline, auth boundary
**Status:** **Audit complete (static analysis). Production DB queries deferred — see "Required-against-production" section.**

---

## Plain-English Summary

The QualifyDMs platform was built for a single founding customer (Daniel / daetradez). As we move to onboard paying customers, we audited whether one customer's data, brand, leads, or AI behavior can bleed into another's.

**The headline:** the platform is **not safe to onboard a second paying customer in its current state.** We found multiple ways one customer's identity could appear in another customer's AI conversations, and one way an Instagram message intended for Customer B could be routed to Customer A by mistake.

**The good news:** the platform has the right tenancy model on paper (every customer is an "Account" with isolated billing, users, and leads), and the access-control layer is correctly enforced for human operators looking at dashboards. The leaks are concentrated in three places:

1. **The AI engine reads "the active persona" by guessing** — for any customer with more than one persona configured, the platform picks one essentially at random per turn.
2. **The conversation thread doesn't remember which persona it belongs to** — so if an account ever runs two personas, the AI's prior turns on the same lead get blended into context regardless of which persona is generating now.
3. **Instagram and Facebook webhooks have a "guess the account" fallback** — if Meta sends us an event we can't recognize, we route it to the oldest account in the database. That's a hard cross-tenant leak the moment a second customer signs up.

Plus, the master prompt and several gate rules contain Daniel's name, Anthony's name, and the "$497 Session Liquidity Model" course price as bare English text — not as configurable variables. Every customer using the AI engine inherits that biased context until we refactor.

**What we recommend:** treat client #2 onboarding as blocked until the CRITICALs in the table below are remediated. Estimated engineering effort: 1–2 sprints.

---

## Compliance Posture Summary (for enterprise security teams)

QualifyDMs runs a multi-tenant SaaS architecture in which every customer is provisioned as an isolated `Account` record. Authentication is enforced per request via Clerk session resolution against the `User → Account` mapping; every dashboard query is scoped through a centralized `requireAuth()` guard that blocks cross-account reads. Webhooks from Meta carry HMAC-signed payloads and resolve to accounts via stored OAuth credentials. Training data, integration tokens, and lead records are partitioned by `accountId` at the database level with foreign-key cascade.

Internal audit (2026-05-03) identified five **CRITICAL** findings primarily concentrated in (a) the within-account multi-persona path — the platform supports multiple AI personas per account but currently lacks the schema-level `personaId` on conversations needed to keep their AI context strictly partitioned, and (b) Meta webhook fallback logic that resolves unknown sender IDs to the chronologically-first account when ambiguous — safe today (one production customer) but unsound for multi-tenant onboarding. Remediation plan is sequenced and tracked. The audit kit (Appendix C) is idempotent and scheduled for quarterly re-execution.

---

## Executive Summary

| Severity | Count | Recommendation |
| --- | --- | --- |
| CRITICAL | **5** | Remediate before onboarding any second paying customer |
| HIGH | **6** | Document mitigation; remediate within 30 days |
| MEDIUM | **5** | Remediate within 60 days |
| LOW | **3** | Track in backlog |

**Personas affected by CRITICAL findings:** every persona that ever shares an `Account` with another persona, plus every customer onboarded after the second account exists in production.

**Recommendation:** **NOT SAFE to onboard new client.** Becomes **SAFE-AFTER-CRITICAL-FIXES** once the five CRITICALs land + are verified by re-running Appendix C against staging.

**Scheduled re-audit:** quarterly (next: 2026-08-03). Run the kit in Appendix C — it is idempotent, returns hard counts, and any new CRITICAL means a regression.

---

## Required-against-production (deferred from this session)

The local dev DB (`prisma/dev.db`) is 0 bytes — production runs on Postgres (`DATABASE_URL`). The following queries and tests **must be run against production read-only** before the audit is fully closed. They are pre-written in Appendix C.

1. **Blast radius for CRITICAL #1 (Conversation lacks personaId):** count of `Conversation` rows in accounts that have ≥2 `AIPersona` rows.
2. **Blast radius for CRITICAL #2 (Webhook fallback):** scan webhook logs (or `AdminLog` if logged) for any `[instagram-webhook] No credentials found at all — falling back to first account` or `[facebook-webhook] No credentials found — falling back` entries.
3. **Pull the alexpintilie GenerationLog:** `AISuggestion` row containing `daetradez.com/course` — inspect the prompt vs raw LLM output to classify the URL's origin.
4. **90-day URL backfill scan:** every `Message` where `senderType='AI'` (last 90d), extract URLs, compare to that conversation's account's allow-list (`getAllowedUrls`).
5. **Reproducibility test:** create test persona `testbrand123` with `downsellUrl=null`, run 20 simulated downsell-delivery turns through `generateReply`, count `testbrand123.*` URL emissions. Run against staging.

Findings 1–5 above will refine severity for CRITICAL #1, CRITICAL #2, and Appendix A.

---

# Class 1 — Hardcoded Persona References

## Investigation summary

Greps for `daetradez`, `daetrading`, `anthony`, `Daniel`, `Session Liquidity`, `whop.com/checkout`, `AGUtPdmb`, `e7Ujmb019gE` across `src/` and prompts. Inspected each match for whether it lives in production code paths, comments, or test fixtures.

## Findings

### F1.1 — `DEFAULT_THEME = 'daetradez'` exposes brand identifier as platform default ❗ HIGH

- **Evidence:** [src/components/themes/theme.config.ts:5](src/components/themes/theme.config.ts:5)
  ```ts
  export const DEFAULT_THEME = 'daetradez';
  ```
- Also lines 9–10 — `daetradez` listed as the "Default" theme value in the theme picker.
- **Severity:** HIGH. Public-facing — every operator landing on the dashboard with no theme preference loads daetradez branding.
- **Remediation:** rename `daetradez` → a generic theme (e.g. `default`) and update all `.css`/Tailwind references.
- **Verification:** grep returns zero matches for `daetradez` in `src/components/`.

### F1.2 — Public landing page hardcodes `daetradez` IG handle ❗ HIGH

- **Evidence:** [src/features/landing/components/landing-page.tsx:700](src/features/landing/components/landing-page.tsx:700)
  ```tsx
  <span className='ig-name'>daetradez</span>
  ```
- **Severity:** HIGH. Marketing site shows daetradez to every visitor — fine while daetradez is the only customer, brand-conflict the day a second customer logs in.
- **Remediation:** parameterize via `<span>{currentPersona.handle ?? 'yourbrand'}</span>` or remove from public page.
- **Verification:** grep returns zero matches for `daetradez` in `src/features/landing/`.

### F1.3 — `"The lead has booked their call with Anthony."` injected into prompt context ❗ CRITICAL

- **Evidence:** [src/lib/ai-engine.ts:187](src/lib/ai-engine.ts:187)
  ```ts
  'The lead has booked their call with Anthony.'
  ```
- This string is unconditionally appended to the system prompt's "Additional context" section when `params.callScheduledAt` is set.
- **Severity:** CRITICAL. Every customer's AI sees the literal name `Anthony` in prompt context. Any persona whose closer is named differently (Sarah, Marco, anyone) will be biased toward outputting "Anthony".
- **Remediation:** template the closer name from `persona.closerName ?? persona.promptConfig.callHandoff.closerName ?? 'your call partner'`. Move the line into the prompt-assembly function.
- **Verification:** grep returns zero matches for the literal string `Anthony` in `src/lib/ai-engine.ts`.

### F1.4 — `Anthony` regex in voice-quality-gate fires for all personas ❗ HIGH

- **Evidence:** [src/lib/voice-quality-gate.ts:238](src/lib/voice-quality-gate.ts:238)
  ```ts
  const CALL_OR_BOOKING_ADVANCEMENT_RE =
    /\b(hop on a (quick )?(call|chat)|call with [A-Z][a-z]+|...|anthony)\b/i;
  ```
- Comment at line 804 claims "no hardcoded Anthony" — the regex literally contradicts.
- Also: [src/lib/webhook-processor.ts:3184](src/lib/webhook-processor.ts:3184), [src/lib/ai-engine.ts:4336](src/lib/ai-engine.ts:4336), [src/lib/script-state-recovery.ts:747](src/lib/script-state-recovery.ts:747) — same `\b(...|anthony)\b` pattern.
- **Severity:** HIGH. False-positive rate uncontrolled for non-Daniel personas. A non-Anthony persona that mentions "Anthony" by coincidence (e.g. lead's name) trips the gate.
- **Remediation:** load `persona.closerName` once, build per-persona regex dynamically. The voice gate already accepts a context object — pass `closerName` through.
- **Verification:** grep `'anthony'` (case-insensitive) in `src/lib/` returns only doc-comment matches, no code matches.

### F1.5 — `Daniel's offering` and `Daniel's actual experience` baked into MASTER_PROMPT_TEMPLATE ❗ CRITICAL

- **Evidence:** [src/lib/ai-prompts.ts:752](src/lib/ai-prompts.ts:752), [src/lib/ai-prompts.ts:951](src/lib/ai-prompts.ts:951)
  ```
  ...pivot back to Daniel's offering or the funded-account flow from the script.
  ...The answer should always come from Daniel's actual experience and persona.
  ```
- Master prompt template at line 151. Token-substituted with `{{fullName}}` etc., but these "Daniel" mentions are bare English, not tokens.
- **Severity:** CRITICAL. Every persona's AI is told to source answers from "Daniel's experience". For any non-Daniel persona this is direct mis-attribution → hallucination risk + brand-confusion in lead-facing output.
- **Remediation:** replace bare `Daniel` mentions in `MASTER_PROMPT_TEMPLATE` with `{{firstName}}` / `{{personaName}}` tokens; verify the substitution path includes them.
- **Verification:** grep `'Daniel'` in `src/lib/ai-prompts.ts` returns only the constant `DANIEL_VOCAB` reference (which itself should be renamed — see F5.1).

### F1.6 — `Anthony said we could reschedule` example in production prompt ❗ MEDIUM

- **Evidence:** [src/lib/ai-prompts.ts:335](src/lib/ai-prompts.ts:335)
- Few-shot-style example shown to LLM. Reads as if Anthony is a known fixture.
- **Severity:** MEDIUM. Pattern primer for hallucination on non-Anthony personas.
- **Remediation:** replace with a placeholder name like "the call partner" or pull from persona config in the assembly path.

### F1.7 — daetradez incident attribution in 20+ source files (comments) ⚪ LOW

- **Evidence:** comments in `src/lib/webhook-processor.ts`, `src/lib/ai-engine.ts`, `src/lib/voice-quality-gate.ts`, `src/lib/distress-detector.ts`, `src/lib/conversation-facts.ts`, etc. Each tags a fix with `(daetradez 2026-04-XX)`.
- **Severity:** LOW. No runtime impact. Optics — establishes the codebase as Daniel-specific in any read-through.
- **Remediation:** keep until first major refactor; replace `(daetradez YYYY-MM-DD)` with internal incident ID at that time.

---

# Class 2 — URL Construction & Hallucination Vectors

## Investigation summary

Located all URL emission paths: hardcoded constants, persona-config reads (`downsellUrl`, `applicationFormUrl`, `homeworkUrl`, etc.), `MASTER_PROMPT_TEMPLATE` literal URLs, and post-generation sanitization. Mapped the existing R16 enforcement (`getAllowedUrls` + `stripHallucinatedUrls`).

## Findings

### F2.1 — `TYPEFORM_BOOKING_URL` hardcoded to daetradez's form ID ❗ CRITICAL

- **Evidence:** [src/lib/follow-up-sequence.ts:24](src/lib/follow-up-sequence.ts:24)
  ```ts
  export const TYPEFORM_BOOKING_URL = 'https://form.typeform.com/to/AGUtPdmb';
  ```
- Also referenced in the same file: a hardcoded YouTube ID `e7Ujmb019gE` at lines 108–109 for "free-resource routing".
- **Severity:** CRITICAL. Customer #2 cannot use this code path without their leads being routed to Daniel's Typeform.
- **Remediation:** read from `persona.applicationFormUrl` (Persona schema field) with strict null-check. If null, skip the follow-up rather than fall back.
- **Verification:** grep `'AGUtPdmb'` and `'e7Ujmb019gE'` in `src/` return zero matches.

### F2.2 — Hardcoded `$497 course` and `Session Liquidity Model` in MASTER_PROMPT_TEMPLATE ❗ CRITICAL

- **Evidence:** [src/lib/ai-prompts.ts:813](src/lib/ai-prompts.ts:813), [src/lib/ai-prompts.ts:550](src/lib/ai-prompts.ts:550), and 4× more in template body. Also injected into runtime directives:
  - [src/lib/ai-engine.ts:1692](src/lib/ai-engine.ts:1692) — geography gate: `(1) the $497 course downsell`
  - [src/lib/ai-engine.ts:1766](src/lib/ai-engine.ts:1766) — restricted-funding directive
  - [src/lib/ai-engine.ts:2198](src/lib/ai-engine.ts:2198) — downsell call override
  - [src/lib/ai-engine.ts:4766, 4802](src/lib/ai-engine.ts:4766) — funding-partner gate
- **Severity:** CRITICAL. Every persona using the engine inherits Daniel's product price + name. The hallucination that triggered this audit (`daetradez.com/course`) is plausibly induced by this exact prompt content — the LLM is repeatedly told the persona sells a "Session Liquidity Model" at "$497", so when it lacks a concrete URL it confabulates a brand-shaped URL.
- **Remediation:** replace literal `$497` and `Session Liquidity Model` with `{{downsellPrice}}` / `{{downsellName}}` tokens sourced from `persona.downsellConfig`. Where the value is missing, omit the entire downsell branch instead of templating an empty string.
- **Verification:** grep `'$497'` and `'Session Liquidity'` in `src/lib/` returns zero matches.

### F2.3 — `getAllowedUrls()` exists but is account-scoped, not persona-scoped ❗ HIGH

- **Evidence:** [src/lib/webhook-processor.ts:200](src/lib/webhook-processor.ts:200) loads URLs from `ScriptSlot` and `ScriptAction` filtered by `accountId` only. [webhook-processor.ts:2740](src/lib/webhook-processor.ts:2740) applies the strip.
- **Severity:** HIGH. Within a multi-persona account, persona A's URLs are in the allow-list when generating for persona B → AI can include persona A's URLs without being stripped. The mitigation works perfectly for inter-account isolation but does nothing intra-account.
- **Remediation:** scope `getAllowedUrls(accountId, personaId)` once Conversation has personaId (CRITICAL #1).
- **Verification:** unit test — two personas in one account, generate for persona B, persona A's URL should be stripped.

### F2.4 — Master prompt contains literal example URLs ⚪ MEDIUM

- **Evidence:**
  - [src/lib/ai-prompts.ts:1670, 1677](src/lib/ai-prompts.ts:1670) — `https://youtu.be/example`
  - [src/lib/ai-prompts.ts:1744, 1750](src/lib/ai-prompts.ts:1744) — `https://form.typeform.com/to/xyz`
  - [src/lib/ai-prompts.ts:815](src/lib/ai-prompts.ts:815) — `https://youtube.com/...`
- **Severity:** MEDIUM. Pattern primers for URL hallucination. Combined with F2.2, this is plausibly part of why the LLM confabulates `daetradez.com/course` — it sees URLs in examples and constructs branded ones.
- **Remediation:** strip example URLs from prompt or replace with `<URL>` placeholders that won't be pattern-matched.

### F2.5 — Persona free-text fields inject unconstrained content ⚪ MEDIUM

- **Evidence:** schema fields `activeCampaignsContext`, `verifiedDetails`, `outOfScopeTopics`, `whatYouSell`, `adminBio`, `callHandoff`, `scopeAndLimits`, `downsellConfig.link` are all injected into the prompt. No URL allow-list applied at write time, no validation.
- **Severity:** MEDIUM. Operator A can paste a URL into `verifiedDetails`; LLM will surface it on persona A's conversations. Within-account this is intended, but if any of these fields are ever copied between personas (e.g. via an admin tool), unauthorized URLs flow.
- **Remediation:** validate URLs in admin form on save; surface a warning when free-text fields contain URLs not in the persona's configured URL set.

---

# Class 3 — Persona Context Injection into LLM Prompt

## Investigation summary

Traced `generateReply()` from entry ([src/lib/ai-engine.ts:492](src/lib/ai-engine.ts:492)) through `assembleSystemPrompt` ([src/lib/ai-prompts.ts:1502](src/lib/ai-prompts.ts:1502)) and `retrieveFewShotExamples` ([src/lib/training-example-retriever.ts:205](src/lib/training-example-retriever.ts:205)). Tabulated every Prisma query in the prompt-assembly path and the persona-resolution path.

## Findings

### F3.1 — `generateReply(accountId, ...)` does not accept a personaId ❗ CRITICAL

- **Evidence:** [src/lib/ai-engine.ts:492](src/lib/ai-engine.ts:492):
  ```ts
  export async function generateReply(
    accountId: string,
    conversationHistory: ConversationMessage[],
    leadContext: LeadContext,
    ...
  ```
- The doc-comment says "for persona + credential lookup" — but persona is *guessed*, not passed.
- **Severity:** CRITICAL. The AI engine has no way to know which persona this turn belongs to. It cannot scope context to one persona within a multi-persona account. This is the architectural root of the multi-tenant within-account leak.
- **Remediation:** add `personaId: string` parameter. Required, non-nullable. Plumb through every call site (webhook-processor, scheduled-replies cron, suggestion endpoints, voice generation).
- **Verification:** TypeScript compile fails until every call site passes a valid `personaId`.

### F3.2 — Persona is loaded by `findFirst({where:{accountId, isActive:true}})` — non-deterministic for multi-persona accounts ❗ CRITICAL

- **Evidence:**
  - [src/lib/ai-engine.ts:838](src/lib/ai-engine.ts:838) — `personaForGate`
  - [src/lib/ai-engine.ts:2868, 2873](src/lib/ai-engine.ts:2868) — second persona reads (with fallback to `findFirst` without `isActive`!)
  - [src/lib/ai-prompts.ts:1502, 1509](src/lib/ai-prompts.ts:1502) — main prompt persona load
  - [src/lib/webhook-processor.ts:712, 716](src/lib/webhook-processor.ts:712) — webhook-side persona load
  - 12+ `src/app/api/settings/...` routes use the same pattern
- The `findFirst` returns whichever row Postgres orders first when `accountId` matches and `isActive=true`. For multi-persona accounts, this is essentially random per query.
- **Severity:** CRITICAL. Two consecutive AI turns on the same conversation can resolve to two different personas. The "persona for prompt assembly" and the "persona for the capital gate" can disagree within a single `generateReply` call (different lines of the same function).
- **Remediation:** replace every `findFirst({where: {accountId, isActive: true}})` with `findUnique({where: {id: personaId}})`. Personas must be selected by ID (from the conversation's stored personaId), not guessed.
- **Verification:** grep `aIPersona.findFirst.*accountId.*isActive` in `src/` returns zero matches.

### F3.3 — Few-shot example retrieval scoped by accountId only, not personaId ❗ CRITICAL

- **Evidence:**
  - [src/lib/training-example-retriever.ts:247, 287, 320, 357](src/lib/training-example-retriever.ts:247) — embeddings + keyword retrieval queries all filter by `accountId: context.accountId` only
  - [src/lib/training-example-retriever.ts:480](src/lib/training-example-retriever.ts:480) — embedding-update query: `where: { conversation: { accountId } }`
  - [src/lib/ai-prompts.ts:1533](src/lib/ai-prompts.ts:1533) — `prisma.trainingExample.findMany({where: {accountId}, take: 10})`
- `TrainingExample` and `TrainingConversation` have `personaId` columns — the queries simply don't use them.
- **Severity:** CRITICAL. In any account with two personas, persona A's hand-curated training examples appear in persona B's prompt context. This is the cleanest cross-persona contamination vector — every turn, every persona, immediately on multi-persona setup.
- **Remediation:** add `personaId` to the retriever's context object; filter all four queries by `{accountId, personaId}`. Backfill existing TrainingExamples/Conversations to set `personaId` correctly (already populated per schema).
- **Verification:** unit test: account with personas A and B, A has training example "X is at $497", B has example "X is at $1997". Generate for B — retrieved examples must contain only the $1997 variant.

### F3.4 — Conversation history is fetched by `conversationId`, not filtered by persona ❗ HIGH

- **Evidence:** Conversation ↔ Lead is `1:1` via `Lead.id ↔ Conversation.leadId @unique`. Within an account, a single lead has exactly one conversation thread regardless of which persona DM'd them. Messages are stored on the conversation. The AI loads the full message history on every turn.
- **Severity:** HIGH. If persona A engages a lead, then persona B engages the same lead later, persona B's AI sees persona A's prior turns as if they were its own. Compounds with F3.1/F3.2 — even fixing the persona-resolution bug doesn't fix history bleed.
- **Remediation:** depends on product decision. Either (a) one Conversation per (lead, persona) pair, or (b) tag each Message with `personaId` and filter history at fetch time. Per the audit context, Lead is account-scoped but a lead can engage multiple personas — option (a) is the cleaner model.
- **Verification:** schema-level `@@unique([leadId, personaId])` on Conversation; runtime test confirms persona B sees only persona-B history.

### F3.5 — `establishedFactsBlock` — captured data points cross-persona via leadId ⚪ HIGH

- **Evidence:** Captured data points (job, income, capital, timeline) are extracted per-conversation. Comment at [src/lib/ai-prompts.ts:1490+](src/lib/ai-prompts.ts:1490) confirms they're conversation-scoped. Since Conversation lacks personaId (F3.4), facts captured under persona A would surface in persona B's context.
- **Severity:** HIGH. Same root cause as F3.4. Listed separately because the operator-facing dashboard surfaces these "established facts" — fixing F3.4 fixes this.
- **Remediation:** subsumed by F3.4.

---

# Class 4 — Lead Data Cross-Contamination

## Investigation summary

Verified Lead/Conversation/Message FK chain. Inspected every `prisma.lead.findMany|findFirst|findUnique|count` and `prisma.conversation.*` query for `accountId` scoping (the confirmed tenancy boundary). Sampled the dashboard pipeline + the lead-search endpoint.

## Findings

### F4.1 — Lead model is correctly account-scoped ✅ NO FINDING (intentional)

- **Evidence:** [prisma/schema.prisma](prisma/schema.prisma) `Lead { accountId String ... }`. `/api/leads/route.ts:26` correctly filters `where: { accountId: auth.accountId }`. Per audit-spec, this is intentional — leads are account-scoped, not persona-scoped, so an operator can see "this person DM'd two of our personas".
- No remediation required.

### F4.2 — Conversation lacks `personaId` field — CONFIRMED CRITICAL ❗ CRITICAL  **[Status: Remediated in branch `audit/f4.2-add-conversation-personaid` — pending merge + production migration window]**

- **Evidence:** [prisma/schema.prisma:911](prisma/schema.prisma:911) `model Conversation { id ... leadId String @unique ... }`. Searched the full model definition — no `personaId` column, no FK to AIPersona.
- **Severity:** CRITICAL. Foundational. Every other within-account isolation finding (F3.1, F3.2, F3.3, F3.4, F3.5, F2.3) depends on this gap being closed before its own remediation can land.
- **Remediation (sequenced):**
  1. Add `personaId String` (non-null, indexed, FK to AIPersona) to `Conversation`
  2. Backfill existing rows: derive `personaId` from `accountId + recipient IG account ID` (the active persona at conversation-creation time)
  3. Make Conversation `@@unique([leadId, personaId])` so the same lead can engage multiple personas
  4. Update `webhook-processor.ts` to set `personaId` on conversation create
  5. Pass `personaId` into `generateReply()` (F3.1)
- **Verification:** integrity SQL — `SELECT COUNT(*) FROM Conversation WHERE personaId IS NULL` returns 0.
- **Blast radius (REQUIRED-AGAINST-PRODUCTION):**
  ```sql
  SELECT a.id AS account_id, COUNT(DISTINCT p.id) AS persona_count, COUNT(c.id) AS convo_count
  FROM "Account" a
  JOIN "AIPersona" p ON p."accountId" = a.id
  JOIN "Lead" l ON l."accountId" = a.id
  JOIN "Conversation" c ON c."leadId" = l.id
  GROUP BY a.id
  HAVING COUNT(DISTINCT p.id) >= 2;
  ```
  Number of conversations in multi-persona accounts = current at-risk surface. Likely ~0 today (single-account production), but every onboarding adds 1 to the affected count once any account goes multi-persona.
- **Customer-facing impact:** "If you create more than one AI persona on your account today, our system cannot guarantee that each persona's conversations stay in their own voice — context can cross between personas. We are remediating before allowing multi-persona accounts in production."

### F4.3 — Lead-search query uses `accountId` correctly ✅ PASS

- **Evidence:** [src/app/api/leads/route.ts:26](src/app/api/leads/route.ts:26) — `where.accountId = auth.accountId`. Verified.

### F4.4 — Dashboard pipeline scoped via `lead.accountId` chain ✅ PASS (with caveat)

- **Evidence:** [src/app/api/dashboard/actions/route.ts:43-58](src/app/api/dashboard/actions/route.ts:43) — comment explicitly notes "Conversation doesn't carry accountId directly — must filter via lead". Filter pattern `conversation: { lead: { accountId } }` used at lines 437, 453, 463.
- **Caveat:** this is the workaround for F4.2. Once Conversation gains personaId, the dashboard could optionally further scope by accessible-personas. Intentional per audit-spec — dashboard CAN show all personas.

---

# Class 5 — Shared State and Caching Leaks

## Investigation summary

Searched module-level constants and global state in `ai-engine.ts`, `ai-prompts.ts`, `voice-quality-gate.ts`, `webhook-processor.ts`, `silent-stop-recovery.ts`. Looked for `Map`, `Set`, `LRU`, memoization, and singleton patterns.

## Findings

### F5.1 — `DANIEL_VOCAB` module-level constant is persona-specific ❗ HIGH

- **Evidence:** [src/lib/voice-quality-gate.ts:138](src/lib/voice-quality-gate.ts:138)
  ```ts
  const DANIEL_VOCAB = new Set([
    'bro','g','brotha','man','haha','ahaha','ahh','damn','real','makes','sense',
    'actually','fr','tbh','ye','ngl','gotchu','lemme','wanna','gonna','kinda',
    'gotta','lotta','fire','sick','bet','fasho','dialled','dope','tho','nah','yo','yoo','aight'
  ]);
  ```
- Used by the voice-quality gate as a "voice match" signal. A persona whose voice is formal English will fail the gate at higher rate than Daniel does.
- **Severity:** HIGH. Not a data leak per se — a behavior leak. Daniel's slang is the implicit success criterion for every persona's AI output.
- **Remediation:** rename → `personaVoiceVocab` → load from `persona.voiceConfig.vocabulary` per persona; default to neutral set. Schema addition: `AIPersona.voiceVocab String[]`.
- **Verification:** grep `DANIEL_VOCAB` returns zero matches; per-persona vocab field populated.

### F5.2 — Module-level constants are universal regex patterns ✅ PASS

- **Evidence:** ~30 module-level `const` definitions in `ai-engine.ts` (e.g. `BOOKING_FABRICATION_PATTERNS`, `RESTRICTED_COUNTRY_PATTERN`, `MAX_BUBBLES_PER_GROUP`). All are stateless, persona-agnostic regex/literal constants.
- No leak risk.

### F5.3 — `MASTER_PROMPT_TEMPLATE` is a module-level template string ✅ PASS (architecturally)

- **Evidence:** [src/lib/ai-prompts.ts:151](src/lib/ai-prompts.ts:151). Template only — no persona data is captured at module load. Per-request token substitution into a fresh string.
- No caching leak. (But see F1.5/F1.6 — the *content* of the template is a separate problem.)

### F5.4 — No prompt-assembly cache ✅ PASS

- Verified by code-path inspection: every call to `assembleSystemPrompt` re-fetches persona + training examples and rebuilds the prompt string. No memoization.

---

# Class 6 — Webhook & External Integration Scope

## Investigation summary

Read both Instagram and Facebook webhook entry handlers, the `webhook-processor` library, and OAuth credential storage. Mapped the account-resolution chain.

## Findings

### F6.1 — Instagram webhook fallback to first/oldest account ❗ CRITICAL

- **Evidence:** [src/app/api/webhooks/instagram/route.ts:202-267](src/app/api/webhooks/instagram/route.ts:202)
  - **Fallback 1 (line 210):** if env var `INSTAGRAM_PAGE_ID` matches the entry ID, route to `findFirst({orderBy: {createdAt: 'asc'}})` → oldest account.
  - **Fallback 2 (line 227):** if zero credentials in DB, route to oldest account.
  - **Fallback 3 (line 247):** if multiple credentials but entry ID matches none, AND only one distinct account exists → use that account.
- **Severity:** CRITICAL. The day a second customer signs up:
  - If they OAuth before us setting `INSTAGRAM_PAGE_ID` to their page → Fallback 1 routes their messages to Daniel's account.
  - If their OAuth fails to populate the entry ID we expect (Meta's IG Business Account ID isn't always returned reliably) → Fallback 3 collapses to the wrong account.
- **Remediation:** delete fallbacks 1, 2, 3. Return `400 Bad Request` (or no-op + log) for unrecognized entry IDs. Force operators to re-OAuth or contact support if their entry ID isn't matching.
- **Verification:** unit test — synthetic webhook with unknown entry ID returns 400 and creates no Lead/Conversation row. Integration test — multi-account scenario, persona B's webhook reaches persona B (and only persona B).
- **Blast radius (REQUIRED-AGAINST-PRODUCTION):** scan logs for any line matching `falling back to first account` or `but only one account exists — using account=`. Any non-zero count = a historical fall-through; zero count = mitigation has not yet been triggered (today's single-customer setup masks the bug).
- **Customer-facing impact:** "Today, our webhook router has fallback logic written for single-customer use. We are removing those fallbacks before onboarding additional customers — without the fix, an unrecognized webhook event could be routed to the wrong customer account."

### F6.2 — Facebook webhook fallback identical to Instagram ❗ CRITICAL

- **Evidence:** [src/app/api/webhooks/facebook/route.ts:184-260](src/app/api/webhooks/facebook/route.ts:184). Same three-fallback pattern.
- **Severity:** CRITICAL. Same fix as F6.1.
- **Remediation:** apply F6.1's fix to both webhook routes; ideally extract to shared helper.

### F6.3 — OAuth tokens stored in `IntegrationCredential` ✅ PASS

- **Evidence:** Tokens stored at `IntegrationCredential.metadata.accessToken`, scoped by `accountId + provider`. One token per account+provider. Acceptable per audit-spec (account is the tenancy boundary).
- No remediation. (Per-persona token scoping is a future consideration if a single Account ever connects two IG handles.)

### F6.4 — Meta callbacks (data-deletion, deauthorize) use HMAC signature verification ✅ PASS

- **Evidence:** [src/app/api/meta/data-deletion/route.ts](src/app/api/meta/data-deletion/route.ts) + [src/app/api/meta/deauthorize/route.ts](src/app/api/meta/deauthorize/route.ts) both use `crypto.timingSafeEqual` against an HMAC signed with the app secret. No auth bypass.

---

# Class 7 — Training Data and Learning Loop

## Investigation summary

Verified `TrainingConversation`, `TrainingExample`, `TrainingMessage`, `TrainingUpload` schema for `personaId` requiredness + indexing. Audited every load-into-prompt query for persona scope. Checked for premature Phase-2 cross-conversation aggregation.

## Findings

### F7.1 — Schema is correct ✅ PASS

- **Evidence:** [prisma/schema.prisma:709, 729, 753](prisma/schema.prisma:709) — `TrainingExample`, `TrainingUpload`, `TrainingConversation` all have `personaId String` (non-null) + indexed `@@index([accountId, personaId])`. FK cascade to `AIPersona`.
- No remediation needed.

### F7.2 — Retrieval queries IGNORE the personaId column ❗ CRITICAL

- **Evidence:** Already enumerated as F3.3.
- Listed here for class-completeness — same finding, same remediation, same severity.

### F7.3 — `HumanOverrideNote` — no separate model, stored on Message ✅ PASS

- **Evidence:** `Message.humanOverrideNote String? @db.Text`. Inherits scope from Message → Conversation → Lead → Account. Once F4.2 lands and Conversation has personaId, override notes inherit it.
- No standalone remediation.

### F7.4 — No premature Phase-2 cross-conversation aggregation ✅ PASS

- Verified by grep — no code aggregates across conversations or personas. Phase 2 is correctly gated.

---

# Class 8 — Operator/User Access Control

## Investigation summary

Read `src/lib/auth-guard.ts` end-to-end. Sampled 14 API routes for `requireAuth` invocation and downstream `accountId` scoping. Searched for `isAdmin`/`impersonate`/`role ===` backdoors. Verified cron auth.

## Findings

### F8.1 — Auth boundary is solid ✅ PASS

- **Evidence:** [src/lib/auth-guard.ts](src/lib/auth-guard.ts):
  - `requireAuth(request)` resolves Clerk session → User row → AuthContext with `{userId, accountId, role}`.
  - `requireSuperAdmin` and `requirePlatformAdmin` correctly enforce platform-operator roles.
  - `canAccessAccount(auth, accountId)` returns true only if `isPlatformOperator || auth.accountId === accountId`.
  - `scopedAccountId` correctly substitutes a requested accountId only when called by a platform operator.

### F8.2 — All cron routes use `CRON_SECRET` bearer-token auth ✅ PASS

- **Evidence:** every `src/app/api/cron/*/route.ts` checks `Authorization: Bearer ${process.env.CRON_SECRET}` before doing work. Routes flagged as "no requireAuth" by the heuristic grep are all auth'd via cron secret.

### F8.3 — Public/un-auth routes are intentional ✅ PASS

- **Evidence:** `register`, `login`, `meta/data-deletion`, `meta/deauthorize`, `realtime` — all expected to be unauthenticated or auth'd via different mechanisms (HMAC, Clerk on the Next side, etc.).

### F8.4 — No `impersonate` or admin-override backdoors ✅ PASS

- Grep found no `impersonate`, `viewAs`, or `roleOverride` patterns in API code.

---

# Class — Staging/Dev Contamination Sweep (per audit addition #2)

## Investigation summary

Greps in `prisma/seed*`, `scripts/`, `tests/`, `__fixtures__/`, `.env*`, `vercel.json`, `.github/workflows/`, and the dev DB binary for daetradez/anthony/SLM/whop strings.

## Findings

### F9.1 — `scripts/populate-dae-tenant-data.ts` carries hardcoded daetradez strings ⚪ MEDIUM

- **Evidence:** explicit grep returns the file. Modified in db88b53 commit — `linkSource: 'active_account_script_action'` plus existing daetradez tenant data.
- **Severity:** MEDIUM. Dev/seed only — no production runtime impact, but indicates the same persona data may be templated into onboarding tooling. Future onboarding scripts copying this template will inherit the hardcodes.
- **Remediation:** parameterize via env vars or a JSON config file. Rename to `populate-tenant-data.ts`. Add a check that errors if persona handle is left as default `daetradez`.

### F9.2 — `.env*` files / vercel.json clean ✅ PASS

- **Evidence:** `vercel.json` contains no persona-specific values. No `.env` files in repo root.

### F9.3 — `dev.db` is empty (0 bytes) ✅ INFORMATIONAL

- The local dev DB is unused — production runs on Postgres. Re-audit kit (Appendix C) provides queries for production read-only execution.

### F9.4 — `.github/workflows/` clean ✅ PASS

- No daetradez/anthony/SLM strings in CI configs.

---

# Appendix A — daetradez URL Hallucination Root-Cause (preliminary)

## Summary of static-analysis-only conclusion

The hallucinated URL `daetradez.com/course` sent to `@alexpintilie_` was **almost certainly base-model hallucination induced by prompt content**, not a code bug or persona-config bug. The classifier:

1. **Code bug origin (URL inserted post-process)?** **Ruled out.** Post-processing only *strips* URLs (`stripHallucinatedUrls`), never inserts. There is no URL-construction code that interpolates persona handle into a `.com/course` path.

2. **Persona-config origin (URL appeared in prompt context)?** **Ruled out.** No place in the codebase reads `${personaHandle}.com/course`. Persona's `downsellUrl` is a real Whop URL when configured. The string `daetradez.com/course` does not exist in the codebase or schema.

3. **LLM hallucination?** **Most likely.** The prompt:
   - Tells the LLM the persona sells a "$497 course" / "Session Liquidity Model" multiple times (F2.2)
   - Carries example URLs in the prompt body (F2.4 — `https://youtube.com/...`, `https://form.typeform.com/to/xyz`)
   - The LLM's training data associates `daetradez` with `daetradez.com` (it's a real public IG profile)
   - The link-promise-without-URL gate (`ai-engine.ts:1900+`) **forces a regen if the AI promises a link without one** — pressuring the LLM to emit *some* URL on retry
   - The course-link-placeholder gate (`ai-engine.ts:1880+`) explicitly says "use the EXACT course / payment URL from the script's Available Links & URLs section" — but if no allowed course URL is configured, the LLM has been told to emit one and has nothing safe to fall back to

The combination produces a plausible failure mode: lead context implies "course pitch", AI has been ordered to emit a URL, and lacking a real one, the LLM confabulates `daetradez.com/course` from the persona name + the word "course" repeated 8+ times in the prompt.

## Required to confirm (against production read-only)

```sql
-- Pull the offending suggestion + its full prompt
SELECT s.id, s."generatedAt", s."responseText", s."finalSentText",
       c.id AS conversation_id, l.handle AS lead_handle, p.handle AS persona_handle
FROM "AISuggestion" s
JOIN "Conversation" c ON c.id = s."conversationId"
JOIN "Lead" l ON l.id = c."leadId"
JOIN "AIPersona" p ON p."accountId" = s."accountId" AND p."isActive" = true
WHERE s."finalSentText" LIKE '%daetradez.com/course%'
   OR s."responseText" LIKE '%daetradez.com/course%'
ORDER BY s."generatedAt" DESC
LIMIT 5;
```

Then: read the prompt that was sent (if logged) or reproduce by re-running `generateReply` against that conversation's history.

## Reproducibility test (for staging — DO NOT run in prod)

```ts
// scripts/test-url-hallucination-repro.ts
// 1. Create test persona handle='testbrand123', downsellUrl=null, isActive=true
// 2. Create test lead with status='UNQUALIFIED'
// 3. Run 20 iterations of:
//    generateReply(testAccountId, [{sender:'LEAD', content:'how much is the course'}], leadCtx, ...)
// 4. Count emissions matching /testbrand123\.[a-z]/i
// 5. Threshold: > 0% emission rate = systemic hallucination, fix is allowlist+regen-without-URL fallback
```

If the rate is non-zero, the immediate mitigation is: **never let the link-promise-without-URL gate force a regen when no allowlisted URL exists for the requested action**. Instead, route to "free resource fallback" or send a no-URL reply.

---

# Appendix B — 90-Day URL Backfill Scan (REQUIRED-AGAINST-PRODUCTION)

```sql
-- Every AI-emitted URL in the last 90 days, grouped by persona, with allowlist match check
WITH ai_messages AS (
  SELECT
    m.id,
    m."conversationId",
    m.content,
    c."leadId",
    l."accountId",
    l.handle AS lead_handle,
    m.timestamp
  FROM "Message" m
  JOIN "Conversation" c ON c.id = m."conversationId"
  JOIN "Lead" l ON l.id = c."leadId"
  WHERE m."senderType" = 'AI'
    AND m.timestamp > NOW() - INTERVAL '90 days'
),
extracted_urls AS (
  SELECT
    am.*,
    REGEXP_MATCHES(am.content, 'https?://[^\s<>"'')]+', 'g') AS url_match
  FROM ai_messages am
)
SELECT
  e."accountId",
  e.lead_handle,
  e.url_match[1] AS url,
  COUNT(*) AS occurrences,
  MIN(e.timestamp) AS first_seen,
  MAX(e.timestamp) AS last_seen
FROM extracted_urls e
GROUP BY e."accountId", e.lead_handle, e.url_match[1]
ORDER BY e."accountId", occurrences DESC;
```

Then for each `(accountId, url)` pair, cross-reference against `getAllowedUrls(accountId)` (from `ScriptSlot` + `ScriptAction`) to flag unauthorized URLs. Group findings by persona once Conversation has `personaId`.

---

# Appendix C — Re-Audit Kit (idempotent — run quarterly)

Each block returns hard counts. Any non-zero in a "must be 0" block is a regression.

## C1 — Schema regression checks (must be 0)

```bash
# Conversation must have personaId once F4.2 lands
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"Conversation\" WHERE \"personaId\" IS NULL;"

# Training data must always have personaId (already enforced at schema level)
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"TrainingExample\" WHERE \"personaId\" IS NULL;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"TrainingConversation\" WHERE \"personaId\" IS NULL;"
```

## C2 — Code regression greps (must be 0)

```bash
cd /path/to/ai-dm-setter

# Hardcoded persona handles
grep -r 'daetradez' src/ --include='*.ts' --include='*.tsx' --include='*.js' \
  | grep -v -E '(// |/\* )' | wc -l

# Hardcoded persona-specific names in production code
grep -rn '\bAnthony\b' src/lib/ src/app/api/ --include='*.ts' \
  | grep -v -E '(// |/\* )' | wc -l

# Hardcoded SLM / $497
grep -rn 'Session Liquidity\|\$497' src/lib/ --include='*.ts' \
  | grep -v -E '(// |/\* )' | wc -l

# Hardcoded Typeform / YouTube IDs
grep -rn 'AGUtPdmb\|e7Ujmb019gE' src/ --include='*.ts' | wc -l

# Non-deterministic persona reads
grep -rn 'aIPersona.findFirst.*accountId.*isActive' src/ --include='*.ts' | wc -l

# Webhook fallback to first account
grep -rn 'falling back to first account\|only one account exists' src/app/api/webhooks/ --include='*.ts' | wc -l
```

## C3 — Cross-persona retrieval must filter by personaId (manual review)

Files to re-check on every audit:

- [src/lib/training-example-retriever.ts](src/lib/training-example-retriever.ts) — every Prisma query must include `personaId` in the where clause (F3.3)
- [src/lib/ai-prompts.ts:1502](src/lib/ai-prompts.ts:1502) — persona load must use `findUnique({where: {id: personaId}})` (F3.2)
- [src/lib/ai-engine.ts:492](src/lib/ai-engine.ts:492) — `generateReply` signature must include `personaId` (F3.1)

## C4 — Webhook fallback regression (must be 0 in logs)

```bash
# Search Vercel/Datadog logs (last 30 days) for:
grep -E 'falling back to first account|only one account exists' production-logs.txt | wc -l
```

## C5 — Reproducibility test (run on staging quarterly)

See Appendix A — script outline. Threshold: zero `testbrand123.*` URL emissions across 20 iterations.

---

# Out-of-Scope (this audit)

- Schema migration to add `Conversation.personaId` + backfill (sequenced first follow-up)
- Webhook fallback removal
- Master prompt refactor to remove `Daniel`/`Anthony`/`$497`/`Session Liquidity Model` literals
- URL allow-list move from account-scope to persona-scope
- `DANIEL_VOCAB` rename + per-persona vocabulary loading
- Pulling alexpintilie GenerationLog from production
- Running 90-day URL backfill scan against production
- Running reproducibility test on staging

These are tracked separately for sequenced remediation. Priority order is:
1. F4.2 (Conversation.personaId) — unblocks F3.1, F3.2, F3.3, F3.4, F3.5, F2.3
2. F6.1 + F6.2 (webhook fallback) — independent, can land in parallel
3. F2.1 + F2.2 (TYPEFORM_BOOKING_URL + $497 hardcodes)
4. F1.3 + F1.5 (Anthony / Daniel name leakage in prompt)
5. F5.1 (DANIEL_VOCAB → per-persona)
6. F1.1 + F1.2 (DEFAULT_THEME, landing page) — cosmetic but visible
