CREATE TABLE "InstagramOwnershipEventLog" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "credentialId" TEXT,
    "entryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "senderId" TEXT,
    "recipientId" TEXT,
    "previousOwnerAppId" TEXT,
    "newOwnerAppId" TEXT,
    "eventTimestamp" TIMESTAMP(3),
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstagramOwnershipEventLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstagramOwnershipEventLog_payloadHash_key"
ON "InstagramOwnershipEventLog"("payloadHash");

CREATE INDEX "InstagramOwnershipEventLog_accountId_createdAt_idx"
ON "InstagramOwnershipEventLog"("accountId", "createdAt" DESC);

CREATE INDEX "InstagramOwnershipEventLog_recipientId_createdAt_idx"
ON "InstagramOwnershipEventLog"("recipientId", "createdAt" DESC);

CREATE INDEX "InstagramOwnershipEventLog_previousOwnerAppId_newOwnerAppId_idx"
ON "InstagramOwnershipEventLog"("previousOwnerAppId", "newOwnerAppId");
