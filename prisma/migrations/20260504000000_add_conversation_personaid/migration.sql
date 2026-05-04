-- Audit F4.2 — add Conversation.personaId for multi-tenant isolation.
--
-- Today every Conversation is implicitly owned by "the account's first
-- active AIPersona", which is non-deterministic for multi-persona accounts
-- and the root of every cross-persona context-bleed finding in
-- audit/2026-05-03-multi-tenant-leak-audit.md (F3.1, F3.2, F3.3, F3.4,
-- F3.5, F2.3 all depend on this column).
--
-- Migration plan:
--   1. ADD COLUMN nullable
--   2. BACKFILL: every Conversation gets the AIPersona of its account
--      (prefer isActive=true, most-recently-updated; fall back to any).
--   3. Assert zero NULL rows post-backfill (raises and aborts otherwise).
--   4. SET NOT NULL.
--   5. Add FK constraint with onDelete: Restrict (refuse persona delete
--      while live conversations reference it).
--   6. Add index for personaId-scoped queries.
--
-- Production posture: only deploy this when (a) staging has run end-to-end
-- with this migration applied AND (b) every account either has at least
-- one AIPersona row or has zero Conversation rows. The DO block at step 3
-- aborts the transaction safely if the backfill leaves any conversation
-- unowned, so the migration is single-statement-safe to retry after fixing
-- the offending account's persona configuration.

-- 1. Add column nullable
ALTER TABLE "Conversation"
ADD COLUMN "personaId" TEXT;

-- 2. Backfill — pick the active persona for each conversation's account.
-- Tie-break by most-recently-updated. Falls back to any persona if no
-- active row exists for the account (transitional accounts mid-onboarding).
WITH chosen_persona AS (
  SELECT DISTINCT ON (p."accountId")
    p."accountId",
    p."id" AS persona_id
  FROM "AIPersona" p
  ORDER BY p."accountId",
           p."isActive" DESC,
           p."updatedAt" DESC
)
UPDATE "Conversation" c
SET "personaId" = cp.persona_id
FROM "Lead" l, chosen_persona cp
WHERE c."leadId" = l."id"
  AND l."accountId" = cp."accountId"
  AND c."personaId" IS NULL;

-- 3. Assert backfill is complete. Any leftover NULL means an account has
-- a Conversation but no AIPersona at all — operator data integrity bug
-- the migration cannot silently invent its way out of.
DO $$
DECLARE
  null_count INTEGER;
  orphan_account RECORD;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM "Conversation"
  WHERE "personaId" IS NULL;

  IF null_count > 0 THEN
    -- Surface which accounts are at fault so the operator can fix.
    FOR orphan_account IN
      SELECT DISTINCT l."accountId", COUNT(c."id") AS unowned_conversations
      FROM "Conversation" c
      JOIN "Lead" l ON l."id" = c."leadId"
      WHERE c."personaId" IS NULL
      GROUP BY l."accountId"
    LOOP
      RAISE NOTICE 'Account % has % Conversation rows but no AIPersona to assign.',
        orphan_account."accountId",
        orphan_account.unowned_conversations;
    END LOOP;

    RAISE EXCEPTION
      'Backfill incomplete: % Conversation rows still have NULL personaId. '
      'Create an AIPersona row for each listed account, then re-run this migration.',
      null_count;
  END IF;
END
$$;

-- 4. Lock the invariant — every future Conversation MUST be created with
-- an explicit personaId.
ALTER TABLE "Conversation"
ALTER COLUMN "personaId" SET NOT NULL;

-- 5. FK to AIPersona. Restrict on persona delete keeps conversation
-- history safe — operator must explicitly archive/migrate first.
ALTER TABLE "Conversation"
ADD CONSTRAINT "Conversation_personaId_fkey"
FOREIGN KEY ("personaId") REFERENCES "AIPersona"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Index for personaId-scoped queries (per-persona conversation lists,
-- per-persona allowlist scoping in F2.3, etc.).
CREATE INDEX "Conversation_personaId_idx"
ON "Conversation"("personaId");
