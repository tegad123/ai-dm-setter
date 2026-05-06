-- AlterTable
ALTER TABLE "Message" ADD COLUMN "deletedReason" TEXT;
ALTER TABLE "Message" ADD COLUMN "isHumanCorrection" BOOLEAN NOT NULL DEFAULT false;
