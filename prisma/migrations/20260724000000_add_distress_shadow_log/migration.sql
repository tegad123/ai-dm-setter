-- Distress classifier-first shadow-mode comparison ledger (2026-07-24).
-- Purely additive: one new table, no changes to existing tables, no data
-- movement. Nothing acts on it at deploy time (regex stays authoritative);
-- it only records the shadow classifier's verdict for joint review before the
-- authoritative flip. Safe to apply ahead of the code that writes to it.

-- CreateTable
CREATE TABLE "DistressShadowLog" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "accountId" TEXT,
    "messageText" TEXT NOT NULL,
    "regexDetected" BOOLEAN NOT NULL,
    "regexLabel" TEXT,
    "classifierDetected" BOOLEAN NOT NULL,
    "classifierOk" BOOLEAN NOT NULL,
    "classifierCategory" TEXT,
    "classifierReason" TEXT,
    "agreed" BOOLEAN NOT NULL,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistressShadowLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DistressShadowLog_agreed_createdAt_idx" ON "DistressShadowLog"("agreed", "createdAt");

-- CreateIndex
CREATE INDEX "DistressShadowLog_conversationId_createdAt_idx" ON "DistressShadowLog"("conversationId", "createdAt");
