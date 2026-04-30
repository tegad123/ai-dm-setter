-- DFY integration infrastructure:
-- - account-scoped ManyChat External Request key
-- - stored ManyChat outbound handoff context on Conversation
-- - stored Typeform application/booking context on Conversation
-- - Typeform credential provider
-- - platform MANAGER role

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MANAGER';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'TYPEFORM';

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "manyChatWebhookKey" TEXT;

UPDATE "Account"
SET "manyChatWebhookKey" = 'qdm_mc_' || md5(random()::text || clock_timestamp()::text || "id")
WHERE "manyChatWebhookKey" IS NULL OR "manyChatWebhookKey" = '';

ALTER TABLE "Account" ALTER COLUMN "manyChatWebhookKey" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Account_manyChatWebhookKey_key"
  ON "Account"("manyChatWebhookKey");

ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "manyChatOpenerMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "manyChatTriggerType" TEXT,
  ADD COLUMN IF NOT EXISTS "manyChatCommentText" TEXT,
  ADD COLUMN IF NOT EXISTS "manyChatFiredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "typeformSubmittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "typeformResponseToken" TEXT,
  ADD COLUMN IF NOT EXISTS "typeformCapitalConfirmed" INTEGER,
  ADD COLUMN IF NOT EXISTS "typeformCallScheduledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "typeformAnswers" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_typeformResponseToken_key"
  ON "Conversation"("typeformResponseToken");

CREATE INDEX IF NOT EXISTS "Conversation_source_manyChatFiredAt_idx"
  ON "Conversation"("source", "manyChatFiredAt");

CREATE INDEX IF NOT EXISTS "Conversation_typeformSubmittedAt_idx"
  ON "Conversation"("typeformSubmittedAt");
