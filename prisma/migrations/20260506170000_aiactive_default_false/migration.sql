-- AlterTable
-- Flip Conversation.aiActive default from true → false. Going forward
-- new conversations are created with AI OFF; operator explicitly
-- toggles on. Existing rows are unaffected by a default change.
ALTER TABLE "Conversation" ALTER COLUMN "aiActive" SET DEFAULT false;
