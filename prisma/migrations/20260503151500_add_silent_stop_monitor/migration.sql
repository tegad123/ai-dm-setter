-- Silent-stop heartbeat monitor.
-- Keeps track of lead turns awaiting an AI response and logs every
-- auto-recovery attempt so stalled conversations cannot die silently.

-- Idempotent: 20260502192000_backfill_drift may have already created these.
ALTER TABLE "Conversation"
ADD COLUMN IF NOT EXISTS "awaitingAiResponse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "awaitingSince" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "silentStopCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "lastSilentStopAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "silentStopRecoveredCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "SilentStopEvent" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLeadMessageAt" TIMESTAMP(3) NOT NULL,
  "silenceDurationMs" INTEGER NOT NULL,
  "detectedReason" TEXT NOT NULL,
  "lastGateViolation" TEXT,
  "lastRegenAttempts" INTEGER,
  "recoveryAttempted" BOOLEAN NOT NULL DEFAULT false,
  "recoveryAction" TEXT,
  "recoveryMessageSent" TEXT,
  "recoveryStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "triggeredAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),

  CONSTRAINT "SilentStopEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Conversation_awaitingAiResponse_awaitingSince_idx"
ON "Conversation"("awaitingAiResponse", "awaitingSince");

CREATE INDEX IF NOT EXISTS "Conversation_lastSilentStopAt_idx"
ON "Conversation"("lastSilentStopAt");

-- Seed the heartbeat state for live conversations already dark at deploy
-- time. Limit to the last 24h so historical cold leads stay report-only.
WITH latest_message AS (
  SELECT DISTINCT ON (m."conversationId")
    m."conversationId",
    m."sender",
    m."timestamp"
  FROM "Message" m
  WHERE m."sender" != 'SYSTEM'
  ORDER BY m."conversationId", m."timestamp" DESC
)
UPDATE "Conversation" c
SET
  "awaitingAiResponse" = true,
  "awaitingSince" = lm."timestamp"
FROM latest_message lm, "Lead" l
WHERE c."id" = lm."conversationId"
  AND l."id" = c."leadId"
  AND c."aiActive" = true
  AND lm."sender" = 'LEAD'
  AND lm."timestamp" > NOW() - INTERVAL '24 hours'
  AND l."stage"::text NOT IN (
    'BOOKED',
    'SHOWED',
    'CLOSED_WON',
    'CLOSED_LOST',
    'GHOSTED',
    'NO_SHOWED'
  );

CREATE INDEX IF NOT EXISTS "SilentStopEvent_conversationId_idx"
ON "SilentStopEvent"("conversationId");

CREATE INDEX IF NOT EXISTS "SilentStopEvent_recoveryStatus_idx"
ON "SilentStopEvent"("recoveryStatus");

CREATE INDEX IF NOT EXISTS "SilentStopEvent_detectedAt_idx"
ON "SilentStopEvent"("detectedAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SilentStopEvent_conversationId_fkey') THEN
    ALTER TABLE "SilentStopEvent"
    ADD CONSTRAINT "SilentStopEvent_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
