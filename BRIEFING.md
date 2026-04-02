---

# COMPREHENSIVE ARCHITECTURE & ANALYSIS BRIEFING
## AI DM Setter - Multi-tenant Lead Generation & Sales Automation Platform

---

## 1. PROJECT OVERVIEW

**Project**: AI DM Setter  
**Stack**: Next.js 16 (App Router) + TypeScript + PostgreSQL + Prisma + Clerk Auth  
**Primary Purpose**: AI-powered sales automation that receives leads via Instagram/Facebook DMs & comments, auto-replies with AI, and books calls  
**Architecture**: Multi-tenant SaaS with account isolation + per-account AI personalization  
**Deployment**: Vercel (with cron job support)

---

## 2. ARCHITECTURE

### 2.1 Directory Structure

```
src/
├── app/
│   ├── api/               # Next.js API routes
│   │   ├── auth/          # OAuth & session routes (Clerk + JWT)
│   │   ├── webhooks/      # Instagram & Facebook webhook handlers
│   │   ├── ai/            # AI generation endpoints
│   │   ├── conversations/ # Conversation CRUD + messages
│   │   ├── leads/         # Lead management
│   │   ├── settings/      # Account/integrations config
│   │   ├── analytics/     # Dashboard analytics endpoints
│   │   ├── cron/          # Scheduled tasks (process-scheduled-replies, daily-analysis, retrain-model, etc.)
│   │   └── calendar/      # Calendar booking integrations
│   ├── dashboard/         # Protected pages (Auth guard: Clerk)
│   │   ├── overview/      # Main dashboard with stats
│   │   ├── conversations/ # Conversation list & detail
│   │   ├── leads/         # Lead management view
│   │   ├── content/       # Content attribution tracking
│   │   ├── team/          # Team member management
│   │   ├── analytics/     # Advanced analytics
│   │   ├── settings/      # Account settings
│   │   │   ├── persona/   # AI persona configuration
│   │   │   ├── integrations/ # Third-party service connections
│   │   │   ├── training/  # Training examples management
│   │   │   ├── tags/      # Tag management
│   │   │   ├── notifications/ # Notification preferences
│   │   │   └── [MISSING] account/  # Missing page (404 error)
│   │   ├── onboarding/    # Onboarding flow
│   │   ├── profile/       # User profile (Clerk integration)
│   │   └── layout.tsx     # Dashboard wrapper with Clerk protection
│   ├── layout.tsx         # Root layout
│   └── page.tsx           # Landing page
├── lib/
│   ├── auth-guard.ts      # Clerk-based auth + auto-account provisioning
│   ├── auth.ts            # JWT token utilities (legacy)
│   ├── ai-engine.ts       # Core AI reply generation (OpenAI/Anthropic dual provider)
│   ├── ai-prompts.ts      # Dynamic system prompt builder with template variables
│   ├── webhook-processor.ts # Processes incoming messages from Meta, schedules AI replies
│   ├── credential-store.ts # AES-256-GCM encryption for API keys
│   ├── instagram.ts       # Instagram Graph API (DMs, comments, user profiles)
│   ├── facebook.ts        # Facebook Graph API (Messenger DMs, comments)
│   ├── api.ts             # Client-side fetch wrapper with JWT auth
│   ├── realtime.ts        # WebSocket-based real-time broadcasts
│   ├── conversation-state-machine.ts # Conversation outcome & stage tracking
│   ├── prisma.ts          # Prisma singleton + connection pooling
│   └── [25 other lib files] # Optimization, prediction, booking, voice, etc.
├── components/
│   ├── ui/                # shadcn/ui component library
│   └── kbar/              # Command palette
├── hooks/
│   └── use-api.ts         # React hooks for API calls (leads, conversations, analytics, etc.)
└── middleware.ts          # [MISSING - Clerk middleware not implemented]
```

### 2.2 Next.js App Router Configuration

- **Framework**: Next.js 16.0.10 with React 19
- **Rendering**: SSR for auth pages, RSC for data fetching, Client Components for interactions
- **Image Optimization**: Remote patterns for Clerk, Sling Academy
- **Sentry Integration**: Optional error tracking (controlled by env var)
- **TypeScript**: Strict mode enabled

---

## 3. DATABASE SCHEMA (Prisma)

### 3.1 Core Multi-Tenant Models

#### **Account** (Root tenant container)
- `id`: Unique identifier
- `slug`: URL-safe identifier (unique)
- `name`: Business name
- `logoUrl`, `brandName`, `primaryColor`: Branding
- `plan`: FREE | PRO | ENTERPRISE
- `awayMode`: Boolean toggle for global AI takeover
- Relations: users, leads, integrations, personas, notifications, tags, teamNotes

