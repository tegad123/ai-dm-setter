-- ============================================================================
-- Backfill drift: schema objects added via `prisma db push` without migrations
-- ============================================================================
-- Approximately 30 tables, 19 enums, 122 column additions, and several
-- enum-value extensions were applied to prod via `prisma db push` after the
-- last formal migration (20260320022128_add_prediction_models). Fresh
-- `prisma migrate deploy` runs failed once subsequent migrations
-- (20260502193000_add_durable_r24_state, 20260503151500_add_silent_stop_monitor,
-- 20260503210000_add_script_self_recovery, etc.) referenced tables / columns
-- that no migration had ever created.
--
-- This file consolidates the entire drift into one idempotent migration:
--   - CREATE TYPE wrapped in `DO $$ ... pg_type guard` blocks
--   - CREATE TABLE / CREATE [UNIQUE] INDEX use `IF NOT EXISTS`
--   - ALTER TABLE ADD/DROP COLUMN use `IF [NOT] EXISTS`
--   - ALTER TYPE ADD VALUE uses `IF NOT EXISTS`
--   - DROP INDEX/TYPE uses `IF EXISTS`
--   - FK ADD CONSTRAINT wrapped in `DO $$ ... pg_constraint guard` blocks
--
-- On prod, all of these objects already exist; this migration is a no-op.
-- Mark it as already-applied with:
--   npx prisma migrate resolve --applied 20260502192000_backfill_drift
--
-- The placement (just before 20260502193000_add_durable_r24_state) keeps
-- subsequent migrations untouched where possible. A small number of later
-- migrations have been made idempotent so they're no-ops on prod and on
-- a fresh DB after this backfill runs.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlanStatus') THEN
    CREATE TYPE "PlanStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AccountHealthStatus') THEN
    CREATE TYPE "AccountHealthStatus" AS ENUM ('HEALTHY', 'WARNING', 'CRITICAL', 'UNKNOWN');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LeadStage') THEN
    CREATE TYPE "LeadStage" AS ENUM ('NEW_LEAD', 'ENGAGED', 'QUALIFYING', 'QUALIFIED', 'CALL_PROPOSED', 'BOOKED', 'SHOWED', 'NO_SHOWED', 'RESCHEDULED', 'CLOSED_WON', 'CLOSED_LOST', 'UNQUALIFIED', 'GHOSTED', 'NURTURE');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CapitalVerificationStatus') THEN
    CREATE TYPE "CapitalVerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED_QUALIFIED', 'VERIFIED_UNQUALIFIED', 'MANUALLY_OVERRIDDEN');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TrainingPhase') THEN
    CREATE TYPE "TrainingPhase" AS ENUM ('ONBOARDING', 'ACTIVE', 'PAUSED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UploadStatus') THEN
    CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'EXTRACTING', 'PREFLIGHT_FAILED', 'AWAITING_CONFIRMATION', 'STRUCTURING', 'COMPLETE', 'FAILED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TrainingOutcome') THEN
    CREATE TYPE "TrainingOutcome" AS ENUM ('CLOSED_WIN', 'GHOSTED', 'OBJECTION_LOST', 'HARD_NO', 'BOOKED_NO_SHOW', 'UNKNOWN');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BreakdownStatus') THEN
    CREATE TYPE "BreakdownStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VoiceNoteSlotStatus') THEN
    CREATE TYPE "VoiceNoteSlotStatus" AS ENUM ('EMPTY', 'UPLOADED', 'APPROVED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VoiceNoteFallback') THEN
    CREATE TYPE "VoiceNoteFallback" AS ENUM ('BLOCK_UNTIL_FILLED', 'SEND_TEXT_EQUIVALENT', 'SKIP_ACTION');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VoiceNoteLibraryStatus') THEN
    CREATE TYPE "VoiceNoteLibraryStatus" AS ENUM ('PROCESSING', 'NEEDS_REVIEW', 'ACTIVE', 'DISABLED', 'FAILED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ScriptActionType') THEN
    CREATE TYPE "ScriptActionType" AS ENUM ('send_message', 'ask_question', 'send_voice_note', 'send_link', 'send_video', 'form_reference', 'runtime_judgment', 'wait_for_response', 'wait_duration');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LeadScriptStatus') THEN
    CREATE TYPE "LeadScriptStatus" AS ENUM ('active', 'completed', 'stalled');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ScriptCreatedVia') THEN
    CREATE TYPE "ScriptCreatedVia" AS ENUM ('template', 'blank', 'upload_parsed');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ParserConfidence') THEN
    CREATE TYPE "ParserConfidence" AS ENUM ('high', 'medium', 'low');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ParserActionStatus') THEN
    CREATE TYPE "ParserActionStatus" AS ENUM ('filled', 'needs_review', 'needs_user_input');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VoiceNoteBindingMode') THEN
    CREATE TYPE "VoiceNoteBindingMode" AS ENUM ('specific', 'runtime_match');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TriggerSuggestionStatus') THEN
    CREATE TYPE "TriggerSuggestionStatus" AS ENUM ('pending', 'approved', 'edited', 'rejected');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TrainingEventType') THEN
    CREATE TYPE "TrainingEventType" AS ENUM ('APPROVED', 'EDITED', 'REJECTED');
  END IF;
END$$;

-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.

ALTER TYPE "ConversationOutcome" ADD VALUE IF NOT EXISTS 'SOFT_EXIT';
ALTER TYPE "ConversationOutcome" ADD VALUE IF NOT EXISTS 'DORMANT';
ALTER TYPE "ConversationOutcome" ADD VALUE IF NOT EXISTS 'SPAM';

-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.

ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'INSTAGRAM';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'MANYCHAT';

ALTER TYPE "MessageSender" ADD VALUE IF NOT EXISTS 'SYSTEM';

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';

-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.

ALTER TYPE "ScheduledMessageType" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_1';
ALTER TYPE "ScheduledMessageType" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_2';
ALTER TYPE "ScheduledMessageType" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_3';
ALTER TYPE "ScheduledMessageType" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_SOFT_EXIT';
ALTER TYPE "ScheduledMessageType" ADD VALUE IF NOT EXISTS 'BOOKING_LINK_FOLLOWUP';

