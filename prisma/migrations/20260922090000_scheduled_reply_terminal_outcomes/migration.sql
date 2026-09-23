-- Structured terminal evidence for every ScheduledReply lifecycle.
-- Historical terminal rows are explicitly labelled as historical rather than
-- guessed from free-text `lastError` values.
ALTER TABLE "ScheduledReply"
  ADD COLUMN IF NOT EXISTS "terminalReasonCode" TEXT,
  ADD COLUMN IF NOT EXISTS "terminalAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "generationTraceId" TEXT;

UPDATE "ScheduledReply"
SET
  "terminalReasonCode" = CASE
    WHEN "status" = 'SENT' THEN 'HISTORICAL_SENT'
    WHEN "status" = 'FAILED_QUALITY_GATE' THEN 'HISTORICAL_QUALITY_GATE'
    WHEN "status" = 'FAILED' THEN 'HISTORICAL_FAILED_UNKNOWN'
    WHEN "status" = 'CANCELLED' THEN 'HISTORICAL_CANCELLED_UNKNOWN'
    ELSE "terminalReasonCode"
  END,
  "terminalAt" = COALESCE("processedAt", "createdAt")
WHERE "status" IN ('SENT', 'FAILED', 'FAILED_QUALITY_GATE', 'CANCELLED')
  AND "terminalReasonCode" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ScheduledReply_generationTraceId_key"
  ON "ScheduledReply"("generationTraceId");

CREATE INDEX IF NOT EXISTS "ScheduledReply_terminalReasonCode_terminalAt_idx"
  ON "ScheduledReply"("terminalReasonCode", "terminalAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ScheduledReply_generationTraceId_fkey'
  ) THEN
    ALTER TABLE "ScheduledReply"
      ADD CONSTRAINT "ScheduledReply_generationTraceId_fkey"
      FOREIGN KEY ("generationTraceId") REFERENCES "GenerationTurnTrace"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
