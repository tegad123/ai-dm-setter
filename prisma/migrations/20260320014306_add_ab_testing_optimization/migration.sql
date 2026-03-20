-- CreateEnum
CREATE TYPE "ABTestStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PAUSED');

-- CreateEnum
CREATE TYPE "OptimizationStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'STAGING_TEST', 'APPLIED', 'REJECTED', 'MODIFIED', 'REVERTED');

-- CreateEnum
CREATE TYPE "OptimizationType" AS ENUM ('SYSTEM_PROMPT_UPDATE', 'MESSAGE_VARIATION', 'FLOW_ADJUSTMENT');

-- AlterTable
ALTER TABLE "PromptVersion" ADD COLUMN     "appliedBy" TEXT,
ADD COLUMN     "changeType" TEXT,
ADD COLUMN     "optimizationId" TEXT,
ADD COLUMN     "performanceAfter" JSONB,
ADD COLUMN     "performanceBefore" JSONB,
ADD COLUMN     "promptContent" TEXT;

-- CreateTable
CREATE TABLE "ABTest" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "variantA" TEXT NOT NULL,
    "variantB" TEXT NOT NULL,
    "metric" TEXT NOT NULL DEFAULT 'response_rate',
    "sampleSizeTarget" INTEGER NOT NULL DEFAULT 50,
    "countA" INTEGER NOT NULL DEFAULT 0,
    "countB" INTEGER NOT NULL DEFAULT 0,
    "resultsA" JSONB,
    "resultsB" JSONB,
    "winner" TEXT,
    "status" "ABTestStatus" NOT NULL DEFAULT 'RUNNING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ABTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ABTestAssignment" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ABTestAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationSuggestion" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "OptimizationType" NOT NULL,
    "reasoning" TEXT NOT NULL,
    "currentVersion" TEXT,
    "proposedVersion" TEXT,
    "proposedChanges" TEXT,
    "supportingData" JSONB,
    "stagingTestResults" JSONB,
    "status" "OptimizationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "OptimizationSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ABTest_accountId_status_idx" ON "ABTest"("accountId", "status");

-- CreateIndex
CREATE INDEX "ABTestAssignment_testId_variant_idx" ON "ABTestAssignment"("testId", "variant");

-- CreateIndex
CREATE UNIQUE INDEX "ABTestAssignment_testId_leadId_key" ON "ABTestAssignment"("testId", "leadId");

-- CreateIndex
CREATE INDEX "OptimizationSuggestion_accountId_status_idx" ON "OptimizationSuggestion"("accountId", "status");

-- CreateIndex
CREATE INDEX "OptimizationSuggestion_accountId_createdAt_idx" ON "OptimizationSuggestion"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "ABTestAssignment" ADD CONSTRAINT "ABTestAssignment_testId_fkey" FOREIGN KEY ("testId") REFERENCES "ABTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ABTestAssignment" ADD CONSTRAINT "ABTestAssignment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