-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.

ALTER TYPE "TrainingCategory" ADD VALUE IF NOT EXISTS 'STALL_TIME';
ALTER TYPE "TrainingCategory" ADD VALUE IF NOT EXISTS 'STALL_MONEY';
ALTER TYPE "TrainingCategory" ADD VALUE IF NOT EXISTS 'STALL_THINK';
ALTER TYPE "TrainingCategory" ADD VALUE IF NOT EXISTS 'STALL_PARTNER';
ALTER TYPE "TrainingCategory" ADD VALUE IF NOT EXISTS 'GHOST_SEQUENCE';
ALTER TYPE "TrainingCategory" ADD VALUE IF NOT EXISTS 'NO_SHOW';
ALTER TYPE "TrainingCategory" ADD VALUE IF NOT EXISTS 'PRE_CALL_NURTURE';
ALTER TYPE "TrainingCategory" ADD VALUE IF NOT EXISTS 'DOWNSELL';
ALTER TYPE "TrainingCategory" ADD VALUE IF NOT EXISTS 'ORIGIN_STORY';
ALTER TYPE "TrainingCategory" ADD VALUE IF NOT EXISTS 'PROOF_POINT';

DROP INDEX IF EXISTS "Lead_accountId_status_idx";

ALTER TABLE "AIPersona" ADD COLUMN IF NOT EXISTS     "activeCampaignsContext" TEXT,
  ADD COLUMN IF NOT EXISTS     "allowEarlyFinancialScreening" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "capitalVerificationPrompt" TEXT,
  ADD COLUMN IF NOT EXISTS     "closerName" TEXT,
  ADD COLUMN IF NOT EXISTS     "contextUpdatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "contextUpdatedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS     "downsellConfig" JSONB,
  ADD COLUMN IF NOT EXISTS     "financialWaterfall" JSONB,
  ADD COLUMN IF NOT EXISTS     "knowledgeAssets" JSONB,
  ADD COLUMN IF NOT EXISTS     "mediaTranscriptionEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "minimumCapitalRequired" INTEGER,
  ADD COLUMN IF NOT EXISTS     "multiBubbleEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "noShowProtocol" JSONB,
  ADD COLUMN IF NOT EXISTS     "outOfScopeTopics" TEXT,
  ADD COLUMN IF NOT EXISTS     "preCallSequence" JSONB,
  ADD COLUMN IF NOT EXISTS     "proofPoints" JSONB,
  ADD COLUMN IF NOT EXISTS     "rawScript" TEXT,
  ADD COLUMN IF NOT EXISTS     "rawScriptFileName" TEXT,
  ADD COLUMN IF NOT EXISTS     "skipR24ScriptInject" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "styleAnalysis" TEXT,
  ADD COLUMN IF NOT EXISTS     "verifiedDetails" TEXT;

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS     "aiProvider" TEXT NOT NULL DEFAULT 'openai',
  ADD COLUMN IF NOT EXISTS     "awayModeFacebook" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "awayModeFacebookEnabledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "awayModeInstagram" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "awayModeInstagramEnabledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "debounceWindowSeconds" INTEGER NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS     "distressDetectionEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "emailDailySummary" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "emailWeeklyReport" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "ghostThresholdDays" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS     "healthStatus" "AccountHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS     "lastHealthCheck" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "maxDebounceWindowSeconds" INTEGER NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS     "monthlyApiCostUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS     "notifyOnAIStuck" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "notifyOnBookingLimbo" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "notifyOnCallBooked" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "notifyOnClosedDeal" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "notifyOnDistress" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "notifyOnHotLead" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "notifyOnHumanOverride" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "notifyOnNoShow" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "notifyOnSchedulingConflict" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "onboardingStep" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS     "planStatus" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS     "responseDelayMax" INTEGER NOT NULL DEFAULT 600,
  ADD COLUMN IF NOT EXISTS     "responseDelayMin" INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS     "showSuggestionBanner" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS     "trainingOverrideCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS     "trainingPhase" "TrainingPhase" NOT NULL DEFAULT 'ONBOARDING',
  ADD COLUMN IF NOT EXISTS     "trainingPhaseCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "trainingPhaseStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS     "trainingTargetOverrideCount" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS     "trialEndsAt" TIMESTAMP(3);

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS     "autoSendOverride" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "awaitingAiResponse" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "awaitingSince" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "capitalVerificationStatus" "CapitalVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS     "capitalVerifiedAmount" INTEGER,
  ADD COLUMN IF NOT EXISTS     "capitalVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "capturedDataPoints" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS     "currentScriptStep" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS     "distressDetected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "distressDetectedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "distressMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS     "geographyCountry" TEXT,
  ADD COLUMN IF NOT EXISTS     "geographyGated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "lastSilentStopAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "llmEmittedStage" TEXT,
  ADD COLUMN IF NOT EXISTS     "personaId" TEXT NOT NULL,
  ADD COLUMN IF NOT EXISTS     "scheduledCallAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "scheduledCallConfirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "scheduledCallNote" TEXT,
  ADD COLUMN IF NOT EXISTS     "scheduledCallSource" "ScheduledCallSource",
  ADD COLUMN IF NOT EXISTS     "scheduledCallTimezone" TEXT,
  ADD COLUMN IF NOT EXISTS     "scheduledCallUpdatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "scheduledCallUpdatedBy" TEXT,
  ADD COLUMN IF NOT EXISTS     "schedulingConflict" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "schedulingConflictAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "schedulingConflictMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS     "schedulingConflictPreference" TEXT,
  ADD COLUMN IF NOT EXISTS     "selfRecoveryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS     "silentStopCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS     "silentStopRecoveredCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS     "stageFinancialScreeningAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "stageGoalEmotionalWhyAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "stageMismatchCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS     "stageOpeningAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "stageSituationDiscoveryAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "stageSoftPitchCommitmentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "systemStage" TEXT;

