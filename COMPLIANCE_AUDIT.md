# Convlo (QualifyDMs) — Meta/Instagram DM Automation Compliance Audit

**Date:** 2026-05-22
**Scope:** Preventive, code-level review against Meta/Instagram DM-automation policy, ahead of scaling to more customers.
**Method:** Read-only review of the codebase (no changes made). Evidence cited as `file:line`.

## Scorecard

| # | Item | Verdict |
|---|---|---|
| 1 | 24-hour messaging window | ❌ Not compliant |
| 2 | Rate limiting (per-account caps) | ❌ Not compliant |
| 3 | Account warmup / volume ramp | ❌ Not compliant |
| 4 | Reply delays (randomized) | ✅ Compliant |
| 5 | Inbound-only enforcement | ⚠️ Partial |
| 7 | Message variation / templating | ⚠️ Partial |
| 8 | API hygiene (endpoints, scopes, creds) | ✅ Compliant (1 minor note) |
| 9 | Monitoring / volume alerting | ⚠️ Partial |
| 10 | Financial / trading guardrails | ❌ Not compliant |

*(Item 6 was not in the client's checklist.)*

**Highest-risk gaps before scaling:** #1 (24h window), #2 (rate limiting), #10 (income-claim filters), #3 (warmup).

---

## 1. 24-hour messaging window — ❌ Not compliant

**What we found:** The follow-up cascade fires on a fixed **12h interval** (`FOLLOW_UP_INTERVAL_MS = 12h`, `follow-up-sequence.ts:26`): FOLLOW_UP_1 ≈ 12h, FOLLOW_UP_2 ≈ 24h, FOLLOW_UP_3 ≈ 36h, FOLLOW_UP_SOFT_EXIT ≈ 48h after the last AI message. **FOLLOW_UP_2/3/SOFT_EXIT land at or past the 24h window.** There is **no proactive window check** before sending — the scheduled-message cron sends and lets Meta reject it (`process-scheduled-messages/route.ts:397`: *"Platform send FIRST. If Meta rejects (e.g. 'outside allowed window')..."*). We reproduced the `(#10) … outside of allowed window` rejection live during testing.

**Why it's a risk:** Sending past 24h violates Meta's standard messaging window, and *repeatedly attempting* sends Meta rejects is itself a spam/health signal against the account. There's also a `window-keepalive` cron (`cron/window-keepalive/route.ts`, `keepalive-generator.ts`) that nudges the lead at ~20h specifically to keep the 24h clock open — a workaround that could read as **circumventing** the policy rather than respecting it.

**To fix:** Add a hard guard before any automated send — compute `hoursSinceLastInboundMessage` and skip/abort if `> 24` (unless an approved message tag applies). Cap the follow-up cascade so no nudge is scheduled beyond the window. Re-evaluate the keepalive feature.

## 2. Rate limiting — ❌ Not compliant

**What we found:** No per-account caps on outbound DMs anywhere. The only "rate limit" code is for the OpenAI/Anthropic APIs and operator-notification throttling (`meta-health`, one alert/account/hour). There is **no messages/hour, messages/day, or max-concurrent-active-conversations** ceiling on sends.

**To fix:** Add account-level send budgets (e.g. configurable per-hour and per-day caps + a concurrent-conversation ceiling), enforced in the send path. Start conservative; make them per-account so warmup (item 3) can scale them.

## 3. Account warmup — ❌ Not compliant

**What we found:** No warmup/ramp logic. A newly connected account can send at full volume on day 1. (Grep for warmup/ramp returns only script-parsing follow-up cadence text, unrelated.)

**To fix:** Gate daily send volume by account age (e.g. day 1: N, ramping over ~2 weeks), tied to the item-2 caps. Critical before onboarding many fresh accounts — new accounts blasting volume is a top Meta ban trigger.

## 4. Reply delays — ✅ Compliant

**What we found:** `computeReplyDelaySeconds` (`webhook-processor.ts:6443`) returns a **randomized** value: `Math.floor(Math.random() * (max - min + 1)) + min` (default 45–120s), and the multi-bubble delivery adds typing simulation (8–15s reading + 50–80ms/char, `webhook-processor.ts:3488`). Never instant by default.

**Minor note:** operator-set `responseDelayMin/Max` aren't floored — an operator could set them very low (we set 1–3s for local testing). Consider a minimum floor (e.g. ≥10s) so config can't make it bot-fast.

## 5. Inbound-only enforcement — ⚠️ Partial

**What we found:** The system is inbound-only **by architecture** — there is no cold-DM/broadcast/bulk-send feature, and the AI fires only from inbound webhooks (`processIncomingMessage`) or follow-ups within an existing thread the lead started (and ManyChat handoffs, which the lead triggered). But there is **no explicit code-level guard/invariant** asserting "never initiate a thread." It's emergent, not enforced.

**To fix:** Add an explicit guard at the send boundary — refuse to send if there is no prior inbound lead message on the conversation. Cheap insurance that a future feature can't silently start cold outreach.

## 7. Message variation — ⚠️ Partial

**What we found:** Scripted `[MSG]` actions are sent **verbatim** across every lead (`script-serializer.ts:342,801,803`: *"send verbatim, do not paraphrase or reorder"*), enforced by the quality gate (`msg_verbatim_violation`). Personalization comes only from `{{variables}}`, AI-generated connective text, and light `[ASK]` wording adjustments. Core scripted lines (e.g. the belief-break reframe) are byte-identical across all conversations — a templating fingerprint at scale.

**To fix:** Add light phrase-variation (approved paraphrase set / spintax) for required `[MSG]`s, or relax verbatim enforcement to "semantically equivalent" so the same step doesn't ship identical bytes to thousands of leads.

## 8. API hygiene — ✅ Compliant (1 minor note)

**What we found:** Only official Meta hosts are called — `graph.facebook.com`, `graph.instagram.com`, `api.instagram.com`, `www.instagram.com`. No scraping, no third-party endpoints. OAuth scopes are minimal and individually justified: `pages_messaging`, `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement` (`auth/meta/route.ts:67`) and `instagram_business_basic`, `instagram_business_manage_messages` (`auth/instagram/route.ts:37`). Credentials are encrypted at rest with AES-256-GCM (`credential-store.ts`).

**Minor note:** the encryption key falls back to a hardcoded default (`credential-store.ts:5`) and the value currently in use looks like a dev key. Rotate `CREDENTIAL_ENCRYPTION_KEY` to a strong, secret value in production and confirm the fallback can never be hit.

## 9. Monitoring — ⚠️ Partial

**What we found:** There IS alerting infrastructure — operator notifications + Slack, silent-stop **spike** alerts per account (`silent-stop-recovery.ts:852`, 1h window), low-recovery-rate alerts, and Meta token-health alerts (`cron/meta-health`). Analytics dashboards show message volume. But there is **no per-account outbound send-rate/volume spike alert** — nothing watches "messages sent per account per hour/day" and warns when sends spike (the specific ask).

**To fix:** Add a per-account send-volume meter (pairs naturally with items 2–3) and a spike alert reusing the existing notification/Slack path.

## 10. Financial / trading guardrails — ❌ Not compliant

**What we found:** `BANNED_PHRASES`/`BANNED_WORDS` (`voice-quality-gate.ts:199,227`) are AI-voice tells only ("i understand that", "great question", "real quick tho"). There is **no filter for profit guarantees or income claims** — "guaranteed returns", "you'll make $X/month", "risk-free", "get rich", "passive income", etc. The only finance-adjacent guard blocks the AI from fabricating *course refund/guarantee terms* (`voice-quality-gate.ts:2753`) — a different concern. Given customers are trading educators, unfiltered income claims are real **FTC** and **Meta financial-services** exposure.

**To fix:** Add a hard-fail banned-pattern set for income/profit/guarantee claims to the quality gate (regex + LLM check), configurable per account, so the AI cannot ship a guaranteed-return or income-promise message regardless of script or model.

---

## Recommended priority order (before go-live)

1. **24h window guard (#1)** — stop sending past the window; cap the cascade.
2. **Rate limiting + warmup (#2, #3)** — per-account caps with age-based ramp.
3. **Income-claim filter (#10)** — direct regulatory exposure for trading customers.
4. **Send-volume monitoring/alerting (#9)** — visibility once #2/#3 exist.
5. **Inbound-only guard (#5)** + **message variation (#7)** — hardening.
6. **Reply-delay floor (#4)** + **rotate encryption key (#8)** — small polish.

*All findings are read-only observations; no code was changed during this audit.*
