# DMsetter — Business Requirements Document

**Status:** Draft (reverse-engineered from code) — `2026-05-10`
**Audience:** Engineering, product, audit
**Source of truth:** the codebase. This BRD describes *current* behavior. Future features live in `docs/ROADMAP.md`.

---

## Document conventions

- **Code citations** use the form `path/to/file.ts:line` so the BRD stays auditable as code drifts.
- **Open questions** for the product owner are flagged inline with `(OQ-N)` and collected in `BRD-open-questions.md`.
- **Module sections** follow a fixed template:
  1. Purpose
  2. Inputs
  3. Outputs
  4. Workflows (happy path)
  5. Business rules
  6. Edge cases
  7. Cross-module dependencies
- **Tenancy boundary:** `Account` is the tenancy boundary (billing, access, operators). `AIPersona` is the per-bot config inside an account. `Lead` is account-scoped (multiple personas in one account share a lead pool — *intentional*). `Conversation` is persona-scoped (lead × persona pair).

---

## System summary (one-paragraph)

DMsetter is a SaaS that turns Instagram and Facebook DMs into qualified, booked sales calls without a human in the loop until the closer step. Each customer (`Account`) connects one or more Instagram/Facebook handles, configures one or more `AIPersona`s with a sales script and voice profile, and the system auto-replies to inbound DMs, qualifies leads against persona-defined criteria, books calls into Calendly/HubSpot, and hands off to a human closer. Operators monitor and intervene from a Next.js dashboard backed by Postgres + Prisma + Clerk auth.

---

## Modules

The system breaks into eleven modules. Each is documented in its own section below.

