-- ============================================================================
-- Enable RLS on Prisma's internal _prisma_migrations bookkeeping table
-- ============================================================================
-- The previous migration (20260405120000_enable_rls_security) covered all
-- application tables. This one closes the last public-schema table that
-- Supabase's linter flags: _prisma_migrations.
--
-- _prisma_migrations only stores migration metadata (id, checksum, applied_at).
-- It contains no user data, but it's in the public schema and therefore
-- exposed via PostgREST through the anon key.
--
-- Prisma itself writes to this table during `migrate deploy` using the
-- postgres superuser (DIRECT_URL), which has BYPASSRLS — so enabling RLS
-- has no effect on Prisma's migration workflow.
-- ============================================================================

-- Guarded so the migration is a no-op when the _prisma_migrations table
-- doesn't exist (e.g. inside Prisma's shadow database used by
-- `prisma migrate diff`).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations'
  ) THEN
    EXECUTE 'ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY';
  END IF;
END$$;
