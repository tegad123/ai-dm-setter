-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('REEL', 'STORY', 'POST', 'LIVE', 'AD', 'COMMENT_TRIGGER', 'DM_DIRECT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationProvider" ADD VALUE 'CALENDLY';
ALTER TYPE "IntegrationProvider" ADD VALUE 'CALCOM';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TEAM_NOTE';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "awayMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "awayModeEnabledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "lastAIAnalysis" TIMESTAMP(3),
ADD COLUMN     "priorityScore" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "contentAttributionId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avgResponseTime" INTEGER,
ADD COLUMN     "commissionRate" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN     "totalCommission" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6B7280',
    "isAuto" BOOLEAN NOT NULL DEFAULT false,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadTag" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "appliedBy" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamNote" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentAttribution" (
    "id" TEXT NOT NULL,
    "contentType" "ContentType" NOT NULL,
    "contentId" TEXT,
    "contentUrl" TEXT,
    "caption" TEXT,
    "platform" "Platform" NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadsCount" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "callsBooked" INTEGER NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tag_accountId_idx" ON "Tag"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_accountId_name_key" ON "Tag"("accountId", "name");

-- CreateIndex
CREATE INDEX "LeadTag_leadId_idx" ON "LeadTag"("leadId");

-- CreateIndex
CREATE INDEX "LeadTag_tagId_idx" ON "LeadTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadTag_leadId_tagId_key" ON "LeadTag"("leadId", "tagId");

-- CreateIndex
CREATE INDEX "TeamNote_leadId_createdAt_idx" ON "TeamNote"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "TeamNote_accountId_idx" ON "TeamNote"("accountId");

-- CreateIndex
CREATE INDEX "ContentAttribution_accountId_createdAt_idx" ON "ContentAttribution"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentAttribution_accountId_contentType_idx" ON "ContentAttribution"("accountId", "contentType");

-- CreateIndex
CREATE UNIQUE INDEX "ContentAttribution_accountId_contentId_platform_key" ON "ContentAttribution"("accountId", "contentId", "platform");

-- CreateIndex
CREATE INDEX "Conversation_priorityScore_idx" ON "Conversation"("priorityScore");

-- CreateIndex
CREATE INDEX "Lead_contentAttributionId_idx" ON "Lead"("contentAttributionId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_contentAttributionId_fkey" FOREIGN KEY ("contentAttributionId") REFERENCES "ContentAttribution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTag" ADD CONSTRAINT "LeadTag_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTag" ADD CONSTRAINT "LeadTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamNote" ADD CONSTRAINT "TeamNote_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamNote" ADD CONSTRAINT "TeamNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamNote" ADD CONSTRAINT "TeamNote_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAttribution" ADD CONSTRAINT "ContentAttribution_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
