-- AlterEnum
ALTER TYPE "MessageSource" ADD VALUE 'IMPORTED_TAKEOVER';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "priorHumanHandoff" BOOLEAN NOT NULL DEFAULT false;
