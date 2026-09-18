DO $$
BEGIN
  CREATE TYPE "MessageDeliveryStatus" AS ENUM (
    'PLANNED',
    'PROVIDER_REPORTED',
    'META_CONFIRMED',
    'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryStatus" "MessageDeliveryStatus",
  ADD COLUMN IF NOT EXISTS "deliveryReportedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveryConfirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveryFailedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveryErrorCode" TEXT,
  ADD COLUMN IF NOT EXISTS "echoAttributionPendingUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "echoAttributionFinalizedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Message_conversationId_providerMessageId_key"
  ON "Message"("conversationId", "providerMessageId");

CREATE INDEX IF NOT EXISTS "Message_deliveryStatus_deliveryReportedAt_idx"
  ON "Message"("deliveryStatus", "deliveryReportedAt");

CREATE INDEX IF NOT EXISTS "Message_echoAttributionPendingUntil_echoAttributionFinalizedAt_idx"
  ON "Message"("echoAttributionPendingUntil", "echoAttributionFinalizedAt");
