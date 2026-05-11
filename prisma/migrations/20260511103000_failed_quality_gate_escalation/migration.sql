ALTER TYPE "ScheduledReplyStatus" ADD VALUE IF NOT EXISTS 'FAILED_QUALITY_GATE';

ALTER TABLE "Conversation"
ADD COLUMN IF NOT EXISTS "awaitingHumanReview" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Conversation_awaitingHumanReview_idx"
ON "Conversation"("awaitingHumanReview");