#### **User** (Team member)
- `id`, `email` (unique), `name`, `passwordHash` (Clerk-managed)
- `accountId`: Tenant reference
- `role`: ADMIN | CLOSER | SETTER | READ_ONLY
- `avatarUrl`, `isActive`
- `commissionRate`, `totalCommission`, `leadsHandled`, `callsBooked`, `closeRate`, `avgResponseTime`

#### **Lead** (Sales prospect)
- `id`, `accountId`: Tenant reference
- `name`, `handle`, `platform`: INSTAGRAM | FACEBOOK
- `platformUserId`: Meta's user ID for API calls
- `status`: NEW_LEAD → IN_QUALIFICATION → HOT_LEAD → QUALIFIED → BOOKED → SHOWED_UP → CLOSED (+ terminal states)
- `triggerType`: DM | COMMENT
- `triggerSource`: Which post/conversation triggered entry
- `qualityScore`: 0-100
- `contentAttributionId`: Which content generated this lead
- `timezone`, `experience`, `incomeLevel`, `geography`: Lead enrichment
- `bookedAt`, `showedUp`, `closedAt`, `revenue`: Booking/close tracking

#### **Conversation** (1:1 thread with a lead)
- `leadId`: Unique relationship (1 conversation per lead)
- `aiActive`: Boolean (manual toggle to pause AI on demand)
- `unreadCount`, `lastMessageAt`
- `priorityScore`: 0-100 (used for sorting in UI)
- `outcome`: ONGOING | BOOKED | LEFT_ON_READ | UNQUALIFIED_REDIRECT | etc. (Self-optimizing layer)
- `leadSource`: INBOUND | OUTBOUND
- `leadIntentTag`: HIGH_INTENT | RESISTANT | UNQUALIFIED | NEUTRAL
- Stage timestamps: `stageQualificationAt`, `stageVisionBuildingAt`, etc. (set once, never reset)

