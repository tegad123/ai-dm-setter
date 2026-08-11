-- Fix D P0: move the atomic per-turn generation claim out of
-- capturedDataPoints (business data) into dedicated columns. Claims are
-- 3-minute-transient by contract, so no backfill — just add the columns
-- and strip the legacy jsonb key everywhere it still lingers.
ALTER TABLE "Conversation" ADD COLUMN "generationClaimMessageId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "generationClaimAt" TIMESTAMP(3);

UPDATE "Conversation"
SET "capturedDataPoints" = "capturedDataPoints" - 'lastGenerationClaim'
WHERE "capturedDataPoints" ? 'lastGenerationClaim';
