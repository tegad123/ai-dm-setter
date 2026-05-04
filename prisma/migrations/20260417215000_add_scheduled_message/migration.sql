-- ============================================================================
-- Add ScheduledMessage table + supporting enums — backfill missing migration
-- ============================================================================
-- The ScheduledMessage model and its enums (ScheduledMessageType,
-- ScheduledMessageStatus, ScheduledMessageCreatedBy, ScheduledCallSource)
-- were added to schema.prisma in commit c14571c (2026-04-17) but no
-- migration was generated alongside them. Prod was updated via
-- `prisma db push`; fresh `prisma migrate deploy` previously failed at
-- 20260427175000_add_call_confirmation_sequence with
-- "type ScheduledMessageType does not exist" because that migration ALTERs
-- the enum without it ever being created.
--
-- Original ScheduledMessageType values at commit c14571c were:
--   DAY_BEFORE_REMINDER, MORNING_OF_REMINDER, WINDOW_KEEPALIVE,
--   RE_ENGAGEMENT, CUSTOM
-- The PRE_CALL_HOMEWORK / CALL_DAY_CONFIRMATION / CALL_DAY_REMINDER values
-- are added by the subsequent 20260427175000 migration; we keep that
-- migration unchanged.
--
-- This migration is idempotent so prod (which already has these objects)
-- can be reconciled with `prisma migrate resolve --applied`.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ScheduledMessageType') THEN
    CREATE TYPE "ScheduledMessageType" AS ENUM (
      'DAY_BEFORE_REMINDER',
      'MORNING_OF_REMINDER',
      'WINDOW_KEEPALIVE',
      'RE_ENGAGEMENT',
      'CUSTOM'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ScheduledMessageStatus') THEN
    CREATE TYPE "ScheduledMessageStatus" AS ENUM (
      'PENDING',
      'FIRING',
      'FIRED',
      'CANCELLED',
      'FAILED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ScheduledMessageCreatedBy') THEN
    CREATE TYPE "ScheduledMessageCreatedBy" AS ENUM ('SYSTEM', 'HUMAN', 'AI');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ScheduledCallSource') THEN
    CREATE TYPE "ScheduledCallSource" AS ENUM (
      'HUMAN_ENTRY',
      'AI_PARSED_FROM_LEAD',
      'CALENDAR_INTEGRATION'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "ScheduledMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "messageType" "ScheduledMessageType" NOT NULL,
    "messageBody" TEXT,
    "generateAtSendTime" BOOLEAN NOT NULL DEFAULT true,
    "status" "ScheduledMessageStatus" NOT NULL DEFAULT 'PENDING',
    "firedAt" TIMESTAMP(3),
    "relatedCallAt" TIMESTAMP(3),
    "createdBy" "ScheduledMessageCreatedBy" NOT NULL DEFAULT 'SYSTEM',
    "createdByUserId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ScheduledMessage_status_scheduledFor_idx" ON "ScheduledMessage"("status", "scheduledFor");
CREATE INDEX IF NOT EXISTS "ScheduledMessage_conversationId_status_idx" ON "ScheduledMessage"("conversationId", "status");
CREATE INDEX IF NOT EXISTS "ScheduledMessage_conversationId_messageType_status_idx" ON "ScheduledMessage"("conversationId", "messageType", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ScheduledMessage_conversationId_fkey'
  ) THEN
    ALTER TABLE "ScheduledMessage"
      ADD CONSTRAINT "ScheduledMessage_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
