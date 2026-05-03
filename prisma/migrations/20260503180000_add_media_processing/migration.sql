-- Inbound media processing for voice-note transcription and image OCR.
ALTER TABLE "AIPersona"
ADD COLUMN "mediaTranscriptionEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Message"
ADD COLUMN "mediaType" TEXT,
ADD COLUMN "mediaUrl" TEXT,
ADD COLUMN "transcription" TEXT,
ADD COLUMN "imageMetadata" JSONB,
ADD COLUMN "mediaProcessedAt" TIMESTAMP(3),
ADD COLUMN "mediaProcessingError" TEXT,
ADD COLUMN "mediaCostUsd" DECIMAL(10,6);

CREATE TABLE "MediaProcessingLog" (
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

CREATE INDEX "MediaProcessingLog_accountId_createdAt_idx" ON "MediaProcessingLog"("accountId", "createdAt");
CREATE INDEX "MediaProcessingLog_messageId_idx" ON "MediaProcessingLog"("messageId");
CREATE INDEX "MediaProcessingLog_mediaType_createdAt_idx" ON "MediaProcessingLog"("mediaType", "createdAt");
CREATE INDEX "MediaProcessingLog_success_createdAt_idx" ON "MediaProcessingLog"("success", "createdAt");

ALTER TABLE "MediaProcessingLog"
ADD CONSTRAINT "MediaProcessingLog_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MediaProcessingLog"
ADD CONSTRAINT "MediaProcessingLog_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable the pilot only for daetradez; every other persona remains off.
UPDATE "AIPersona"
SET "mediaTranscriptionEnabled" = true
WHERE "accountId" IN (
  SELECT "id"
  FROM "Account"
  WHERE "slug" = 'daetradez2003'
     OR "slug" = 'daetradez'
);