#### **Message** (Single message in a conversation)
- `conversationId`, `sender`: LEAD | AI | HUMAN
- `content`, `isVoiceNote`, `voiceNoteUrl`
- `timestamp`, `platformMessageId` (Meta's message.mid for dedup)
- `sentByUserId`: For HUMAN messages only
- Self-optimizing fields: `stage`, `stageConfidence`, `sentimentScore`, `gotResponse`, `leadContinuedConversation`, `responseTimeSeconds`, `systemPromptVersion`

### 3.2 AI & Personalization Models

#### **AIPersona** (Account's AI configuration)
- `accountId`: Tenant reference
- `personaName`, `fullName`, `companyName`, `tone`
- `systemPrompt`: Base prompt template
- `qualificationFlow`, `objectionHandling`, `knowledgeAssets`: JSON configs
- `proofPoints`, `downsellConfig`, `preCallSequence`, `financialWaterfall`: Sales strategy
- `closerName`, `voiceNotesEnabled`, `responseDelayMin/Max`
- `setupStep`: 0-8 (onboarding progress)
- `isActive`: Only one persona is live at a time
- `setupComplete`, `createdAt`, `updatedAt`

#### **TrainingExample** (Few-shot examples for AI)
- `accountId`, `personaId`: References
- `category`: GREETING | QUALIFICATION | OBJECTION_TRUST | CLOSING | etc. (TrainingCategory enum)
- `leadMessage`: What the lead said
- `idealResponse`: How AI should reply
- `notes`: Context

### 3.3 Integration & Credential Models

#### **IntegrationCredential** (Encrypted API keys)
- `accountId`, `provider`: META | INSTAGRAM | OPENAI | ANTHROPIC | ELEVENLABS | LEADCONNECTOR | etc.
- `credentials`: JSON (AES-256-GCM encrypted: apiKey, accessToken, refreshToken)
- `metadata`: Non-secret config (pageId, igUserId, instagramAccountId, username, voiceId, etc.)
- `isActive`, `verifiedAt`: Connection status

### 3.4 Content & Attribution Models

#### **ContentAttribution** (Track leads from specific content)
- `accountId`, `contentType`: REEL | STORY | POST | LIVE | AD | COMMENT_TRIGGER | DM_DIRECT
- `contentId`, `contentUrl`, `caption`, `platform`, `postedAt`
- `leadsCount`, `revenue`, `callsBooked`: Denormalized for performance

#### **Tag** & **LeadTag** (Lead classification)
- `Tag`: `accountId`, `name` (unique per account), `color`, `isAuto` (AI-generated tags)
- `LeadTag`: Junction table with `confidence` score for AI-generated tags

#### **TeamNote** (Collaboration)
- `leadId`, `authorId`, `accountId`, `content`, `createdAt`

### 3.5 Self-Optimizing Layer Models

#### **Conversation Outcome** (Enum)
- ONGOING, BOOKED, LEFT_ON_READ, UNQUALIFIED_REDIRECT, RESISTANT_EXIT, SOFT_OBJECTION, PRICE_QUESTION_DEFLECTED

#### **PromptVersion** (Track prompt iterations)
- `accountId`, `version` (semver), `promptHash`, `description`, `changeType`
- `performanceBefore/After`: JSON metrics
- `promptContent`: Full snapshot for rollback

#### **CrmOutcome** (Lead disposition from external CRM)
- `accountId`, `leadId`, `showed`, `closed`, `dealValue`
- `closeReason`: ENROLLED | NOT_READY | CANT_AFFORD | NO_SHOW | OTHER
- `source`: "webhook" | "manual"

#### **ABTest** & **ABTestAssignment**
- `ABTest`: `accountId`, `testName`, `stage`, `variantA/B`, `metric`, `sampleSizeTarget`, `status`
- `ABTestAssignment`: Link leads to test variants

#### **OptimizationSuggestion** (AI-generated improvements)
- `accountId`, `type`: SYSTEM_PROMPT_UPDATE | MESSAGE_VARIATION | FLOW_ADJUSTMENT
- `reasoning`, `proposedChanges`, `supportingData`, `stagingTestResults`, `status`

#### **PredictionModel** & **PredictionLog** (Booking predictor)
- `PredictionModel`: ML model weights, features, accuracy, AUC
- `PredictionLog`: Per-conversation predictions with outcomes

### 3.6 Scheduling & Delay Queue

#### **ScheduledReply** (Delayed message sending)
- `conversationId`, `accountId`, `scheduledFor`
- `status`: PENDING | PROCESSING | SENT | CANCELLED | FAILED
- `attempts`, `lastError`

### 3.7 Enums Summary

- **Role**: ADMIN, CLOSER, SETTER, READ_ONLY
- **Platform**: INSTAGRAM, FACEBOOK
- **LeadStatus**: 14 states from NEW_LEAD → CLOSED
- **TriggerType**: COMMENT, DM
- **MessageSender**: AI, LEAD, HUMAN
- **NotificationType**: CALL_BOOKED, HOT_LEAD, HUMAN_OVERRIDE_NEEDED, NO_SHOW, CLOSED_DEAL, NEW_LEAD, SYSTEM, TEAM_NOTE
- **IntegrationProvider**: 7 provider types
- **ContentType**: 7 content types
- **TrainingCategory**: 19 training categories
- **ABTestStatus**: RUNNING, COMPLETED, PAUSED
- **OptimizationStatus**: 6 states
- **ScheduledReplyStatus**: 5 states

---

## 4. AUTHENTICATION FLOW

### 4.1 Clerk Integration (Primary)

1. **User logs in** via Clerk UI (email/password, social, etc.)
2. **Clerk creates JWT** in session cookie
3. **Dashboard pages** are protected by Clerk middleware (not yet implemented in `src/middleware.ts`)
4. **API routes** use `requireAuth()` from `auth-guard.ts` which:
   - Calls `auth()` and `currentUser()` from `@clerk/nextjs/server`
   - Looks up user in database by email
   - **Auto-provisions** if user doesn't exist:
     - Creates new Account with unique slug
     - Creates default AIPersona with basic system prompt
     - Creates User with ADMIN role

### 4.2 JWT Token (Legacy/Fallback)

- **Token creation** in `src/lib/auth.ts`
- Uses `jsonwebtoken` library with `HS256` algorithm
- Stored in localStorage on client
- Fallback strategy in `/api/auth/me` if Clerk session unavailable
- **Token structure**: `{ userId, email, role, accountId }`

### 4.3 Auth Guard (`src/lib/auth-guard.ts`)

```typescript
interface AuthContext {
  userId: string;
  email: string;
  name: string;
  role: string;  // ADMIN | CLOSER | SETTER | READ_ONLY
  accountId: string;
}
```

- Used in all API routes via `await requireAuth(request)`
- Enforces Clerk session requirement
- Returns 401 if not authenticated
- Auto-provisions missing users (creates account + persona)

---

## 5. META / INSTAGRAM INTEGRATION

### 5.1 OAuth Flow (Instagram)

#### **Initiation** (`/api/auth/instagram/route.ts`)
1. Generate `state` param: `base64url(JSON.stringify({ accountId, userId }))`
2. Redirect to: `https://api.instagram.com/oauth/authorize?client_id=...&scope=instagram_graph_user,pages_manage_metadata...&redirect_uri=...&state=...`

#### **Callback** (`/api/auth/instagram/callback/route.ts`)
1. Exchange code for **short-lived token** (via `api.instagram.com/oauth/access_token`)
2. Exchange for **long-lived token** (via Graph API `ig_exchange_token` grant)
3. Fetch user profile (username, name, followers)
4. Save credentials via `setCredentials()`:
   - Provider: `INSTAGRAM`
   - Credentials: `{ accessToken }` (encrypted)
   - Metadata: `{ igUserId, instagramAccountId, username, name, profilePicture, followersCount }`

### 5.2 OAuth Flow (Facebook/Meta)

#### **Initiation** (`/api/auth/meta/route.ts`)
Similar to Instagram but:
- Redirect to Facebook Login (`facebook.com/v21.0/dialog/oauth`)
- Scope: `pages_manage_metadata`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_messaging`

#### **Callback** (`/api/auth/meta/callback/route.ts`)
1. Exchange code for token
2. Fetch user's pages (via Graph API)
3. Auto-subscribe to webhook (POST to `/{pageId}/subscribed_apps`)
4. Save credentials as provider `META`

### 5.3 Webhook Signature Verification

**Instagram Webhook** (`src/lib/instagram.ts`):
```typescript
function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const appSecret = process.env.META_APP_SECRET || process.env.INSTAGRAM_APP_SECRET;
  const expectedSig = 'sha256=' + HMAC-SHA256(rawBody, appSecret);
  return timingSafeEqual(signature, expectedSig);
}
```

**Facebook Webhook** (`src/lib/facebook.ts`):
Same verification logic.

### 5.4 Webhook Handlers

#### **Instagram DMs & Comments** (`/api/webhooks/instagram/route.ts`)

**GET** (Verification):
- Endpoint: `/api/webhooks/instagram`
- Meta sends: `hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
- Return challenge if `hub.verify_token === WEBHOOK_VERIFY_TOKEN`

