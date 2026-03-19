# AI DM Setter — Competitive Feature Roadmap

> **Goal:** Close feature gaps with Mochi and establish clear product superiority.
> **Approach:** Schema-first, batch migrations, then build features layer by layer.
> **Last updated:** 2026-03-18

---

## Architecture Principles

- All new models follow existing multi-tenant pattern (`accountId` on every table)
- All API routes use `requireAuth(request)` returning `{ accountId, userId, role }`
- Enums use `UPPER_SNAKE_CASE` in Prisma, mapped to lowercase in frontend
- New features are built as `/src/features/<feature>/` modules
- UI components follow shadcn/ui + Radix patterns already established

---

## Phase 1 — Schema Expansion (Single Migration)

**Priority:** CRITICAL — must land first, everything else depends on it.

### New Models

```prisma
model Tag {
  id          String    @id @default(cuid())
  name        String
  color       String    @default("#6B7280") // hex color for UI badge
  isAuto      Boolean   @default(false)     // true = AI-generated tag
  accountId   String
  account     Account   @relation(fields: [accountId], references: [id], onDelete: Cascade)
  leads       LeadTag[]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([accountId, name])
  @@index([accountId])
}

model LeadTag {
  id          String   @id @default(cuid())
  leadId      String
  lead        Lead     @relation(fields: [leadId], references: [id], onDelete: Cascade)
  tagId       String
  tag         Tag      @relation(fields: [tagId], references: [id], onDelete: Cascade)
  appliedBy   String?  // userId or "AI" for auto-tags
  confidence  Float?   // AI confidence score (0-1) for auto-tags
  createdAt   DateTime @default(now())

  @@unique([leadId, tagId])
  @@index([leadId])
  @@index([tagId])
}

model TeamNote {
  id             String   @id @default(cuid())
  content        String
  leadId         String
  lead           Lead     @relation(fields: [leadId], references: [id], onDelete: Cascade)
  authorId       String
  author         User     @relation(fields: [authorId], references: [id], onDelete: Cascade)
  accountId      String
  account        Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([leadId, createdAt])
  @@index([accountId])
}

model ContentAttribution {
  id             String   @id @default(cuid())
  contentType    ContentType           // REEL, STORY, POST, LIVE, AD
  contentId      String?               // platform-specific content ID
  contentUrl     String?               // URL to the original content
  caption        String?               // first 200 chars of caption
  platform       Platform              // INSTAGRAM, FACEBOOK
  accountId      String
  account        Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  leads          Lead[]                // leads generated from this content
  leadsCount     Int      @default(0)  // denormalized count for perf
  revenue        Float    @default(0)  // denormalized revenue for perf
  callsBooked    Int      @default(0)  // denormalized
  postedAt       DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([accountId, contentId, platform])
  @@index([accountId, createdAt])
  @@index([accountId, contentType])
}

enum ContentType {
  REEL
  STORY
  POST
  LIVE
  AD
  COMMENT_TRIGGER
  DM_DIRECT
}
```

### Schema Modifications to Existing Models

```prisma
// Account — add Away Mode
model Account {
  // ... existing fields ...
  awayMode       Boolean  @default(false)    // global AI takeover toggle
  awayModeEnabledAt DateTime?                // when away mode was last enabled
  // ... new relations ...
  tags              Tag[]
  teamNotes         TeamNote[]
  contentAttributions ContentAttribution[]
}

// User — add commission + performance fields
model User {
  // ... existing fields ...
  commissionRate    Float?   @default(0)      // percentage (e.g., 10.0 = 10%)
  totalCommission   Float    @default(0)      // lifetime earned commission
  avgResponseTime   Int?                       // average response time in seconds
  // ... new relations ...
  teamNotes         TeamNote[]
}

// Lead — add tag + content attribution relations
model Lead {
  // ... existing fields ...
  tags              LeadTag[]
  teamNotes         TeamNote[]
  contentAttributionId String?
  contentAttribution   ContentAttribution? @relation(fields: [contentAttributionId], references: [id])
}

// Conversation — add priority scoring
model Conversation {
  // ... existing fields ...
  priorityScore     Int      @default(0)      // 0-100, higher = hotter
  lastAIAnalysis    DateTime?                  // when AI last scored this
}
```

