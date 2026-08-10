-- Fix D Phase 0: egress shadow-compare ledger (log-only, no behavior change)
CREATE TABLE "EgressShadowLog" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationId" TEXT,
    "sendPath" TEXT NOT NULL,
    "draftPreview" TEXT,
    "machineAllow" BOOLEAN NOT NULL,
    "machineReason" TEXT,
    "machineHold" TEXT,
    "agreed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EgressShadowLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EgressShadowLog_accountId_createdAt_idx" ON "EgressShadowLog"("accountId", "createdAt" DESC);

CREATE INDEX "EgressShadowLog_agreed_createdAt_idx" ON "EgressShadowLog"("agreed", "createdAt" DESC);
