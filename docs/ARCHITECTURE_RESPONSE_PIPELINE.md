# AI Response Generation Pipeline — Architectural Audit

> **Generated:** 2026-04-16  
> **Codebase version:** Current `main` branch  
> **Scope:** Inbound webhook receipt through outbound message delivery  

---

## Part 1: Full Pipeline Trace

### Stage A: Webhook Receipt

**Files:** `src/app/api/webhooks/instagram/route.ts` (L47-78), `src/app/api/webhooks/facebook/route.ts`

Meta sends a POST with a JSON payload and `x-hub-signature-256` header. The route handler:

1. Reads the raw body as text (L49).
2. Validates the HMAC-SHA256 signature via `verifyWebhookSignature()` from `src/lib/instagram.ts`. In production, an invalid signature returns 401. Dev mode logs a warning but continues (L58-62).
3. Parses the JSON payload (L65).
4. Calls `processInstagramEvents(payload)` **synchronously before returning 200** (L70-76). This is intentional: Vercel keeps the function alive until the response is returned, and `maxDuration` is set to 120s (L20) to accommodate the full pipeline.

```
POST /api/webhooks/instagram
  → raw body read
  → HMAC-SHA256 signature check
  → processInstagramEvents(payload) (awaited)
  → return 200
```

**Key design decision:** Events are processed fully before the 200 response, not in `after()`. The inline `after()` callback is only used for short-delay reply delivery (see Stage C).

### Stage B: Account Resolution + Message Routing

**File:** `src/app/api/webhooks/instagram/route.ts` (L84-393)

`processInstagramEvents()` iterates `payload.entry[]` and for each entry:

1. **Account lookup** (L98-201): Fetches all active `IntegrationCredential` rows where `provider IN ('META', 'INSTAGRAM')`. Matches `entry.id` against credential metadata fields (`pageId`, `igUserId`, `instagramAccountId`, `igBusinessAccountId`). Three fallback tiers:
   - Env var match (`INSTAGRAM_PAGE_ID` / `FACEBOOK_PAGE_ID`)
   - Zero credentials: use first account
   - Single account across all credentials: use it with a warning

2. **Platform gate** (L208-216): Skips entries where the matched account has no `INSTAGRAM` credential (prevents META-only creds from processing IG DMs).

3. **Admin detection** (L243-278): Identifies messages from the business/page via `is_echo` flag or `senderId` matching `pageOwnIds`. Admin messages route to `processAdminMessage()` and skip AI generation.

4. **Profile resolution** (L284-304): Attempts `getUserProfile()` for the sender's name and handle. Falls back to the raw sender ID on failure.

5. **Hands off to `processIncomingMessage()`** (L306-315) from `src/lib/webhook-processor.ts`.

### Stage C: Message Deduplication + Persistence

**File:** `src/lib/webhook-processor.ts`, `processIncomingMessage()` (L314-601)

Three-layer deduplication prevents duplicate AI replies from Meta's webhook retries:

| Layer | Mechanism | Location |
|-------|-----------|----------|
| 1. In-memory | `platformMessageId` lookup against existing `Message` rows | L414-433 |
| 2. DB constraint | Prisma `P2002` unique violation catch on `(conversationId, platformMessageId)` | L527-545 |
| 3. `skipReply` flag | Returned to webhook route; caller skips `scheduleAIReply()` | L323-325 |

**Lead resolution** (L332-394):

- Finds existing lead by `(accountId, platformUserId, platform)`.
- Creates new lead + conversation if none exists. AI defaults to ON when `awayMode` is true, OFF otherwise.
- `looksLikeOngoingConversation()` heuristic (L275-305): checks against `ONGOING_PHRASES` (51 entries) and `NEW_LEAD_OPENERS` (18 entries). Ongoing messages create the lead with `aiActive: false`.

**"Clear conversation" command** (L442-512): Literal `"clear conversation"` DM wipes all messages, resets conversation + lead state, cancels pending `ScheduledReply` rows. Returns `skipReply: true`.

**Post-save side effects** (L547-601):
- Updates `conversation.lastMessageAt` and `unreadCount`
- Back-fills effectiveness tracking on previous AI messages
- Re-engages `LEFT_ON_READ` conversations
- Broadcasts real-time SSE events (`broadcastNewMessage`, `broadcastConversationUpdate`)
- Fires `runPostMessageScoring()` (non-fatal)

### Stage D: Delay Routing

**Files:** `src/app/api/webhooks/instagram/route.ts` (L328-381), `src/lib/webhook-processor.ts` (L802-897), `src/lib/delay-utils.ts`

