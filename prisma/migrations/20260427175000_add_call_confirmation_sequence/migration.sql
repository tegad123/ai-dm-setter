-- Add the call-confirmation sequence tracking fields.
ALTER TABLE "Conversation"
  ADD COLUMN "callConfirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "callConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "callOutcome" TEXT;

-- Add scheduled-message types for Daniel's production call-confirmation flow.
ALTER TYPE "ScheduledMessageType" ADD VALUE 'PRE_CALL_HOMEWORK';
ALTER TYPE "ScheduledMessageType" ADD VALUE 'CALL_DAY_CONFIRMATION';
ALTER TYPE "ScheduledMessageType" ADD VALUE 'CALL_DAY_REMINDER';