### Files to Change

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add all new models, enums, and field modifications above |
| Run `npx prisma migrate dev --name add_competitive_features` | Single migration for all schema changes |
| `prisma/seed.ts` | Add default tags (COLD, WARM, HOT, HIGH_INTENT, GHOST_RISK, MONEY_OBJECTION, REACTIVATED) |

### Acceptance Criteria

- [ ] Migration runs cleanly on fresh and existing databases
- [ ] Seed script creates default auto-tags per account
- [ ] All existing tests still pass
- [ ] No breaking changes to existing API responses

---

## Phase 2 — Core Features (P0)

### 2A. Tag System + AI Auto-Tagging

**What:** Flexible, stackable tags on leads. AI automatically applies tags based on conversation analysis. Users can also manually tag.

**Why:** Mochi's auto-tagging is one of their most praised features. Tags are more flexible than our rigid status enum — a lead can be both "HIGH_INTENT" and "MONEY_OBJECTION" simultaneously.

#### Backend

| File | Change |
|------|--------|
| `src/app/api/tags/route.ts` (NEW) | GET: list tags for account. POST: create custom tag |
| `src/app/api/tags/[id]/route.ts` (NEW) | PUT: update tag. DELETE: remove tag |
| `src/app/api/leads/[id]/tags/route.ts` (NEW) | POST: add tag to lead. DELETE: remove tag from lead |
| `src/lib/ai-engine.ts` | Extend `AIStructuredResponse` to include `suggestedTags: string[]` in the system prompt. AI returns tag suggestions with each reply |
| `src/lib/webhook-processor.ts` | After AI reply, auto-apply suggested tags with `appliedBy: "AI"` and confidence score |
| `src/app/api/leads/route.ts` | Add `tags` filter param. Include tags in lead response via Prisma `include: { tags: { include: { tag: true } } }` |

#### Frontend

| File | Change |
|------|--------|
| `src/features/tags/` (NEW directory) | Tag management components |
| `src/features/tags/components/tag-badge.tsx` | Colored badge component for displaying tags |
| `src/features/tags/components/tag-picker.tsx` | Dropdown multi-select for applying tags to leads |
| `src/features/tags/components/tag-manager.tsx` | Settings page for creating/editing/deleting tags |
| `src/features/leads/components/leads-table.tsx` | Add tags column with colored badges, add tag filter dropdown |
| `src/features/conversations/components/conversation-thread.tsx` | Show lead tags in the header area, allow quick-tag from thread |
| `src/app/dashboard/settings/tags/page.tsx` (NEW) | Tag management settings page |
| `src/hooks/use-tags.ts` (NEW) | Data fetching hook for tags |

#### AI Prompt Changes

Add to the system prompt in `ai-prompts.ts`:

```
TAGGING INSTRUCTIONS:
Analyze the conversation and suggest tags from this list: [account tags].
Return suggested tags in your response JSON as "suggestedTags": ["TAG_NAME", ...].
Rules:
- HIGH_INTENT: Lead has expressed clear interest, asked about pricing, or wants to start
- GHOST_RISK: Lead has gone quiet for 24h+ after initial engagement
- MONEY_OBJECTION: Lead mentioned cost, budget, or financial concerns
- COLD: Lead is unresponsive or gave short/disengaged replies
- REACTIVATED: Lead returned after being inactive 7+ days
Only suggest tags when confidence is > 0.7.
```

#### Acceptance Criteria

- [ ] Tags display as colored badges on leads table and conversation thread
- [ ] Users can create custom tags with name + color
- [ ] AI auto-applies tags after each conversation with confidence > 0.7
- [ ] Tags are filterable in leads table and conversation list
- [ ] Multiple tags can be applied to a single lead
- [ ] Manual tag add/remove works from both leads table and conversation view

---

### 2B. Team Notes / Internal Chat on Leads

**What:** A threaded internal discussion attached to each lead. Setters leave notes, closers read context before taking over. Think Slack thread but on the lead profile.

**Why:** This is the #1 operational gap for setter→closer handoff. Mochi has it, and teams without it resort to external Slack channels which fragment context.

#### Backend

| File | Change |
|------|--------|
| `src/app/api/leads/[id]/notes/route.ts` (NEW) | GET: list notes for lead (paginated, newest first). POST: create note |
| `src/app/api/leads/[id]/notes/[noteId]/route.ts` (NEW) | PUT: edit note. DELETE: remove own note |
| `src/lib/notifications.ts` | Add `TEAM_NOTE` notification type. Notify assigned team members when a note is added to their lead |

