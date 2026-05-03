-- Script-stage self-recovery: authoritative per-conversation script state,
-- recovery metadata on existing script steps, and observable recovery events.

ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "currentScriptStep" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "capturedDataPoints" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "systemStage" TEXT,
  ADD COLUMN IF NOT EXISTS "llmEmittedStage" TEXT,
  ADD COLUMN IF NOT EXISTS "stageMismatchCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "selfRecoveryCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ScriptStep"
  ADD COLUMN IF NOT EXISTS "stateKey" TEXT,
  ADD COLUMN IF NOT EXISTS "requiredDataPoints" JSONB,
  ADD COLUMN IF NOT EXISTS "recoveryActionType" TEXT,
  ADD COLUMN IF NOT EXISTS "canonicalQuestion" TEXT,
  ADD COLUMN IF NOT EXISTS "artifactField" TEXT,
  ADD COLUMN IF NOT EXISTS "routingRules" JSONB,
  ADD COLUMN IF NOT EXISTS "completionRule" JSONB;

CREATE INDEX IF NOT EXISTS "ScriptStep_scriptId_stateKey_idx"
  ON "ScriptStep"("scriptId", "stateKey");

CREATE TABLE IF NOT EXISTS "SelfRecoveryEvent" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "scriptId" TEXT,
  "scriptStepId" TEXT,
  "stepNumber" INTEGER,
  "triggerReason" TEXT NOT NULL,
  "recoveryAction" TEXT,
  "status" TEXT NOT NULL DEFAULT 'SUCCEEDED',
  "failureReason" TEXT,
  "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
  "generatedMessages" JSONB,
  "metadata" JSONB,
  "llmEmittedStage" TEXT,
  "systemStage" TEXT,
  "approvedAt" TIMESTAMP(3),
  "approvedByUserId" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SelfRecoveryEvent_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SelfRecoveryEvent_accountId_fkey'
  ) THEN
    ALTER TABLE "SelfRecoveryEvent"
      ADD CONSTRAINT "SelfRecoveryEvent_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SelfRecoveryEvent_conversationId_fkey'
  ) THEN
    ALTER TABLE "SelfRecoveryEvent"
      ADD CONSTRAINT "SelfRecoveryEvent_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SelfRecoveryEvent_leadId_fkey'
  ) THEN
    ALTER TABLE "SelfRecoveryEvent"
      ADD CONSTRAINT "SelfRecoveryEvent_leadId_fkey"
      FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SelfRecoveryEvent_scriptStepId_fkey'
  ) THEN
    ALTER TABLE "SelfRecoveryEvent"
      ADD CONSTRAINT "SelfRecoveryEvent_scriptStepId_fkey"
      FOREIGN KEY ("scriptStepId") REFERENCES "ScriptStep"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "SelfRecoveryEvent_accountId_createdAt_idx"
  ON "SelfRecoveryEvent"("accountId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "SelfRecoveryEvent_conversationId_createdAt_idx"
  ON "SelfRecoveryEvent"("conversationId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "SelfRecoveryEvent_leadId_createdAt_idx"
  ON "SelfRecoveryEvent"("leadId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "SelfRecoveryEvent_status_priority_createdAt_idx"
  ON "SelfRecoveryEvent"("status", "priority", "createdAt");

CREATE INDEX IF NOT EXISTS "SelfRecoveryEvent_scriptStepId_idx"
  ON "SelfRecoveryEvent"("scriptStepId");

-- Seed daetradez's current 14-step script with recovery metadata. This keeps
-- runtime generic: the data lives in ScriptStep rows and can be edited later.
WITH active_script AS (
  SELECT s."id"
  FROM "Script" s
  JOIN "Account" a ON a."id" = s."accountId"
  WHERE a."slug" = 'daetradez2003'
    AND s."isActive" = true
  ORDER BY s."updatedAt" DESC
  LIMIT 1
)
UPDATE "ScriptStep" ss
SET
  "stateKey" = CASE ss."stepNumber"
    WHEN 1 THEN 'INTRO'
    WHEN 2 THEN 'BREAKDOWN'
    WHEN 3 THEN 'DISCOVER_WORK_BACKGROUND'
    WHEN 4 THEN 'DISCOVER_INCOME_GOAL_TYPE'
    WHEN 5 THEN 'CAPTURE_TANGIBLE_INCOME_GOAL'
    WHEN 6 THEN 'DEEPER_MOTIVATION'
    WHEN 7 THEN 'DEPLOY_SOCIAL_PROOF'
    WHEN 8 THEN 'CAPITAL_QUALIFICATION'
    WHEN 9 THEN 'ROUTE_BY_CAPITAL'
    WHEN 10 THEN 'SEND_APPLICATION_LINK'
    WHEN 11 THEN 'FUNDING_OR_DOWNSELL'
    WHEN 12 THEN 'CONFIRM_BOOKING'
    WHEN 13 THEN 'VERIFY_HOMEWORK_DELIVERY'
    WHEN 14 THEN 'CALL_REMINDERS'
    ELSE ss."stateKey"
  END,
  "completionRule" = CASE ss."stepNumber"
    WHEN 8 THEN '{"type":"data_captured","fields":["verifiedCapitalUsd"]}'::jsonb
    WHEN 9 THEN '{"type":"route_decision","field":"verifiedCapitalUsd"}'::jsonb
    WHEN 10 THEN '{"type":"artifact_delivered","field":"applicationFormUrl"}'::jsonb
    WHEN 11 THEN '{"type":"artifact_delivered","field":"downsellUrl","optional":true}'::jsonb
    ELSE COALESCE(ss."completionRule", '{"type":"always_complete"}'::jsonb)
  END,
  "requiredDataPoints" = CASE ss."stepNumber"
    WHEN 8 THEN '["verifiedCapitalUsd"]'::jsonb
    WHEN 9 THEN '["verifiedCapitalUsd"]'::jsonb
    ELSE ss."requiredDataPoints"
  END,
  "recoveryActionType" = CASE ss."stepNumber"
    WHEN 8 THEN 'ASK_QUESTION'
    WHEN 9 THEN 'ROUTE_DECISION'
    WHEN 10 THEN 'DELIVER_ARTIFACT'
    WHEN 11 THEN 'DELIVER_ARTIFACT'
    ELSE ss."recoveryActionType"
  END,
  "canonicalQuestion" = CASE ss."stepNumber"
    WHEN 8 THEN 'with that being said bro how much capital would you say you have set aside in usd for the markets right now'
    ELSE ss."canonicalQuestion"
  END,
  "artifactField" = CASE ss."stepNumber"
    WHEN 10 THEN 'applicationFormUrl'
    WHEN 11 THEN 'downsellUrl'
    ELSE ss."artifactField"
  END,
  "routingRules" = CASE ss."stepNumber"
    WHEN 9 THEN '{
      "field": "verifiedCapitalUsd",
      "branches": [
        { "condition": "value >= minimumCapitalRequired", "nextStep": 10, "label": "qualified_application_first" },
        { "condition": "value < minimumCapitalRequired", "nextStep": 11, "label": "downsell" },
        { "condition": "value == null", "nextStep": 8, "label": "capital_clarifier" }
      ]
    }'::jsonb
    ELSE ss."routingRules"
  END
FROM active_script
WHERE ss."scriptId" = active_script."id";
