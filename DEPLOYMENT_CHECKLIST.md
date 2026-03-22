# DM Setter — Deployment Readiness Checklist

## Phase 1: Core Auth & Account Setup
- [x] Sign up with Clerk (email + Google)
- [x] Sign in / sign out cycle works
- [x] Auto-provisioning creates account + user in DB on first login
- [x] Redirect to /dashboard/overview after login
- [x] Protected routes redirect to sign-in when not authenticated
- [ ] User profile page loads (Settings → Profile)

## Phase 2: Meta/Facebook Integration
- [ ] "Connect with Facebook" OAuth flow works (Settings → Integrations) — CODE COMPLETE, needs browser test
- [ ] Page Access Token stored and encrypted in DB — CODE COMPLETE, needs browser test
- [ ] Instagram Business Account detected and linked — CODE COMPLETE, needs browser test
- [ ] Disconnect integration removes credentials — CODE COMPLETE, needs browser test
- [ ] Integration status shows "Connected" after OAuth — CODE COMPLETE, needs browser test
- [x] Webhook verification (GET /api/webhooks/facebook) returns challenge
- [x] Webhook signature validation (POST) — dev mode bypass works, prod mode validates
- [x] Incoming Facebook DM creates Lead + Conversation + Message
- [x] Incoming Instagram DM creates Lead + Conversation + Message
- [x] Sender profile (name, avatar) fetched from Meta API
- [x] Reply from app actually delivered to Facebook Messenger
- [x] Reply from app actually delivered to Instagram DM — CODE WORKS (tested with fake ID, real IG user needed)
- [x] Comment trigger creates lead from Facebook post comment (triggerType: COMMENT, triggerSource: postId)
- [x] Content attribution tracked (which reel/post triggered the DM)

## Phase 3: Conversation Management
- [ ] Conversations page lists all conversations
- [ ] Priority tab shows high-priority conversations first
- [ ] Unread tab shows only unread conversations
- [ ] Click conversation opens message thread
- [ ] Send message from UI saves to DB
- [ ] Send message from UI delivers to Facebook/Instagram
- [ ] Real-time updates — new incoming messages appear without refresh
- [ ] AI Active toggle turns on/off per conversation
- [ ] Human override pauses AI and sends manual reply
- [ ] Unread count updates correctly
- [ ] Conversation search works
- [ ] Filter by funnel stage works
- [ ] Filter by tags works
- [ ] Filter by assigned team member works

## Phase 4: AI Engine & Persona
- [ ] Anthropic API key set and working
- [ ] AI generates reply when AI Active is ON and new message arrives
- [ ] AI reply uses persona settings (tone, name, company)
- [ ] AI reply follows qualification flow stages
- [ ] AI handles objections using objection scripts
- [ ] AI suggests voice note at appropriate stages
- [ ] Persona settings page loads with current config
- [ ] Upload document extracts and fills persona fields
- [ ] Save persona changes persists to DB
- [ ] Creator DNA / Voice Profile generation works (Analyze My Style)
- [ ] Voice profile shows stats after generation
- [ ] Training data page shows examples
- [ ] Add training example works
- [ ] Edit training example works
- [ ] Delete training example works
- [ ] Bulk import training data works
- [ ] Test message (API) generates correct AI response

## Phase 5: Lead Management
- [ ] Leads page shows all leads with correct columns
- [ ] Lead table shows: name, platform, status, tags, quality, trigger, booking, revenue, last active
- [ ] Search leads by name works
- [ ] Filter by status works
- [ ] Filter by tags works
- [ ] Click lead opens conversation
- [ ] Lead status updates (NEW_LEAD → IN_QUALIFICATION → etc.)
- [ ] Lead quality score displays correctly
- [ ] CSV export works
- [ ] Manual lead creation works
- [ ] Lead detail shows timeline of events

## Phase 6: Tags System
- [ ] Tags settings page lists all tags
- [ ] Create tag with name and color
- [ ] Edit tag name/color
- [ ] Delete tag
- [ ] AI auto-tagging applies tags during conversation (HIGH_INTENT, MONEY_OBJECTION, etc.)
- [ ] Manual tag application to leads
- [ ] Remove tag from lead
- [ ] Tags display as colored badges on lead cards
- [ ] Tags filter on leads page works
- [ ] Tags filter on conversations page works

## Phase 7: Content Attribution
- [ ] Content page shows all tracked content pieces
- [ ] Summary cards: Total Leads, Revenue, Calls Booked
- [ ] Filter by content type (Reel, Story, Post, Live, Ad)
- [ ] Sort by Most Leads / Most Revenue / Most Recent
- [ ] Each row shows: content name, platform, leads, calls, revenue, conv rate, posted date
- [ ] Webhook processor tracks which content piece triggered each lead
- [ ] Revenue and booking stats aggregate correctly per content piece

## Phase 8: Team Management
- [ ] Team page lists all team members
- [ ] Add team member (name, email, role)
- [ ] Edit team member role and commission rate
- [ ] Remove team member
- [ ] Role-based access: Admin sees everything
- [ ] Role-based access: Setter sees only assigned leads
- [ ] Role-based access: Closer sees qualified leads
- [ ] Role-based access: Read-only can view but not act
- [ ] Commission rates display correctly per member
- [ ] Lead assignment/routing works

## Phase 9: Team Notes
- [ ] Notes tab in conversation shows internal notes
- [ ] Add note to a lead
- [ ] Edit existing note
- [ ] Delete note
- [ ] Notes show author name and timestamp
- [ ] Notes visible to all team members on the lead

