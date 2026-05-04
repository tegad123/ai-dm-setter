-- ============================================================================
-- Add ConversationSource enum + Conversation.source column
-- ============================================================================
-- Both were added to schema.prisma in commit 89252d8 (2026-04-30) but no
-- migration was generated. The next migration
-- (20260430120000_dfy_integrations_manager) creates an index on
-- Conversation(source, manyChatFiredAt), which fails on a fresh DB because
-- the column does not exist.
--
-- Idempotent so prod (which already has these objects via `prisma db push`)
-- can be reconciled with `prisma migrate resolve --applied`.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConversationSource') THEN
    CREATE TYPE "ConversationSource" AS ENUM ('INBOUND', 'MANYCHAT', 'MANUAL_UPLOAD');
  END IF;
END$$;

ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "source" "ConversationSource" NOT NULL DEFAULT 'INBOUND';
