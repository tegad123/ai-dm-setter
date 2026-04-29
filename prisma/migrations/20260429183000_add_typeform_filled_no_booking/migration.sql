ALTER TABLE "Conversation"
  ADD COLUMN "typeformFilledNoBooking" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "typeformFilledNoBookingAt" TIMESTAMP(3),
  ADD COLUMN "typeformFilledNoBookingMessageId" TEXT;
