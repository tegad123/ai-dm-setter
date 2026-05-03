-- Keep the deploy-time seed focused on truly live conversations.
-- The 60-day backlog is diagnostic/operator-review only; do not auto-send
-- to older cold leads just because their latest message was from LEAD.

WITH latest_message AS (
  SELECT DISTINCT ON (m."conversationId")
    m."conversationId",
    m."sender",
    m."timestamp"
  FROM "Message" m
  WHERE m."sender" != 'SYSTEM'
  ORDER BY m."conversationId", m."timestamp" DESC
)
UPDATE "Conversation" c
SET
  "awaitingAiResponse" = false,
  "awaitingSince" = NULL
FROM latest_message lm
WHERE c."id" = lm."conversationId"
  AND c."awaitingAiResponse" = true
  AND lm."sender" = 'LEAD'
  AND lm."timestamp" < NOW() - INTERVAL '2 hours';