ALTER TABLE "Lead" DROP COLUMN IF EXISTS "status",
  ADD COLUMN IF NOT EXISTS     "email" TEXT,
  ADD COLUMN IF NOT EXISTS     "geographyDisqualified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "previousStage" "LeadStage",
  ADD COLUMN IF NOT EXISTS     "stage" "LeadStage" NOT NULL DEFAULT 'NEW_LEAD',
  ADD COLUMN IF NOT EXISTS     "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS     "bubbleIndex" INTEGER,
  ADD COLUMN IF NOT EXISTS     "bubbleTotalCount" INTEGER,
  ADD COLUMN IF NOT EXISTS     "editedFromSuggestion" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "experiencePath" TEXT,
  ADD COLUMN IF NOT EXISTS     "hasImage" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "humanOverrideNote" TEXT,
  ADD COLUMN IF NOT EXISTS     "humanSource" TEXT,
  ADD COLUMN IF NOT EXISTS     "imageMetadata" JSONB,
  ADD COLUMN IF NOT EXISTS     "imageUrl" TEXT,
  ADD COLUMN IF NOT EXISTS     "intraGroupDelayMs" INTEGER,
  ADD COLUMN IF NOT EXISTS     "isHumanOverride" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "loggedDuringTrainingPhase" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS     "mediaCostUsd" DECIMAL(10,6),
  ADD COLUMN IF NOT EXISTS     "mediaProcessedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS     "mediaProcessingError" TEXT,
  ADD COLUMN IF NOT EXISTS     "mediaType" TEXT,
  ADD COLUMN IF NOT EXISTS     "mediaUrl" TEXT,
  ADD COLUMN IF NOT EXISTS     "messageGroupId" TEXT,
  ADD COLUMN IF NOT EXISTS     "objectionType" TEXT,
  ADD COLUMN IF NOT EXISTS     "platformMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS     "rejectedAISuggestionId" TEXT,
  ADD COLUMN IF NOT EXISTS     "stallType" TEXT,
  ADD COLUMN IF NOT EXISTS     "subStage" TEXT,
  ADD COLUMN IF NOT EXISTS     "suggestionId" TEXT,
  ADD COLUMN IF NOT EXISTS     "transcription" TEXT;

DROP TYPE IF EXISTS "LeadStatus";

CREATE TABLE IF NOT EXISTS "AdminLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "targetAccountId" TEXT,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PersonaBreakdown" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "sourceScriptHash" TEXT NOT NULL,
    "sourceFileName" TEXT,
    "sourceText" TEXT NOT NULL,
    "methodologySummary" TEXT NOT NULL,
    "methodologySummaryEdited" BOOLEAN NOT NULL DEFAULT false,
    "gaps" JSONB,
    "scriptSteps" JSONB,
    "status" "BreakdownStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonaBreakdown_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BreakdownSection" (
    "id" TEXT NOT NULL,
    "breakdownId" TEXT NOT NULL,
    "sectionType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceExcerpts" JSONB NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "userEdited" BOOLEAN NOT NULL DEFAULT false,
    "userApproved" BOOLEAN NOT NULL DEFAULT false,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BreakdownSection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BreakdownAmbiguity" (
    "id" TEXT NOT NULL,
    "breakdownId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "suggestedDefault" TEXT NOT NULL,
    "userAnswer" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BreakdownAmbiguity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VoiceNoteSlot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "breakdownId" TEXT,
    "slotName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "triggerCondition" JSONB NOT NULL,
    "audioFileUrl" TEXT,
    "audioDurationSecs" DOUBLE PRECISION,
    "uploadedAt" TIMESTAMP(3),
    "fallbackBehavior" "VoiceNoteFallback" NOT NULL DEFAULT 'SEND_TEXT_EQUIVALENT',
    "fallbackText" TEXT,
    "status" "VoiceNoteSlotStatus" NOT NULL DEFAULT 'EMPTY',
    "userApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceNoteSlot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VoiceNoteLibraryItem" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "audioFileUrl" TEXT NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transcript" TEXT,
    "summary" TEXT,
    "useCases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "leadTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conversationStages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "emotionalTone" TEXT,
    "triggerConditionsNatural" TEXT,
    "triggers" JSONB,
    "triggerDescription" TEXT,
    "legacyTriggerText" TEXT,
    "boundToScriptStep" TEXT,
    "scriptBindings" JSONB,
    "userLabel" TEXT,
    "userNotes" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "embeddingVector" JSONB,
    "autoSuggestedTriggers" JSONB,
    "suggestionStatus" "TriggerSuggestionStatus",
    "status" "VoiceNoteLibraryStatus" NOT NULL DEFAULT 'PROCESSING',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEditedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceNoteLibraryItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScriptSlot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "breakdownId" TEXT NOT NULL,
    "slotType" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "branchId" TEXT,
    "actionId" TEXT,
    "detectedName" TEXT,
    "description" TEXT,
    "suggestedTrigger" JSONB,
    "boundVoiceNoteId" TEXT,
    "linkDescription" TEXT,
    "url" TEXT,
    "formSchema" JSONB,
    "formValues" JSONB,
    "suggestedContent" TEXT,
    "userContent" TEXT,
    "instruction" TEXT,
    "context" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unfilled',
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptSlot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VoiceNoteSendLog" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "voiceNoteId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageIndex" INTEGER NOT NULL,
    "triggerType" TEXT NOT NULL,

    CONSTRAINT "VoiceNoteSendLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TrainingUpload" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "blobUrl" TEXT NOT NULL,
    "pdfBase64" TEXT,
    "rawText" TEXT,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "tokenEstimate" INTEGER,
    "conversationCount" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingUpload_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TrainingConversation" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "leadIdentifier" TEXT NOT NULL,
    "outcomeLabel" "TrainingOutcome" NOT NULL DEFAULT 'UNKNOWN',
    "contentHash" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "closerMessageCount" INTEGER NOT NULL DEFAULT 0,
    "leadMessageCount" INTEGER NOT NULL DEFAULT 0,
    "voiceNoteCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leadType" TEXT,
    "primaryObjectionType" TEXT,
    "dominantStage" TEXT,
    "analyzedAt" TIMESTAMP(3),

    CONSTRAINT "TrainingConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TrainingMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "text" TEXT,
    "timestamp" TIMESTAMP(3),
    "messageType" TEXT NOT NULL DEFAULT 'TEXT',
    "stage" TEXT,
    "objectionType" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "embeddingVector" JSONB,

    CONSTRAINT "TrainingMessage_pkey" PRIMARY KEY ("id")
);

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