#### Frontend

| File | Change |
|------|--------|
| `src/features/team-notes/` (NEW directory) | Team notes components |
| `src/features/team-notes/components/notes-panel.tsx` | Scrollable note thread with author avatar, timestamp, content |
| `src/features/team-notes/components/note-input.tsx` | Text input with submit for adding notes |
| `src/features/team-notes/components/note-item.tsx` | Individual note display with edit/delete for own notes |
| `src/features/conversations/components/conversation-thread.tsx` | Add a "Team Notes" tab or collapsible panel in the lead sidebar |
| `src/hooks/use-team-notes.ts` (NEW) | Data fetching hook |

#### Schema Addition (already in Phase 1)

`TeamNote` model with `leadId`, `authorId`, `accountId`, `content`, timestamps.

#### Acceptance Criteria

- [ ] Notes panel visible in conversation thread view (tab or sidebar)
- [ ] Any team member can add a note
- [ ] Notes show author name, role badge, and timestamp
- [ ] Authors can edit/delete their own notes
- [ ] Adding a note sends notification to lead's assigned team member
- [ ] Notes are account-scoped (multi-tenant safe)

---

### 2C. Content Attribution Tracking

**What:** Track which piece of content (reel, story, post, ad) generated each lead, and roll up revenue + calls booked per content piece. Show a dashboard of "your top-performing content."

**Why:** This is Mochi's #1 differentiator. Creators desperately want to know which content makes money. We can do it better by also tracking Facebook content, not just Instagram.

#### Backend

| File | Change |
|------|--------|
| `src/app/api/content/route.ts` (NEW) | GET: list content attributions with metrics (leads, revenue, calls). Filterable by contentType, platform, date range |
| `src/app/api/content/[id]/route.ts` (NEW) | GET: single content attribution with all associated leads |
| `src/lib/webhook-processor.ts` | On incoming message, extract content reference from webhook payload (comment source post, story reply source, etc.). Create or link `ContentAttribution` record. Update denormalized counters |
| `src/lib/instagram.ts` | Add helper to resolve content metadata (caption, type, URL) from Instagram Graph API media endpoint |
| `src/app/api/analytics/content/route.ts` (NEW) | GET: content performance analytics — top content by leads, revenue, conversion rate. Supports date range and grouping |

#### Frontend

| File | Change |
|------|--------|
| `src/features/content/` (NEW directory) | Content attribution components |
| `src/features/content/components/content-table.tsx` | Table showing content pieces with columns: type icon, caption preview, leads generated, calls booked, revenue, conversion rate |
| `src/features/content/components/content-card.tsx` | Card view for individual content piece with key metrics |
| `src/features/content/components/content-chart.tsx` | Bar/line chart of content performance over time |
| `src/app/dashboard/content/page.tsx` (NEW) | Content attribution dashboard page |
| `src/features/overview/components/` | Add "Top Content" widget to main dashboard |
| Navigation config | Add "Content" nav item under analytics section |

#### Webhook Extraction Logic

```typescript
// In webhook-processor.ts — extract content source
function extractContentSource(webhookPayload: any): ContentSource | null {
  // Instagram comment → extract media_id from the comment's media
  // Instagram story reply → extract story_id
  // Instagram DM with shared media → extract shared media reference
  // Direct DM with no content reference → type = DM_DIRECT
  // Facebook comment → extract post_id
}
```

#### Acceptance Criteria

- [ ] Every new lead is linked to a ContentAttribution (or DM_DIRECT if no content trigger)
- [ ] Content dashboard shows all content pieces with lead count, revenue, calls booked
- [ ] Filterable by content type (Reel, Story, Post, etc.) and date range
- [ ] Content performance chart on analytics page
- [ ] "Top Content" widget on main dashboard
- [ ] Revenue and calls update in real-time when leads progress through funnel
- [ ] Works for both Instagram and Facebook content

---

## Phase 3 — Operational Features (P1)

### 3A. Priority Inbox

**What:** A filtered inbox view that surfaces the hottest conversations first, scored by AI analysis of intent signals, recency, and lead quality.

