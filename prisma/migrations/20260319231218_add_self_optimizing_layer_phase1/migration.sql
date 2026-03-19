-- CreateEnum
CREATE TYPE "ConversationOutcome" AS ENUM ('ONGOING', 'BOOKED', 'LEFT_ON_READ', 'UNQUALIFIED_REDIRECT', 'RESISTANT_EXIT', 'SOFT_OBJECTION', 'PRICE_QUESTION_DEFLECTED');

-- CreateEnum
CREATE TYPE "LeadIntentTag" AS ENUM ('HIGH_INTENT', 'RESISTANT', 'UNQUALIFIED', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('LIVE', 'SEED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "consentToLog" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dataSource" "DataSource" NOT NULL DEFAULT 'LIVE',
ADD COLUMN     "leadIntentTag" "LeadIntentTag" NOT NULL DEFAULT 'NEUTRAL',
ADD COLUMN     "leadSource" "LeadSource",
ADD COLUMN     "outcome" "ConversationOutcome" NOT NULL DEFAULT 'ONGOING',
ADD COLUMN     "stageBookingAt" TIMESTAMP(3),
ADD COLUMN     "stageCapitalQualificationAt" TIMESTAMP(3),
ADD COLUMN     "stagePainIdentificationAt" TIMESTAMP(3),
ADD COLUMN     "stageQualificationAt" TIMESTAMP(3),
ADD COLUMN     "stageSolutionOfferAt" TIMESTAMP(3),
ADD COLUMN     "stageUrgencyAt" TIMESTAMP(3),
ADD COLUMN     "stageVisionBuildingAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "followUpAttemptNumber" INTEGER,
ADD COLUMN     "gotResponse" BOOLEAN,
ADD COLUMN     "leadContinuedConversation" BOOLEAN,
ADD COLUMN     "responseTimeSeconds" INTEGER,
ADD COLUMN     "sentimentScore" DOUBLE PRECISION,
ADD COLUMN     "stage" TEXT,
ADD COLUMN     "stageConfidence" DOUBLE PRECISION,
ADD COLUMN     "systemPromptVersion" TEXT;

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmOutcome" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "showed" BOOLEAN NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "dealValue" DOUBLE PRECISION,
    "closeReason" TEXT,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptVersion_accountId_createdAt_idx" ON "PromptVersion"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_accountId_version_key" ON "PromptVersion"("accountId", "version");

-- CreateIndex
CREATE INDEX "CrmOutcome_accountId_leadId_idx" ON "CrmOutcome"("accountId", "leadId");

-- CreateIndex
CREATE INDEX "CrmOutcome_accountId_receivedAt_idx" ON "CrmOutcome"("accountId", "receivedAt");

-- CreateIndex
CREATE INDEX "Conversation_outcome_idx" ON "Conversation"("outcome");

-- CreateIndex
CREATE INDEX "Message_conversationId_sender_timestamp_idx" ON "Message"("conversationId", "sender", "timestamp");

-- AddForeignKey
ALTER TABLE "CrmOutcome" ADD CONSTRAINT "CrmOutcome_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
