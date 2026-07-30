-- Store the question ManyChat's own automation asked the lead before handoff,
-- so the AI does not re-ask it on its first turn (Tega B5, 2026-07-30).
-- Additive, nullable — no backfill, no data risk.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "manyChatNativeQuestion" TEXT;