CREATE TABLE IF NOT EXISTS "MessageGroup" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "aiSuggestionId" TEXT,
    "bubbleCount" INTEGER NOT NULL,
    "totalCharacters" INTEGER NOT NULL,
    "sentByType" TEXT NOT NULL DEFAULT 'AI',
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "deliveryNotes" JSONB,

    CONSTRAINT "MessageGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VoiceNoteTimingSettings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "minDelay" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "maxDelay" DOUBLE PRECISION NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceNoteTimingSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LeadStageTransition" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromStage" "LeadStage" NOT NULL,
    "toStage" "LeadStage" NOT NULL,
    "transitionedBy" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadStageTransition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DismissedActionItem" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedByUserId" TEXT,

    CONSTRAINT "DismissedActionItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BookingRoutingAudit" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "personaMinimumCapital" INTEGER,
    "verificationAskedAtMessageId" TEXT,
    "verificationConfirmedAtMessageId" TEXT,
    "routingAllowed" BOOLEAN NOT NULL,
    "regenerationForced" BOOLEAN NOT NULL DEFAULT false,
    "blockReason" TEXT,
    "aiStageReported" TEXT,
    "aiSubStageReported" TEXT,
    "contentPreview" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingRoutingAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Script" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdVia" "ScriptCreatedVia" NOT NULL DEFAULT 'blank',
    "originalUploadText" TEXT,
    "lastParsedAt" TIMESTAMP(3),
    "parseWarnings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScriptStep" (
    "id" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "objective" TEXT,
    "stateKey" TEXT,
    "requiredDataPoints" JSONB,
    "recoveryActionType" TEXT,
    "canonicalQuestion" TEXT,
    "artifactField" TEXT,
    "routingRules" JSONB,
    "completionRule" JSONB,
    "parserConfidence" "ParserConfidence",
    "userConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptStep_pkey" PRIMARY KEY ("id")
);

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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfRecoveryEvent_pkey" PRIMARY KEY ("id")
);

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

