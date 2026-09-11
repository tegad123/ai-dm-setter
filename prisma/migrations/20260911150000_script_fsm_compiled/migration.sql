-- M5 compiler (2026-09-11): compiled FSM stored on the Script row (additive,
-- nullable = not compiled yet → legacy routing) + the routing shadow ledger.
ALTER TABLE "Script" ADD COLUMN IF NOT EXISTS "compiledFsm" JSONB;
ALTER TABLE "Script" ADD COLUMN IF NOT EXISTS "compiledFsmVersion" INTEGER;

CREATE TABLE IF NOT EXISTS "RoutingShadowLog" (
  "id"                TEXT PRIMARY KEY,
  "accountId"         TEXT NOT NULL,
  "conversationId"    TEXT,
  "scriptId"          TEXT,
  "stepNumber"        INTEGER NOT NULL,
  "legacyBranchLabel" TEXT,
  "fsmBranchLabel"    TEXT,
  "fsmReason"         TEXT,
  "legacyNextStep"    INTEGER,
  "fsmNextStep"       INTEGER,
  "branchAgreed"      BOOLEAN NOT NULL,
  "advanceAgreed"     BOOLEAN,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "RoutingShadowLog_accountId_createdAt_idx" ON "RoutingShadowLog"("accountId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "RoutingShadowLog_branchAgreed_createdAt_idx" ON "RoutingShadowLog"("branchAgreed", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "RoutingShadowLog_conversationId_idx" ON "RoutingShadowLog"("conversationId");