After `processIncomingMessage()` returns, the webhook route decides between two delivery paths:

```
                    ┌─ delaySeconds <= 90s ─→ after() inline delay + processScheduledReply()
AI active? ────────>│
                    └─ delaySeconds > 90s ──→ scheduleAIReply() → ScheduledReply row → cron pickup
```

**Inline path** (L341-375): Uses Next.js `after()` to sleep, then re-checks `aiActive` at delivery time and calls `processScheduledReply()`. The 90s threshold (`INLINE_DELAY_THRESHOLD_SECONDS`) keeps the lambda alive but avoids excessive cron lag for short delays.

**Cron path** (L376-380): Creates a `ScheduledReply` row with `scheduledFor = now + delaySeconds`. A per-minute cron picks it up and calls `scheduleAIReply(conversationId, accountId, { skipDelayQueue: true })`.

**Delay calculation** (`src/lib/delay-utils.ts`, L15-29):

```typescript
function humanResponseDelay(minSec: number, maxSec: number): number
```

Uses a log-normal distribution via Box-Muller transform. `mu` = log of the geometric mean of the range, `sigma` = 0.5. This skews toward shorter delays with occasional longer ones, matching real human typing patterns.

**Voice-note-aware path** (L818-897): When `voiceNotesEnabled`, the delay is deferred until after generation (Step 4d) so the system knows whether to apply text delay or voice note delay timing.

### Stage E: Context Assembly

**File:** `src/lib/webhook-processor.ts`, `scheduleAIReply()` (L614-1046)

Assembles all context the AI needs:

1. **Conversation + lead fetch** (L634-651): Single Prisma query with `include: { lead: { include: { tags } }, messages: { orderBy: timestamp: 'asc' } }`.

2. **Meta API backfill** (L692-714): If only 1 message exists locally, attempts to fetch history from Meta's Conversations API as a fallback.

3. **Lead context** (L717-734): Builds `LeadContext` object with:
   - Identity: name, handle, platform
   - Stage: `lead.stage` (LeadStage enum, 14 values)
   - Enrichment: intentTag, tags, experience, incomeLevel, geography, timezone

4. **Test mode backdoor** (L748-800): Phrase `"september 2002"` fast-forwards to BOOKING stage, records all stage timestamps, rewrites the trigger in history.

5. **Booking state injection** (L913-1028): Fetches real calendar slots via `getUnifiedAvailability()` when:
   - Any calendar integration exists (`LEADCONNECTOR`, `CALENDLY`, `CALCOM`)
   - `leadTimezone` is known
   
   Filters to business hours 9am-7pm in lead's timezone, caps at 12 slots. Persists `proposedSlots` to the conversation for later R14 validation.

6. **Scoring context** (L1031-1045): `getScoringContextForPrompt()` appends lead scoring intelligence to the system prompt.

### Stage F: Few-Shot Retrieval

**File:** `src/lib/ai-engine.ts` (L64-105), `src/lib/training-example-retriever.ts`

Before prompt construction, the system retrieves semantically similar examples from training data:

1. **Intent classification** (L73-92): Calls `classifyContentIntent()` (see Stage G) to detect the lead's intent. Non-fatal — continues without it on failure.

2. **3-tier metadata-filtered retrieval** (`training-example-retriever.ts`):

```
TIER 1 — Exact metadata match:
  WHERE leadType = ? AND dominantStage = ?
  + embeddingVector IS NOT NULL
  → cosine similarity rank → top 5
  → IF >= 3 results: DONE

TIER 2 — Relaxed (any 1 metadata match):
  WHERE (leadType = ? OR dominantStage = ? OR primaryObjectionType = ?)
  + embeddingVector IS NOT NULL
  → cosine similarity rank → top 5 (dedup with Tier 1)
  → IF >= 3 total results: DONE

TIER 3 — Vector fallback:
  WHERE embeddingVector IS NOT NULL
  + outcomeLabel NOT IN (HARD_NO, UNKNOWN)
  → cosine similarity rank → top 5 (dedup with Tier 1+2)
```

**Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions). Cosine similarity computed in-memory.

**Metadata mapping helpers:**
- `mapLeadStageToTrainingStage()`: Maps 14 LeadStage enum values to 10 training stage names
- `mapExperienceToLeadType()`: Maps live experience values to training lead type taxonomy

### Stage G: Content Intent Classification

**File:** `src/lib/content-intent-classifier.ts` (311 lines)

Lightweight Haiku-based intent detection that runs on every message generation cycle:

