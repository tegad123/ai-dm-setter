# BRD Open Questions

Questions surfaced while reverse-engineering the BRD. Each needs a product-owner decision before the relevant BRD section can be marked final.

Format: `OQ-N · module · question · why it matters`.

---

## Open

- **OQ-1 · Account & tenancy · Onboarding source.** Today's account creation appears to be super-admin-driven via `/api/admin/onboard/account`. Is self-serve sign-up intended before client #2 onboards, or is every Account provisioned by Tega? Affects whether we need a public sign-up flow + payment integration in the BRD scope.
- **OQ-2 · Account & tenancy · Trial expiry.** What should happen when `Account.planStatus=TRIAL` and `trialEndsAt` passes? Auto-pause auto-replies? Hard-block dashboard access? Notify only?
- **OQ-3 · Account & tenancy · Multiple IG handles per account.** `IntegrationCredential` is unique on `(accountId, provider)`, so one Account = one IG handle. Is this the intended product constraint, or a stop-gap? Affects whether we need to plan per-persona token scoping.
- **OQ-4 · Personas · Timing override precedence.** `responseDelayMin/Max` exist on both `Account` and `AIPersona`. Does persona override account, or vice versa, or do they sum? Behavior must be documented because operators tune both surfaces.
- **OQ-5 · Personas · Persona deletion behavior.** Cascade-deletes Conversations etc. What's intended for in-flight conversations when their persona is deleted? Should deletion be gated by "no active conversations" or is the cascade intentional?
- **OQ-6 · Personas · Multi-persona lead routing.** When an Account has 2+ personas and a lead DMs in, which persona handles it? By IG-handle binding via IntegrationCredential metadata, by account default, or by inbox routing? Affects how `Conversation.personaId` is assigned at creation.
- **OQ-7 · Personas · Re-parse preserves operator work?** When an operator re-uploads a script, does re-parsing preserve resolved ambiguities and bound slots, or does it reset them? Affects operator UX and whether script edits are non-destructive.
- **OQ-8 · AI pipeline · Test backdoor in prod?** The phrase `"september 2002"` fast-forwards a conversation to BOOKING. Is this gated by env (`NODE_ENV !== 'production'`) or by persona flag, or is it permanently in the prod code path? If unguarded, a real lead could trigger it.
- **OQ-9 · AI pipeline · `LEAD_OPENERS` auto-engage rule.** Opener messages create Conversation with `aiActive=true`; ongoing inbounds with `aiActive=false`. Does this bypass the 2026-05-06 "explicit opt-in" rule? Is it intentional that an opener auto-engages even when the operator hasn't toggled AI on yet?
- **OQ-10 · AI pipeline · Dev-mode webhook signature bypass.** In dev env, an invalid HMAC sig logs a warning and continues. Confirm this is gated strictly by `NODE_ENV !== 'production'` and not by an env-var presence check (which could silently disable verification in a misconfigured prod deploy).
- **OQ-11 · ManyChat · Webhook key rotation.** `Account.manyChatWebhookKey` is generated at Account creation. Is there a UI-driven re-roll? If a key leaks, what's the recovery process?
- **OQ-12 · ManyChat · Stale-key 404 handling.** When an Account is deleted and a ManyChat External Request still references the old key, requests 404. Is there logging/alerting so the operator knows their flow is broken? Or do they discover it silently?
- **OQ-13 · Closer/handoff · Commission auto-compute.** `User.commissionRate` + `totalCommission` exist. Is commission auto-credited on every `CLOSED_WON`, or is it manual-entry? Same for `closeRate`, `callsBooked`, `leadsHandled`.
- **OQ-14 · Closer/handoff · Per-user notification preferences.** Notifications are per-Account today. Is per-user mute / preference out of scope, planned, or expected?
- **OQ-15 · Closer/handoff · `LeadConnector` vs `Calendly` vs `Cal.com` provider precedence.** Multiple `IntegrationCredential` providers exist for calendaring. Which is the canonical booking source if more than one is connected? `getUnifiedAvailability` resolution order needs documenting.
- **OQ-16 · Closer/handoff · Scheduled reminders on takeover.** When operator takes over (toggles `aiActive=false`), do existing `ScheduledMessage` reminders cancel automatically, or continue firing as-is?
- **OQ-17 · Training data · Re-upload across personas.** `TrainingUpload` is unique on `(accountId, fileHash)`. If the operator wants to use the same chat export for two personas in the same account, the second upload is blocked. Should the unique be `(accountId, personaId, fileHash)`, or is one-upload-per-account intentional?
- **OQ-18 · Training data · Embedding model migration.** If we change the embedding model (e.g., `text-embedding-3-small` → newer), is there a backfill script to re-embed existing `TrainingMessage` rows? Without one, model swaps silently degrade retrieval quality.
- **OQ-19 · Training data · Empty-retrieval warning.** When all 3 retrieval tiers return < 3 examples, the few-shot block is empty and the AI generates without prior examples. Should the system surface a "training corpus too small" warning to operators, or is silent degradation acceptable?
- **OQ-20 · Admin dashboard · Theme persistence.** Light/dark theme — where is preference stored? Clerk user metadata, localStorage, or DB? Affects whether theme persists across devices/sessions.
- **OQ-21 · Admin dashboard · Clerk-DB User-row sync.** What happens if a Clerk user signs in without a matching `User` DB row (Clerk-side delete out-of-band, missed webhook, etc.)? Is there a sync hook, or do they get a silent 500?
- **OQ-22 · Admin dashboard · "Why isn't AI sending?" diagnostic.** The 3-layer auto-send gate (`awayMode<Platform>`, `aiActive`, `autoSendOverride`) creates the most common operator confusion. Is there a UI diagnostic that explains why a conversation isn't auto-sending, or do operators have to triage manually?
- **OQ-23 · Admin dashboard · Persona attribution in conversation list.** Post-F4.2, conversations are persona-bound. Does the conversation list surface the owning persona name, or do operators have to dig into details?
- **OQ-24 · Operational · RLS in prod.** Postgres RLS is the belt-and-suspenders to application-level scoping. Confirm RLS policies are enabled in prod and which `scripts/` files verify them. Failing audit if RLS is documented but not enforced.
- **OQ-25 · Operational · External observability.** No Sentry / DataDog / OpenTelemetry config is visible. Is logging exclusively Vercel logs? If something else exists, document it; if not, decide whether prod incidents need a real APM before client #2.
- **OQ-26 · Operational · PromptVersion stop-loss policy.** When does `performanceAfter` count as "sufficient data"? After N replies, N days, or N closed deals? Affects when AB tests auto-promote a winning prompt.
- **OQ-27 · Scheduling · Max-retry + dead-letter policy.** `ScheduledReply` and `ScheduledMessage` both have `attempts` counter. After N failures, what happens? Drop, alert, requeue? Today's behavior may silently drop messages.
- **OQ-28 · Scheduling · Inbound-cancels-pending-reminders policy.** A `CALL_DAY_REMINDER` is queued for 8am tomorrow; lead replies tonight. Should the reminder still fire? Per-message-type rule needed.
- **OQ-29 · Scheduling · Duplicate-message uniqueness.** If operator and AI both schedule the same `(messageType, relatedCallAt)`, are duplicate rows allowed? Today no unique index exists on `(conversationId, messageType, relatedCallAt)`.

---

## Resolved

*[questions answered by the product owner; keep history for audit trail]*
