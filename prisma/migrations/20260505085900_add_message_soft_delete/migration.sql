-- Soft-delete fields on Message — drives the unsend feature.
--
-- Inbound (lead unsent from IG): the IG message_deletions webhook
-- event sets deletedAt + deletedBy='LEAD' + deletedSource='INSTAGRAM'.
-- Outbound (operator unsent from dashboard): /api/conversations/.../
-- unsend endpoint calls Meta's IG DELETE then sets deletedAt + the
-- operator's userId + deletedSource='DASHBOARD'.
--
-- All three columns nullable + no default so existing rows are
-- unaffected. No backfill required.

ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "deletedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deletedBy"     TEXT,
  ADD COLUMN IF NOT EXISTS "deletedSource" TEXT;