**Why:** When you have 1000+ conversations, finding the ones that need attention NOW is impossible without prioritization. Mochi has this; we need it.

#### Backend

| File | Change |
|------|--------|
| `src/lib/ai-engine.ts` | Add `calculatePriorityScore(conversation, lead)` function. Factors: lead quality score, last message recency, AI-detected intent level, unread count, current funnel stage |
| `src/app/api/conversations/route.ts` | Add `priority=true` query param that filters conversations with priorityScore > 50 and sorts by score descending |
| `src/lib/webhook-processor.ts` | Recalculate priority score on each new incoming message |

#### Frontend

| File | Change |
|------|--------|
| `src/features/conversations/components/conversations-view.tsx` | Add tab switcher: "All" / "Priority" / "Unread" |
| `src/features/conversations/components/conversation-list.tsx` | When priority tab active, show priority badge with score. Sort by priority score |
| `src/features/conversations/components/priority-badge.tsx` (NEW) | Visual indicator — fire emoji for >80, orange dot for >50 |

#### Priority Score Algorithm

```
priorityScore = weighted sum of:
  - Lead quality score (0-100) × 0.3
  - Intent signals from last 3 messages × 0.25
  - Recency factor (exponential decay from last message) × 0.2
  - Unread message count (capped at 10) × 0.15
  - Funnel stage weight (QUALIFIED > IN_QUALIFICATION > NEW_LEAD) × 0.1
```

#### Acceptance Criteria

- [ ] Priority tab shows only conversations with score > 50
- [ ] Conversations sorted by priority score (highest first)
- [ ] Priority score recalculated on each new message
- [ ] Visual priority indicators in conversation list
- [ ] Priority score visible in conversation header

---

### 3B. Global Away Mode

**What:** One toggle at the account level that activates AI on ALL conversations simultaneously. When the team logs off for the night, flip Away Mode and the AI handles everything.

**Why:** Currently `aiActive` is per-conversation. Toggling 100+ conversations is impractical. Mochi's Away Mode is elegant — one switch, full coverage.

#### Backend

| File | Change |
|------|--------|
| `src/app/api/settings/away-mode/route.ts` (NEW) | GET: current away mode status. PUT: toggle away mode on/off. When enabled, sets `account.awayMode = true` and `account.awayModeEnabledAt = now()` |
| `src/lib/webhook-processor.ts` | In `processIncomingMessage()`, check `account.awayMode`. If true, treat ALL conversations as AI-active regardless of per-conversation `aiActive` setting |
| `src/lib/ai-engine.ts` | When away mode is active, prepend context to AI: "You are handling this conversation in away mode. The team is unavailable. Be helpful but set expectations about response times for complex questions." |

#### Frontend

| File | Change |
|------|--------|
| `src/features/away-mode/` (NEW directory) | Away mode components |
| `src/features/away-mode/components/away-mode-toggle.tsx` | Prominent toggle switch with status indicator (moon icon when active) |
| `src/app/dashboard/layout.tsx` or top nav | Add Away Mode toggle to the dashboard header/nav bar so it's always accessible |
| `src/features/conversations/components/conversation-list.tsx` | Show "Away Mode Active" banner at top when enabled |

#### Acceptance Criteria

- [ ] Single toggle in dashboard header enables/disables away mode
- [ ] When active, AI responds to ALL incoming messages across all conversations
- [ ] Per-conversation `aiActive` toggle is respected as an override (if someone explicitly turned AI off on a conversation, away mode does NOT re-enable it)
- [ ] Visual indicator (banner + icon) when away mode is active
- [ ] Away mode auto-disables when any team member sends a manual message (optional, configurable)

---

### 3C. Setter Performance Heatmaps & Metrics

**What:** Activity heatmaps showing when each setter is active, plus detailed response time analytics, conversation throughput, and stage progression metrics.

**Why:** Mochi has this marked "coming soon." If we ship it first, we own this feature. Sales managers need visibility into team performance.

#### Backend

| File | Change |
|------|--------|
| `src/app/api/analytics/team/route.ts` (NEW) | GET: per-user metrics — messages sent per hour (for heatmap), avg response time, conversations handled, leads by stage, close rate, revenue attributed |
| `src/app/api/analytics/team/[userId]/route.ts` (NEW) | GET: detailed individual performance with time-series data |
| Message model | Track `respondedAt` timestamp to calculate response times accurately |

