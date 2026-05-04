-- Inbound media processing for voice-note transcription and image OCR.
-- Idempotent: 20260502192000_backfill_drift may have already created these.
ALTER TABLE "AIPersona"
ADD COLUMN IF NOT EXISTS "mediaTranscriptionEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Message"
ADD COLUMN IF NOT EXISTS "mediaType" TEXT,
ADD COLUMN IF NOT EXISTS "mediaUrl" TEXT,
ADD COLUMN IF NOT EXISTS "transcription" TEXT,
ADD COLUMN IF NOT EXISTS "imageMetadata" JSONB,
ADD COLUMN IF NOT EXISTS "mediaProcessedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "mediaProcessingError" TEXT,
ADD COLUMN IF NOT EXISTS "mediaCostUsd" DECIMAL(10,6);

CREATE TABLE IF NOT EXISTS "MediaProcessingLog" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "latencyMs" INTEGER NOT NULL,
  "success" BOOLEAN NOT NULL,
  "errorMessage" TEXT,
  "transcriptionLength" INTEGER,
  "costUsd" DECIMAL(10,6),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MediaProcessingLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MediaProcessingLog_accountId_createdAt_idx" ON "MediaProcessingLog"("accountId", "createdAt");
CREATE INDEX IF NOT EXISTS "MediaProcessingLog_messageId_idx" ON "MediaProcessingLog"("messageId");
CREATE INDEX IF NOT EXISTS "MediaProcessingLog_mediaType_createdAt_idx" ON "MediaProcessingLog"("mediaType", "createdAt");
CREATE INDEX IF NOT EXISTS "MediaProcessingLog_success_createdAt_idx" ON "MediaProcessingLog"("success", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MediaProcessingLog_accountId_fkey') THEN
    ALTER TABLE "MediaProcessingLog"
    ADD CONSTRAINT "MediaProcessingLog_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MediaProcessingLog_messageId_fkey') THEN
    ALTER TABLE "MediaProcessingLog"
    ADD CONSTRAINT "MediaProcessingLog_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- Enable the pilot only for daetradez; every other persona remains off.
UPDATE "AIPersona"
SET "mediaTranscriptionEnabled" = true
WHERE "accountId" IN (
  SELECT "id"
  FROM "Account"
  WHERE "slug" = 'daetradez2003'
     OR "slug" = 'daetradez'
);
