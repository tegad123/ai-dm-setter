-- Pipeline lead search indexes. The regular btree indexes help exact/prefix
-- lookups scoped by account; trigram indexes keep partial handle/name search
-- fast as lead volume grows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Lead_accountId_handle_idx"
  ON "Lead"("accountId", "handle");

CREATE INDEX IF NOT EXISTS "Lead_accountId_name_idx"
  ON "Lead"("accountId", "name");

CREATE INDEX IF NOT EXISTS "Conversation_leadPhone_idx"
  ON "Conversation"("leadPhone");

CREATE INDEX IF NOT EXISTS "Conversation_leadEmail_idx"
  ON "Conversation"("leadEmail");

CREATE INDEX IF NOT EXISTS "Lead_handle_trgm_idx"
  ON "Lead" USING gin (lower("handle") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Lead_name_trgm_idx"
  ON "Lead" USING gin (lower("name") gin_trgm_ops);
