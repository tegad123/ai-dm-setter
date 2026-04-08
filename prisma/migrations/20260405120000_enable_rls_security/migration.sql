-- ============================================================================
-- Enable Row-Level Security (RLS) on all public schema tables
-- ============================================================================
-- WHY: Supabase auto-exposes the public schema via PostgREST using the anon
-- key. Anyone with the project URL + anon key could read/write tables directly,
-- bypassing the Next.js app's `requireAuth` middleware.
--
-- THE FIX: Enable RLS on every table with NO policies. PostgREST honors RLS
-- and will deny all anon/authenticated requests by default. Prisma connects
-- via the direct Postgres connection string (DATABASE_URL / DIRECT_URL) using
-- the `postgres` / `service_role` user, both of which have BYPASSRLS — so the
-- app keeps working unchanged.
--
-- We deliberately do NOT use FORCE ROW LEVEL SECURITY here, because that
-- could affect Prisma if it ever connects via the table-owner role. Plain
-- ENABLE is sufficient to close the anon-key hole flagged by Supabase.
--
-- If we ever want to use the Supabase JS client from the browser, we will
-- add explicit policies per table at that time. Until then, all access must
-- go through the authenticated Next.js API routes.
-- ============================================================================

-- Multi-Tenant / Account Models
ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AIPersona" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrainingExample" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IntegrationCredential" ENABLE ROW LEVEL SECURITY;

-- Core User / Lead / Conversation Models
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;

-- Tagging / Notes / Content Attribution
ALTER TABLE "Tag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeadTag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentAttribution" ENABLE ROW LEVEL SECURITY;

-- Self-Optimizing Layer Models
ALTER TABLE "PromptVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CrmOutcome" ENABLE ROW LEVEL SECURITY;

-- A/B Testing + Optimization Models
ALTER TABLE "ABTest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ABTestAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OptimizationSuggestion" ENABLE ROW LEVEL SECURITY;

-- Booking Prediction Models
ALTER TABLE "PredictionModel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PredictionLog" ENABLE ROW LEVEL SECURITY;

-- Delay Queue
ALTER TABLE "ScheduledReply" ENABLE ROW LEVEL SECURITY;