1. [Account & tenancy](#1-account--tenancy)
2. [Personas (AIPersona)](#2-personas-aipersona)
3. [Leads & Conversations](#3-leads--conversations)
4. [AI response pipeline](#4-ai-response-pipeline)
5. [Instagram integration](#5-instagram-integration)
6. [ManyChat integration](#6-manychat-integration)
7. [Closer / handoff workflow](#7-closer--handoff-workflow)
8. [Training data](#8-training-data)
9. [Admin dashboard](#9-admin-dashboard)
10. [Operational primitives](#10-operational-primitives)
11. [Scheduling & timing](#11-scheduling--timing)

---

## 1. Account & tenancy

### Purpose

`Account` is the tenancy boundary — billing, access, operators, and external integrations are all scoped to an Account. One Account ≈ one paying customer (a brand, agency, or solo creator running DM automation). Inside an Account, multiple `User`s collaborate as operators, and one or more `AIPersona`s drive the auto-replies.

### Inputs

- Self-serve sign-up: Clerk session → User row creation → Account creation. *(OQ-1: today's onboarding flow appears to be super-admin-driven via `/api/admin/onboard/account` — confirm whether self-serve sign-up is intended for client #2 or if every Account is provisioned by Tega.)*
- Super-admin onboarding wizard (Phase 2): 6-step flow at `/admin/onboard` that creates `Account + User + AIPersona`, configures personas, runs test scenarios, and activates the bot. Tracked by `Account.onboardingStep` (0=not started → 6=complete) — `prisma/schema.prisma:372`, [admin-dashboard-phase-2-plan.md](admin-dashboard-phase-2-plan.md).
- OAuth grants: Instagram, Facebook, Calendly, Cal.com, ElevenLabs, OpenAI, Anthropic, ManyChat, Typeform, LeadConnector — stored in `IntegrationCredential` keyed by `(accountId, provider)`.

### Outputs

- An active tenant capable of receiving inbound DMs, generating AI replies, booking calls, and surfacing suggestions in the dashboard.
- AdminLog rows for every super-admin action against the tenant.

### Workflows

1. **Account creation (Phase 2 wizard)** — super-admin posts `/api/admin/onboard/account` → creates `Account + User + AIPersona` with `onboardingComplete=false`, `awayModeInstagram=false`, `awayModeFacebook=false`.
2. **Connect integrations** — operator OAuth-connects each platform; tokens land in `IntegrationCredential.metadata.accessToken` (per `audit/2026-05-03-multi-tenant-leak-audit.md` F6.3).
3. **Configure persona** — operator fills the AIPersona core fields via `POST /api/admin/onboard/[accountId]/persona`.
4. **Test** — `POST /api/admin/onboard/[accountId]/test` runs N test scenarios; returns AI replies + pass/fail per scenario.
5. **Activate** — `POST /api/admin/onboard/[accountId]/activate` flips `awayModeInstagram=true` / `awayModeFacebook=true`, sets `onboardingComplete=true`, writes an AdminLog row.
6. **Operate** — operators run the dashboard, monitor conversations, intervene via human override, manage suggestions.

### Business rules

- **Tenancy isolation:** every account-scoped query MUST filter by `accountId`. `auth-guard.ts:canAccessAccount(auth, accountId)` returns true only if `isPlatformOperator || auth.accountId === accountId`. (See [src/lib/auth-guard.ts](src/lib/auth-guard.ts).)
- **Roles** (`Role` enum, `prisma/schema.prisma:13`): tenant-internal — `ADMIN` (tenant owner), `CLOSER`, `SETTER`, `READ_ONLY`. Platform-level — `SUPER_ADMIN` (Tega; can impersonate, manage plans, see all tenants), `MANAGER` (view/action across tenants, no billing).
- **Per-platform AI master switches** (`prisma/schema.prisma:249-252`): `awayModeInstagram` and `awayModeFacebook` are the master switches. Both this AND per-conversation `Conversation.aiActive` must be true before any auto-send. Legacy single `awayMode` is retained for migration but no longer read at runtime.
- **Suggestion review banner** (`prisma/schema.prisma:264`): `showSuggestionBanner` defaults true. When false, AI still generates suggestions in the background but the banner UI is suppressed; per-conversation `autoSendOverride=true` graduates a single conversation to auto-send.
- **AI provider routing** (`prisma/schema.prisma:275`): `aiProvider` is `'openai'` (default, gpt-4o-mini) or `'anthropic'` (claude-sonnet-4-6). Bypasses the credential resolver for primary `generateReply()` calls only — script-parser and voice-note-context-matcher still read OpenAI.
- **Distress detection** (`prisma/schema.prisma:306`): `distressDetectionEnabled` defaults true. Cannot be toggled via UI — DB-only. Every inbound lead message is scanned against `DISTRESS_PATTERNS` before entering the AI pipeline; matches pause AI on the conversation, notify the operator, and route through a supportive (non-sales) reply path.
- **Response timing** (`prisma/schema.prisma:316-324`): account-level `responseDelayMin/Max` (default 300s/600s) and debounce (`debounceWindowSeconds=45`, `maxDebounceWindowSeconds=120`) apply to all scripts. Each new lead message resets the debounce timer; max-debounce caps total wait from the first message in a batch.
- **Ghost threshold** (`prisma/schema.prisma:265`): `ghostThresholdDays` defaults 7 — days of silence before auto-ghosting a lead.
- **Training phase** (`prisma/schema.prisma:309-313`): accounts move through `TrainingPhase` states (`ONBOARDING` → ...). `trainingTargetOverrideCount` (default 20) is the threshold for suggesting "training complete"; `trainingOverrideCount` increments on each human override during onboarding.
- **Notification toggles** (`prisma/schema.prisma:286-296`): 12 booleans — URGENT (email + in-app), ACTIVITY (in-app only), EMAIL REPORTS. Email goes to the account owner's `User.email`, not a separate field.
- **OAuth-token scoping** (per multi-tenant audit F6.3): `IntegrationCredential` is unique on `(accountId, provider)` — one token per account+provider. Per-persona token scoping is a future consideration and only matters if a single Account ever connects two IG handles.

### Edge cases

- **Cascade delete:** deleting an Account cascades to Users, Personas, Leads, Conversations, Tags, IntegrationCredentials, etc. AdminLog rows survive (`adminLog.targetAccount` is `onDelete: SetNull`) for audit retention.
- **Health-check rollup** (`prisma/schema.prisma:368`): `healthStatus` defaults `UNKNOWN` until `runHealthChecks` runs. Used by the admin overview table.
- **Trial accounts:** `planStatus=TRIAL` + `trialEndsAt` — *(OQ-2: confirm what happens at trial end — does the bot pause auto-replies, or does it keep running until billing kicks in?)*
- **Multiple personas per account** (intentional): personas inside one Account share the lead pool; operators must pick which persona handles a lead. Pre-F4.2, `Conversation` lacked `personaId` and the system non-deterministically picked the active persona — now fixed (`audit/2026-05-03-multi-tenant-leak-audit.md` F4.2).
- **Multiple IG handles per account:** schema currently enforces one `IntegrationCredential` per `(accountId, provider)` — connecting two IG handles to one account is not supported. *(OQ-3: is this the intended product constraint, or is it a stop-gap?)*

### Cross-module dependencies

- → §2 Personas: `Account 1—n AIPersona`. Persona-level config inherits some account-level settings (e.g., master AI switch).
- → §3 Leads & Conversations: every Lead and Conversation is scoped to an `accountId`.
- → §5 Instagram, §6 ManyChat: webhooks resolve to an `accountId` via `IntegrationCredential` lookup; resolution failure must NOT fall back to the first/oldest account (per audit F6.1+F6.2 — Phase 4 of the security sprint).
- → §10 Operational primitives: distress detection, response timing, debounce all read from Account fields.


---

## 2. Personas (AIPersona)

### Purpose

`AIPersona` is the per-bot configuration inside an Account. It defines the bot's identity (name, company, tone), its sales script, its voice (voice notes), its qualification rules (financial waterfall, capital gate), and its safety rails (out-of-scope topics, verified details). One Account can have multiple personas — leads in that account share the lead pool, but each `Conversation` is bound to exactly one persona (post-F4.2 fix per `audit/2026-05-03-multi-tenant-leak-audit.md`).

### Inputs

- **Operator config** via the persona editor UI — identity, system prompt overrides, knowledge assets, proof points, active campaigns, verified details, out-of-scope topics.
- **Script upload** — operator uploads a raw sales script (`rawScript` text). The parser produces a `PersonaBreakdown` with sections, ambiguities, and slots.
- **Voice notes** — operator uploads audio files into `VoiceNoteLibraryItem`; AI binds them to script actions or matches them at runtime.
- **Account-level inheritance** — persona inherits master AI switch, distress detection, debounce, and (some) timing settings from `Account`.

### Outputs

- A complete persona config that the AI engine uses to generate replies (system prompt, knowledge assets, slot fills, voice notes, qualification flow).
- A parsed `Script` (with `ScriptStep` + `ScriptBranch` + `ScriptAction`) that drives deterministic conversation flow, indexed by `LeadScriptPosition` per lead.

### Workflows

1. **Persona create** — `POST /api/admin/onboard/[accountId]/persona` populates AIPersona core fields (`personaName`, `fullName`, `companyName`, `tone`, `systemPrompt`).
2. **Script upload + parse** — operator uploads script text → parser emits `PersonaBreakdown` (sections, ambiguities) and `ScriptSlot`s (voice_note / link / form / runtime_judgment / text_gap).
3. **Slot fill** — operator resolves each `BreakdownAmbiguity` (free-text answer) and binds each `ScriptSlot` (uploads voice note, provides URL, fills form values, supplies text content). Slots track `status: unfilled | filled | bound | partially_filled | complete`.
4. **Voice note library** — operator uploads voice notes into `VoiceNoteLibraryItem`; system runs transcription + LLM-generated trigger suggestions, then operator approves. `active=true` makes the note eligible for runtime selection.
5. **Activate** — `AIPersona.isActive` flips true once `setupComplete` is true (setup steps 0-8 done). The persona starts handling new conversations.
6. **Edit at runtime** — operators can edit `activeCampaignsContext`, `verifiedDetails`, `outOfScopeTopics`, `customPhrases`, etc., on the fly without restarting; the prompt assembler reads the latest values.

### Business rules

- **Identity & tone** (`prisma/schema.prisma:408-411`): `personaName`, `fullName`, `companyName`, `tone` go into the system prompt as `<persona_identity>` block.
- **System prompt** (`prisma/schema.prisma:412`): `systemPrompt` is the main conversation prompt. The prompt assembler in `src/lib/ai-prompts.ts` wraps it with persona-derived context blocks (`<active_campaigns>`, `<verified_details>`, `<knowledge_assets>`, etc.).
- **Multi-bubble delivery** (`prisma/schema.prisma:480`): `multiBubbleEnabled=false` by default. When true, the LLM emits 1-4 short DM bubbles per turn (`messages[]` schema injected); the delivery pipeline ships each as a separate send with realistic typing delays between.
- **Capital verification gate (R24)** (`prisma/schema.prisma:445-446`): if `minimumCapitalRequired` is set, the AI must verify the lead's capital claim in DM before routing to booking — leads lie on Typeform. `capitalVerificationPrompt` is an optional override; otherwise default R24 phrasing. Two opt-out flags exist: `skipR24ScriptInject` (skip Layer-1 serializer's prepended verification question on "qualified" branches) and `allowEarlyFinancialScreening` (relax R3 sequence lock so financial screening can fire before the soft pitch). Both default false.
- **Out-of-scope topics (R26)** (`prisma/schema.prisma:453`): `outOfScopeTopics` augments the universal "stay in scope" rule with account-specific carveouts. Example use: a financial-literacy coach lists "career advice" so the off-topic regex guard doesn't false-positive.
- **Verified details (R27)** (`prisma/schema.prisma:464`): only facts listed in `verifiedDetails` may be asserted by the AI. Anything outside escalates to "lemme check with the team" — prevents fabrications like "Anthony speaks German" when the operator hasn't disclosed that fact.
- **Persona-level timing overrides** (`prisma/schema.prisma:481-482`): `responseDelayMin/Max` exist on AIPersona AND Account. *(OQ-4: confirm precedence — does persona override account, or vice versa, or do they sum?)*
- **Voice notes enabled** (`prisma/schema.prisma:483`): `voiceNotesEnabled=true` by default. When false, the persona never sends voice notes — voice slots fall back per their `fallbackBehavior`.
- **Media transcription** (`prisma/schema.prisma:484`): `mediaTranscriptionEnabled=false` by default. When true, inbound audio/image attachments are transcribed before AI generation.
- **Active campaigns** (`prisma/schema.prisma:437`): `activeCampaignsContext` is free-form text injected as `<active_campaigns>` so the AI distinguishes warm CTA responses from cold DMs. `contextUpdatedAt` + `contextUpdatedByUserId` provide an audit trail without a separate history table.
- **Per-conversation persona binding:** `Conversation.personaId` now (post-F4.2) records exactly which persona owns the conversation. AI prompt assembly reads this — never the account's "active" persona, which was non-deterministic for multi-persona accounts.

### Edge cases

- **Persona deletion:** cascades to TrainingExamples, TrainingUploads, TrainingConversations, PersonaBreakdowns, Conversations. *(OQ-5: what happens to in-flight conversations when their persona is deleted? Is deletion gated, or is the cascade intentional?)*
- **Two personas, ambiguous lead routing:** when a lead DMs an Account with 2+ personas, which persona's bot replies? *(OQ-6: confirm assignment rule — by IG-handle binding via IntegrationCredential metadata? By account-level default? By inbox routing?)*
- **Slot fallback** (`VoiceNoteFallback`, `prisma/schema.prisma:577`): `BLOCK_UNTIL_FILLED` (block AI until operator uploads), `SEND_TEXT_EQUIVALENT` (use `fallbackText`), `SKIP_ACTION` (skip the script action entirely). Default `SEND_TEXT_EQUIVALENT`.
- **Sprint 3 parser overhaul:** the slot system replaces free-text ambiguities with structured slots (`VoiceNoteSlot`, `LinkSlot`, `RuntimeInstruction`, `FormSlot`). Per memory, 3 of 4 ambiguities from the test-script case were originally wrong free-text — structured slots eliminate that.
- **Re-parse on script update:** when an operator re-uploads a script, the existing `PersonaBreakdown` flips `status=ARCHIVED` and a new one is created. *(OQ-7: confirm — does re-parse preserve operator-resolved ambiguities and slot fills, or does the operator have to redo them?)*

### Cross-module dependencies

- → §3 Leads & Conversations: `Conversation.personaId` binds a conversation to one persona.
- → §4 AI response pipeline: every `generateReply()` call must accept `personaId` (post-F3.1 fix) and load AIPersona via `findUnique({where: {id: personaId}})` (post-F3.2 fix).
- → §8 Training data: `TrainingExample`, `TrainingUpload`, `TrainingConversation` all carry `personaId`. Few-shot retrieval must filter by `personaId` (post-F3.3 fix).
- → §11 Scheduling: `Script` + `ScriptStep` + `ScriptBranch` + `ScriptAction` drive deterministic flow; `LeadScriptPosition` tracks where each lead sits in the flow.


---

## 3. Leads & Conversations

### Purpose

`Lead` is the identity of a prospect at a given Account on a given platform (one Lead per `(accountId, platform, handle)` triple). `Conversation` is the lead × persona pair — every message exchange belongs to exactly one Conversation, and exactly one persona owns it. `Message` is an individual DM (inbound or outbound), with full provenance, media handling, and soft-delete support.

### Inputs

- **Inbound webhook** (Instagram or Facebook) — first DM from a new handle creates a `Lead` (account-scoped) and a `Conversation` (persona-bound), then a `Message`.
- **ManyChat handoff** — when ManyChat detects an opener, the inbound handler marks `Conversation.source=MANYCHAT`, suppresses the AI's opener, and stores the ManyChat-side fields (`manyChatOpenerMessage`, `manyChatTriggerType`, `manyChatCommentText`, `manyChatFiredAt`).
- **Typeform submission** — `POST /api/webhooks/typeform` after signature verification populates `typeformSubmittedAt`, `typeformResponseToken`, `typeformCapitalConfirmed`, `typeformAnswers` on the matching Conversation.
- **Operator action** (dashboard) — manual sends, AI on/off toggles, scheduling edits, tags, team notes.

### Outputs

- AI-generated outbound messages (subject to debounce + auto-send gates).
- Stage transitions tracked on Lead (`LeadStageTransition`) and Conversation (stage-reached timestamps).
- Notifications, AdminLogs, and dashboard-visible state changes.

### Workflows

1. **First inbound DM** → resolve Account via `IntegrationCredential`; create Lead if `(accountId, platform, handle)` is new; create Conversation with `aiActive=false` (default since 2026-05-06; legacy default was true), bind to a persona via `Conversation.personaId`; persist Message; trigger AI generation pipeline (see §4).
2. **AI auto-send gate**: send only if BOTH `Account.awayMode<Platform>=true` AND `Conversation.aiActive=true`, OR `Conversation.autoSendOverride=true`. Otherwise generate as `AISuggestion` only and surface in dashboard banner.
3. **Stage progression**: AI/parser updates `Conversation.stageOpeningAt`, `stageSituationDiscoveryAt`, `stageGoalEmotionalWhyAt`, `stageUrgencyAt`, `stageSoftPitchCommitmentAt`, `stageFinancialScreeningAt`, `stageBookingAt` (7-stage SOP). Each stage timestamp is set ONCE on first reach.
4. **Capital verification (R24)**: if `AIPersona.minimumCapitalRequired` is set, AI gates booking on durable `Conversation.capitalVerificationStatus` (`UNVERIFIED → VERIFIED_QUALIFIED | VERIFIED_UNQUALIFIED | MANUALLY_OVERRIDDEN`); status survives reschedules.
5. **Booking**: AI collects timezone/email/phone, offers `proposedSlots` (TimeSlot[]), confirms `selectedSlot`, calls LeadConnector to book, persists `bookingId`. Falls back to `bookingUrl` if provider doesn't support server-side booking.
6. **Scheduled call lifecycle**: `scheduledCallAt` + `scheduledCallTimezone` + `scheduledCallSource` (audit trail) → `callConfirmed` → `callOutcome` (`SHOWED | NO_SHOWED | RESCHEDULED`).
7. **Distress / crisis**: distress-detector pre-screens lead messages → sets `distressDetected=true` (permanent), `distressDetectedAt`, `distressMessageId`, pauses AI, fires URGENT notification. Re-enabling AI later still injects a "soft check-in, no pitch" override.
8. **Scheduling conflict**: lead at `CALL_PROPOSED` expresses scheduling conflict AI can't resolve → `schedulingConflict=true`, `schedulingConflictPreference` captures parsed day/time signal, fires URGENT notification + email.
9. **Geography gate**: persona-level opt-in. Triggered conversation: `geographyGated=true`, `geographyCountry` set, exit message sent ONCE, AI paused, no follow-ups. Lead row also flips `geographyDisqualified=true` (permanent — preserved through operator override for analytics).
10. **Unsend**: lead-side (IG `message_deletions` event) → `Message.deletedAt + deletedBy=LEAD + deletedSource=INSTAGRAM`. Operator-side (`/api/conversations/[id]/messages/[mid]/unsend`) → calls Meta's IG DELETE, then soft-deletes locally. If operator replaces the unsent message with a corrected manual send within 2 minutes, the new message is flagged `isHumanCorrection=true` and the AI prompt builder injects an "[Operator correction]" note.
11. **Ghosting**: silence longer than `Account.ghostThresholdDays` → ghost follow-ups; `Lead.stage=GHOSTED`.
12. **Outcome closure**: stages settle into `LeadStage.CLOSED_WON | CLOSED_LOST | UNQUALIFIED | GHOSTED | NURTURE`; `Conversation.outcome` mirrors final state; `Lead.revenue` + `Lead.closedAt` populated on close.

### Business rules

- **Tenancy:** `Lead.accountId` is the tenancy scope; `Conversation.personaId` is the persona scope (post-F4.2). Messages, AISuggestions, ScheduledMessages, and SelfRecoveryEvents inherit persona scope through `Conversation`.
- **Auto-send composition** (`shouldAutoSend`): `awayMode<Platform> OR autoSendOverride`. Auto-send is the only condition under which AI text ships to the platform without operator click.
- **`aiActive` default = false** (2026-05-06 policy, `prisma/schema.prisma:927`): explicit operator opt-in per conversation. Legacy default of `true` caused silent auto-engage.
- **`source=MANYCHAT` short-circuits the opener:** suppresses the AI opener, injects `outbound_context` block in system prompt so the AI knows ManyChat already greeted.
- **Multi-bubble grouping** (`prisma/schema.prisma:1185-1188`): when `AIPersona.multiBubbleEnabled=true`, one AI turn produces 2-4 `Message` rows linked by `messageGroupId`; `bubbleIndex` orders within group, `bubbleTotalCount` denormalises count, `intraGroupDelayMs` records the typing delay between bubbles. Single-message rows have `messageGroupId=null` (implicit 1-bubble).
- **Soft delete only:** `Message.deletedAt + deletedBy + deletedSource + deletedReason` retain audit trail. `OPERATOR_UNSEND` is the canonical reason for dashboard-initiated unsends.
- **Conversation handoff `lastMessageAt`:** when ManyChat / direct-message inserts a Message, the inbound handler MUST bump `Conversation.lastMessageAt` and `unreadCount`, else the dashboard hides the conversation (per memory: ManyChat handoff invariant).
- **`personaId` is `onDelete: Restrict`** (`prisma/schema.prisma:1095`): cannot delete a persona while it owns live Conversations. Operator must migrate or archive first. (See OQ-5.)
- **Captured data points:** `Conversation.capturedDataPoints` is a JSON map of slot-fills the parser/AI extracted (e.g. timezone, email, phone, pain points). Used by the prompt assembler to skip already-answered questions.
- **Self-recovery state:** `currentScriptStep`, `systemStage`, `llmEmittedStage`, `stageMismatchCount`, `selfRecoveryCount` track LLM-vs-script divergence. The recovery layer (`SelfRecoveryEvent`) emits a corrective turn when the LLM strays from the deterministic script flow.
- **Silent-stop heartbeat:** `awaitingAiResponse + awaitingSince + silentStopCount` plus `SilentStopEvent` rows let a cron detect conversations where the AI was *expected* to reply and didn't (gate failure / exception / dead-end). Recovery messages auto-send to unstick.
- **Message dedup:** `(conversationId, platformMessageId)` is unique — Meta's `message.mid` deduplicates webhook retries.
- **Provenance vs. delivery:** `MessageSender` is the *delivery* sender (AI / LEAD / HUMAN / SYSTEM / MANYCHAT). `MessageSource` is the *authoring* origin (`QUALIFYDMS_AI | MANYCHAT_FLOW | HUMAN_OVERRIDE | UNKNOWN`). They differ when ManyChat is the delivery carrier — `sender='MANYCHAT'` alone can't distinguish a hardcoded ManyChat welcome flow from an AI-generated reply, so `msgSource` is set at write time by the authoring system.
- **Human source labelling:** `Message.humanSource = 'DASHBOARD' | 'PHONE'` — `PHONE` is captured via Meta's `is_echo=true` webhook echo in `processAdminMessage`. UI shows a "from phone" badge.

### Edge cases

- **`clear conversation` reset command:** literal "clear conversation" DM must fully wipe convo + lead state for re-testing (per memory). Used internally for testbrand123-style staging tests.
- **Numeric IG ID bug** (`docs/diagnostic-numeric-ig-id-bug.md`): historical bug where IG handle was sometimes stored as numeric ID — to be revisited in functional audit (Phase C).
- **New-account ingestion** (`docs/diagnosis-new-account-ingestion.md`): edge case where new accounts didn't see inbound messages until X — revisit in functional audit.
- **`nickdoesfutures` confirmed** (`docs/diagnosis-nickdoesfutures-confirmed.md`): specific account-scope leak diagnosed — verify fix landed.
- **Typeform-filled-no-booking:** AI asked "which day did you book?" and lead says "I only filled the form" — `typeformFilledNoBooking=true`. Expected screening outcome, not Action Required.
- **Booking limbo:** booked but not confirmed for 24h fires `notifyOnBookingLimbo`.
- **Stage mismatch:** LLM emits stage X but the script-stage state machine expected stage Y — `stageMismatchCount++`. Above threshold → `SelfRecoveryEvent` triggers a corrective turn.
- **Awaiting AI response flag:** if a lead reply was expected to receive an AI turn and didn't (gate failure, exception), the heartbeat cron detects via `awaitingAiResponse=true + awaitingSince` aged > threshold and emits a `SilentStopEvent` + recovery message.

### Cross-module dependencies

- → §1 Account: tenancy, master AI switches, distress detection, ghost threshold.
- → §2 Personas: `Conversation.personaId` binds the conversation to one persona for prompt assembly.
- → §4 AI response pipeline: every Message + `aiActive` + `autoSendOverride` flows through the pipeline.
- → §5 Instagram, §6 ManyChat: inbound webhooks create / update Lead + Conversation + Message.
- → §7 Closer: `LeadStage` progression terminates at handoff to closer or final outcome.
- → §11 Scheduling: `ScheduledMessage` + `ScheduledReply` + booking state machine.


---

## 4. AI response pipeline

> The 11-stage technical breakdown lives in [docs/ARCHITECTURE_RESPONSE_PIPELINE.md](ARCHITECTURE_RESPONSE_PIPELINE.md). This section captures the *business rules* — what the pipeline does, what it must guarantee, and what the operator sees.

### Purpose

Turn an inbound DM into an on-voice, persona-scoped, qualification-aware reply that ships to the platform within the configured delay window — or, when not authorized to auto-send, lands as a reviewable suggestion in the dashboard.

### Inputs

- A persisted inbound `Message` belonging to a `Conversation` with known `personaId` and an Account that has at least one platform's `awayMode<Platform>` flag in a defined state.
- The `AIPersona` config, the parsed `Script`, voice notes, training examples, lead profile, prior message history, scheduling state.

### Outputs

- Either a *delivered* AI message (saved as `Message` with `sender=AI`, `msgSource=QUALIFYDMS_AI`), shipped to Meta via ManyChat or direct send.
- Or an `AISuggestion` row + dashboard banner for operator review (when not authorized to auto-send).
- Side effects: stage timestamp updates, captured data points, Lead.stage progression, calendar booking calls, notifications, training events, scoring data.

### Workflows

The pipeline runs as 11 stages (see architecture doc for line-level detail):

1. **Stage A — Webhook receipt** — Meta POST → HMAC-SHA256 sig check → JSON parse → `processInstagramEvents()` synchronously before 200 (Vercel `maxDuration=120s`). [src/app/api/webhooks/instagram/route.ts:47](src/app/api/webhooks/instagram/route.ts:47).
2. **Stage B — Account routing** — webhook payload's `entry[].id` (page/IG-business ID) is looked up via `IntegrationCredential.metadata` to resolve `accountId`. *Currently* falls back to first/oldest account on miss — the multi-tenant audit (F6.1+F6.2) requires changing this to 400+alert.
3. **Stage C — Message dedup + persistence** — uniqueness on `(conversationId, platformMessageId=event.message.mid)` deduplicates retries. Lead created if new. Conversation created if new (with `aiActive=false` for ongoing messages, `true` for `LEAD_OPENERS` (18 entries)). "clear conversation" command wipes state. Post-save: bumps `lastMessageAt`, `unreadCount`; back-fills effectiveness; re-engages `LEFT_ON_READ`; broadcasts SSE; triggers `runPostMessageScoring()`.
4. **Stage D — Delay routing** — debounce + delay-min/max yield `delaySeconds`. ≤ 90s → `after()` inline sleep, then `processScheduledReply()`. > 90s → `ScheduledReply` row picked up by per-minute cron. Bug noted in [response-delay-fix-plan.md](response-delay-fix-plan.md): `maxDebounceWindowSeconds` was clamping the *final fire time* instead of just the debounce phase, capping delays at 120s — fix scheduled.
5. **Stage E — Context assembly** — fetches conversation + lead + tags + history (one query). Backfills history from Meta API if local count == 1. Builds `LeadContext`. Test backdoor: phrase `"september 2002"` fast-forwards to BOOKING. Booking-state injection: `getUnifiedAvailability()` on calendar integrations, filters to 9am-7pm in lead's timezone, capped at 12 slots, persists `proposedSlots`. Adds scoring context.
6. **Stage F — Few-shot retrieval** — 3-tier metadata-filtered retrieval against `TrainingExample` (vectorized via OpenAI `text-embedding-3-small`, 1536-dim). Tier 1: exact `(leadType, dominantStage)` match → top 5. Tier 2: any 1 metadata match → top 5 (dedup). Tier 3: vector fallback excluding `HARD_NO`/`UNKNOWN` outcomes → top 5. **Audit gap (F3.3):** retrieval scopes by `accountId` only, not `personaId` — Phase 5 fix required for multi-persona accounts.
7. **Stage G — Content intent classification** — Claude Haiku (`claude-haiku-4-20250414`), temp 0, max_tokens 100, 3s timeout. 11 intents (`price_objection`, `time_concern`, `skepticism_or_scam_concern`, `past_failure`, `complexity_concern`, `need_to_think`, `not_interested`, `ready_to_buy`, `budget_question`, `experience_question`, `timeline_question`). Fallback: 70+-entry keyword map at 0.65 confidence. Direct `fetch()` (no SDK).
8. **Stage H — Persona fetch + system prompt assembly** — currently `prisma.aIPersona.findFirst({where: {accountId, isActive: true}})` (non-deterministic for multi-persona accounts; **F3.2 fix → `findUnique({where: {id: personaId}})`**). Then `assembleSystemPrompt()` builds 30+ context blocks: persona identity, `<active_campaigns>`, `<verified_details>`, `<knowledge_assets>`, `<proof_points>`, `<out_of_scope_topics>`, financial waterfall, downsell config, no-show protocol, R-rules, captured data points, allowed URLs, voice-note slot fills, booking state, scoring intel, etc.
9. **Stage I — LLM call + voice quality gate loop** — provider resolution per `Account.aiProvider` ('openai' default = `gpt-4o`, 'anthropic' = `claude-sonnet-4-20250514`); Anthropic path uses prompt caching. Temperature 0.85, max_tokens 500. History formatting: LEAD → `user`, AI/HUMAN → `assistant` (HUMAN prefixed `[Human team member]`). Anthropic requires user-first → prepends `[Conversation started by our team]`; merges consecutive same-role via `mergeConsecutiveRoles()`. Response = JSON with 17 structured fields; falls back to raw text on parse failure. **Voice quality gate loop:** up to 3 attempts; first attempt failing logs to `VoiceQualityFailure` and retries; attempt 3 ships best-effort.
10. **Stage J — Voice quality gate** ([src/lib/voice-quality-gate.ts](src/lib/voice-quality-gate.ts)) — hard fails (instant regen): 23 banned phrases ("I'm sorry to hear", "Great question", etc.), 9 banned words ("specifically", "ultimately", etc.), banned starter "However,", 16 banned emojis (without skin tone), em/en dash, semicolon, "lol", > 300 chars. Soft signals (target ≥ 0.7): `short_message` (≤ 200 chars = 1.0), `has_daniel_vocab` (28-word allowlist), `short_sentences` (≤ 2 = 1.0), `lowercase_start` (0.5), `approved_emoji` (0.5).
11. **Stage K — Anti-hallucination guards + delivery** — voice-note trigger evaluation (3 trigger types: `stage_transition`, `content_intent`, `conversational_move`) overrides LLM's voice-note decision. Runtime-match `[VN]` slots resolved via `findBestVoiceNoteMatch()` (embedding similarity + LLM judgment). **R16 URL sanitization:** `stripHallucinatedUrls()` regex-matches `https?://`, validates against `getAllowedUrls()` (persona links + script action links + slot URLs); unauthorized → `[link removed]`. **R17 dash sanitization:** `—` → `, `, `–` → `-`, ` - ` → `, `. VN-aware delay queues via `ScheduledReply`. Auto-send vs suggestion: `!shouldAutoSend` broadcasts SSE without saving. `sendAIReply()` re-checks `aiActive` (human takeover during delay), checks for human conflict in last 30s, saves Message with stage metadata, persists booking fields, updates `Lead.stage`, fires notifications + tags.

### Business rules

- **Tenancy:** every stage that touches persona-derived state MUST use the `Conversation.personaId` of the conversation under generation. The audit's CRITICAL fixes (F3.1, F3.2, F3.3, F6.1, F6.2) close the current leaks; until they ship, a multi-persona account is unsafe.
- **Auto-send composition:** `shouldAutoSend = (Account.awayMode<Platform> && Conversation.aiActive) || Conversation.autoSendOverride`.
- **Inline vs cron:** 90s is the boundary (`INLINE_DELAY_THRESHOLD_SECONDS`). Inline keeps the lambda alive; cron picks up `ScheduledReply` rows with `scheduledFor ≤ now`.
- **Voice quality gate is mandatory:** every shipped reply has either passed the gate or exhausted the 3-attempt budget. Best-effort fallback still ships, but the failure is logged to `VoiceQualityFailure` for training.
- **R16 URL allowlist:** the only URLs allowed in the reply come from (a) the persona's `freeValueLink` + downsell links + verified knowledge-asset URLs, (b) `ScriptAction.linkUrl` for the active step, (c) bound `ScriptSlot.url` values. Anything else is stripped — the `daetradez.com/course` hallucination that triggered the audit was caught by this layer's missing allowlist.
- **Capital-verification gate (R24):** if `AIPersona.minimumCapitalRequired` set, the AI must verify capital in DM before booking; durable status on `Conversation.capitalVerificationStatus`.
- **Distress short-circuit:** distress-detector hits route to a dedicated supportive (non-sales) reply path, pause AI, fire URGENT notification — bypass the rest of the pipeline.
- **Test backdoor:** phrase `"september 2002"` in lead message fast-forwards to BOOKING stage and rewrites stage history. *(OQ-8: confirm this is intended for staging only and is gated by env or persona flag — otherwise it's a prod-leakable bypass.)*
- **Suggestion mode:** when `!shouldAutoSend`, no Message is saved; only an `AISuggestion` row + SSE broadcast for the dashboard banner. Operator's `manuallyApproved` / `editedByHuman` / `dismissed` actions populate `TrainingEvent` rows that drive the "ready to enable auto-send" readiness metric.
- **Cost tracking:** every shipped reply records `modelUsed`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens` on `AISuggestion`. Token counts are summed across voice-gate retries. `Account.monthlyApiCostUsd` is recomputed by the health-check job over a trailing 30-day window.
- **No prompt-assembly cache** (audit F5.4 PASS): every turn re-fetches persona + training examples and rebuilds the prompt string. Trades CPU for freshness — operator edits to persona context apply on the next turn.

### Edge cases

- **Lead opener vs ongoing inbound** (`LEAD_OPENERS` list, 18 entries): an opener creates a Conversation with `aiActive=true` (auto-engage); an ongoing message creates with `aiActive=false`. *(OQ-9: confirm this opener-list policy — does it bypass the "explicit opt-in" 2026-05-06 rule for `aiActive`? If so, document the rationale.)*
- **Human takeover during delay:** `sendAIReply()` re-checks `aiActive` and aborts if the operator typed in the last 30s. The pending `ScheduledReply` is cancelled.
- **`LEFT_ON_READ` re-engagement:** an inbound after a "left on read" stretch re-arms the pipeline.
- **JSON parse failure:** the LLM's response is expected JSON; on failure, raw text is taken as `message` with safe defaults for the other 16 fields.
- **Anthropic fallback:** if the Anthropic call fails, system falls back to OpenAI gpt-4o-mini (`modelUsed='gpt-4o-mini-fallback'` on the suggestion).
- **Dev-mode signature bypass** (audit-flagged): in dev env, an invalid HMAC sig logs a warning but continues. *(OQ-10: ensure this is gated by `NODE_ENV !== 'production'` and not by a missing env var.)*

### Cross-module dependencies

- → §2 Personas: prompt assembly reads every persona field; voice-note triggers + script actions drive Stage K decisions.
- → §3 Leads & Conversations: every stage reads/writes Conversation state.
- → §5 Instagram, §6 ManyChat: Stage A receives, Stage K delivers.
- → §8 Training data: Stage F retrieves from `TrainingExample`; Stage K post-process writes back via `AISuggestion` and `TrainingEvent`.
- → §11 Scheduling: Stage D queues `ScheduledReply`; Stage K consumes booking calendar via `getUnifiedAvailability()`.


---

## 5. Instagram integration

### Purpose

Receive inbound DMs and comments from Instagram, route them to the right Account, and ship outbound replies via Meta's Graph API or via ManyChat (preferred outbound carrier).

### Inputs

- **OAuth grant** — operator connects their IG Business / IG Creator account; we receive an access token and store it in `IntegrationCredential` (`provider=INSTAGRAM` for IGAA tokens, `provider=META` for EAA Facebook page tokens).
- **Inbound webhooks** — Meta POSTs to `/api/webhooks/instagram` with HMAC-SHA256 signature in `x-hub-signature-256`.

### Outputs

- Lead + Conversation + Message rows persisted; AI pipeline triggered.
- Outbound replies delivered via ManyChat (default) or via direct Meta Send API call.
- Real-time SSE broadcasts to the dashboard.

### Workflows

1. **Webhook signature verification** — `verifyWebhookSignature()` from [src/lib/instagram.ts](src/lib/instagram.ts). Production: invalid sig → 401. Dev: warning + continue.
2. **Account routing** — payload's `entry[].id` (page/IG-business ID) is matched against `IntegrationCredential.metadata` keys: `pageId`, `igUserId`, `instagramAccountId`, `igBusinessAccountId` ([src/app/api/webhooks/instagram/route.ts:180-187](src/app/api/webhooks/instagram/route.ts:180)). On match → resolve `accountId`. On miss → currently falls back to first/oldest account; **F6.1 fix:** unknown entry IDs return 400 + alert (no fallback).
3. **Token routing for outbound** — IGAA tokens (IG Login flow) call `graph.instagram.com`; EAA tokens (Meta Business Login) call `graph.facebook.com`. Per memory: this distinction is critical — wrong host → silent send failure.
4. **History backfill** — if local message count == 1, attempts to fetch history from Meta's Conversations API as a fallback ([src/lib/webhook-processor.ts](src/lib/webhook-processor.ts)).
5. **Username resolution** — `resolveInstagramProfile(accountId, igsid, accessToken)` in [src/lib/instagram.ts](src/lib/instagram.ts) maps a numeric IGSID to a `{username, name}` via Meta Graph API direct lookup → conversations API fallback.
6. **Numeric-ID upgrade** — `resolveAndUpgradeInstagramNumericId` in [src/lib/manychat-resolve-ig-id.ts](src/lib/manychat-resolve-ig-id.ts) upgrades `Lead.platformUserId` (the Meta Send API recipient ID) for leads that arrived with a numeric handle. Does NOT update `Lead.handle` or `Lead.name` — that's the username-resolution path's job.

### Business rules

- **Token-host routing** (per memory `reference_instagram_api`): `IGAA*` tokens → `graph.instagram.com`; `EAA*` tokens → `graph.facebook.com`. The `getCredentials()` resolver must return the right host for the token type, or sends silently fail.
- **Webhook entry-ID matching:** any of `pageId | igUserId | instagramAccountId | igBusinessAccountId` in `IntegrationCredential.metadata` may match an incoming `entry.id`. The IG OAuth flow returns two distinct numeric IDs for the same account: an IG Login user ID (e.g., `26566938759642516`) returned by `/me`, and an IG Business Account ID (the `17841…` value) returned by `/conversations` participants and embedded in webhook `entry.id`. Both must be stored in metadata, else webhooks drop on unmatched entry.id.
- **Webhook fallback (currently broken):** unmatched entry IDs fall back to the first/oldest account — multi-tenant data leak. Phase 4 of the security sprint replaces with 400 + alert.
- **Inline body read first:** raw body is read as text BEFORE parsing JSON, because HMAC verification requires the exact byte sequence Meta signed.
- **Synchronous processing before 200:** `processInstagramEvents()` is awaited before returning 200. `maxDuration=120s` accommodates the full pipeline. Short replies use Next.js `after()` for the delay; long replies queue to `ScheduledReply`.
- **Distress detector pre-filters** every inbound lead message before the AI pipeline runs.
- **Lead-handle preservation:** for `manychat-handoff` payloads with numeric `instagramUsername`, attempt subscriber-info resolution via ManyChat's API to upgrade the handle; persist with the numeric handle if resolution fails (non-fatal — the webhook-processor upgrade fixes later).
- **`message_deletions` event** flips `Message.deletedAt + deletedBy=LEAD + deletedSource=INSTAGRAM`.
- **Outbound delivery preference:** when ManyChat is connected, outbound replies go through ManyChat (single delivery carrier for the whole platform). Direct Meta Send API is the fallback for accounts without ManyChat.

### Edge cases

- **The `nickdoesfutures` confirmed bug** ([docs/diagnosis-nickdoesfutures-confirmed.md](diagnosis-nickdoesfutures-confirmed.md)): account had only `igUserId=26566…` and `instagramAccountId=26566…` in metadata; webhook arrived with `entry.id=17841…`; no match → drop. Fix: add `igBusinessAccountId: '17841…'` to credential metadata. This is the same OAuth ID-format bug that hit `daetradez` earlier.
- **Numeric-handle bug** ([docs/diagnostic-numeric-ig-id-bug.md](diagnostic-numeric-ig-id-bug.md)): 56 historical leads have numeric IGSID stored as both `handle` and `platformUserId`. Backfill plan exists at `scripts/backfill-numeric-handles.ts`. Resolvable rate: ~70-80%.
- **New-account ingestion** ([docs/diagnosis-new-account-ingestion.md](diagnosis-new-account-ingestion.md)): edge case where new accounts didn't see inbound messages — verify in functional audit (Phase C).
- **Comment vs DM** (`TriggerType` enum): `COMMENT` triggers come from Instagram comment events; `DM` from direct messages. Story replies and shared media are handled by `extractContentSource()` for content attribution.
- **Story reply / shared media:** `ContentAttribution` captures the `media_id` / `story_id` / shared media reference so the dashboard can show "this lead came from your reel `X`".
- **Echo events** (`is_echo=true`): captured as HUMAN messages from PHONE source — operator typed the reply on Meta's app.

### Cross-module dependencies

- → §1 Account: `IntegrationCredential.metadata` must contain all four ID keys; outbound token routing per `aiProvider` of the account.
- → §3 Leads & Conversations: every webhook event creates/updates Lead + Conversation + Message.
- → §4 AI pipeline: Stage A sits here; Stage K's outbound send returns through this module's send helpers.
- → §6 ManyChat: ManyChat is the preferred outbound carrier on accounts that have it connected; ManyChat handoff webhook also creates conversations.

---

## 6. ManyChat integration

> Spec: [docs/manychat-message-webhook.md](manychat-message-webhook.md), [docs/manychat-complete-webhook.md](manychat-complete-webhook.md). Handoff bug + fix discussion: [docs/handoff-ai-not-delivering-2026-05-06.md](handoff-ai-not-delivering-2026-05-06.md).

### Purpose

ManyChat is the outbound delivery carrier and the inbound automation handoff. Operators run a ManyChat flow that greets new leads (welcome opener, lead-magnet drop, button-based qualification), then hands the conversation to QualifyDMs's AI when the lead is ready for live conversation.

### Inputs

- **`POST /api/webhooks/manychat-handoff?key=<accountWebhookKey>`** — fired by an External Request action in ManyChat at the trigger point (e.g., `User follows your account`, button click, comment-reply trigger). Payload: `{instagramUserId, instagramUsername, manyChatSubscriberId, openerMessage, triggerType, leadResponseText?}`.
- **`POST /api/webhooks/manychat-message`** — every inbound DM that hits ManyChat is forwarded here so QualifyDMs has the full message history. Same `X-QualifyDMs-Key` header.
- **`POST /api/webhooks/manychat-complete`** — fired when the ManyChat outbound flow finishes; explicit handoff signal that lets the AI pick up immediately (vs the 5-minute time-based fallback).

### Outputs

- Conversations created with `source=MANYCHAT`, populated `manyChatOpenerMessage`, `manyChatTriggerType`, `manyChatCommentText`, `manyChatFiredAt`.
- AI opener suppressed (ManyChat already greeted); `outbound_context` block injected in system prompt.
- Outbound AI replies delivered via ManyChat's Send API.

### Workflows

1. **Per-account webhook key auth** — every ManyChat webhook URL ends with `?key=<Account.manyChatWebhookKey>` (a UUID generated at Account creation, `prisma/schema.prisma:230`). The handler resolves Account by key. Header `X-QualifyDMs-Key` is the same value (per `docs/manychat-message-webhook.md` and `manychat-complete-webhook.md`).
2. **Handoff at trigger time** — operator places an External Request block in the ManyChat flow at the earliest point (`User follows your account`) so 100% of leads are captured (button-click only captures ~1.6%). Payload omits `leadResponseText` if the lead hasn't replied yet.
3. **Conversation creation** — `processManyChatHandoff` resolves Account by webhook key, resolves the IG handle (subscriber-info API fallback if numeric), creates Lead + Conversation, sets `Conversation.source=MANYCHAT`, suppresses AI opener, persists the ManyChat-side opener as a Message with `sender=MANYCHAT, msgSource=MANYCHAT_FLOW`.
4. **Inbound message forwarding** — every lead reply hitting ManyChat fires `manychat-message` webhook → persisted with `sender=LEAD`. Conversation's `lastMessageAt` and `unreadCount` are bumped (per memory invariant) — else dashboard hides the conversation.
5. **Completion handoff** — when the ManyChat flow ends, `manychat-complete` webhook flips the conversation to AI-managed mode immediately. Without it, a 5-min time-based fallback still kicks in (~60s vs 5min).
6. **Outbound delivery** — when QualifyDMs's AI generates a reply, the delivery layer sends via ManyChat's Send API, not direct Meta Send. ManyChat is the only delivery carrier for outbound DMs once connected.

### Business rules

- **`manyChatWebhookKey` is account-unique** (`prisma/schema.prisma:230`, `@unique @default(uuid())`). Auth = key match. *(OQ-11: confirm key rotation policy — is there a UI-driven re-roll, or is rotation manual via DB?)*
- **MessageSource provenance:** `sender='MANYCHAT'` alone can't distinguish a hardcoded ManyChat welcome flow from an AI-generated reply ManyChat is delivering. `msgSource` records the *authoring* origin: `MANYCHAT_FLOW` (hardcoded ManyChat block), `QUALIFYDMS_AI` (AI), `HUMAN_OVERRIDE` (operator typed).
- **Handoff invariant:** every Direct Message insert via ManyChat MUST bump `Conversation.lastMessageAt` and `unreadCount` — else dashboard hides the convo (per memory `manychat_handoff_lastmessageat`).
- **5-minute fallback:** if `manychat-complete` doesn't fire (operator didn't add the block, or it failed), a time-based fallback in the ManyChat-source detection logic still hands off to the AI after ~5 minutes.
- **Numeric-handle resolution at handoff:** if `instagramUsername` is purely numeric (12+ digits), call ManyChat's `findSubscriberById` API to get the real `ig_username` before persisting the Lead. Non-fatal — falls through to webhook-processor upgrade if API call fails.

### Edge cases

- **Late lead replies before AI takeover:** a lead can reply to the ManyChat flow's last message before `manychat-complete` fires. Inbound `manychat-message` webhook records the reply; when AI takes over, it sees full ManyChat history.
- **Operator skips the ManyChat external request block** (per [handoff-ai-not-delivering-2026-05-06.md](handoff-ai-not-delivering-2026-05-06.md)): only ~1.6% of leads handoff because the block sits behind a button click. Operator must add an upfront block at the trigger point (`User follows your account`) — operator config, not code.
- **`Retry on failure` flag** on the ManyChat External Request setting: must be enabled, else transient handoff failures drop leads silently.
- **Cross-account key collision:** webhook key is `@unique` so collisions are DB-impossible, but if an Account is deleted and a stale ManyChat config retains the key, the next request 404s. *(OQ-12: confirm graceful 404 message + alerting on stale-key requests.)*

### Cross-module dependencies

- → §1 Account: `manyChatWebhookKey` per Account.
- → §3 Leads & Conversations: every handoff creates a Conversation with `source=MANYCHAT`.
- → §4 AI pipeline: ManyChat handoff suppresses the AI opener; the system prompt injects `<outbound_context>` so the AI knows ManyChat already greeted.
- → §5 Instagram: ManyChat is the outbound carrier when connected; numeric-handle resolution can call ManyChat or fall back to Meta Conversations API.


---

## 7. Closer / handoff workflow

### Purpose

Move a qualified lead from AI-managed conversation to a booked, confirmed call attended by a human closer; track outcome through to revenue. The AI's job ends when the call is confirmed; the human closer takes over for the call itself; the system tracks whether the lead showed, whether they closed, and how much revenue.

### Inputs

- AI-flagged events (call booked, distress, scheduling conflict, AI stuck, hot lead) → notifications + dashboard surfacing.
- Operator dashboard actions (manual override, take-over, scheduling edits, tag application, team note, AI on/off toggle).
- External: LeadConnector / Calendly / Cal.com booking confirmations; Typeform application submissions; manual CRM-outcome updates.

### Outputs

- `Lead.stage` progression through 14 states (`LeadStage` enum).
- Booked + confirmed call (`Conversation.scheduledCallAt`, `callConfirmed`).
- Pre-call reminders + post-call no-show / reschedule handling.
- Revenue + close attribution (`Lead.revenue`, `Lead.closedAt`, `CrmOutcome`).
- Closer commission tracking (`User.commissionRate`, `totalCommission`, `closeRate`).

### Workflows

1. **Lead-stage progression** (`LeadStage` enum, 14 values): `NEW_LEAD → ENGAGED → QUALIFYING → QUALIFIED → CALL_PROPOSED → BOOKED → SHOWED → NO_SHOWED | RESCHEDULED → CLOSED_WON | CLOSED_LOST | UNQUALIFIED | GHOSTED | NURTURE`. Every transition writes a `LeadStageTransition` row with `transitionedBy: 'ai' | 'user' | 'system'` + free-text reason.
2. **Booking** (Stage 7 of the AI's 7-stage SOP): AI collects timezone → email → phone → offers `proposedSlots[]` → confirms `selectedSlot` → calls LeadConnector to book → persists `bookingId` (or `bookingUrl` fallback). Stage flips to `BOOKED`.
3. **Pre-call sequence**: `AIPersona.preCallSequence` JSON `[{timing, message}]` (typically: night before, morning of, 1 hour before). Each step queues a `ScheduledMessage` of the matching type (`DAY_BEFORE_REMINDER`, `MORNING_OF_REMINDER`, `CALL_DAY_CONFIRMATION`, etc.).
4. **Call-day confirmation**: `callConfirmed` flips when the lead replies affirmatively to a confirmation reminder. `notifyOnCallBooked` fires.
5. **Outcome capture**: closer marks `callOutcome = SHOWED | NO_SHOWED | RESCHEDULED` after the call. Stage moves to `SHOWED` / `NO_SHOWED` / `RESCHEDULED` accordingly. `CrmOutcome` row captures `{showed, closed, dealValue, closeReason}` with `closeReason ∈ {ENROLLED | NOT_READY | CANT_AFFORD | NO_SHOW | OTHER}`.
6. **No-show protocol** (`AIPersona.noShowProtocol` JSON `{firstNoShow, secondNoShow, maxReschedules}`): on `NO_SHOWED`, AI sends the configured first-no-show message; on second no-show, maxReschedules cap kicks in; further misses → `Lead.stage=GHOSTED` or `UNQUALIFIED`.
7. **Close**: `CLOSED_WON` writes `Lead.revenue`, `Lead.closedAt`. Notification `CLOSED_DEAL` fires. Closer commission accrues (`User.totalCommission += revenue * commissionRate`, *if commission tracking is enabled — OQ-13*).
8. **Soft exit**: 3 specific guardrail conditions (per system prompt's SOFT EXIT GUARD RAILS section in `MASTER_PROMPT_TEMPLATE`) where the AI can politely close out the conversation without a call (e.g., lead explicitly says no, lead is unqualified by capital gate, lead is out of geographic scope). Stage flips to `UNQUALIFIED` or `NURTURE`.
9. **Ghost re-engagement**: silence > `Account.ghostThresholdDays` (default 7) → AI emits a re-engagement message (`SCHEDULED_MESSAGE.RE_ENGAGEMENT` or `FOLLOW_UP_1/2/3`); on no reply, `Lead.stage=GHOSTED`.
10. **Human override / take-over**: operator types in dashboard → `Message.sender=HUMAN, msgSource=HUMAN_OVERRIDE, isHumanOverride=true`. If a pending AISuggestion existed, `rejectedAISuggestionId` links to it (or `editedFromSuggestion=true` if text similarity > 0.7). Optional `humanOverrideNote` records 1-line reason. AI is paused on the conversation if operator flips `aiActive=false`. `notifyOnHumanOverride` fires.

### Business rules

- **Closer name in prompts:** `AIPersona.closerName` is the name the AI uses when referring to "who you'll be talking to." Phase 6 of the security sprint adds a separate `callHandoffName` field so the prompt scrubs the hardcoded "Anthony" reference (per audit F1.3).
- **Suggestion-review banner UX:** when not auto-sending (account in test-mode for that platform), the AI's reply is held as `AISuggestion`. Banner gives the operator: ship verbatim (`manuallyApproved=true, editedByHuman=false`), edit (`editedByHuman=true, humanEditedContent=…`), or dismiss (`dismissed=true, actionedAt=now`). `TrainingEvent` rows track per-platform approval rate; gates the "ready to enable auto-send" prompt.
- **AISuggestion outcome auto-tracking:** on operator override, `wasRejected=true`. If text similarity to suggestion > 0.7, `wasEdited=true`. `finalSentText` records the actually-sent content; `similarityToFinalSent` is the cosine similarity.
- **`HUMAN_OVERRIDE_NEEDED` notification** fires when the AI hits a guard it can't resolve (e.g., distress, scheduling conflict, R27 verified-details gap). Surfaces as URGENT in the Action Required dashboard.
- **`HUMAN_OVERRIDE` flag is permanent:** once a human types in a conversation, `Message.isHumanOverride=true` for that message. Used by the analytics layer to compute "AI vs human ratio" per conversation and per closer.
- **TeamNote:** operator-typed note attached to a Lead, scoped by `accountId`. Visible in dashboard sidebar.
- **Notifications scope:** Notifications are per-Account (`accountId`); URGENT types email account owner; ACTIVITY types in-app only. Per-user mute is *not* currently supported. *(OQ-14: confirm whether per-user notification preferences are out of scope or planned.)*
- **Commission tracking:** `User.commissionRate` (percentage) and `totalCommission` (lifetime) live on User. *(OQ-15: confirm — is commission auto-computed on every CLOSED_WON, or is it manual? `closeRate` and `callsBooked` similarly need a populator path.)*

### Edge cases

- **Booking limbo** (`notifyOnBookingLimbo`): booked but not confirmed for 24h → ACTIVITY notification.
- **Scheduling conflict at `CALL_PROPOSED`** (per §3): set `Conversation.schedulingConflict=true`, parse `schedulingConflictPreference` from the lead's message, fire URGENT notification + email.
- **Reschedule** drops back to `CALL_PROPOSED` from `BOOKED`; `noShowProtocol.maxReschedules` caps how many times before the lead is given up on.
- **AI takeover after human:** if an operator typed but didn't disable AI, the next inbound lead reply re-arms the AI. Operator must explicitly toggle `aiActive=false` to lock out the AI.
- **`Message.isHumanCorrection=true`** (per §3): operator unsent an AI message and replaced it with a corrected manual send within 2 minutes. AI prompt builder injects "[Operator correction]" so the AI treats the corrected message as canonical. Unsent message is soft-deleted.
- **Closer takes over mid-call-day**: operator typing → next reminders pause? *(OQ-16: confirm whether scheduled reminders cancel automatically when human takes over, or whether they continue firing.)*
- **Capital-verification override** (`MANUALLY_OVERRIDDEN`): closer can manually mark a lead as capital-verified to bypass R24 — used when verification happened off-DM (call, email, etc.).

### Cross-module dependencies

- → §1 Account: notification preferences, away-mode master switches.
- → §3 Leads & Conversations: stage progression, scheduled-call state, AISuggestion lifecycle.
- → §4 AI pipeline: human override flips `aiActive`; suggestion mode produces AISuggestion + TrainingEvent rows.
- → §8 Training data: every override is a training signal (`isHumanOverride`, `humanOverrideNote`, `editedFromSuggestion`).
- → §11 Scheduling: pre-call reminders + ghost re-engagement use `ScheduledMessage`.


---

## 8. Training data

### Purpose

Capture the closer's voice and the persona's qualification logic from real conversations, then surface those as few-shot examples to the live AI engine. Two sources feed the training corpus: (a) **historical chat exports** uploaded as PDFs/text files (`TrainingUpload` → `TrainingConversation` → `TrainingMessage`), and (b) **runtime operator actions** during the suggestion-review test mode (`TrainingEvent` rows on every approve / edit / reject).

### Inputs

- **Onboarding upload**: operator drops a PDF/text export of past sales DMs. System hashes (`fileHash`) for dedup, parses to `TrainingConversation` rows + per-message `TrainingMessage` rows, runs an LLM analyzer to populate `leadType`, `dominantStage`, `primaryObjectionType` per conversation.
- **Hand-curated examples**: operator types a `(leadMessage, idealResponse)` pair into `TrainingExample` (per-category: `GREETING | QUALIFICATION | OBJECTION_TRUST | OBJECTION_MONEY | OBJECTION_TIME | …`).
- **Runtime suggestion-review actions**: every banner click in test mode produces a `TrainingEvent` (`APPROVED | EDITED | REJECTED`), preserving `originalContent` (the AI's suggestion) and `editedContent` (what the operator actually shipped).
- **Inbound qualification classification**: on first AI turn, `InboundQualification` row records what the classifier extracted (experience, pain, goal, urgency, financial info, intent) so the AI doesn't re-ask. *Effectively another training-signal stream — the classifier's hits and misses are visible per-conversation.*

### Outputs

- A persona-scoped corpus of training examples available to the few-shot retriever (Stage F of the AI pipeline).
- Per-platform approval-rate metric (`TrainingEvent` aggregates) gating the "ready to enable auto-send" admin prompt.
- Operator-visible training-readiness signals (`Account.trainingPhase`, `trainingOverrideCount`, `trainingTargetOverrideCount`).

### Workflows

1. **Upload pipeline** (`UploadStatus` enum: `PENDING → PROCESSING → ANALYZED → COMPLETE | FAILED`):
   - Operator uploads file → `TrainingUpload` row with `fileHash` for dedup.
   - Parser extracts conversations + messages → `TrainingConversation` + `TrainingMessage` rows.
   - Analyzer (LLM) classifies each conversation: `leadType`, `dominantStage`, `primaryObjectionType`, `outcomeLabel` (`HARD_NO | SOFT_NO | SHOWED | BOOKED | CLOSED | UNKNOWN`).
   - Per-message classifier populates `stage` and `objectionType`.
   - Embedding generator computes `embeddingVector` (OpenAI `text-embedding-3-small`, 1536-dim) for **lead messages only** (the lookup key).
2. **Few-shot retrieval at runtime**: 3-tier metadata-filtered cosine ranking against `TrainingMessage.embeddingVector`. (See §4 Stage F.) Currently scoped by `accountId` only — Phase 5 fix adds `personaId` filter (audit F3.3).
3. **Hand-curated examples** populate `TrainingExample` directly (no upload needed). Used as supplementary fallback in retrieval. *Currently filtered by `accountId` only at [src/lib/ai-prompts.ts:1533](src/lib/ai-prompts.ts:1533) — F3.3 fix applies here too.*
4. **Suggestion-review feedback loop**: in test mode (account in `awayMode<Platform>=false` but `aiActive` enabled per-conversation), every operator action on the banner writes a `TrainingEvent`. Aggregated approval rate per platform = "training adequacy" signal.
5. **Closed-loop training during onboarding**: `Account.trainingPhase=ONBOARDING`. Each `TrainingEvent` of type `APPROVED` increments `Account.trainingOverrideCount`. When that hits `Account.trainingTargetOverrideCount` (default 20), system surfaces "ready to enable auto-send" recommendation.
6. **Inbound qualification classifier**: first AI turn calls a classifier that reads opening messages and emits `InboundQualification` row with `suggestedStartStage`, `finalStartStage`, `stagesSkipped`, extracted data points (`hasExperience`, `experienceLevel`, `hasPainPoint`, `painPointSummary`, etc.). Skip-cap clamps overly-aggressive skips (`capped=true`).
7. **Voice-quality failure tracking**: `VoiceQualityFailure` rows captured on every gate retry — feeds future prompt-tuning analysis.

### Business rules

- **Tenancy:** `TrainingExample` and `TrainingConversation` carry `personaId` (already populated). `TrainingMessage` inherits via Conversation. Retrieval queries MUST filter by `{accountId, personaId}` (audit F3.3 — Phase 5 fix).
- **Dedup:** `TrainingUpload` is unique on `(accountId, fileHash)`. `TrainingConversation` is unique on `(accountId, contentHash)`. Re-uploading the same PDF or pasting an already-imported conversation is a no-op.
- **Embedding generation:** **lead messages only** — the AI looks up "what did past leads say similar to this?" Closer messages aren't embedded.
- **Outcome filtering at Tier 3** (vector fallback): excludes `HARD_NO` and `UNKNOWN` outcomes, so the retriever never proposes a closer reply that came from a doomed conversation.
- **TrainingEvent vs AISuggestion outcome fields:** `AISuggestion.wasSelected/wasRejected/wasEdited` track auto-send mode; `TrainingEvent` only fires in test-mode (manual-review) and scopes by platform for the per-platform readiness check. They're complementary, not redundant.
- **`HumanOverrideNote` lives on Message** (audit F7.3 PASS): no separate model. Inherits scope through Message → Conversation → Lead → Account → personaId (post-F4.2).
- **`InboundQualification` is one row per conversation** (`@unique conversationId`), written on the first AI turn. Subsequent turns read this row instead of re-classifying.

### Edge cases

- **Re-upload after persona switch:** uploading the same PDF under a different persona produces a new `TrainingUpload` (different `personaId` though same `fileHash` — *(OQ-17: confirm — does the unique on `(accountId, fileHash)` block this, or does the unique need to be `(accountId, personaId, fileHash)`? Currently it's account-level, which would block re-classification under a different persona.)*
- **Analyzer failure:** `TrainingConversation.analyzedAt` null → entry is parsed but not metadata-classified. Tier 1 + Tier 2 retrieval skip these; Tier 3 vector fallback still picks them up. *Operator visibility: any UI surfacing of "training corpus health"?*
- **Embedding regeneration:** if the embedding model changes (e.g., `text-embedding-3-small` → newer), all training messages need re-embedding. *(OQ-18: confirm there's a re-embedding script or backfill path; otherwise model swaps silently degrade retrieval quality.)*
- **Insufficient training corpus:** when Tier 1/2/3 all return < 3 examples, the system prompt's few-shot block is just empty — the AI generates without examples. *(OQ-19: confirm minimum-examples threshold; should we surface a "training corpus too small" warning when retrieval comes back empty?)*
- **Cross-persona contamination (current critical bug):** Persona A's hand-curated examples appear in Persona B's prompt context (audit F3.3) — Phase 5 fix.

### Cross-module dependencies

- → §1 Account: `trainingPhase`, `trainingOverrideCount`, `trainingTargetOverrideCount`.
- → §2 Personas: `TrainingExample`, `TrainingUpload`, `TrainingConversation` all carry `personaId`.
- → §4 AI pipeline: Stage F retrieves training examples; Stage K writes back `AISuggestion` + `TrainingEvent`.
- → §7 Closer/handoff: every operator action in suggestion-review banner creates a `TrainingEvent`.


---

## 9. Admin dashboard

> Plans: [docs/admin-dashboard-phase-1-plan.md](admin-dashboard-phase-1-plan.md), [docs/admin-dashboard-phase-2-plan.md](admin-dashboard-phase-2-plan.md), [docs/nav-rbac.md](nav-rbac.md), [docs/clerk_setup.md](clerk_setup.md), [docs/themes.md](themes.md).

### Purpose

Two distinct dashboards: (a) **operator dashboard** at `/dashboard/*` — the day-to-day surface where each Account's team manages conversations, leads, personas, training, voice notes, and analytics for *their* tenant; (b) **super-admin dashboard** at `/admin/*` — Tega-only platform overview that lists all tenant Accounts, runs health checks, and drives the onboarding wizard for new clients.

### Inputs

- Clerk session → `User` row → `AuthContext { userId, accountId, role }` via [src/lib/auth-guard.ts](src/lib/auth-guard.ts).
- Real-time SSE broadcasts: `broadcastNewMessage`, `broadcastConversationUpdate`, suggestion-banner events.
- API routes under `/api/dashboard/*` and `/api/admin/*`.

### Outputs

- Operator UI for conversation management, persona config, training, analytics, billing.
- Super-admin UI for cross-tenant overview, account health, onboarding new tenants, AdminLog audit trail.
- Cross-cutting UX: theme switcher (light/dark), navigation RBAC, suggestion-review banner.

### Workflows

#### Operator dashboard (`/dashboard/*`)

Pages today (from `find src/app/dashboard -name page.tsx`):

- `/dashboard` — overview (stats: leads, calls, revenue, deal flow).
- `/dashboard/conversations` — conversation list + thread view, AI suggestion banner, manual send composer, voice-note attach, unsend.
- `/dashboard/leads` + `/dashboard/leads/[id]` — leads table + per-lead profile.
- `/dashboard/pipeline` — Kanban-style stage progression view (top-level `/pipeline` route).
- `/dashboard/analytics/*` — six sub-pages: top-level `analytics`, `live`, `team`, `deep-dive`, `predictions`, `optimizations`, `ab-tests`.
- `/dashboard/content` — content attribution (`ContentAttribution` rows) showing which reels/posts are converting.
- `/dashboard/team` — team members + closer commission stats.
- `/dashboard/voice-notes` + `/dashboard/voice-notes/[id]` + `/dashboard/voice-notes/timing` — voice-note library + per-item editor + timing settings.
- `/dashboard/onboarding` — operator-side onboarding (per-tenant; distinct from super-admin onboard wizard).
- `/dashboard/profile/[[...profile]]` — Clerk-native user profile.
- `/dashboard/settings/account` — account settings (away mode toggles, response timing, distress detection toggle, notification prefs).
- `/dashboard/settings/billing` — Clerk-billing for B2B subscriptions.
- `/dashboard/settings/integrations` — OAuth connect for IG, FB, Calendly, Cal.com, ManyChat, ElevenLabs, OpenAI, Anthropic, Typeform, LeadConnector.
- `/dashboard/settings/notifications` — 12 notification toggles.
- `/dashboard/settings/persona` + `/dashboard/settings/persona/[scriptId]` + `/dashboard/settings/persona-editor` — persona editor + parsed-script per-step editor.
- `/dashboard/settings/training` + `/dashboard/settings/training/analysis` — training corpus uploader + analysis.
- `/dashboard/settings/tags` — tag management (custom tag CRUD + colors).

#### Super-admin dashboard (`/admin/*`)

Phase 1 (Tega-only platform overview):
- `/admin` — summary cards + accounts table; filters (All / Healthy / Warning / Critical); per-row [View] [Pause AI] [Edit Plan]. Phase 1 wires only [View]; others gated to Phase 3 with tooltip.
- `/admin/accounts/[id]` — sections A (account info) + B (computed health checks via `src/lib/admin-health.ts`) + C (30-day stats). Sections D/E/F deferred.

Phase 2 (onboarding wizard, ships today's spec):
- `/admin/onboard` — landing: lists in-progress wizards + "Start new" button.
- `/admin/onboard/new` — Step 1 form (creates Account + User + AIPersona on submit).
- `/admin/onboard/[accountId]/step/[n]` — Steps 2-6 (n in {2,3,4,5,6}). Progress = `Account.onboardingStep`. Step 6 sets `onboardingComplete=true`, `awayModeInstagram/Facebook=true`, writes `AdminLog` row, redirects to `/admin/accounts/[id]`. Resume: visiting `/admin/onboard/[accountId]` redirects to the step matching `onboardingStep`.

#### Phase 3 (deferred):
Per-account [Pause AI] / [Edit Plan] / impersonation actions; AdminLog viewer; cross-tenant search; admin-side suggestion review.

### Business rules

- **Auth & access** ([src/lib/auth-guard.ts](src/lib/auth-guard.ts)):
  - `requireAuth(request)` → resolves Clerk session → User → `AuthContext`.
  - `requireSuperAdmin` and `requirePlatformAdmin` enforce platform-operator roles (`SUPER_ADMIN` / `MANAGER`).
  - `canAccessAccount(auth, accountId) = isPlatformOperator || auth.accountId === accountId`.
  - `scopedAccountId(auth, requestedAccountId)` substitutes the requested accountId only when called by a platform operator (prevents tenant-A operator from spoofing tenant-B's scope).
- **Roles in nav-config** (`src/config/nav-config.ts`): nav items have an `access` property (`requireOrg`, `permission`, `role`). Filtering is **fully client-side** via `useNav` hook ([src/hooks/use-nav.ts](src/hooks/use-nav.ts)) — UX-only, not security. Real auth runs server-side per route.
- **Clerk Organizations** = the multi-tenant primitive on the Clerk side; mapped to `Account` in our DB. `User.role` mirrors Clerk org-membership role.
- **`SUPER_ADMIN` is set via script only** (`scripts/promote-tega-super-admin.ts`); never assigned via UI. `MANAGER` is assignable via admin UI in a later phase.
- **Onboarding wizard is super-admin gated** today (`/api/admin/onboard/*`). Per OQ-1, self-serve sign-up may or may not be in scope.
- **Theme** (`docs/themes.md`): light/dark theme switcher, persisted per-user. *(OQ-20: confirm where theme preference is stored — Clerk user metadata, localStorage, DB?)*
- **Suggestion-review banner** is rendered per-conversation when `Account.showSuggestionBanner=true` AND there's a pending un-`actionedAt` `AISuggestion` for that conversation.
- **Real-time updates:** SSE channel per accountId broadcasts `newMessage`, `conversationUpdate`, `suggestionGenerated`, `notification` events. Subscribed by every page that shows live data.
- **AdminLog audit trail** captures every super-admin action against a tenant (`impersonate.start`, `account.pause_ai`, `plan.change`, `persona.edit`, `account.delete`). Queried by Phase 3 admin viewer.

### Edge cases

- **Tenant operator visiting `/admin/*`**: `requireSuperAdmin` rejects → redirect to `/dashboard`. Not a 403 because that would leak the existence of admin routes; redirect is silent.
- **Stale Clerk session vs deleted User row**: cleanup script needed. *(OQ-21: confirm what happens if a Clerk user exists without a matching DB User row — is there a sync hook?)*
- **Dashboard "AI Auto-Send Off" but operator expects auto-send**: confusing UX. The 3 layers (`Account.awayMode<Platform>`, `Conversation.aiActive`, `Conversation.autoSendOverride`) compound. *(OQ-22: confirm whether the dashboard surfaces a "why isn't AI sending?" diagnostic, since this is the most common operator confusion.)*
- **Cross-tenant impersonation by `MANAGER`**: scope is "view/action all tenant conversations" but not billing. Confirm scope boundary in code.
- **Multiple personas in account, dashboard view** (post-F4.2): conversation row should display which persona owns it. *(OQ-23: confirm dashboard surfaces `Conversation.personaId` so operators don't have to guess which persona is replying.)*

### Cross-module dependencies

- → §1 Account: `auth-guard.ts` resolves accountId from Clerk session.
- → §3 Leads & Conversations: every `/dashboard/conversations` interaction reads/writes the conversation state machine.
- → §4 AI pipeline: suggestion-review banner is the dashboard surface for the test-mode review loop.
- → §7 Closer/handoff: human override actions originate in the conversation thread UI.
- → §8 Training data: `/dashboard/settings/training` is the upload + curation surface.


---

## 10. Operational primitives

### Purpose

Cross-cutting capabilities every other module relies on: notifications, tags, content attribution, distress safety, RLS / row-level security, real-time SSE, observability, prompt versioning + AB testing, and analytics scoring.

### Inputs

- AI pipeline events, operator actions, cron jobs, external webhooks (Typeform, calendar callbacks, CRM updates).

### Outputs

- Operator notifications, tag-based filtering, content-source attribution rollups, prompt-version performance tracking, AB-test assignments + outcomes.

### Sub-systems

#### 10.1 Notifications

- `Notification` model: `accountId`, optional `userId` (null = team-wide), optional `leadId`. 8 types (`NotificationType`): `CALL_BOOKED`, `HOT_LEAD`, `HUMAN_OVERRIDE_NEEDED`, `NO_SHOW`, `CLOSED_DEAL`, `NEW_LEAD`, `SYSTEM`, `TEAM_NOTE`.
- 12 toggle preferences on Account (split into URGENT / ACTIVITY / EMAIL REPORTS — see §1).
- URGENT types email account owner (`User.email`); ACTIVITY in-app only.

#### 10.2 Tags

- `Tag` per Account (`@unique [accountId, name]`); `LeadTag` join with `appliedBy` (`userId | "AI"`) and `confidence` (0-1).
- `Tag.isAuto` distinguishes AI-generated from operator-curated.
- AI auto-tags applied after each conversation when confidence > 0.7 (per ROADMAP acceptance criteria).
- Operator can create custom tags with name + color (`#6B7280` default).

#### 10.3 Content attribution

- `ContentAttribution`: per `(accountId, contentId, platform)`. Captures `contentType ∈ {REEL, STORY, POST, LIVE, AD, COMMENT_TRIGGER, DM_DIRECT}`, `contentUrl`, `caption`, `postedAt`. Denormalized rollups: `leadsCount`, `revenue`, `callsBooked`.
- Webhook extraction in `src/lib/webhook-processor.ts`: IG comment → `media_id`; story reply → `story_id`; DM with shared media → shared media reference.
- Used by `/dashboard/content` to show "this reel converted X leads / $Y".

#### 10.4 Distress / crisis detection

- Account-level `distressDetectionEnabled=true` (DB-only toggle, not UI).
- Inbound lead messages scanned against `DISTRESS_PATTERNS` BEFORE the AI pipeline.
- On match: `Conversation.distressDetected=true` (permanent), `distressDetectedAt`, `distressMessageId`. AI paused. Supportive (non-sales) reply path injected. URGENT notification fires.
- Re-enabling AI later still injects "soft check-in, no pitch" override.

#### 10.5 Row-Level Security (RLS)

- Postgres RLS policies enforce `accountId` scoping at the DB layer (per memory `Multi-Tenant Leak Audit`). Operator scripts in `scripts/` include RLS verification (`scripts/verify-rls.ts` or similar). *(OQ-24: confirm RLS is currently enabled in prod — the multi-tenant audit's primary layer is application-level scoping; RLS is the belt-and-suspenders.)*

#### 10.6 Real-time SSE broadcasts

- Per-`accountId` SSE channel. Events: `newMessage`, `conversationUpdate`, `suggestionGenerated`, `notification`.
- Subscribed by every dashboard page that shows live state.
- Not authenticated separately — relies on the auth middleware that gates the `/api/sse` endpoint.

#### 10.7 Prompt versioning + AB testing

- `PromptVersion`: `(accountId, version)` unique; `promptHash` = SHA-256 of rendered prompt (minus lead-specific vars). `appliedBy ∈ {ADMIN, STAGING_AUTO}`. `performanceBefore/After` JSON tracks `{bookingRate, responseRate, avgTimeToBook}`.
- `ABTest` (status `RUNNING | COMPLETED | PAUSED`) + `ABTestAssignment` (per-Lead) + `OptimizationSuggestion` (status `OptimizationStatus`) + `PredictionModel` + `PredictionLog` — the self-optimizing layer.

#### 10.8 Scoring + effectiveness back-fill

- `priorityScore` (0-100) on Conversation, recalculated on each new message via `runPostMessageScoring()`.
- Per-message `gotResponse`, `leadContinuedConversation`, `responseTimeSeconds` back-filled when the lead replies to an AI message — drives "what AI moves work?" analytics.
- `Message.stage`, `subStage`, `stageConfidence`, `sentimentScore`, `experiencePath`, `objectionType`, `stallType` all populated by AI's structured response or post-classifier.

#### 10.9 Cost + latency observability

- `Account.monthlyApiCostUsd` (Decimal): cached 30-day rollup, refreshed by health-check job.
- `AISuggestion.modelUsed`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`: per-suggestion cost trace.
- `MediaProcessingLog`: per-media `latencyMs`, `success`, `errorMessage`, `transcriptionLength`, `costUsd`.
- `VoiceQualityFailure`: every gate retry logs reason + soft-score breakdown.
- `SilentStopEvent` + `SelfRecoveryEvent`: pipeline-level error/recovery telemetry.
- *No external observability tool referenced in repo (no Sentry / DataDog / OpenTelemetry config visible). (OQ-25: confirm log destination — Vercel logs only? Or is there something else?)*

#### 10.10 "Clear conversation" reset command

- Literal `"clear conversation"` DM (per memory) wipes conversation messages, resets lead state, cancels pending `ScheduledReply` rows. Used internally for testbrand123 staging tests. Returns `skipReply: true`.

### Business rules

- **Tenancy** for every primitive above is `accountId`. Notifications can additionally be user-scoped.
- **Audit trail integrity:** `Notification`, `Tag`, `ContentAttribution`, `PromptVersion`, `ABTest*` all `onDelete: Cascade` from Account — they don't survive Account deletion. `LeadStageTransition` cascades from Lead. `AdminLog` is the only cross-tenant audit that survives target-Account deletion (`onDelete: SetNull`).
- **AI auto-tagging confidence threshold = 0.7** (per ROADMAP). Below threshold, the tag isn't applied.
- **Distress detection cannot be UI-toggled** (safety feature; only DB-disable possible).

### Edge cases

- **Notifications for deleted Lead:** `Notification.lead` is `onDelete: SetNull` — notification persists but loses link.
- **Stale prompt-version performance data:** if AB test ends mid-flight (status flipped to `PAUSED`), `performanceAfter` may be partially populated. *(OQ-26: confirm stop-loss policy on PromptVersion stats — what counts as "sufficient data"?)*

### Cross-module dependencies

- → All other modules. This is the cross-cutting layer.

---

## 11. Scheduling & timing

### Purpose

Two distinct queues: (a) **`ScheduledReply`** — debounced reply-to-lead pipeline (Stage D of the AI pipeline); (b) **`ScheduledMessage`** — SYSTEM-initiated outbound touches tied to calendar events or conversation state (call reminders, keepalives, re-engagement).

### Inputs

- Inbound lead message → debounced reply queued in `ScheduledReply`.
- Booking event → pre-call sequence rendered into `ScheduledMessage` rows.
- Silence > ghost threshold → re-engagement queued.
- Operator manually scheduling a custom message.

### Outputs

- Outbound delivered messages (text or voice note) sent at `scheduledFor` time via the delivery layer.
- Pre-call reminder series ("night before", "morning of", "1 hour before") and post-no-show follow-ups.

### Workflows

1. **`ScheduledReply`** ([prisma/schema.prisma:1556](prisma/schema.prisma:1556)): per-lead debounced reply queue. Status: `PENDING → PROCESSING → SENT | CANCELLED | FAILED`. `messageType ∈ {'text', 'voice_note', null}`. `generatedResult` JSON pre-stores the AI's pre-generation result (for VN-aware path). Per-minute cron picks up `WHERE status='PENDING' AND scheduledFor <= now`.
2. **`ScheduledMessage`** ([prisma/schema.prisma:1616](prisma/schema.prisma:1616)): SYSTEM-initiated outbound. `ScheduledMessageType` covers 13 cases: `DAY_BEFORE_REMINDER`, `MORNING_OF_REMINDER`, `PRE_CALL_HOMEWORK`, `CALL_DAY_CONFIRMATION`, `CALL_DAY_REMINDER`, `WINDOW_KEEPALIVE`, `RE_ENGAGEMENT`, `CUSTOM`, `FOLLOW_UP_1/2/3`, `FOLLOW_UP_SOFT_EXIT`, `BOOKING_LINK_FOLLOWUP`. Status state machine: `PENDING → FIRING (optimistic lock) → FIRED | CANCELLED | FAILED`. `createdBy ∈ {SYSTEM, HUMAN, AI}`.
3. **Pre-call sequence rendering**: when a Conversation flips to `BOOKED`, a render job creates the persona's configured `preCallSequence` entries as `ScheduledMessage` rows tied to `relatedCallAt = scheduledCallAt`.
4. **Reschedule handling**: when `scheduledCallAt` shifts, the system uses the denormalized `relatedCallAt` to find + cancel stale reminders + render new ones.
5. **Voice-note timing settings** (`VoiceNoteTimingSettings`): per-account `minDelay/maxDelay` (default 10/60 seconds) — independent from AI persona text delay.
6. **Booking-link follow-up**: when calendar provider has a `bookingUrl` fallback (vs server-side booking), `BOOKING_LINK_FOLLOWUP` chases the lead if they haven't clicked.
7. **Window keepalive**: long-running Stage E waits (lead in QUALIFYING for many hours) trigger `WINDOW_KEEPALIVE` to keep Meta's 24-hour messaging window open.
8. **Soft-exit follow-up** (`FOLLOW_UP_SOFT_EXIT`): the AI's last word-pick after a soft exit; nudges the lead one last time at a configured delay before final ghost.

### Business rules

- **Two distinct queues:** `ScheduledReply` is debounced replies. `ScheduledMessage` is system-initiated touches. They DO NOT share state — both can fire on the same conversation in the same minute.
- **`generateAtSendTime=true`** on `ScheduledMessage` (default): regenerate the message body at send time (so reminders pick up the latest persona context). When false, the operator-prepared `messageBody` ships verbatim.
- **Cancel-on-reschedule:** updating `Conversation.scheduledCallAt` triggers cancellation of all `ScheduledMessage WHERE relatedCallAt = oldCallAt`. Then the new `relatedCallAt` series is rendered. Implemented via `relatedCallAt` index.
- **Inline vs cron threshold = 90s** for `ScheduledReply`. `ScheduledMessage` is always cron-driven (no inline path).
- **Optimistic lock via `FIRING`:** the cron picks up a row, flips status `PENDING → FIRING`, then `FIRED`/`FAILED`. Two-cron-instance race is impossible because the state transition is atomic.
- **Account-level response-delay** (per [docs/response-delay-fix-plan.md](response-delay-fix-plan.md)): `responseDelayMin/Max` apply to `ScheduledReply` only. The `maxDebounceWindowSeconds` cap was bugged (clamping the *final fire time* instead of the debounce phase) — fix scheduled.

### Edge cases

- **Cron retry on `FAILED`:** `attempts` increments on each failure. *(OQ-27: confirm max-retry policy and dead-letter handling for both ScheduledReply and ScheduledMessage. After N attempts, what happens?)*
- **Lead replies during pending reminder:** a `CALL_DAY_REMINDER` is queued for 8am tomorrow. Lead replies tonight. Should the reminder still fire? *(OQ-28: confirm policy — does any inbound cancel pending non-reminder messages, or only specific types?)*
- **Time-zone shifts:** `relatedCallAt` is stored UTC; lead-perceived time uses `scheduledCallTimezone`. DST transitions could shift "morning of" by an hour. Verify in functional audit.
- **Multi-device scheduling conflict:** if operator and AI both schedule a call message at the same minute, two rows. Dedup? *(OQ-29: confirm — is there a uniqueness constraint preventing duplicate same-type same-relatedCallAt rows?)*

### Cross-module dependencies

- → §1 Account: response delay, ghost threshold, voice-note timing settings.
- → §2 Personas: `preCallSequence` configuration on AIPersona.
- → §3 Conversations: `scheduledCallAt`, `callConfirmed`, `callOutcome` fields drive reminder lifecycle.
- → §4 AI pipeline: Stage D queues `ScheduledReply`; Stage K's `sendAIReply()` consumes them.


---

## Appendix A — Data model overview

> Generated from [prisma/schema.prisma](prisma/schema.prisma) on 2026-05-10. 60+ models, ~30 enums. Grouped by BRD module.

### Tenancy & identity (§1)

| Model | Purpose |
|---|---|
| `Account` | Tenancy boundary. Plan, billing, master AI switches, notification toggles, response timing, training phase, AI provider routing. |
| `User` | Operator/closer/setter inside an Account. Clerk-synced. Role-gated. |
| `AdminLog` | Super-admin audit trail (impersonate/pause/plan-change/delete). Survives Account cascade-delete. |
| `IntegrationCredential` | OAuth tokens + non-secret config per `(accountId, provider)`. Unique. |

### Personas & scripts (§2)

| Model | Purpose |
|---|---|
| `AIPersona` | Per-bot config (identity, prompts, knowledge, financial waterfall, downsell, no-show protocol, capital gate, multi-bubble, voice notes). |
| `PersonaBreakdown` | Parsed sales script (sections + ambiguities + slots). DRAFT/ACTIVE/ARCHIVED. |
| `BreakdownSection` | One section of a parsed script (intro, qualification, closing, etc.). |
| `BreakdownAmbiguity` | Free-text question the parser couldn't auto-resolve. |
| `VoiceNoteSlot` | Placeholder in a parsed script where a voice note should fire (status EMPTY/UPLOADED/APPROVED, fallback BLOCK_UNTIL_FILLED/SEND_TEXT_EQUIVALENT/SKIP_ACTION). |
| `VoiceNoteLibraryItem` | Operator-uploaded voice note (transcript, summary, triggers, embeddings). |
| `VoiceNoteSendLog` | History of which voice notes shipped to which lead. |
| `VoiceNoteTimingSettings` | Per-account voice-note delivery timing. |
| `Script` | Sprint-3 deterministic script (steps + branches + actions + forms). |
| `ScriptStep` / `ScriptBranch` / `ScriptAction` / `ScriptForm` / `ScriptFormField` | Tree of script structure. |
| `ScriptSlot` | Sprint-3 structured slot (`voice_note | link | form | runtime_judgment | text_gap`). |
| `LeadScriptPosition` | Per-lead pointer into the script tree. |
| `BridgingMessageTemplate` | Filler messages when a lead skipped ahead. |
| `SelfRecoveryEvent` | LLM-vs-script-stage divergence + recovery turn. |
| `SilentStopEvent` | Heartbeat-detected pipeline failure + recovery telemetry. |

### Leads, conversations, messages (§3)

| Model | Purpose |
|---|---|
| `Lead` | Prospect identity per `(accountId, platform, handle)`. |
| `Conversation` | Lead × persona pair. AI-on switch, distress, scheduling, capital verification, script-stage state, multi-bubble grouping, unsend. |
| `Message` | One DM. Provenance (`MessageSender`, `MessageSource`), media, soft delete, training fields. |
| `MessageGroup` | Multi-bubble cluster (group of Messages from one AI turn). |
| `MediaProcessingLog` | Per-media transcription / image-extraction telemetry. |
| `LeadStageTransition` | Audit row on every `LeadStage` change. |
| `Tag` / `LeadTag` | Operator + AI auto-tags. |
| `TeamNote` | Operator-typed note attached to a Lead. |
| `ContentAttribution` | Per-content rollup (reels/posts/stories/ads → leads + revenue). |
| `Notification` | Operator notification (8 types). |
| `CrmOutcome` | Per-lead close outcome (showed, closed, dealValue, closeReason). |
| `InboundQualification` | Per-conversation classifier output (one row, written on first AI turn). |
| `CapitalVerificationStatus` (enum) | UNVERIFIED → VERIFIED_QUALIFIED / VERIFIED_UNQUALIFIED / MANUALLY_OVERRIDDEN. |

### AI engine + suggestions (§4)

| Model | Purpose |
|---|---|
| `AISuggestion` | Per-turn AI generation (responseText, voice quality, intent, model, cost, multi-bubble payload, manual-review state). |
| `TrainingEvent` | Operator action on a suggestion in test mode (APPROVED/EDITED/REJECTED). |
| `VoiceQualityFailure` | Per-retry voice-gate failure. |
| `PromptVersion` | Versioned prompt snapshot + before/after performance. |

### Training corpus (§8)

| Model | Purpose |
|---|---|
| `TrainingExample` | Hand-curated `(leadMessage, idealResponse)` per category. |
| `TrainingUpload` | PDF upload (status, dedup hash). |
| `TrainingConversation` | One past sales DM conversation parsed from upload. |
| `TrainingMessage` | Per-message row in TrainingConversation; lead-message embeddings. |
| `TrainingDataAnalysis` | LLM-driven analyzer output for the corpus. |

### A/B testing & optimization (§10)

| Model | Purpose |
|---|---|
| `ABTest` / `ABTestAssignment` | Variant assignment per Lead. |
| `OptimizationSuggestion` | LLM-proposed change to persona/prompt. |
| `PredictionModel` / `PredictionLog` | Lead-outcome predictor. |
| `AISuggestionDismissed` (`DismissedActionItem`) | Operator dismissals on the actions panel. |

### Scheduling (§11)

| Model | Purpose |
|---|---|
| `ScheduledReply` | Debounced reply queue (per-conversation, status PENDING→SENT). |
| `ScheduledMessage` | SYSTEM/HUMAN/AI-initiated outbound touches (reminders, keepalives, follow-ups). |

### Other

| Model | Purpose |
|---|---|
| `BookingRoutingAudit` | Per-booking provider routing decision. |
| `AISuggestion` (cross-listed) | Already in §4. |
| `TrainingDataAnalysis` (cross-listed) | Already in §8. |

### Key enums

| Enum | Values |
|---|---|
| `Role` | ADMIN, CLOSER, SETTER, READ_ONLY, SUPER_ADMIN, MANAGER |
| `Platform` | INSTAGRAM, FACEBOOK |
| `LeadStage` | NEW_LEAD, ENGAGED, QUALIFYING, QUALIFIED, CALL_PROPOSED, BOOKED, SHOWED, NO_SHOWED, RESCHEDULED, CLOSED_WON, CLOSED_LOST, UNQUALIFIED, GHOSTED, NURTURE |
| `MessageSender` | AI, LEAD, HUMAN, SYSTEM, MANYCHAT |
| `MessageSource` | QUALIFYDMS_AI, MANYCHAT_FLOW, HUMAN_OVERRIDE, UNKNOWN |
| `IntegrationProvider` | META, INSTAGRAM, ELEVENLABS, LEADCONNECTOR, OPENAI, ANTHROPIC, CALENDLY, CALCOM, MANYCHAT, TYPEFORM |
| `ScheduledMessageType` | DAY_BEFORE_REMINDER, MORNING_OF_REMINDER, PRE_CALL_HOMEWORK, CALL_DAY_CONFIRMATION, CALL_DAY_REMINDER, WINDOW_KEEPALIVE, RE_ENGAGEMENT, CUSTOM, FOLLOW_UP_1/2/3, FOLLOW_UP_SOFT_EXIT, BOOKING_LINK_FOLLOWUP |
| `ConversationOutcome` | ONGOING, SUCCESS, GHOSTED, REJECTED, etc. |
| `TrainingCategory` | GREETING, QUALIFICATION, OBJECTION_TRUST/MONEY/TIME/etc. |
| `PlanStatus` | TRIAL, ACTIVE, PAST_DUE, CANCELLED |
| `AccountHealthStatus` | HEALTHY, WARNING, CRITICAL, UNKNOWN |

## Appendix B — API surface

> Generated from `src/app/api` on 2026-05-10. ~150 routes. Grouped by area.

### Webhooks (external → us)

- `POST /api/webhooks/instagram` — Meta IG events (HMAC-signed).
- `POST /api/webhooks/facebook` — Meta FB page events (HMAC-signed).
- `POST /api/webhooks/manychat-handoff` — ManyChat → us (lead handoff).
- `POST /api/webhooks/manychat-message` — ManyChat → us (forwarded inbound).
- `POST /api/webhooks/manychat-complete` — ManyChat → us (flow complete).
- `POST /api/webhooks/typeform` — Typeform application submission.
- `POST /api/webhooks/leadconnector` — LeadConnector booking events.
- `POST /api/webhooks/crm` — CRM outcome ingestion.
- `POST /api/webhooks/subscribe` — outbound subscription endpoint.

### Auth (Clerk + OAuth)

- `GET /api/auth/me` — current `AuthContext`.
- `POST /api/auth/login` / `/auth/register` — legacy auth endpoints (Clerk now primary).
- `GET /api/auth/instagram` / `/auth/instagram/callback` — IG OAuth.
- `GET /api/auth/meta` / `/auth/meta/callback` — Meta OAuth.
- `POST /api/meta/data-deletion` — Meta data-deletion compliance callback.
- `POST /api/meta/deauthorize` — Meta deauthorize callback.

### AI engine (manual triggers)

- `POST /api/ai/generate-reply` — manual generate (admin / debug).
- `POST /api/ai/test-message` — test scenario runner.
- `POST /api/voice/generate` — ElevenLabs voice synthesis.

### Conversations & messages

- `GET/POST /api/conversations` — list / create.
- `GET/PATCH /api/conversations/[id]` — view / update.
- `POST /api/conversations/[id]/messages` — operator manual send.
- `PATCH/DELETE /api/conversations/[id]/messages/[mid]` — edit / soft-delete.
- `POST /api/conversations/[id]/messages/[mid]/unsend` — Meta IG DELETE + soft-delete.
- `POST /api/conversations/[id]/ai-toggle` and `/toggle-ai` — flip `aiActive`.
- `POST /api/conversations/[id]/call` — schedule / update call.
- `POST /api/conversations/[id]/override-note` — attach `humanOverrideNote`.
- `POST /api/conversations/[id]/suggestion` — generate (or fetch) suggestion.
- `POST /api/conversations/[id]/suggestion/send` — ship suggestion as Message.
- `POST /api/conversations/[id]/suggestion/dismiss` — dismiss suggestion.

### Leads

- `GET/POST /api/leads` — list / create.
- `GET/PATCH /api/leads/[id]` — view / update.
- `POST /api/leads/[id]/stage` — manual stage flip.
- `POST /api/leads/[id]/tags` — apply tag.
- `POST /api/leads/[id]/notes`, `DELETE /api/leads/[id]/notes/[noteId]` — TeamNote.
- `GET /api/leads/[id]/conversations` — multi-conversation view.
- `POST /api/leads/[id]/crm-outcome` — manual CRM update.

### Settings (operator)

- `GET/PATCH /api/settings/account` — Account fields.
- `POST /api/settings/away-mode` — flip `awayModeInstagram/Facebook`.
- `GET/POST /api/settings/integrations` and `/integrations/[provider]` — IntegrationCredential CRUD.
- `GET /api/settings/integrations/ai-status` — AI provider health.
- `POST /api/settings/integrations/verify` — test credential.
- `POST /api/settings/integrations/instagram` — IG-specific connect.
- `GET/POST /api/settings/notification-prefs` — 12-toggle prefs.
- `GET/POST /api/settings/persona` — AIPersona CRUD.
- `POST /api/settings/persona/analyze` / `/extract` — script analysis.
- Persona script subtree: `/settings/persona/script/[id]/activate`, `/ambiguity`, `/section`, `/slot`, `/step`.
- `GET/POST /api/settings/persona/voice-slots`, `/voice-slots/upload`.
- Sprint-3 script subtree: `/settings/scripts`, `/scripts/parse`, `/scripts/[scriptId]/activate/duplicate/reupload/route`, `/steps/[stepId]/branches/[branchId]`, `/forms/[formId]/fields`.
- `POST /api/settings/training-phase` — flip `Account.trainingPhase`.
- `GET/POST /api/settings/training` — `TrainingExample` CRUD.
- Training upload pipeline: `/settings/training/upload`, `/upload/[id]`, `/upload/[id]/label`, `/upload/[id]/structure`.
- `POST /api/settings/training/embed` — re-embed.
- `POST /api/settings/training/backfill-outcomes` — backfill outcomeLabel.
- `GET /api/settings/voice-profile` — voice profile.

### Voice notes

- `GET/POST /api/voice-notes` — VoiceNoteLibraryItem CRUD.
- `GET/POST /api/voice-notes/[id]`, `/[id]/process`, `/[id]/retry`, `/[id]/suggestions`.
- `POST /api/voice-notes/upload`.
- `GET/POST /api/voice-notes/timing-settings`.

### Tags / Team / Notifications / Calendar

- `GET/POST /api/tags`, `/tags/[id]`.
- `GET/POST /api/team`, `/team/invite`, `/team/[id]`.
- `GET /api/notifications`, `POST /api/notifications/read-all`, `POST /api/notifications/[id]/read`, `GET /api/notifications/settings`.
- `GET /api/calendar/availability` — `getUnifiedAvailability()` over connected providers.
- `POST /api/calendar/book` — book a slot.

### Analytics (~17 routes)

`overview`, `funnel`, `conversation-funnel`, `velocity`, `revenue`, `commissions`, `content`, `triggers`, `data-quality`, `drop-off-hotspots`, `effectiveness`, `lead-distribution`, `lead-volume`, `live-conversations`, `message-effectiveness`, `predictions`, `segments`, `sequences`, `team`.

### Dashboard (operator surface helpers)

- `GET /api/dashboard/actions` — Action Required list.
- `POST /api/dashboard/actions/dismiss` — dismiss an action item.

### Realtime

- `GET /api/realtime` — SSE channel (subscribed by dashboard pages).

### Cron (12 jobs)

`process-scheduled-replies`, `process-scheduled-messages`, `silent-stop-heartbeat`, `recover-stale-bubbles`, `stale-conversations`, `daily-analysis`, `data-retention`, `media-retention`, `meta-health`, `retrain-model`, `window-keepalive`. Per-minute / per-hour / per-day frequencies vary; each job is a standalone POST.

### Super-admin (`/api/admin/*`)

- `GET /api/admin/accounts` — table + rollups.
- `GET/PATCH /api/admin/accounts/[id]` — sections A+B+C.
- `POST /api/admin/lead-deletion` — admin lead deletion.
- `GET/POST /api/admin/managers` — MANAGER role assign.
- Onboarding wizard: `/api/admin/onboard/account`, `/onboard/[accountId]/status/persona/test/activate`.
- `GET/POST /api/admin/ab-tests`, `/ab-tests/[id]`, `/ab-tests/[id]/results`.
- `GET /api/admin/optimizations`, `/optimizations/[id]`.
- `POST /api/admin/prediction/train`, `/prediction/evaluate`; `GET /api/admin/prediction/models`.
- `GET/POST /api/admin/prompt-versions`, `POST /api/admin/prompt-versions/[version]/rollback`.
- `POST /api/admin/seed-conversations` — seed test data.

## Appendix C — Glossary

| Term | Definition |
|---|---|
| **Account** | Tenancy boundary. One Account ≈ one paying customer. |
| **AISuggestion** | Per-turn AI generation, held for review or auto-sent. Captures cost + voice-gate metrics. |
| **AIPersona** | Per-bot config inside an Account. One Account can have multiple personas; each `Conversation` is bound to one. |
| **Auto-send gate** | `(awayMode<Platform> && aiActive) || autoSendOverride`. The only condition under which AI text ships without operator click. |
| **Away mode** | Per-platform master switch on Account that enables AI auto-reply for a whole platform. Legacy single `awayMode` field is deprecated. |
| **Banned phrases / words** | 23 phrases and 9 words the voice quality gate hard-fails on. Preserves the closer's casual texting voice. |
| **BRD** | This document — Business Requirements Document. |
| **BYOK** | Bring-your-own-key — operator-supplied OpenAI / Anthropic / ElevenLabs keys. Stored in `IntegrationCredential.credentials`. |
| **Capital verification (R24)** | DM-side confirmation of a lead's stated capital before booking. Durable on `Conversation.capitalVerificationStatus`. |
| **Closer** | The human at the other end of the booked call. Persona's `closerName` / `callHandoffName` references this person. |
| **Closed-loop training** | Operator's accept/edit/dismiss actions on the suggestion-review banner feed `TrainingEvent`, gating the "ready to enable auto-send" prompt. |
| **Distress detection** | Pre-AI scan for crisis language. Pauses AI, fires URGENT, routes to supportive reply path. DB-only toggle. |
| **EAA token** | Meta Business Login (Facebook page) access token. Calls `graph.facebook.com`. |
| **F-N (audit finding)** | Multi-tenant leak audit numbering. Critical fixes: F4.2, F6.1+F6.2, F3.1, F3.2, F3.3. |
| **Few-shot retrieval** | Stage F of AI pipeline. 3-tier metadata-filtered cosine similarity over `TrainingMessage` embeddings. |
| **Geography gate** | Persona-opt-in. If the lead's first messages identify them as outside supported regions, send exit message once + pause AI. |
| **Ghost threshold** | `Account.ghostThresholdDays` (default 7). Days of silence before auto-ghosting. |
| **Hot lead** | High `priorityScore` (> 50 per ROADMAP). Surfaces in priority inbox. |
| **HUMAN_OVERRIDE** | A message typed by an operator (dashboard or phone via `is_echo`). `Message.isHumanOverride=true`, `MessageSource.HUMAN_OVERRIDE`. |
| **IGAA token** | Instagram Login (IG Business) access token. Calls `graph.instagram.com`. Distinct from EAA. |
| **Inline path** | Reply delay ≤ 90s → handled in lambda via Next.js `after()`. > 90s → cron pickup of `ScheduledReply`. |
| **InboundQualification** | One-row-per-conversation classifier output captured on first AI turn. |
| **Lead** | Prospect identity per `(accountId, platform, handle)`. |
| **LeadStage** | 14-state enum from `NEW_LEAD` to `CLOSED_WON / GHOSTED`. Transitions tracked in `LeadStageTransition`. |
| **Manual-review mode (test mode)** | When auto-send is off for a platform, AI generates suggestions held in `AISuggestion`; operator approves/edits/dismisses via banner. |
| **Master prompt** | 370-line `MASTER_PROMPT_TEMPLATE` in `src/lib/ai-prompts.ts` (R-rules R1-R18, persona identity, response format, conversation stages, objection handling, stall classification, no-show protocol, soft exit, ghost re-engagement, voice constraints). |
| **MessageSource** | Authoring origin (`QUALIFYDMS_AI` / `MANYCHAT_FLOW` / `HUMAN_OVERRIDE` / `UNKNOWN`). Distinct from `MessageSender` (delivery). |
| **Multi-bubble** | One AI turn → multiple Messages in a `MessageGroup`, each with `bubbleIndex` and inter-bubble typing delay. |
| **Persona breakdown** | Parsed sales script with sections, ambiguities, slots. DRAFT/ACTIVE/ARCHIVED. |
| **Platform** | INSTAGRAM or FACEBOOK. |
| **Priority score** | 0-100 conversation hotness, recalculated per message. |
| **Privacy/distress** | Account-level `distressDetectionEnabled` defaults true; cannot be UI-toggled. |
| **R-rules (R1-R27)** | Numbered rules in MASTER_PROMPT_TEMPLATE governing AI behavior (e.g., R3 sequence lock, R14 booking validation, R16 URL allowlist, R17 dash sanitization, R24 capital verification, R26 stay-in-scope, R27 verified-details escalation). |
| **RLS** | Postgres Row-Level Security. Belt-and-suspenders to application-level `accountId` filtering. |
| **ScheduledReply** vs **ScheduledMessage** | Two distinct queues. ScheduledReply = debounced reply-to-lead. ScheduledMessage = SYSTEM/HUMAN/AI-initiated outbound (reminders, follow-ups, keepalives). |
| **Self-recovery** | LLM-vs-script-stage divergence triggers a corrective AI turn. Logged in `SelfRecoveryEvent`. |
| **Silent-stop** | Heartbeat-detected pipeline failure (gate failure, exception, dead-end classifier). Logged in `SilentStopEvent` + recovery message auto-sent. |
| **Slot (Sprint 3)** | Structured replacement for free-text ambiguities: `voice_note` / `link` / `form` / `runtime_judgment` / `text_gap`. |
| **Soft exit** | 3 specific conditions where AI politely closes out without a call. From MASTER_PROMPT_TEMPLATE's SOFT EXIT GUARD RAILS. |
| **SUPER_ADMIN** | Platform-level operator (Tega). Sees `/admin` across all tenants. |
| **Tier 1 / 2 / 3 retrieval** | Few-shot retrieval cascade: Tier 1 = exact `(leadType, dominantStage)`; Tier 2 = any 1 metadata match; Tier 3 = vector fallback. |
| **TrainingEvent** | Operator action in suggestion-review banner (APPROVED/EDITED/REJECTED). Drives the per-platform "ready to enable auto-send" metric. |
| **Voice quality gate** | Hard-fail + soft-score check on every AI message. Up to 3 attempts; logs failures to `VoiceQualityFailure`. |