- **Model:** `claude-haiku-4-20250414`
- **Parameters:** temperature 0, max_tokens 100
- **Timeout:** 3 seconds (AbortController)
- **11 intents:** `price_objection`, `time_concern`, `skepticism_or_scam_concern`, `past_failure`, `complexity_concern`, `need_to_think`, `not_interested`, `ready_to_buy`, `budget_question`, `experience_question`, `timeline_question`
- **Fallback:** Keyword map with 70+ entries, returns confidence 0.65 on match
- **API:** Direct `fetch()` to `https://api.anthropic.com/v1/messages` (no SDK)

### Stage H: System Prompt Construction

**File:** `src/lib/ai-prompts.ts` (1176 lines)

`buildDynamicSystemPrompt(accountId, leadContext, fewShotBlock)` merges the 370-line `MASTER_PROMPT_TEMPLATE` with account-specific data:

**Template structure:**
```
YOUR IDENTITY (name, persona, tone, closer handoff)
RESPONSE FORMAT (JSON schema with 17 fields)
CONVERSATION STAGES (7 stages: OPENING → BOOKING)
OBJECTION HANDLING PROTOCOL (5 types + HAS_MENTOR pattern)
STALL CLASSIFICATION (5 types: TIME_DELAY, MONEY_DELAY, THINKING, PARTNER, GHOST)
NO-SHOW PROTOCOL (max 2 booking attempts)
PRE-CALL TIMING (night before, morning of, 1 hour before)
SOFT EXIT GUARD RAILS (3 conditions only)
GHOST RE-ENGAGEMENT
ABSOLUTE RULES (R1-R18)
ADDITIONAL RULES
<voice_constraints> (vocabulary allowlist/banlist, punctuation norms, emoji rules)
TENANT DATA (script or persona breakdown)
LEAD CONTEXT
CONVERSATION HISTORY
```

**Key template variables (40+):** `{{fullName}}`, `{{personaName}}`, `{{triggerContext}}`, `{{fewShotBlock}}`, `{{tenantDataBlock}}`, `{{availableSlotsContext}}`, `{{bookingLinkContext}}`, `{{objectionProtocolsContext}}`, `{{stallScriptsContext}}`, etc.

**Tenant data assembly** — three paths in priority order (L1088-1128):
1. **Script template system** (`serializeScriptForPrompt`) → PersonaBreakdown dual-layer block
2. **Script-first legacy** (`buildScriptFirstTenantData`) — rawScript + styleAnalysis + supplemental
3. **Field-by-field legacy** (`buildLegacyTenantData`) — opening scripts, path A/B, financial waterfall, objection protocols, stall scripts, no-show scripts, pre-call sequence, proof points, knowledge assets, custom phrases

**Booking slot injection** (L992-1060): Five branches based on calendar state:
- Has calendar + no timezone → "ask timezone first"
- Has calendar + has timezone + has slots → list slots with tz-aware labels
- Has calendar + has timezone + no slots → "ask preferred day/time"
- No calendar + has booking link → "drop the link"
- No calendar + no link → "DO NOT invent a URL"

**Test mode override** (L1144-1160): Prepends a hard override block that forces BOOKING stage.

### Stage I: LLM Call + Voice Quality Gate

**File:** `src/lib/ai-engine.ts` (L57-252)

`generateReply()` orchestrates the full generation cycle:

1. **Provider resolution** (L258-295): Checks per-account BYOK keys (OpenAI → Anthropic → env fallback). Default models: `gpt-4o` (OpenAI), `claude-sonnet-4-20250514` (Anthropic).

2. **History formatting** (L301-313): LEAD → `user` role, AI/HUMAN → `assistant` role. Human messages prefixed with `[Human team member]`.

3. **LLM call** (L319-374):
   - **OpenAI:** `chat.completions.create()` with temperature 0.85, max_tokens 500
   - **Anthropic:** `messages.create()` with temperature 0.85, max_tokens 500. Handles required user-first constraint by prepending `[Conversation started by our team]`. Merges consecutive same-role messages via `mergeConsecutiveRoles()`.

4. **Response parsing** (L423-499): Expects JSON. Strips markdown fences. Extracts 17 structured fields with safe defaults. Falls back to raw text as `message` on JSON parse failure.

5. **Voice quality gate loop** (L135-189): Up to 3 attempts (initial + 2 retries):

```
for attempt 0..2:
  rawResponse = callLLM(...)
  parsed = parseAIResponse(rawResponse)
  quality = scoreVoiceQuality(parsed.message)
  if quality.passed: break
  log failure + persist to voiceQualityFailure table
  if attempt == 2: send best effort
```

