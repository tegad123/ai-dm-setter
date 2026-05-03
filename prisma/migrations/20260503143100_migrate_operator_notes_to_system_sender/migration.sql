UPDATE "Message"
SET "sender" = 'SYSTEM'::"MessageSender"
WHERE "sender" = 'HUMAN'::"MessageSender"
  AND "content" LIKE 'OPERATOR NOTE:%';