CREATE TABLE IF NOT EXISTS "BridgingMessageTemplate" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "scriptId" TEXT,
    "currentStepKey" TEXT NOT NULL,
    "skippedAheadStepKey" TEXT NOT NULL,
    "templates" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BridgingMessageTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScriptBranch" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "branchLabel" TEXT NOT NULL,
    "conditionDescription" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "parserConfidence" "ParserConfidence",
    "userConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptBranch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScriptAction" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "branchId" TEXT,
    "actionType" "ScriptActionType" NOT NULL,
    "content" TEXT,
    "voiceNoteId" TEXT,
    "bindingMode" "VoiceNoteBindingMode" NOT NULL DEFAULT 'runtime_match',
    "linkUrl" TEXT,
    "linkLabel" TEXT,
    "formId" TEXT,
    "waitDuration" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "parserConfidence" "ParserConfidence",
    "parserStatus" "ParserActionStatus",
    "userConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScriptForm" (
    "id" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptForm_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScriptFormField" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "fieldLabel" TEXT NOT NULL,
    "fieldValue" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptFormField_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LeadScriptPosition" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "currentStepId" TEXT NOT NULL,
    "currentBranchId" TEXT,
    "status" "LeadScriptStatus" NOT NULL DEFAULT 'active',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadScriptPosition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TrainingDataAnalysis" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "overallScore" INTEGER NOT NULL,
    "categoryScores" JSONB NOT NULL,
    "totalConversations" INTEGER NOT NULL,
    "totalMessages" INTEGER NOT NULL,
    "recommendations" JSONB NOT NULL,
    "estimatedCostCents" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'complete',
    "errorMessage" TEXT,
    "analyzedConversationIds" JSONB,
    "categoryMetrics" JSONB,

    CONSTRAINT "TrainingDataAnalysis_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VoiceQualityFailure" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "hardFails" JSONB NOT NULL,
    "attempt" INTEGER NOT NULL,
    "leadMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceQualityFailure_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AISuggestion" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseText" TEXT NOT NULL,
    "retrievalTier" INTEGER,
    "qualityGateAttempts" INTEGER NOT NULL DEFAULT 1,
    "qualityGateScore" DOUBLE PRECISION,
    "qualityGatePassedFirstAttempt" BOOLEAN NOT NULL DEFAULT false,
    "intentClassification" TEXT,
    "intentConfidence" DOUBLE PRECISION,
    "leadStageSnapshot" TEXT,
    "leadTypeSnapshot" TEXT,
    "aiStageReported" TEXT,
    "aiSubStageReported" TEXT,
    "capitalOutcome" TEXT,
    "wasSelected" BOOLEAN NOT NULL DEFAULT false,
    "wasRejected" BOOLEAN NOT NULL DEFAULT false,
    "wasEdited" BOOLEAN NOT NULL DEFAULT false,
    "finalSentText" TEXT,
    "similarityToFinalSent" DOUBLE PRECISION,
    "generatedDuringTrainingPhase" BOOLEAN NOT NULL DEFAULT false,
    "modelUsed" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheCreationTokens" INTEGER,
    "messageBubbles" JSONB,
    "bubbleCount" INTEGER NOT NULL DEFAULT 1,
    "dismissed" BOOLEAN NOT NULL DEFAULT false,
    "actionedAt" TIMESTAMP(3),
    "editedByHuman" BOOLEAN NOT NULL DEFAULT false,
    "humanEditedContent" TEXT,
    "manuallyApproved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AISuggestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TrainingEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "type" "TrainingEventType" NOT NULL,
    "platform" "Platform" NOT NULL,
    "originalContent" TEXT NOT NULL,
    "editedContent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InboundQualification" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "classifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suggestedStartStage" INTEGER NOT NULL,
    "finalStartStage" INTEGER NOT NULL,
    "stagesSkipped" INTEGER NOT NULL,
    "stageSkipReason" TEXT NOT NULL,
    "classifierConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "capped" BOOLEAN NOT NULL DEFAULT false,
    "hasExperience" BOOLEAN NOT NULL DEFAULT false,
    "experienceLevel" TEXT,
    "hasPainPoint" BOOLEAN NOT NULL DEFAULT false,
    "painPointSummary" TEXT,
    "hasGoal" BOOLEAN NOT NULL DEFAULT false,
    "goalSummary" TEXT,
    "hasUrgency" BOOLEAN NOT NULL DEFAULT false,
    "urgencySummary" TEXT,
    "hasFinancialInfo" BOOLEAN NOT NULL DEFAULT false,
    "financialSummary" TEXT,
    "hasExplicitIntent" BOOLEAN NOT NULL DEFAULT false,
    "intentType" TEXT,
    "isInbound" BOOLEAN NOT NULL DEFAULT false,
    "rawResponse" JSONB,

    CONSTRAINT "InboundQualification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdminLog_adminUserId_createdAt_idx" ON "AdminLog"("adminUserId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "AdminLog_targetAccountId_createdAt_idx" ON "AdminLog"("targetAccountId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "AdminLog_action_idx" ON "AdminLog"("action");

CREATE INDEX IF NOT EXISTS "PersonaBreakdown_accountId_idx" ON "PersonaBreakdown"("accountId");

CREATE INDEX IF NOT EXISTS "PersonaBreakdown_personaId_idx" ON "PersonaBreakdown"("personaId");

CREATE INDEX IF NOT EXISTS "BreakdownSection_breakdownId_orderIndex_idx" ON "BreakdownSection"("breakdownId", "orderIndex");

CREATE INDEX IF NOT EXISTS "BreakdownAmbiguity_breakdownId_idx" ON "BreakdownAmbiguity"("breakdownId");

CREATE INDEX IF NOT EXISTS "VoiceNoteSlot_accountId_idx" ON "VoiceNoteSlot"("accountId");

CREATE INDEX IF NOT EXISTS "VoiceNoteSlot_breakdownId_idx" ON "VoiceNoteSlot"("breakdownId");

CREATE INDEX IF NOT EXISTS "VoiceNoteSlot_accountId_status_idx" ON "VoiceNoteSlot"("accountId", "status");

CREATE INDEX IF NOT EXISTS "VoiceNoteLibraryItem_accountId_idx" ON "VoiceNoteLibraryItem"("accountId");

CREATE INDEX IF NOT EXISTS "VoiceNoteLibraryItem_accountId_status_idx" ON "VoiceNoteLibraryItem"("accountId", "status");

CREATE INDEX IF NOT EXISTS "VoiceNoteLibraryItem_accountId_active_idx" ON "VoiceNoteLibraryItem"("accountId", "active");

CREATE INDEX IF NOT EXISTS "ScriptSlot_accountId_idx" ON "ScriptSlot"("accountId");

CREATE INDEX IF NOT EXISTS "ScriptSlot_breakdownId_idx" ON "ScriptSlot"("breakdownId");

CREATE INDEX IF NOT EXISTS "ScriptSlot_breakdownId_slotType_idx" ON "ScriptSlot"("breakdownId", "slotType");

CREATE INDEX IF NOT EXISTS "VoiceNoteSendLog_leadId_voiceNoteId_sentAt_idx" ON "VoiceNoteSendLog"("leadId", "voiceNoteId", "sentAt" DESC);

CREATE INDEX IF NOT EXISTS "VoiceNoteSendLog_accountId_idx" ON "VoiceNoteSendLog"("accountId");

CREATE INDEX IF NOT EXISTS "TrainingUpload_accountId_status_idx" ON "TrainingUpload"("accountId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingUpload_accountId_fileHash_key" ON "TrainingUpload"("accountId", "fileHash");

CREATE INDEX IF NOT EXISTS "TrainingConversation_uploadId_idx" ON "TrainingConversation"("uploadId");

CREATE INDEX IF NOT EXISTS "TrainingConversation_accountId_personaId_idx" ON "TrainingConversation"("accountId", "personaId");

CREATE INDEX IF NOT EXISTS "TrainingConversation_accountId_leadType_idx" ON "TrainingConversation"("accountId", "leadType");

CREATE INDEX IF NOT EXISTS "TrainingConversation_accountId_dominantStage_idx" ON "TrainingConversation"("accountId", "dominantStage");

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingConversation_accountId_contentHash_key" ON "TrainingConversation"("accountId", "contentHash");

CREATE INDEX IF NOT EXISTS "TrainingMessage_conversationId_orderIndex_idx" ON "TrainingMessage"("conversationId", "orderIndex");

CREATE INDEX IF NOT EXISTS "MediaProcessingLog_accountId_createdAt_idx" ON "MediaProcessingLog"("accountId", "createdAt");

CREATE INDEX IF NOT EXISTS "MediaProcessingLog_messageId_idx" ON "MediaProcessingLog"("messageId");

CREATE INDEX IF NOT EXISTS "MediaProcessingLog_mediaType_createdAt_idx" ON "MediaProcessingLog"("mediaType", "createdAt");

CREATE INDEX IF NOT EXISTS "MediaProcessingLog_success_createdAt_idx" ON "MediaProcessingLog"("success", "createdAt");

CREATE INDEX IF NOT EXISTS "MessageGroup_conversationId_generatedAt_idx" ON "MessageGroup"("conversationId", "generatedAt" DESC);

CREATE INDEX IF NOT EXISTS "MessageGroup_aiSuggestionId_idx" ON "MessageGroup"("aiSuggestionId");

CREATE UNIQUE INDEX IF NOT EXISTS "VoiceNoteTimingSettings_accountId_key" ON "VoiceNoteTimingSettings"("accountId");

CREATE INDEX IF NOT EXISTS "LeadStageTransition_leadId_createdAt_idx" ON "LeadStageTransition"("leadId", "createdAt");

CREATE INDEX IF NOT EXISTS "DismissedActionItem_accountId_conversationId_idx" ON "DismissedActionItem"("accountId", "conversationId");

CREATE INDEX IF NOT EXISTS "DismissedActionItem_dismissedAt_idx" ON "DismissedActionItem"("dismissedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "DismissedActionItem_accountId_conversationId_actionType_key" ON "DismissedActionItem"("accountId", "conversationId", "actionType");

CREATE INDEX IF NOT EXISTS "BookingRoutingAudit_conversationId_createdAt_idx" ON "BookingRoutingAudit"("conversationId", "createdAt");

CREATE INDEX IF NOT EXISTS "BookingRoutingAudit_accountId_createdAt_idx" ON "BookingRoutingAudit"("accountId", "createdAt");

CREATE INDEX IF NOT EXISTS "BookingRoutingAudit_routingAllowed_createdAt_idx" ON "BookingRoutingAudit"("routingAllowed", "createdAt");

CREATE INDEX IF NOT EXISTS "Script_accountId_idx" ON "Script"("accountId");

CREATE INDEX IF NOT EXISTS "Script_accountId_isActive_idx" ON "Script"("accountId", "isActive");

CREATE INDEX IF NOT EXISTS "ScriptStep_scriptId_stepNumber_idx" ON "ScriptStep"("scriptId", "stepNumber");

CREATE INDEX IF NOT EXISTS "ScriptStep_scriptId_stateKey_idx" ON "ScriptStep"("scriptId", "stateKey");

CREATE INDEX IF NOT EXISTS "SelfRecoveryEvent_accountId_createdAt_idx" ON "SelfRecoveryEvent"("accountId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "SelfRecoveryEvent_conversationId_createdAt_idx" ON "SelfRecoveryEvent"("conversationId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "SelfRecoveryEvent_leadId_createdAt_idx" ON "SelfRecoveryEvent"("leadId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "SelfRecoveryEvent_status_priority_createdAt_idx" ON "SelfRecoveryEvent"("status", "priority", "createdAt");

CREATE INDEX IF NOT EXISTS "SelfRecoveryEvent_scriptStepId_idx" ON "SelfRecoveryEvent"("scriptStepId");

CREATE INDEX IF NOT EXISTS "SilentStopEvent_conversationId_idx" ON "SilentStopEvent"("conversationId");

CREATE INDEX IF NOT EXISTS "SilentStopEvent_recoveryStatus_idx" ON "SilentStopEvent"("recoveryStatus");

CREATE INDEX IF NOT EXISTS "SilentStopEvent_detectedAt_idx" ON "SilentStopEvent"("detectedAt");

CREATE INDEX IF NOT EXISTS "BridgingMessageTemplate_accountId_currentStepKey_skippedAhe_idx" ON "BridgingMessageTemplate"("accountId", "currentStepKey", "skippedAheadStepKey");

CREATE INDEX IF NOT EXISTS "BridgingMessageTemplate_scriptId_currentStepKey_skippedAhea_idx" ON "BridgingMessageTemplate"("scriptId", "currentStepKey", "skippedAheadStepKey");

CREATE INDEX IF NOT EXISTS "BridgingMessageTemplate_currentStepKey_skippedAheadStepKey__idx" ON "BridgingMessageTemplate"("currentStepKey", "skippedAheadStepKey", "isActive");

CREATE INDEX IF NOT EXISTS "ScriptBranch_stepId_sortOrder_idx" ON "ScriptBranch"("stepId", "sortOrder");

CREATE INDEX IF NOT EXISTS "ScriptAction_stepId_sortOrder_idx" ON "ScriptAction"("stepId", "sortOrder");

CREATE INDEX IF NOT EXISTS "ScriptAction_branchId_sortOrder_idx" ON "ScriptAction"("branchId", "sortOrder");

CREATE INDEX IF NOT EXISTS "ScriptForm_scriptId_idx" ON "ScriptForm"("scriptId");

CREATE INDEX IF NOT EXISTS "ScriptFormField_formId_sortOrder_idx" ON "ScriptFormField"("formId", "sortOrder");

CREATE INDEX IF NOT EXISTS "LeadScriptPosition_leadId_idx" ON "LeadScriptPosition"("leadId");

CREATE INDEX IF NOT EXISTS "LeadScriptPosition_scriptId_idx" ON "LeadScriptPosition"("scriptId");

CREATE UNIQUE INDEX IF NOT EXISTS "LeadScriptPosition_leadId_scriptId_key" ON "LeadScriptPosition"("leadId", "scriptId");

CREATE INDEX IF NOT EXISTS "TrainingDataAnalysis_accountId_runAt_idx" ON "TrainingDataAnalysis"("accountId", "runAt" DESC);

CREATE INDEX IF NOT EXISTS "VoiceQualityFailure_accountId_createdAt_idx" ON "VoiceQualityFailure"("accountId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "AISuggestion_conversationId_generatedAt_idx" ON "AISuggestion"("conversationId", "generatedAt" DESC);

CREATE INDEX IF NOT EXISTS "AISuggestion_accountId_generatedAt_idx" ON "AISuggestion"("accountId", "generatedAt" DESC);

CREATE INDEX IF NOT EXISTS "AISuggestion_accountId_generatedDuringTrainingPhase_generat_idx" ON "AISuggestion"("accountId", "generatedDuringTrainingPhase", "generatedAt" DESC);

CREATE INDEX IF NOT EXISTS "AISuggestion_wasSelected_generatedAt_idx" ON "AISuggestion"("wasSelected", "generatedAt" DESC);

CREATE INDEX IF NOT EXISTS "AISuggestion_wasRejected_generatedAt_idx" ON "AISuggestion"("wasRejected", "generatedAt" DESC);

CREATE INDEX IF NOT EXISTS "AISuggestion_conversationId_dismissed_actionedAt_generatedA_idx" ON "AISuggestion"("conversationId", "dismissed", "actionedAt", "generatedAt" DESC);

CREATE INDEX IF NOT EXISTS "TrainingEvent_accountId_platform_createdAt_idx" ON "TrainingEvent"("accountId", "platform", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "TrainingEvent_conversationId_createdAt_idx" ON "TrainingEvent"("conversationId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "TrainingEvent_suggestionId_idx" ON "TrainingEvent"("suggestionId");

CREATE UNIQUE INDEX IF NOT EXISTS "InboundQualification_conversationId_key" ON "InboundQualification"("conversationId");

CREATE UNIQUE INDEX IF NOT EXISTS "InboundQualification_leadId_key" ON "InboundQualification"("leadId");

CREATE INDEX IF NOT EXISTS "InboundQualification_accountId_classifiedAt_idx" ON "InboundQualification"("accountId", "classifiedAt" DESC);

CREATE INDEX IF NOT EXISTS "InboundQualification_accountId_finalStartStage_idx" ON "InboundQualification"("accountId", "finalStartStage");

CREATE INDEX IF NOT EXISTS "Account_healthStatus_idx" ON "Account"("healthStatus");

CREATE INDEX IF NOT EXISTS "Account_planStatus_idx" ON "Account"("planStatus");

CREATE INDEX IF NOT EXISTS "Conversation_awaitingAiResponse_awaitingSince_idx" ON "Conversation"("awaitingAiResponse", "awaitingSince");

CREATE INDEX IF NOT EXISTS "Conversation_lastSilentStopAt_idx" ON "Conversation"("lastSilentStopAt");

CREATE INDEX IF NOT EXISTS "Conversation_scheduledCallAt_idx" ON "Conversation"("scheduledCallAt");

CREATE INDEX IF NOT EXISTS "Conversation_capitalVerificationStatus_idx" ON "Conversation"("capitalVerificationStatus");

CREATE INDEX IF NOT EXISTS "Conversation_leadPhone_idx" ON "Conversation"("leadPhone");

CREATE INDEX IF NOT EXISTS "Conversation_leadEmail_idx" ON "Conversation"("leadEmail");

CREATE INDEX IF NOT EXISTS "Conversation_personaId_idx" ON "Conversation"("personaId");

CREATE INDEX IF NOT EXISTS "Lead_accountId_stage_idx" ON "Lead"("accountId", "stage");

CREATE INDEX IF NOT EXISTS "Lead_accountId_handle_idx" ON "Lead"("accountId", "handle");

CREATE INDEX IF NOT EXISTS "Lead_accountId_name_idx" ON "Lead"("accountId", "name");

CREATE INDEX IF NOT EXISTS "Lead_accountId_email_idx" ON "Lead"("accountId", "email");

CREATE INDEX IF NOT EXISTS "Message_messageGroupId_idx" ON "Message"("messageGroupId");

CREATE UNIQUE INDEX IF NOT EXISTS "Message_conversationId_platformMessageId_key" ON "Message"("conversationId", "platformMessageId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdminLog_adminUserId_fkey') THEN
    ALTER TABLE "AdminLog" ADD CONSTRAINT "AdminLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdminLog_targetAccountId_fkey') THEN
    ALTER TABLE "AdminLog" ADD CONSTRAINT "AdminLog_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PersonaBreakdown_accountId_fkey') THEN
    ALTER TABLE "PersonaBreakdown" ADD CONSTRAINT "PersonaBreakdown_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PersonaBreakdown_personaId_fkey') THEN
    ALTER TABLE "PersonaBreakdown" ADD CONSTRAINT "PersonaBreakdown_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "AIPersona"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BreakdownSection_breakdownId_fkey') THEN
    ALTER TABLE "BreakdownSection" ADD CONSTRAINT "BreakdownSection_breakdownId_fkey" FOREIGN KEY ("breakdownId") REFERENCES "PersonaBreakdown"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BreakdownAmbiguity_breakdownId_fkey') THEN
    ALTER TABLE "BreakdownAmbiguity" ADD CONSTRAINT "BreakdownAmbiguity_breakdownId_fkey" FOREIGN KEY ("breakdownId") REFERENCES "PersonaBreakdown"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VoiceNoteSlot_accountId_fkey') THEN
    ALTER TABLE "VoiceNoteSlot" ADD CONSTRAINT "VoiceNoteSlot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VoiceNoteSlot_breakdownId_fkey') THEN
    ALTER TABLE "VoiceNoteSlot" ADD CONSTRAINT "VoiceNoteSlot_breakdownId_fkey" FOREIGN KEY ("breakdownId") REFERENCES "PersonaBreakdown"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VoiceNoteLibraryItem_accountId_fkey') THEN
    ALTER TABLE "VoiceNoteLibraryItem" ADD CONSTRAINT "VoiceNoteLibraryItem_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptSlot_accountId_fkey') THEN
    ALTER TABLE "ScriptSlot" ADD CONSTRAINT "ScriptSlot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptSlot_breakdownId_fkey') THEN
    ALTER TABLE "ScriptSlot" ADD CONSTRAINT "ScriptSlot_breakdownId_fkey" FOREIGN KEY ("breakdownId") REFERENCES "PersonaBreakdown"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptSlot_boundVoiceNoteId_fkey') THEN
    ALTER TABLE "ScriptSlot" ADD CONSTRAINT "ScriptSlot_boundVoiceNoteId_fkey" FOREIGN KEY ("boundVoiceNoteId") REFERENCES "VoiceNoteLibraryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrainingUpload_accountId_fkey') THEN
    ALTER TABLE "TrainingUpload" ADD CONSTRAINT "TrainingUpload_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrainingUpload_personaId_fkey') THEN
    ALTER TABLE "TrainingUpload" ADD CONSTRAINT "TrainingUpload_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "AIPersona"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrainingConversation_uploadId_fkey') THEN
    ALTER TABLE "TrainingConversation" ADD CONSTRAINT "TrainingConversation_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "TrainingUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrainingConversation_accountId_fkey') THEN
    ALTER TABLE "TrainingConversation" ADD CONSTRAINT "TrainingConversation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrainingConversation_personaId_fkey') THEN
    ALTER TABLE "TrainingConversation" ADD CONSTRAINT "TrainingConversation_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "AIPersona"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrainingMessage_conversationId_fkey') THEN
    ALTER TABLE "TrainingMessage" ADD CONSTRAINT "TrainingMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "TrainingConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Conversation_personaId_fkey') THEN
    ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "AIPersona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Message_suggestionId_fkey') THEN
    ALTER TABLE "Message" ADD CONSTRAINT "Message_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "AISuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Message_rejectedAISuggestionId_fkey') THEN
    ALTER TABLE "Message" ADD CONSTRAINT "Message_rejectedAISuggestionId_fkey" FOREIGN KEY ("rejectedAISuggestionId") REFERENCES "AISuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Message_messageGroupId_fkey') THEN
    ALTER TABLE "Message" ADD CONSTRAINT "Message_messageGroupId_fkey" FOREIGN KEY ("messageGroupId") REFERENCES "MessageGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MediaProcessingLog_accountId_fkey') THEN
    ALTER TABLE "MediaProcessingLog" ADD CONSTRAINT "MediaProcessingLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MediaProcessingLog_messageId_fkey') THEN
    ALTER TABLE "MediaProcessingLog" ADD CONSTRAINT "MediaProcessingLog_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageGroup_aiSuggestionId_fkey') THEN
    ALTER TABLE "MessageGroup" ADD CONSTRAINT "MessageGroup_aiSuggestionId_fkey" FOREIGN KEY ("aiSuggestionId") REFERENCES "AISuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VoiceNoteTimingSettings_accountId_fkey') THEN
    ALTER TABLE "VoiceNoteTimingSettings" ADD CONSTRAINT "VoiceNoteTimingSettings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LeadStageTransition_leadId_fkey') THEN
    ALTER TABLE "LeadStageTransition" ADD CONSTRAINT "LeadStageTransition_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Script_accountId_fkey') THEN
    ALTER TABLE "Script" ADD CONSTRAINT "Script_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptStep_scriptId_fkey') THEN
    ALTER TABLE "ScriptStep" ADD CONSTRAINT "ScriptStep_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SelfRecoveryEvent_accountId_fkey') THEN
    ALTER TABLE "SelfRecoveryEvent" ADD CONSTRAINT "SelfRecoveryEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SelfRecoveryEvent_conversationId_fkey') THEN
    ALTER TABLE "SelfRecoveryEvent" ADD CONSTRAINT "SelfRecoveryEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SelfRecoveryEvent_leadId_fkey') THEN
    ALTER TABLE "SelfRecoveryEvent" ADD CONSTRAINT "SelfRecoveryEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SelfRecoveryEvent_scriptStepId_fkey') THEN
    ALTER TABLE "SelfRecoveryEvent" ADD CONSTRAINT "SelfRecoveryEvent_scriptStepId_fkey" FOREIGN KEY ("scriptStepId") REFERENCES "ScriptStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SilentStopEvent_conversationId_fkey') THEN
    ALTER TABLE "SilentStopEvent" ADD CONSTRAINT "SilentStopEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BridgingMessageTemplate_accountId_fkey') THEN
    ALTER TABLE "BridgingMessageTemplate" ADD CONSTRAINT "BridgingMessageTemplate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BridgingMessageTemplate_scriptId_fkey') THEN
    ALTER TABLE "BridgingMessageTemplate" ADD CONSTRAINT "BridgingMessageTemplate_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptBranch_stepId_fkey') THEN
    ALTER TABLE "ScriptBranch" ADD CONSTRAINT "ScriptBranch_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "ScriptStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptAction_stepId_fkey') THEN
    ALTER TABLE "ScriptAction" ADD CONSTRAINT "ScriptAction_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "ScriptStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptAction_branchId_fkey') THEN
    ALTER TABLE "ScriptAction" ADD CONSTRAINT "ScriptAction_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "ScriptBranch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptAction_voiceNoteId_fkey') THEN
    ALTER TABLE "ScriptAction" ADD CONSTRAINT "ScriptAction_voiceNoteId_fkey" FOREIGN KEY ("voiceNoteId") REFERENCES "VoiceNoteLibraryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptAction_formId_fkey') THEN
    ALTER TABLE "ScriptAction" ADD CONSTRAINT "ScriptAction_formId_fkey" FOREIGN KEY ("formId") REFERENCES "ScriptForm"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptForm_scriptId_fkey') THEN
    ALTER TABLE "ScriptForm" ADD CONSTRAINT "ScriptForm_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptFormField_formId_fkey') THEN
    ALTER TABLE "ScriptFormField" ADD CONSTRAINT "ScriptFormField_formId_fkey" FOREIGN KEY ("formId") REFERENCES "ScriptForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LeadScriptPosition_leadId_fkey') THEN
    ALTER TABLE "LeadScriptPosition" ADD CONSTRAINT "LeadScriptPosition_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LeadScriptPosition_scriptId_fkey') THEN
    ALTER TABLE "LeadScriptPosition" ADD CONSTRAINT "LeadScriptPosition_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LeadScriptPosition_currentStepId_fkey') THEN
    ALTER TABLE "LeadScriptPosition" ADD CONSTRAINT "LeadScriptPosition_currentStepId_fkey" FOREIGN KEY ("currentStepId") REFERENCES "ScriptStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LeadScriptPosition_currentBranchId_fkey') THEN
    ALTER TABLE "LeadScriptPosition" ADD CONSTRAINT "LeadScriptPosition_currentBranchId_fkey" FOREIGN KEY ("currentBranchId") REFERENCES "ScriptBranch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrainingDataAnalysis_accountId_fkey') THEN
    ALTER TABLE "TrainingDataAnalysis" ADD CONSTRAINT "TrainingDataAnalysis_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AISuggestion_conversationId_fkey') THEN
    ALTER TABLE "AISuggestion" ADD CONSTRAINT "AISuggestion_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AISuggestion_accountId_fkey') THEN
    ALTER TABLE "AISuggestion" ADD CONSTRAINT "AISuggestion_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrainingEvent_accountId_fkey') THEN
    ALTER TABLE "TrainingEvent" ADD CONSTRAINT "TrainingEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrainingEvent_conversationId_fkey') THEN
    ALTER TABLE "TrainingEvent" ADD CONSTRAINT "TrainingEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrainingEvent_suggestionId_fkey') THEN
    ALTER TABLE "TrainingEvent" ADD CONSTRAINT "TrainingEvent_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "AISuggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InboundQualification_accountId_fkey') THEN
    ALTER TABLE "InboundQualification" ADD CONSTRAINT "InboundQualification_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InboundQualification_conversationId_fkey') THEN
    ALTER TABLE "InboundQualification" ADD CONSTRAINT "InboundQualification_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InboundQualification_leadId_fkey') THEN
    ALTER TABLE "InboundQualification" ADD CONSTRAINT "InboundQualification_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

