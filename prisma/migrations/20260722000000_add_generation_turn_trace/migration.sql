-- Per-turn generation trace (instrumentation, 2026-07-22).
-- Purely additive: one new table, no changes to existing tables, no data
-- movement. Nothing reads from it at deploy time, so it is safe to apply
-- ahead of the code that writes to it.

-- CreateTable
CREATE TABLE "GenerationTurnTrace" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadMessageId" TEXT,
    "branchSelected" TEXT,
    "stepNumber" INTEGER,
    "systemStage" TEXT,
    "stageEmitted" TEXT,
    "subStageEmitted" TEXT,
    "variablesState" JSONB,
    "promptSent" TEXT,
    "promptChars" INTEGER,
    "replyPreview" TEXT,
    "qualityHardFails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationTurnTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationTurnTrace_conversationId_createdAt_idx" ON "GenerationTurnTrace"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationTurnTrace_accountId_createdAt_idx" ON "GenerationTurnTrace"("accountId", "createdAt");