### Stage J: Voice Quality Gate

**File:** `src/lib/voice-quality-gate.ts` (233 lines)

`scoreVoiceQuality(reply)` enforces the closer's texting voice:

**Hard fail checks (instant regeneration):**

| Check | Detail |
|-------|--------|
| Banned phrases | 23 phrases: "I'm sorry to hear", "Great question", "Could you elaborate", etc. |
| Banned words | 9 words: "specifically", "ultimately", "essentially", "furthermore", etc. |
| Banned starters | "However," / "However " at sentence start |
| Banned emojis | 16 emojis: `🙏 👍 🙂 😊 😄 ✨ 🎯 ✅ 📈 💰 🚀 💡 🌟 👏 🤝 💪` (without skin tone) |
| Em/en dash | `—` (U+2014) or `–` (U+2013) present |
| Semicolon | `;` present |
| "lol" | `\blol\b` match (should use "haha") |
| Message length | Over 300 characters |

**Soft scoring signals (0.0-1.0 score):**

| Signal | Weight | Criteria |
|--------|--------|----------|
| `short_message` | 1.0 | <= 200 chars (0.5 for 201-250, 0 for 250+) |
| `has_daniel_vocab` | 1.0 | Contains any word from DANIEL_VOCAB (28 words) |
| `short_sentences` | 1.0 | <= 2 sentences (0.5 for 3) |
| `lowercase_start` | 0.5 | First character is lowercase |
| `approved_emoji` | 0.5 | Contains `💪🏿 😂 🔥 💯 ❤` |

**Pass condition:** `hardFails.length === 0 AND score >= 0.7` (score = rawSignals / 4.0, capped at 1.0).

### Stage K: Anti-Hallucination Guards + Delivery

**File:** `src/lib/webhook-processor.ts` (L1169-1989)

Post-generation, before delivery:

1. **Voice note trigger evaluation** (L1123-1167): `evaluateTriggers()` checks library voice notes against 3 trigger types: `stage_transition`, `content_intent`, `conversational_move`. Overrides LLM's voice note decision.

2. **Runtime match resolution** (L1083-1121): For script `[VN]` slots in `runtime_match` mode, calls `findBestVoiceNoteMatch()` which uses embedding similarity + LLM judgment.

3. **R16 URL sanitization** (L1169-1192): `stripHallucinatedUrls()` regex-matches all `https?://` URLs in the reply, checks each against `getAllowedUrls()` (persona links + script action links + slot URLs). Unauthorized URLs become `[link removed]`.

4. **R17 dash sanitization** (L1194-1229): Post-process replaces:
   - `—` (em dash) → `, ` 
   - `–` (en dash) → `-`
   - ` - ` (spaced hyphen connector) → `, `

5. **VN-aware delay** (L1231-1289): If voice-note-aware path, applies appropriate delay per message type and queues to `ScheduledReply`.

6. **Auto-send vs suggestion** (L1292-1304): When `!shouldAutoSend`, broadcasts as suggestion via SSE without saving or sending.

7. **sendAIReply()** (L1325-1989):
   - Re-checks `aiActive` (human may have taken over during delay)
   - Checks for human message conflict in last 30 seconds
   - Saves AI message to `Message` table with stage metadata
   - Persists booking fields (timezone, email) to conversation
   - **Booking execution** (L1443-1695): When `sub_stage === 'BOOKING_CONFIRM'`:
     - Validates selected slot against `proposedSlots` (R14 guard)
     - Calls `bookUnifiedAppointment()` to create real calendar entry
     - Updates conversation outcome to `BOOKED`, lead stage to `BOOKED`
     - Creates `CALL_BOOKED` notification
     - On failure: pauses AI + creates SYSTEM notification
   - Records stage timestamp, updates conversation outcome
   - Auto-applies suggested tags
   - Updates lead stage from conversation stage
   - Broadcasts real-time SSE events

8. **Platform delivery** (L1754-1984) — priority cascade:
   ```
   Library voice note (trigger system)
     → VoiceNoteSlot (slot system, with fallback behavior)
       → ElevenLabs TTS (AI-generated voice note)
         → Text DM (default)
   ```
   
   Each tier falls through to the next on failure. Platform dispatch uses `sendInstagramDM()` / `sendFacebookMessage()` (or their audio equivalents). Delivery failures create SYSTEM notifications.

---

## Part 2: Pipeline Diagram

