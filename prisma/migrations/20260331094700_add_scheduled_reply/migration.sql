-- ============================================================================
-- Add ScheduledReply table (delay queue) — backfill missing migration
-- ============================================================================
-- The ScheduledReply model was added to schema.prisma in commit 6cd569e
-- (2026-03-31) but no migration was generated alongside it. The table was
-- created on prod via `prisma db push` (or equivalent), so prod has the
-- table without the migration record. Fresh deploys via `prisma migrate
-- deploy` previously failed at 20260405120000_enable_rls_security because
-- the RLS migration ALTERs ScheduledReply before it was ever created.
--
-- This migration is idempotent (CREATE TABLE IF NOT EXISTS, guarded enum
-- creation). On prod, mark this migration as already-applied with:
--   npx prisma migrate resolve --applied 20260331094700_add_scheduled_reply
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ScheduledReplyStatus') THEN
    CREATE TYPE "ScheduledReplyStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'CANCELLED', 'FAILED');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "ScheduledReply" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledReplyStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "messageType" TEXT,
    "generatedResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ScheduledReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ScheduledReply_status_scheduledFor_idx" ON "ScheduledReply"("status", "scheduledFor");
CREATE INDEX IF NOT EXISTS "ScheduledReply_conversationId_status_idx" ON "ScheduledReply"("conversationId", "status");