#### Frontend

| File | Change |
|------|--------|
| `src/features/analytics/components/activity-heatmap.tsx` (NEW) | 7×24 grid (days × hours) showing message volume by color intensity. Uses Recharts or custom SVG |
| `src/features/analytics/components/team-leaderboard.tsx` (NEW) | Ranked list of team members by key metrics with sparkline trends |
| `src/features/analytics/components/response-time-chart.tsx` (NEW) | Line chart of average response time per setter over time |
| `src/app/dashboard/analytics/team/page.tsx` (NEW) | Team performance analytics page |
| Navigation config | Add "Team Performance" sub-nav under Analytics |

#### Acceptance Criteria

- [ ] Activity heatmap shows message volume by hour/day for each team member
- [ ] Average response time calculated and displayed per setter
- [ ] Leaderboard ranks team members by configurable metric
- [ ] Individual setter drill-down shows their funnel progression
- [ ] Date range filtering for all metrics
- [ ] Data exports to CSV

---

## Phase 4 — Intelligence Features (P2)

### 4A. Auto Voice Profile Generation (Creator DNA)

**What:** Analyze a user's conversation history to auto-generate their communication style profile — tone, vocabulary, message length patterns, emoji usage, response cadence. Use this to make the AI sound exactly like them.

**Why:** Mochi's "Creator DNA" is impressive but manual. We can auto-generate it from existing conversations, making our AI more accurate out of the box.

#### Backend

| File | Change |
|------|--------|
| `src/app/api/settings/voice-profile/route.ts` (NEW) | GET: current voice profile. POST: trigger profile generation from conversation history |
| `src/lib/voice-profile-generator.ts` (NEW) | Analyze last 500 human-sent messages. Extract: avg message length, emoji frequency, common phrases, tone indicators, vocabulary level, question frequency. Return structured profile |
| `src/lib/ai-prompts.ts` | Integrate voice profile into system prompt dynamically. Replace generic tone instructions with data-driven style guidance |

#### Frontend

| File | Change |
|------|--------|
| `src/features/voice-profile/` (NEW directory) | Voice profile components |
| `src/features/voice-profile/components/profile-dashboard.tsx` | Visual display of communication style — charts for message length distribution, word cloud, tone meter |
| `src/features/voice-profile/components/generate-button.tsx` | "Analyze My Style" button that triggers profile generation |
| `src/app/dashboard/settings/persona/page.tsx` | Add voice profile section to existing persona settings |

#### Acceptance Criteria

- [ ] One-click profile generation from conversation history
- [ ] Profile shows: tone analysis, avg message length, common phrases, emoji usage
- [ ] Generated profile automatically enhances AI persona prompt
- [ ] Profile can be manually adjusted after generation
- [ ] Re-generation updates profile with latest conversation data

---

### 4B. Commission Tracking

**What:** Track commission earned per team member based on their role's commission rate and deals they contributed to. Show earnings dashboards per setter and closer.

**Why:** High-ticket sales teams pay setters 5-10% and closers 10-20%. Automating this tracking eliminates spreadsheet hell and gives team members real-time visibility.

#### Backend

| File | Change |
|------|--------|
| `src/app/api/analytics/commissions/route.ts` (NEW) | GET: commission breakdown per team member — deals contributed, total revenue, commission earned, pending vs paid |
| `src/app/api/leads/[id]/route.ts` | When lead status changes to CLOSED and revenue is set, auto-calculate commissions for assigned setter + closer |
| `src/lib/commission-calculator.ts` (NEW) | Calculate commissions based on role rates, handle split attribution (setter who qualified + closer who closed) |

#### Frontend

| File | Change |
|------|--------|
| `src/features/commissions/` (NEW directory) | Commission components |
| `src/features/commissions/components/commission-table.tsx` | Per-member commission breakdown with filters |
| `src/features/commissions/components/earnings-card.tsx` | Individual earnings summary card |
| `src/app/dashboard/team/page.tsx` | Add commission summary to team management page |
| `src/app/dashboard/settings/team/` | Add commission rate configuration per team member |

#### Acceptance Criteria

- [ ] Commission rates configurable per team member in settings
- [ ] Auto-calculated when deal closes with revenue
- [ ] Split attribution between setter and closer
- [ ] Commission dashboard with date range filtering
- [ ] Exportable to CSV for payroll

