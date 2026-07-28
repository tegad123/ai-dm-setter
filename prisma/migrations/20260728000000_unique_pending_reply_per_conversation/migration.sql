-- Enforce the invariant the reply pipeline has always assumed: at most ONE
-- PENDING scheduled reply per conversation (2026-07-28, Tega item 2 —
-- rapid-fire inbounds created two PENDING rows, producing two racing
-- generations; the loser's blocked duplicate then held the conversation).

-- 1. Cancel duplicate PENDING rows first (keep the newest per conversation)
--    so the unique index can build on live data.
UPDATE "ScheduledReply" sr SET status = 'CANCELLED'
WHERE sr.status = 'PENDING'
  AND EXISTS (
    SELECT 1 FROM "ScheduledReply" newer
    WHERE newer."conversationId" = sr."conversationId"
      AND newer.status = 'PENDING'
      AND newer."createdAt" > sr."createdAt"
  );

-- 2. Partial unique index: a second concurrent creator gets a unique
--    violation and merges into the surviving row (webhook-processor
--    catches P2002 and updates scheduledFor instead).
CREATE UNIQUE INDEX IF NOT EXISTS "ScheduledReply_one_pending_per_conversation"
  ON "ScheduledReply" ("conversationId")
  WHERE status = 'PENDING';
