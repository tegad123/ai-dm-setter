-- Idempotent: 20260502192000_backfill_drift may have already added these.
ALTER TABLE "AISuggestion"
ADD COLUMN IF NOT EXISTS "aiStageReported" TEXT,
ADD COLUMN IF NOT EXISTS "aiSubStageReported" TEXT,
ADD COLUMN IF NOT EXISTS "capitalOutcome" TEXT;