```
                         INBOUND
                           │
                    ┌──────▼──────┐
                    │  Meta POST  │  x-hub-signature-256
                    │  webhook    │  HMAC-SHA256 verify
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Account   │  IntegrationCredential lookup
                    │  Resolution │  3 fallback tiers
                    └──────┬──────┘
                           │
                   ┌───────┴───────┐
                   │               │
              Admin msg?      Lead message
                   │               │
            processAdmin    ┌──────▼──────┐
            Message()       │   Dedup     │  3 layers:
                            │  + Persist  │  in-memory / P2002 / skipReply
                            └──────┬──────┘
                                   │
                            ┌──────▼──────┐
                            │    Delay    │  log-normal distribution
                            │   Router   │  Box-Muller transform
                            └──────┬──────┘
                                   │
                      ┌────────────┴────────────┐
                      │                         │
                 <= 90s delay              > 90s delay
                      │                         │
               after() inline          ScheduledReply row
               (sleep + deliver)        (cron pickup)
                      │                         │
                      └────────────┬────────────┘
                                   │
                  ┌────────────────▼────────────────┐
                  │         CONTEXT ASSEMBLY         │
                  │                                  │
                  │  ┌─────────┐  ┌──────────────┐  │
                  │  │  Lead   │  │   Booking    │  │
                  │  │ Context │  │  State Inject│  │
                  │  └────┬────┘  └──────┬───────┘  │
                  │       │              │           │
                  │  ┌────▼────┐  ┌──────▼───────┐  │
                  │  │ Scoring │  │  Calendar    │  │
                  │  │ Context │  │  Slot Fetch  │  │
                  │  └─────────┘  └──────────────┘  │
                  └────────────────┬────────────────┘
                                   │
                  ┌────────────────▼────────────────┐
                  │           AI GENERATION          │
                  │                                  │
                  │  ┌─────────────────────────────┐ │
                  │  │  Intent Classification      │ │
                  │  │  (Haiku, 3s timeout)         │ │
                  │  └──────────┬──────────────────┘ │
                  │             │                     │
                  │  ┌──────────▼──────────────────┐ │
                  │  │  3-Tier Few-Shot Retrieval   │ │
                  │  │  (embedding cosine sim)      │ │
                  │  └──────────┬──────────────────┘ │
                  │             │                     │
                  │  ┌──────────▼──────────────────┐ │
                  │  │  System Prompt Build         │ │
                  │  │  (370-line template +        │ │
                  │  │   tenant data + slots)       │ │
                  │  └──────────┬──────────────────┘ │
                  │             │                     │
                  │  ┌──────────▼──────────────────┐ │
                  │  │  LLM Call (Sonnet/GPT-4o)   │ │
                  │  │  temp=0.85, max_tokens=500  │ │
                  │  └──────────┬──────────────────┘ │
                  │             │                     │
                  │  ┌──────────▼──────────────────┐ │
                  │  │  Voice Quality Gate          │ │
                  │  │  (up to 3 attempts)          │ │
                  │  │  23 banned phrases           │ │
                  │  │  9 banned words              │ │
                  │  │  soft score >= 0.7           │ │
                  │  └──────────┬──────────────────┘ │
                  └────────────┬────────────────────┘
                               │
                  ┌────────────▼────────────────┐
                  │    POST-GENERATION GUARDS    │
                  │                              │
                  │  Voice note trigger eval     │
                  │  R16: URL sanitization       │
                  │  R17: Dash sanitization      │
                  └────────────┬────────────────┘
                               │
                  ┌────────────▼────────────────┐
                  │         DELIVERY             │
                  │                              │
                  │  Save to Message table       │
                  │  Persist booking fields      │
                  │  Execute booking (if Stage7) │
                  │  Record stage timestamp      │
                  │  Update lead stage           │
                  │  Auto-apply tags             │
                  │  Broadcast SSE               │
                  └────────────┬────────────────┘
                               │
                      ┌────────┴────────┐
                      │                 │
                  Library VN      VN Slot
                      │                 │
                  ElevenLabs TTS  Text DM
                      │                 │
                      └────────┬────────┘
                               │
                        Platform Send
                    (Instagram / Facebook)
```

---

## Part 3: Differentiation Audit