**POST** (Event Processing):
1. Verify signature from `x-hub-signature-256` header
2. Parse payload: `{ object: 'instagram', entry: [{ id, messaging: [...], changes: [...] }] }`
3. Resolve `accountId` from webhook entry.id (IG Business Account ID):
   - Primary: Match against stored `IntegrationCredential` metadata (igUserId, instagramAccountId, pageId)
   - Fallback 1: Match via env var `INSTAGRAM_PAGE_ID`
   - Fallback 2: Use first account in DB if no credentials found
   - Fallback 3: Single-account setup — use only account if multiple exist
4. Process messaging events:
   - Extract `event.message.text`, `event.sender.id`, `event.message.mid`
   - Fetch sender profile (username)
   - Call `processIncomingMessage()` with platform: 'INSTAGRAM'
5. Process comment events:
   - Extract `event.changes[].field === 'comments'`
   - Call `processCommentTrigger()`

#### **Facebook Messenger & Comments** (`/api/webhooks/facebook/route.ts`)

Similar structure but:
- Object type: `page` (not `instagram`)
- Comments field: `feed` (not `comments`)
- Entry ID: Page ID

### 5.5 Credential Storage

**Encryption** (`src/lib/credential-store.ts`):
- Algorithm: `AES-256-GCM`
- Key: `CREDENTIAL_ENCRYPTION_KEY` (hashed to 32 bytes if needed)
- Format: `iv:tag:ciphertext` (all hex)
- Stored in `IntegrationCredential.credentials` JSON field

**Usage**:
```typescript
const creds = await getCredentials(accountId, 'INSTAGRAM');
// Returns: { accessToken: "..." }

await setCredentials(accountId, 'INSTAGRAM', { accessToken }, metadata);
// Encrypts and stores, with unique constraint: (accountId, provider)
```

---

## 6. AI ENGINE & REPLY GENERATION

### 6.1 Main Flow (`src/lib/ai-engine.ts`)

```typescript
export async function generateReply(
  accountId: string,
  conversationHistory: ConversationMessage[],
  leadContext: LeadContext
): Promise<GenerateReplyResult>
```

**Steps**:
1. **Build system prompt** via `buildDynamicSystemPrompt(accountId, leadContext)`
   - Fetches active AIPersona
   - Merges master template with persona config + lead context
   - Template variables: `{{fullName}}`, `{{tone}}`, `{{leadName}}`, `{{platform}}`, etc.

2. **Resolve AI provider** (per-account BYOK → env fallback):
   - Try `IntegrationCredential` for `OPENAI` or `ANTHROPIC`
   - Fallback to env vars: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
   - Default model: `gpt-4o` (OpenAI) or `claude-sonnet-4-20250514` (Anthropic)

3. **Format conversation history**:
   - LEAD messages → role: 'user'
   - AI/HUMAN messages → role: 'assistant'
   - Anthropic requires user-first + alternating roles (merge consecutive same-role)

4. **Call LLM** with:
   - `temperature: 0.85` (balance coherence + creativity)
   - `max_tokens: 500`
   - System prompt + conversation

