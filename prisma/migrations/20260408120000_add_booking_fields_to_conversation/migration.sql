-- Booking-stage state for LeadConnector (HighLevel) integration.
-- Adds 7 nullable columns to Conversation. Split into individual
-- ALTER TABLE statements so each one stays under Supabase's pooler
-- statement timeout. All columns are nullable so no backfill needed.

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "leadTimezone" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "leadEmail" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "leadPhone" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "proposedSlots" JSONB;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "selectedSlot" JSONB;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "bookingId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "bookingUrl" TEXT;