| # | Question | Status | Evidence |
|---|----------|--------|----------|
| 1 | **Does the AI retrieve real conversation examples from the user's own training data?** | **YES** | `training-example-retriever.ts`: 3-tier metadata-filtered retrieval. Embeddings via `text-embedding-3-small` (1536 dims). Cosine similarity scoring. Metadata filters on `leadType`, `dominantStage`, `primaryObjectionType`. Injected into prompt as `{{fewShotBlock}}`. |
| 2 | **Does the AI adapt its behavior based on what stage of the sales conversation it's in?** | **YES** | 7 sequential stages (OPENING through BOOKING) enforced by the master prompt template (L92-207). Stage is returned in structured JSON. `recordStageTimestamp()` tracks progression. Sub-stages (PATH_A, PATH_B, WATERFALL_L1-L4, BOOKING_TZ_ASK, etc.) provide granular routing. Stage-aware few-shot retrieval (Tier 1 filters on `dominantStage`). |
| 3 | **Does the system detect and respond to specific objection types?** | **YES** | 5 named objection types in prompt (TRUST, FEAR_OF_LOSS, LOW_ENERGY, HAS_MENTOR, NOT_READY). Content intent classifier detects 11 intent types including `price_objection`, `skepticism_or_scam_concern`, `past_failure`. Objection protocols from tenant data fire automatically. R18 prevents premature soft-exit on HAS_MENTOR. |
| 4 | **Does the system enforce the user's actual voice/texting style?** | **YES** | Voice quality gate (`voice-quality-gate.ts`): 23 banned phrases, 9 banned words, 16 banned emojis, em/en dash ban, semicolon ban, "lol" ban, 300-char limit. 28-word vocabulary allowlist (DANIEL_VOCAB). Soft scoring for message length, sentence count, lowercase start, approved emoji. Retry loop (up to 3 attempts). R17 dash sanitization as final defense. |
| 5 | **Does the system prevent URL hallucination?** | **YES** | Three-layer defense: (1) R16 in prompt explicitly bans fabricated URLs with examples. (2) `getAllowedUrls()` builds allowlist from persona config, script actions, and slot URLs. (3) `stripHallucinatedUrls()` regex-strips unauthorized URLs post-generation. Unauthorized URLs replaced with `[link removed]`. |
| 6 | **Does the system handle real calendar booking end-to-end?** | **YES** | `getUnifiedAvailability()` fetches from LeadConnector, Calendly, or Cal.com. Slots filtered to business hours in lead's timezone. AI proposes from real slots only (R14). Slot selection validated against `proposedSlots`. `bookUnifiedAppointment()` creates the actual appointment. Failure modes: pause AI + create SYSTEM notification. |
| 7 | **Does the system produce human-like response timing?** | **YES** | `humanResponseDelay()` in `delay-utils.ts` uses log-normal distribution (Box-Muller transform) centered on geometric mean of configured min/max. Avoids the uniform-random fingerprint that Meta's behavioral detection could flag. Voice-note-aware delay path applies different timing per message type. |
| 8 | **Does the system support voice notes alongside text?** | **YES** | Four voice note sources in priority cascade: (1) Library trigger system (stage/intent/move triggers), (2) Runtime match (embedding + LLM judgment), (3) VoiceNoteSlot system (with SEND_TEXT_EQUIVALENT / BLOCK_UNTIL_FILLED fallbacks), (4) ElevenLabs TTS generation. Cooldown tracking via `voice-note-send-log`. |
| 9 | **Does the system support human takeover mid-conversation?** | **YES** | `aiActive` toggle on conversation. `awayMode` on account. `shouldAutoSend = aiActive OR awayMode`. When paused: generates suggestion only (SSE broadcast, no save/send). Re-checks `aiActive` at delivery time after delay. Checks for human message conflict in last 30s. Admin messages auto-detected via `is_echo` / pageOwnIds. |
| 10 | **Does the system track and adapt to conversation outcomes?** | **PARTIAL** | `TrainingOutcome` enum: CLOSED_WIN, GHOSTED, OBJECTION_LOST, HARD_NO, BOOKED_NO_SHOW, UNKNOWN. Outcome-aware few-shot retrieval (excludes HARD_NO and UNKNOWN from Tier 3). `updateConversationOutcome()` called after every AI reply. However, the training analyzer found 53/53 conversations had UNKNOWN outcome before the backfill fix (30/53 now resolved). Outcome tracking is functional but data coverage remains incomplete. |

---

## Part 4: Competitive Gap Analysis

### What This System Does That Generic AI Chatbots Do Not

1. **Stage-locked sales progression.** The 7-stage pipeline (OPENING through BOOKING) with hard rules (R2: never skip urgency, R3: never enter financial screening before commitment) prevents the AI from jumping ahead or skipping qualification. Generic chatbots let the LLM decide when to pitch.