5. **Parse structured JSON response**:
   ```json
   {
     "format": "text" | "voice_note",
     "message": "...",
     "stage": "GREETING" | "QUALIFICATION" | ... | "BOOKING",
     "stage_confidence": 0.0-1.0,
     "sentiment_score": -1.0 to 1.0,
     "suggested_tag": "HIGH_INTENT" | "RESISTANT" | "UNQUALIFIED" | "NEUTRAL" | "",
     "suggested_tags": ["tag1", "tag2"]
   }
   ```

6. **Get response delay** from persona config:
   - Random delay between `responseDelayMin` and `responseDelayMax` (default: 5-10 min)

7. **Return result** with prompt version, delay, voice note flag, tags

### 6.2 System Prompt Template (`src/lib/ai-prompts.ts`)

**Master template structure**:
```
You are {{fullName}}, a sales closer and appointment setter{{companyContext}}.

## YOUR IDENTITY
- Name: {{fullName}}
- Persona: {{personaName}}
- Tone: {{toneDescription}}

## RESPONSE FORMAT
You MUST respond with valid JSON only.

## CONVERSATION STAGES
1. GREETING
2. QUALIFICATION
3. VISION_BUILDING
4. PAIN_IDENTIFICATION
5. URGENCY
6. SOLUTION_OFFER
7. CAPITAL_QUALIFICATION
8. GOAL_EMOTIONAL_WHY
9. SOFT_PITCH_COMMITMENT
10. FINANCIAL_SCREENING
11. BOOKING

## OBJECTION HANDLING
[Pre-defined responses for common objections]

## STALL HANDLING
[Follow-up strategies for ghosted leads]

## RULES
1. Talk like a REAL PERSON. No corporate speak.
2. Keep messages SHORT (2-4 sentences max).
3. Ask ONE question at a time.
4. Match the lead's energy.
5. Never reveal you're an AI. You are {{fullName}}.
[...more rules...]

## LEAD CONTEXT
- Name: {{leadName}}
- Handle: @{{handle}}
- Platform: {{platform}}
- Current Status: {{status}}
- Trigger: {{triggerType}}
- Quality Score: {{qualityScore}}/100

## CONVERSATION HISTORY
[Full message history]
```

**Dynamic sections**:
- `{{qualificationFlowContext}}`: If persona has custom qualification flow
- `{{trainingExamplesContext}}`: 3-5 few-shot examples by category
- `{{proofPointsContext}}`: Proof points + deployment triggers
- `{{knowledgeAssetsContext}}`: Knowledge base with deploy triggers
- `{{preCallSequenceContext}}`: Pre-call nurture messaging
- `{{customPhrasesContext}}`: Custom greetings, affirmations, etc.

### 6.3 Dual Provider Support

**OpenAI**:
```typescript
const response = await client.chat.completions.create({
  model, temperature: 0.85, max_tokens: 500,
  messages: [{ role: 'system', content: systemPrompt }, ...messages]
});
```

**Anthropic**:
```typescript
const response = await client.messages.create({
  model, system: systemPrompt, temperature: 0.85, max_tokens: 500,
  messages: anthropicMessages  // User-first, alternating roles
});
```

---

## 7. WEBHOOK PROCESSING & MESSAGE FLOW

### 7.1 Incoming Message Processing (`src/lib/webhook-processor.ts`)

#### `processIncomingMessage()` (Step 1: Save to DB)

**Input**:
```typescript
{
  accountId: string;
  platformUserId: string;  // Meta user ID
  platform: 'INSTAGRAM' | 'FACEBOOK';
  senderName: string;
  senderHandle: string;
  messageText: string;
  triggerType: 'DM' | 'COMMENT';
  platformMessageId?: string;  // Meta's message.mid
}
```

**Steps**:
1. Find or create Lead:
   - Query: `Lead.findFirst({ accountId, platformUserId, platform })`
   - If not found: Create lead + conversation in transaction
   - Set status: `NEW_LEAD`
2. **Dedup check**: If `platformMessageId` exists, check for `Message.platformMessageId` (unique constraint)
3. Create `Message`: Save lead's message with sender='LEAD'
4. Update `Conversation`: Increment `unreadCount`, set `lastMessageAt`
5. **Backfill effectiveness**: Run `backfillEffectivenessTracking()` on previous AI messages
6. **Re-engage**: If conversation outcome was `LEFT_ON_READ`, reset to `ONGOING`
7. **Broadcast**: Real-time event to connected clients

**Output**:
```typescript
{ leadId, conversationId, messageId, isNewLead }
```

#### `scheduleAIReply()` (Step 2: Generate & Schedule)

**Input**: `conversationId`, `accountId`

