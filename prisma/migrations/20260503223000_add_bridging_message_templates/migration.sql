-- Database-backed templates for mid-conversation script-step skip recovery.
-- accountId/scriptId NULL rows are platform defaults. Account/script-specific
-- overrides can be added later by Persona/Script editor flows.

-- Idempotent: 20260502192000_backfill_drift may have already created these.
CREATE TABLE IF NOT EXISTS "BridgingMessageTemplate" (
  "id" TEXT NOT NULL,
  "accountId" TEXT,
  "scriptId" TEXT,
  "currentStepKey" TEXT NOT NULL,
  "skippedAheadStepKey" TEXT NOT NULL,
  "templates" JSONB NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BridgingMessageTemplate_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BridgingMessageTemplate_accountId_fkey') THEN
    ALTER TABLE "BridgingMessageTemplate"
      ADD CONSTRAINT "BridgingMessageTemplate_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BridgingMessageTemplate_scriptId_fkey') THEN
    ALTER TABLE "BridgingMessageTemplate"
      ADD CONSTRAINT "BridgingMessageTemplate_scriptId_fkey"
      FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "BridgingMessageTemplate_accountId_currentStepKey_skippedAheadStepKey_idx"
  ON "BridgingMessageTemplate"("accountId", "currentStepKey", "skippedAheadStepKey");

CREATE INDEX IF NOT EXISTS "BridgingMessageTemplate_scriptId_currentStepKey_skippedAheadStepKey_idx"
  ON "BridgingMessageTemplate"("scriptId", "currentStepKey", "skippedAheadStepKey");

CREATE INDEX IF NOT EXISTS "BridgingMessageTemplate_currentStepKey_skippedAheadStepKey_isActive_idx"
  ON "BridgingMessageTemplate"("currentStepKey", "skippedAheadStepKey", "isActive");

INSERT INTO "BridgingMessageTemplate" (
  "id",
  "currentStepKey",
  "skippedAheadStepKey",
  "templates",
  "isActive",
  "createdAt",
  "updatedAt"
) VALUES
  (
    'platform_bridge_capital_before_soft_pitch',
    'CAPITAL_QUALIFICATION',
    'SOFT_PITCH',
    '[
      "real quick before we lock in the call - what''s your capital situation like for the markets right now?",
      "before we set up the call, what we working with capital-wise on the markets side?"
    ]'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'platform_bridge_capital_before_application',
    'CAPITAL_QUALIFICATION',
    'SEND_APPLICATION_LINK',
    '[
      "before i send the application over - what''s your capital situation like for the markets right now?"
    ]'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'platform_bridge_capital_before_booking',
    'CAPITAL_QUALIFICATION',
    'CONFIRM_BOOKING',
    '[
      "real quick before booking - what''s your capital situation like for the markets right now? just wanna make sure the call is built around where you''re at"
    ]'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'platform_bridge_urgency_before_soft_pitch',
    'URGENCY',
    'SOFT_PITCH',
    '[
      "before we set this up - how soon you trying to make this happen?"
    ]'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("id") DO NOTHING;
