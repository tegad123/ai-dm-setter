-- Generate-only shadow mode, per platform (2026-09-08, Tega / IG parity day 2).
-- Additive, defaults false: no behaviour change for any existing account.
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "generateOnlyInstagram" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "generateOnlyFacebook" BOOLEAN NOT NULL DEFAULT false;
