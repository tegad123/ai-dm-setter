-- Durable R24 qualification state. Qualification must survive scheduling
-- changes such as reschedules, so the gate does not re-scan old chat history.

CREATE TYPE "CapitalVerificationStatus" AS ENUM (
  'UNVERIFIED',
  'VERIFIED_QUALIFIED',
  'VERIFIED_UNQUALIFIED',
  'MANUALLY_OVERRIDDEN'
);

ALTER TABLE "Conversation"
  ADD COLUMN "capitalVerificationStatus" "CapitalVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "capitalVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "capitalVerifiedAmount" INTEGER;

CREATE INDEX "Conversation_capitalVerificationStatus_idx"
  ON "Conversation"("capitalVerificationStatus");

-- Existing qualified / booked / rescheduleable conversations with at least one
-- successful R24 audit should be treated as permanently qualified.
UPDATE "Conversation" c
SET
  "capitalVerificationStatus" = 'VERIFIED_QUALIFIED',
  "capitalVerifiedAt" = COALESCE(
    (
      SELECT MIN(bra."createdAt")
      FROM "BookingRoutingAudit" bra
      WHERE bra."conversationId" = c."id"
        AND bra."routingAllowed" = TRUE
    ),
    c."updatedAt"
  ),
  "capitalVerifiedAmount" = COALESCE(
    c."typeformCapitalConfirmed",
    c."capitalVerifiedAmount"
  )
FROM "Lead" l
WHERE c."leadId" = l."id"
  AND l."stage" IN ('BOOKED', 'CALL_PROPOSED', 'QUALIFIED', 'RESCHEDULED')
  AND EXISTS (
    SELECT 1
    FROM "BookingRoutingAudit" bra
    WHERE bra."conversationId" = c."id"
      AND bra."routingAllowed" = TRUE
  );

-- Existing unqualified conversations with a failed R24 audit keep the durable
-- unqualified marker. This remains re-evaluable by future explicit capital
-- answers because only VERIFIED_QUALIFIED short-circuits the gate.
UPDATE "Conversation" c
SET "capitalVerificationStatus" = 'VERIFIED_UNQUALIFIED'
FROM "Lead" l
WHERE c."leadId" = l."id"
  AND l."stage" = 'UNQUALIFIED'
  AND EXISTS (
    SELECT 1
    FROM "BookingRoutingAudit" bra
    WHERE bra."conversationId" = c."id"
      AND bra."routingAllowed" = FALSE
  );

-- Incident-specific repair: Wout Lngrs qualified at roughly $5k, then got
-- incorrectly re-routed during a reschedule after scheduledCallAt was cleared.
UPDATE "Conversation" c
SET
  "capitalVerificationStatus" = 'VERIFIED_QUALIFIED',
  "capitalVerifiedAt" = COALESCE(c."capitalVerifiedAt", NOW()),
  "capitalVerifiedAmount" = 5000,
  "aiActive" = TRUE
FROM "Lead" l
JOIN "Account" a ON a."id" = l."accountId"
WHERE c."leadId" = l."id"
  AND l."handle" = '__lngrs'
  AND a."slug" = 'daetradez2003';

UPDATE "Lead" l
SET "stage" = 'CALL_PROPOSED'
FROM "Account" a
WHERE a."id" = l."accountId"
  AND l."handle" = '__lngrs'
  AND a."slug" = 'daetradez2003';