2. **Financial waterfall qualification.** 4-level cascade (capital → credit score → credit card → low-ticket) with R1 preventing exit on cash alone. This is a specific sales methodology baked into the architecture, not a prompt-only suggestion.

3. **Post-generation voice enforcement.** The quality gate is code-level, not prompt-level. 23 banned phrases, dash sanitization, and a retry loop mean the output is structurally constrained regardless of what the LLM generates.

4. **Anti-hallucination URL guard.** The allowlist + regex strip pattern is a hard code gate. Even if the LLM ignores R16, fabricated URLs are caught before delivery. No generic chatbot has this.

5. **Real calendar booking with slot validation.** The system fetches real availability, proposes real slots, validates the AI's selection against what was actually proposed (R14), and creates the actual appointment. The failure philosophy (pause AI + notify human on any failure) prevents phantom bookings.

### Known Gaps and Limitations

1. **No streaming responses.** The full LLM response is generated in one shot, then quality-gated, then delivered. This adds latency but is required by the structured JSON output format and quality gate.

2. **Single-message responses only.** The AI returns one message per lead message. Real human closers sometimes send 2-3 rapid-fire messages. The system has no message-splitting or multi-bubble delivery.

3. **No image/media analysis.** If a lead sends a screenshot, proof of income, or trading results, the AI cannot see it. The system only processes text content.

4. **No cross-conversation learning.** Each conversation is independent. If a lead was disqualified in one conversation and returns, the system starts fresh (unless the lead record still exists with enrichment data).

5. **Voice quality gate is persona-specific.** The banned phrases, vocabulary, and emoji rules are hardcoded for one persona ("Daniel"). Multi-tenant voice enforcement would require per-account quality gate configuration.

6. **Intent classification is single-model.** The Haiku classifier runs with a 3s hard timeout. On timeout/failure, keyword fallback covers common cases but misses nuanced intents. No ensemble or confidence calibration.

7. **No A/B testing infrastructure.** The system tracks `systemPromptVersion` on messages but has no mechanism to split traffic between prompt variants or measure conversion rate differences.

---

## Part 5: Latency + Cost Report

### LLM Calls Per Inbound Message

| Call | Model | Tokens | Temperature | Timeout | Fatal? |
|------|-------|--------|-------------|---------|--------|
| Intent classification | `claude-haiku-4-20250414` | max 100 out | 0 | 3s | No (keyword fallback) |
| Embedding generation | `text-embedding-3-small` | ~200 input | N/A | default | No (skip few-shot) |
| Main generation (attempt 1) | `gpt-4o` or `claude-sonnet-4-20250514` | max 500 out | 0.85 | default | Yes |
| Main generation (retry 1) | same | max 500 out | 0.85 | default | Best-effort |
| Main generation (retry 2) | same | max 500 out | 0.85 | default | Best-effort |

**Best case:** 3 LLM calls (intent + embedding + 1 generation)  
**Worst case:** 5 LLM calls (intent + embedding + 3 generation attempts)

### Database Queries Per Inbound Message

| Phase | Operation | Count |
|-------|-----------|-------|
| Account resolution | `integrationCredential.findMany` | 1 |
| Lead lookup | `lead.findFirst` | 1 |
| Lead creation (new) | `lead.create` | 0-1 |
| Dedup check | `message.findFirst` | 1 |
| Message save | `message.create` | 1 |
| Conversation update | `conversation.update` | 1 |
| Effectiveness backfill | `message.findMany` + updates | 1-3 |
| Scoring | `conversation.findUnique` + related | 2-4 |
| Conversation fetch (AI gen) | `conversation.findUnique` (with messages, lead, tags) | 1 |
| Account check | `account.findUnique` | 1 |
| Persona fetch | `aIPersona.findFirst` (x2 for fallback) | 1-2 |
| Credential resolution | `getCredentials` (x3-5 providers) | 3-5 |
| Calendar slots | `getUnifiedAvailability` (external API) | 0-1 |
| Training examples | `trainingMessage.findMany` (per tier) | 1-3 |
| Prompt version | `promptVersion.findFirst` | 1 |
| AI message save | `message.create` | 1 |
| Booking updates | `conversation.update` (1-3x) | 1-3 |
| Stage timestamp | `conversation.update` | 1 |
| Outcome update | `conversation.findUnique` + update | 1-2 |
| Tag application | `tag.findFirst` + `leadTag.upsert` (per tag) | 0-4 |
| Lead stage update | `lead.update` | 1 |

**Estimated total:** 20-40 DB operations per inbound message.

### Estimated Latency Breakdown (Wall Clock)