**Steps**:
1. Fetch conversation with lead + messages + tags
2. Check **AI active** toggle + **away mode**:
   - If AI active OR away mode: `shouldAutoSend = true`
   - Else: Generate as suggestion only (broadcast, don't send)
3. Build conversation history:
   - Fetch all messages from DB
   - Fallback: If only 1 message, try Meta API backfill via `backfillFromMetaAPI()`
4. Build `LeadContext` with enrichment:
   - Lead metadata (name, handle, platform, status, qualityScore)
   - Tags, intentTag, leadScore, experience, incomeLevel, timezone, geography
5. Call `generateReply()` → get AI response + metadata
6. If NOT auto-send: Broadcast as suggestion only, return
7. If auto-send:
   - Create `ScheduledReply` record with `scheduledFor = now + suggestedDelay`
   - Status: PENDING
   - Cron job picks up every 60 seconds

**Critical feature**: "Human override" — if AI is paused (`aiActive = false`), still generate a suggestion but don't auto-send.

#### `processScheduledReply()` (Step 3: Re-check & Send) [Called by cron]

**Input**: `conversationId`, `accountId`

**Steps**:
1. Re-fetch conversation (to check if AI still active)
2. If AI deactivated: Broadcast as suggestion, don't send
3. Regenerate reply (full AI generation pipeline again)
4. Call `sendAIReply()`

#### `sendAIReply()` (Step 4: Persist & Deliver)

**Steps**:
1. Save AI message to DB: sender='AI', include stage + confidence
2. Update `Conversation.lastMessageAt`
3. Record stage timestamp via `recordStageTimestamp()`
4. Update conversation outcome via `updateConversationOutcome()`
5. Auto-apply suggested tags via `applyAutoTags()`
6. Update lead status (only upgrade, never downgrade) via `updateLeadStatusFromStage()`
7. Broadcast real-time message event
8. **Delivery** (fire-and-forget with 3 retries):
   - If INSTAGRAM: Call `sendInstagramDM(accountId, platformUserId, reply)`
   - If FACEBOOK: Call `sendFacebookMessage(accountId, platformUserId, reply)`
9. If delivery fails: Create notification for account owner

### 7.2 Comment Trigger (`processCommentTrigger()`)

1. Check if lead already exists for this commenter
2. If exists, skip (prevent duplicate leads)
3. Find content attribution for the post
4. Create lead + conversation via `processIncomingMessage()`
5. Link lead to content attribution
6. Schedule AI reply (first DM to commence interaction)

### 7.3 Message Deduplication

- **Primary**: Check `Message.platformMessageId` (unique constraint)
- **DB-level catch**: If race condition, catch `P2002` error
- **Idempotent**: Same webhook event processed twice → second ignored

### 7.4 Back-fill from Meta API

**Scenario**: Local DB has only 1 message, but conversation should have more history.

**Process** (`backfillFromMetaAPI()`):
1. Fetch conversations from Meta API (Instagram or Facebook)
2. Find matching conversation by `platformUserId`
3. Fetch messages from matched conversation
4. Merge with local DB (dedupe by content + timestamp)
5. Create missing messages in DB
6. Return complete chronological message list

---

## 8. CRON JOBS & SCHEDULED TASKS

### 8.1 Process Scheduled Replies (`/api/cron/process-scheduled-replies`)

**Schedule**: Every 60 seconds (Vercel Hobby plan limit)  
**Trigger**: External cron service sends `GET /api/cron/process-scheduled-replies` with bearer token

**Logic**:
```typescript
// Find PENDING replies that are due
const pending = await ScheduledReply.findMany({
  where: {
    status: 'PENDING',
    scheduledFor: { lte: now },
    attempts: { lt: 3 }
  },
  take: 10
});

// Mark as PROCESSING (prevent double-pickup)
// For each reply, call processScheduledReply()
// On success: Mark as SENT
// On failure: Increment attempts, mark as FAILED if attempts >= 3
```

**Auth**: Requires `Authorization: Bearer <CRON_SECRET>` header

### 8.2 Daily Analysis (`/api/cron/daily-analysis`)

**Schedule**: Daily at midnight  
**Purpose**: Calculate metrics, effectiveness scores, conversation outcomes

### 8.3 Retrain Model (`/api/cron/retrain-model`)

**Schedule**: Daily  
**Purpose**: Re-train booking prediction model with new conversation data

### 8.4 Stale Conversations (`/api/cron/stale-conversations`)

**Schedule**: Daily  
**Purpose**: Mark conversations as `LEFT_ON_READ` after configurable timeout

### 8.5 Data Retention (`/api/cron/data-retention`)

**Schedule**: Daily  
**Purpose**: Archive or delete old data per GDPR/retention policy

---

## 9. FRONTEND STATE & DATA FLOW

### 9.1 API Fetch Wrapper (`src/lib/api.ts`)

```typescript
export async function apiFetch<T = any>(url: string, options?: RequestInit): Promise<T> {
  // Gets JWT from localStorage
  // Sets Authorization: Bearer <token> header
  // Includes credentials: 'include' (for Clerk cookies)
  // Parses JSON response
}
```

### 9.2 React Hooks (`src/hooks/use-api.ts`)

All hooks use a generic `useApiFetch()` helper:

**Leads**:
- `useLeads(params)` → `getLeads()`

**Conversations**:
- `useConversations(search?, priority?, unread?)` → `getConversations()`
- `useConversation(id)` → `getConversation()`
- `useMessages(conversationId, limit?)` → `getMessages()`

**Analytics**:
- `useOverviewStats()` → `getOverviewStats()`

---

## 8. AI ENGINE

### Core Flow (generateReply)

**File**: `src/lib/ai-engine.ts` (297 lines)

```
generateReply(accountId, conversationHistory, leadContext)
  ├─ [1] buildDynamicSystemPrompt(accountId, leadContext)
  │   └─ Loads AIPersona, training examples, prompt config
  │   └─ Injects lead context (name, status, quality, history)
  ├─ [2] resolveAIProvider(accountId)
  │   ├─ Check account-specific OPENAI credential
  │   ├─ Check account-specific ANTHROPIC credential
  │   ├─ Fall back to env vars: OPENAI_API_KEY or ANTHROPIC_API_KEY
  │   └─ Default model: gpt-4o or claude-sonnet-4-20250514
  ├─ [3] formatConversationForLLM(history)
  │   └─ LEAD → "user", AI/HUMAN → "assistant"
  ├─ [4] callLLM(provider, apiKey, model, systemPrompt, messages)
  │   ├─ OpenAI: client.chat.completions.create()
  │   ├─ Anthropic: client.messages.create()
  │   └─ Temperature: 0.85, max_tokens: 500
  └─ [5] parseAIResponse(rawResponse)
      └─ Expects JSON: {message, stage, stage_confidence, sentiment_score, ...}
      └─ Falls back to plain text if JSON parse fails
```

### AI Response Format (expected JSON)
```json
{
  "format": "text",
  "message": "Hey! What's your experience with trading?",
  "stage": "QUALIFICATION",
  "stage_confidence": 0.85,
  "sentiment_score": 0.6,
  "suggested_tag": "HIGH_INTENT",
  "suggested_tags": ["HIGH_INTENT"],
  "should_voice_note": false,
  "quality_score_delta": 10,
  "suggested_delay": 300
}
```

### Dynamic System Prompt
**File**: `src/lib/ai-prompts.ts`

Builds a 394+ line system prompt from:
- AIPersona config (tone, name, company, custom phrases)
- Qualification flow (multi-step questions)
- Objection handling scripts
- Training examples (injected as few-shot examples)
- Knowledge assets, proof points
- Pre-call sequence, no-show protocol
- Financial waterfall / downsell config
- Lead context (current stage, quality, history)

---

## 9. ENVIRONMENT VARIABLES

### Required for Production
```bash
# Database
DATABASE_URL=postgresql://...

# Auth (Clerk)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
JWT_SECRET=<for legacy auth fallback>

# Meta / Instagram
META_APP_ID=<Facebook App ID>
META_APP_SECRET=<Facebook App Secret>
INSTAGRAM_APP_ID=<Instagram App ID - may be same as META_APP_ID>
INSTAGRAM_APP_SECRET=<Instagram App Secret>
WEBHOOK_VERIFY_TOKEN=<random string for webhook verification>

# AI Provider (at least one)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Security
CREDENTIAL_ENCRYPTION_KEY=<32+ char string for AES-256>

# App URL
NEXT_PUBLIC_APP_URL=https://qualifydms.io
```

### Optional
```bash
# Sentry
NEXT_PUBLIC_SENTRY_DSN=https://...
SENTRY_AUTH_TOKEN=sntrys_...

# ElevenLabs (voice notes)
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...

# CRM Integration
LEADCONNECTOR_API_KEY=...
LEADCONNECTOR_CALENDAR_ID=...

# Calendar
CALENDLY_API_KEY=...

# Fallback page IDs (if not using per-account OAuth)
FACEBOOK_PAGE_ID=...
INSTAGRAM_PAGE_ID=...
META_ACCESS_TOKEN=...
```

---

## 10. CRON JOBS

All in `src/app/api/cron/`:

| Job | Schedule | Purpose |
|-----|----------|---------|
| `process-scheduled-replies` | Every minute | Processes the delayed message queue (ScheduledReply table) |
| `daily-analysis` | Daily at midnight | AI performance analysis, conversation outcome review |
| `stale-conversations` | Daily | Follow up on ghosted leads, send re-engagement messages |
| `data-retention` | Daily | Clean up old messages per retention policy |
| `retrain-model` | Daily | Retrain booking prediction model (needs 200+ conversations) |

**Vercel Cron Config** (`vercel.json`):
- Limited to daily on Hobby plan
- `maxDuration: 60` on webhook routes for AI generation time

---

## 11. KNOWN BUGS & ISSUES

### Fixed (in this session)
1. **~40 API calls returning 404** — `apiFetch` calls missing `/api` prefix. Fixed by normalizing URLs in `apiFetch()`.
2. **Instagram DMs not creating conversations** — Webhook credential matching failed because `igUserId` (creator ID) != `entry.id` (business account ID). Fixed with fallback logic.
3. **TypeScript build error** — `[...new Set()]` spread syntax incompatible with target. Fixed with `Array.from()`.

### Fixed (by partner in separate session)
4. **Webhook signature verification blocking in production** — `INSTAGRAM_APP_SECRET` now tries both IG and Meta secrets.
5. **Instagram DM sending using wrong API base** — IG tokens (IGAA...) now use `graph.instagram.com`, FB tokens use `graph.facebook.com`.
6. **OAuth callback timeouts** — Added `maxDuration=30s` to OAuth routes.

### Still Present
7. **`/dashboard/settings/account` returns 404** — Page file doesn't exist but something links to it. Causes constant 404s in logs.
8. **Prediction model is heuristic, not ML** — Uses hardcoded weights (responseRate 30%, highIntent 20%, etc.), not actual trained model.
9. **Calendar integration incomplete** — Routes exist but booking logic is stub.
10. **CRM integration incomplete** — Only webhook receiver, no bidirectional sync.
11. **Real-time WebSocket** — Infrastructure exists but unclear if wired to frontend.
12. **`scripts/seed_admin.py` uses SQLAlchemy** — App uses Prisma. Script won't work.

---

## 12. FEATURE STATUS

| Feature | Status | Notes |
|---------|--------|-------|
| Auth (Clerk + JWT) | ✅ Complete | Dual auth, auto-provisioning |
| Meta OAuth (Facebook) | ✅ Complete | Long-lived tokens, page subscription |
| Instagram OAuth | ✅ Complete | Token exchange, profile fetch |
| Webhook receipt (IG + FB) | ✅ Complete | Signature verify, account matching with fallbacks |
| AI Reply Generation | ✅ Complete | Dual provider (OpenAI/Anthropic), full prompt system |
| DM Sending (IG + FB) | ✅ Complete | IG/FB token detection, retry logic |
| Lead Management | ✅ Complete | CRUD, filtering, 13 statuses |
| Conversation Management | ✅ ~90% | List, detail, AI toggle, message history |
| Tags System | ✅ Complete | Auto + manual tagging |
| Analytics | ✅ Complete | 15+ endpoints, funnel, team, revenue |
| Persona Setup | ✅ ~90% | Full config, onboarding wizard |
| Training Examples | ✅ Complete | CRUD, bulk import, 19 categories |
| Content Attribution | ✅ Complete | Track which content generates leads |
| Away Mode | ✅ Complete | Global AI on/off toggle |
| Team Management | ✅ ~80% | Roles, commission tracking |
| A/B Testing | ⚠️ ~50% | CRUD done, staging/analysis incomplete |
| Optimization Engine | ⚠️ ~60% | Suggestions work, apply/revert partial |
| Booking Prediction | ⚠️ ~40% | Heuristic only, not ML |
| Voice Profiles | ⚠️ ~50% | Endpoint exists, ElevenLabs untested |
| Calendar Integration | ❌ ~10% | Routes exist, logic missing |
| CRM Integration | ❌ ~30% | Webhook receiver only |
| Account Settings Page | ❌ Missing | Causes 404s |
| Real-time Updates | ⚠️ ~60% | Infrastructure exists, wiring unclear |

---

## 13. QUICK REFERENCE

### Key File Locations
- **Webhook processing**: `src/lib/webhook-processor.ts` (1103 lines — the heart of the app)
- **AI engine**: `src/lib/ai-engine.ts` + `src/lib/ai-prompts.ts`
- **Credential encryption**: `src/lib/credential-store.ts`
- **Auth guard**: `src/lib/auth-guard.ts`
- **Instagram API**: `src/lib/instagram.ts` (377 lines)
- **Facebook API**: `src/lib/facebook.ts` (209 lines)
- **Client API helper**: `src/lib/api.ts` (auto-prefixes `/api` to paths)
- **Prisma schema**: `prisma/schema.prisma`
- **Nav config**: `src/config/nav-config.ts`

### Production URL
- **App**: `https://qualifydms.io`
- **Vercel**: `ai-dm-setter.vercel.app`

### Meta Webhook URLs
- Instagram: `https://qualifydms.io/api/webhooks/instagram`
- Facebook: `https://qualifydms.io/api/webhooks/facebook`
