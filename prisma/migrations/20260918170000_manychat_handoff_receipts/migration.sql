CREATE TABLE IF NOT EXISTS "ManyChatHandoffReceipt" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "platform" "Platform" NOT NULL,
  "subscriberId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "conversationId" TEXT,
  "openerMessageId" TEXT,
  "leadMessageId" TEXT,
  "scheduledReplyId" TEXT,
  "schedulingStartedAt" TIMESTAMP(3),
  "nativeInboundOwned" BOOLEAN NOT NULL DEFAULT false,
  "lastError" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManyChatHandoffReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ManyChatHandoffReceipt_accountId_platform_subscriberId_key"
  ON "ManyChatHandoffReceipt"("accountId", "platform", "subscriberId");
CREATE INDEX IF NOT EXISTS "ManyChatHandoffReceipt_status_nextAttemptAt_idx"
  ON "ManyChatHandoffReceipt"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "ManyChatHandoffReceipt_conversationId_idx"
  ON "ManyChatHandoffReceipt"("conversationId");