---

### 4C. Multi-Calendar Support

**What:** Support Calendly and Cal.com alongside existing LeadConnector integration. Users pick their calendar provider during onboarding or in settings.

**Why:** Not everyone uses LeadConnector/GHL. Calendly is the most popular scheduling tool, and Cal.com is growing fast with the open-source crowd.

#### Backend

| File | Change |
|------|--------|
| `src/lib/calendly.ts` (NEW) | Calendly API client — check availability, create booking, get event details |
| `src/lib/calcom.ts` (NEW) | Cal.com API client — same interface as above |
| `src/lib/calendar-adapter.ts` (NEW) | Unified calendar interface that delegates to LeadConnector, Calendly, or Cal.com based on account config |
| `src/app/api/calendar/availability/route.ts` | Refactor to use calendar adapter instead of direct LeadConnector calls |
| `src/app/api/calendar/book/route.ts` | Refactor to use calendar adapter |
| Integration provider enum | Add `CALENDLY`, `CALCOM` to IntegrationProvider enum |

#### Frontend

| File | Change |
|------|--------|
| `src/app/dashboard/settings/integrations/` | Add Calendly and Cal.com integration cards with OAuth/API key setup |
| Onboarding wizard | Add calendar provider selection step |

#### Acceptance Criteria

- [ ] Users can connect Calendly, Cal.com, or LeadConnector (or multiple)
- [ ] Availability checks work across all providers
- [ ] Booking creates event in the correct calendar
- [ ] AI knows which calendar to use when booking calls
- [ ] OAuth flow for Calendly, API key for Cal.com

---

## Implementation Order & Dependencies

```
Week 1:  Phase 1 (Schema) — all DB changes in one migration
         ↓
Week 2:  Phase 2A (Tags) — backend + frontend
         Phase 2B (Team Notes) — can build in parallel with tags
         ↓
Week 3:  Phase 2C (Content Attribution) — needs webhook changes
         Phase 3A (Priority Inbox) — needs AI engine changes
         ↓
Week 4:  Phase 3B (Away Mode) — depends on webhook processor updates
         Phase 3C (Heatmaps) — independent, can parallel
         ↓
Week 5:  Phase 4A (Voice Profile) — depends on conversation history
         Phase 4B (Commissions) — independent
         ↓
Week 6:  Phase 4C (Multi-Calendar) — independent
         Polish, testing, integration testing
```

---

## Navigation Updates

Add these new pages to the dashboard navigation:

```
Dashboard
├── Overview (existing)
├── Conversations (existing)
│   └── Now with Priority/Unread tabs
├── Leads (existing)
│   └── Now with tag filtering
├── Content (NEW) ← Content Attribution Dashboard
├── Analytics (existing)
│   ├── Overview (existing)
│   └── Team Performance (NEW) ← Heatmaps & Metrics
├── Team (existing)
│   └── Now with commission summary
└── Settings
    ├── Persona (existing, + Voice Profile section)
    ├── Training (existing)
    ├── Tags (NEW) ← Tag Management
    ├── Integrations (existing, + Calendly/Cal.com)
    └── Notifications (existing)
```

---

## What We Already Beat Mochi On (Don't Lose These)

| Our Advantage | Details |
|--------------|---------|
| Multi-platform | Instagram + Facebook (Mochi is IG only) |
| Voice Notes | ElevenLabs TTS generates actual voice DMs |
| AI Model Choice | OpenAI + Anthropic + BYOK |
| Deeper Onboarding | 8-step wizard builds complete AI persona |
| More Lead Statuses | 14 stages vs ~9 (more granular pipeline) |
| Objection Handling | 4 dedicated objection types with custom scripts |
| Quality Scoring | AI-calculated 0-100 score per lead |

---

## Success Metrics

After full implementation, we should be able to claim:

- **"The only AI DM setter that works on Instagram AND Facebook"**
- **"Real AI voice notes that convert 3x better than text"**
- **"Know exactly which reel made you money"** (content attribution)
- **"Your AI learns YOUR voice, not a generic template"** (voice profile)
- **"Never miss a midnight lead again"** (away mode)
- **"See what your team is actually doing"** (heatmaps)
- **"Choose your AI model — GPT-4, Claude, or bring your own"**