## Phase 10: Away Mode
- [ ] Away mode toggle in header works
- [ ] Toggling away mode updates DB
- [ ] When away mode ON, AI takes over ALL conversations
- [ ] When away mode OFF, returns to per-conversation AI settings
- [ ] Away mode persists across page refreshes
- [ ] Away mode status shown in settings

## Phase 11: Analytics Dashboard
- [ ] Overview page loads with KPI cards
- [ ] Revenue metrics display (total, collected, pending)
- [ ] Lead volume chart shows last 14 days
- [ ] Conversion funnel visualization works
- [ ] Recent activity feed shows latest events

## Phase 12: Team Performance Analytics
- [ ] Team Performance page loads
- [ ] Activity heatmap renders (hour × day grid)
- [ ] Response time metrics per team member
- [ ] Conversation count per team member
- [ ] Lead stage breakdown per setter
- [ ] Leaderboard ranking

## Phase 13: Advanced Analytics
- [ ] Conversation funnel analysis
- [ ] Message effectiveness scoring per stage
- [ ] Drop-off hotspot detection
- [ ] Sales velocity metrics
- [ ] Lead segmentation analysis
- [ ] Content performance analytics

## Phase 14: Commission Tracking
- [ ] Commission calculated on deal closure
- [ ] Setter commission tracked (first setter to interact)
- [ ] Closer commission tracked
- [ ] Commission rates configurable per team member
- [ ] Commission totals display in analytics

## Phase 15: Calendar Integration
- [ ] Calendly integration connects (Settings → Integrations)
- [ ] Cal.com integration connects
- [ ] LeadConnector integration connects
- [ ] Available time slots fetched from calendar provider
- [ ] Booking appointment creates event on calendar
- [ ] Lead status updates to BOOKED after booking
- [ ] Booking notification sent

## Phase 16: Voice Notes
- [ ] ElevenLabs API key configured
- [ ] Voice note generation from AI reply text
- [ ] Voice note sent as audio attachment via Facebook
- [ ] Voice note sent via Instagram DM
- [ ] Voice settings configurable (stability, similarity)
- [ ] Voice ID selectable per account

## Phase 17: Self-Optimizing Layer
- [ ] A/B test creation works
- [ ] A/B test variant assignment (deterministic)
- [ ] A/B test results tracking
- [ ] Statistical significance calculation
- [ ] Optimization suggestions generated after 100+ conversations
- [ ] Prompt version history tracked
- [ ] Prompt rollback works
- [ ] Cold start detection shows correct thresholds

## Phase 18: Notifications
- [ ] Notification bell shows unread count
- [ ] Click notification opens relevant item
- [ ] Mark single notification as read
- [ ] Mark all as read
- [ ] Notification settings page loads
- [ ] Notification preferences configurable
- [ ] Real-time notifications via SSE

## Phase 19: Real-Time Updates
- [ ] SSE connection established on page load
- [ ] New message broadcasts to open conversation
- [ ] Conversation list updates when new message arrives
- [ ] AI status change broadcasts
- [ ] Unread count updates in sidebar badge

## Phase 20: Onboarding Flow
- [ ] Onboarding wizard appears for new accounts
- [ ] Step 1: Business info (revenue, DM volume, order value)
- [ ] Step 2: Connect social accounts
- [ ] Step 3: Configure AI persona
- [ ] Onboarding complete flag prevents re-showing

## Phase 21: Account & Security
- [ ] Account settings page loads
- [ ] Update business name
- [ ] Update brand settings (logo, color)
- [ ] Credential encryption working (AES-256-GCM)
- [ ] API routes return 401 for unauthenticated requests
- [ ] Multi-tenant isolation — users only see their own data
- [ ] Rate limiting on AI endpoints
- [ ] Webhook signature validation in production mode

## Phase 22: Production Deployment
- [ ] Environment variables set on hosting platform (Vercel/etc.)
- [ ] DATABASE_URL points to production Supabase
- [ ] CREDENTIAL_ENCRYPTION_KEY is production-grade (not dev key)
- [ ] META_APP_SECRET set for webhook signature validation
- [ ] Clerk production keys (not test keys)
- [ ] Ngrok replaced with real domain for webhook URLs
- [ ] Meta webhook URL updated to production domain
- [ ] Meta app submitted for App Review (for public access)
- [ ] Sentry DSN configured for error monitoring
- [ ] CRON_SECRET set for scheduled job authentication
- [ ] SSL/HTTPS enforced
- [ ] Database migrations applied to production
- [ ] Seed data removed / replaced with empty state

## Phase 23: Performance & Edge Cases
- [ ] App loads in < 3 seconds
- [ ] Conversations page handles 1000+ conversations
- [ ] Leads page handles 5000+ leads with pagination
- [ ] AI reply generates in < 15 seconds
- [ ] Webhook responds to Meta in < 5 seconds (200 OK)
- [ ] Voice note generates in < 10 seconds
- [ ] Multiple simultaneous conversations handled correctly
- [ ] Duplicate webhook payloads don't create duplicate messages
- [ ] Token refresh when Meta token expires (60-day cycle)
- [ ] Graceful error handling when AI provider is down
- [ ] Graceful error handling when calendar API is down

---

## Quick Start Testing Order

**Start here (most critical path):**
1. ✅ Phase 1 — Auth
2. ✅ Phase 2 — Meta Integration (partially tested)
3. 🔲 Phase 3 — Conversations (send/receive working, need full test)
4. 🔲 Phase 4 — AI Engine (key set, needs persona + reply test)
5. 🔲 Phase 5 — Leads
6. 🔲 Phase 6 — Tags
7. 🔲 Phase 10 — Away Mode
8. 🔲 Phase 11 — Dashboard Analytics

**Then expand to:**
9-23 in order above

---

*Last updated: 2026-03-20*