| Phase | Estimated Time | Notes |
|-------|---------------|-------|
| Webhook signature verify | <1ms | HMAC-SHA256, timing-safe compare |
| Account resolution | 50-100ms | Single Prisma query |
| Dedup + message save | 50-150ms | 2-3 queries |
| Context assembly | 200-500ms | Multiple queries + calendar API (if needed) |
| Intent classification | 500-3000ms | Haiku call with 3s timeout |
| Embedding generation | 200-400ms | OpenAI API call |
| Few-shot retrieval | 100-300ms | In-memory cosine similarity |
| Prompt construction | 10-50ms | Template string manipulation |
| Main LLM generation | 2000-8000ms | Sonnet/GPT-4o, 500 max tokens |
| Voice quality gate (if retry) | +2000-8000ms | Additional LLM call per retry |
| Post-generation guards | 10-50ms | Regex operations |
| DB persistence | 100-300ms | Multiple writes |
| Platform delivery | 200-500ms | Instagram/Facebook Graph API |
| **Total (best case)** | **~3.5-10s** | Single generation attempt |
| **Total (worst case)** | **~15-25s** | 3 generation attempts + calendar |

**Note:** The configured response delay (log-normal, typically 30-600s) is applied on top of the generation latency. From the lead's perspective, total response time = delay + generation time.

### Cost Per Message (Estimated)

| Component | Cost Range | Notes |
|-----------|------------|-------|
| Haiku intent classification | $0.0001-0.0003 | ~200 input tokens, 100 output |
| OpenAI embedding | $0.00002 | ~200 tokens at $0.0001/1K |
| GPT-4o generation (per attempt) | $0.005-0.02 | ~3000 input tokens (prompt), 200 output |
| Claude Sonnet generation (per attempt) | $0.01-0.03 | Same token range, higher per-token cost |
| ElevenLabs TTS (if voice note) | $0.01-0.05 | Per-character pricing |
| **Total per message (text, GPT-4o)** | **~$0.005-0.02** | Best case, single attempt |
| **Total per message (text, Sonnet)** | **~$0.01-0.03** | Best case, single attempt |

---

## Appendix: File Index

| File | Lines | Role |
|------|-------|------|
| `src/app/api/webhooks/instagram/route.ts` | 395 | Webhook receipt, signature validation, account resolution, delay routing |
| `src/app/api/webhooks/facebook/route.ts` | ~300 | Same for Facebook Messenger |
| `src/lib/webhook-processor.ts` | ~2000 | Core pipeline: processIncomingMessage, scheduleAIReply, sendAIReply, processAdminMessage |
| `src/lib/ai-engine.ts` | 500 | generateReply, callLLM (OpenAI + Anthropic), parseAIResponse, quality gate loop |
| `src/lib/ai-prompts.ts` | 1176 | Master prompt template (370 lines), buildDynamicSystemPrompt, tenant data builders |
| `src/lib/content-intent-classifier.ts` | 311 | Haiku intent detection + keyword fallback |
| `src/lib/voice-quality-gate.ts` | 233 | Post-generation voice scoring: banned phrases/words/emojis, soft scoring |
| `src/lib/training-example-retriever.ts` | ~300 | 3-tier metadata-filtered few-shot retrieval |
| `src/lib/delay-utils.ts` | 30 | Log-normal delay via Box-Muller transform |
| `src/lib/voice-note-trigger-engine.ts` | ~200 | Stage/intent/move trigger evaluation |
| `src/lib/voice-note-context-matcher.ts` | ~150 | Embedding similarity + LLM judgment for VN matching |
| `src/lib/conversation-state-machine.ts` | ~300 | Stage timestamp recording, outcome updates, effectiveness tracking |
| `src/lib/scoring-integration.ts` | ~200 | Lead scoring context for prompt injection |
| `src/lib/credential-store.ts` | ~100 | Per-account BYOK credential resolution |
| `src/lib/calendar-adapter.ts` | ~400 | Unified calendar API (LeadConnector, Calendly, Cal.com) |
| `src/lib/instagram.ts` | ~300 | verifyWebhookSignature, sendDM, sendAudioDM, getUserProfile |
| `src/lib/facebook.ts` | ~250 | Same for Facebook |
| `src/lib/elevenlabs.ts` | ~100 | TTS voice note generation |
| `src/lib/persona-breakdown-serializer.ts` | ~200 | Dual-layer prompt block from PersonaBreakdown |
| `src/lib/script-serializer.ts` | ~300 | Script template serialization for prompt |
