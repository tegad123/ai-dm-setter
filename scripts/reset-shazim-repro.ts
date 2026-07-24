// Resets Shazim's low-ticket test conversation to a clean step-1 slate so the
// F2–F6 repro before/after is uncontaminated by a prior run's captures.
// Deletes NOTHING permanent — clears captured data points, resets the stage
// panel + systemStage/currentScriptStep, leaves the lead + conversation rows.
//
// Usage: npx tsx scripts/reset-seemal-repro.ts
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: (process.env.PROD_DATABASE_URL ?? '')
        .replace(':6543/', ':5432/')
        .replace('?pgbouncer=true', '')
    }
  }
});
const SENDER_ID = '27053194794302900'; // Shazim

async function retry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw last;
}

async function main() {
  const lead = await retry(() =>
    prisma.lead.findFirst({
      where: { platformUserId: SENDER_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    })
  );
  if (!lead) throw new Error('no Shazim lead found');
  const conv = await retry(() =>
    prisma.conversation.findFirst({
      where: { leadId: lead.id },
      select: {
        id: true,
        systemStage: true,
        currentScriptStep: true,
        capturedDataPoints: true
      }
    })
  );
  if (!conv) throw new Error('no Shazim conversation found');
  console.log(
    `BEFORE convId=${conv.id} systemStage="${conv.systemStage}" step=${conv.currentScriptStep} cdpKeys=${Object.keys((conv.capturedDataPoints ?? {}) as object).join(',')}`
  );

  // Clear message history + any pending/generated artifacts so the re-run
  // starts from a true clean slate (AI does not "see" the prior transcript,
  // including the pre-fix fabricated goal line). Keeps lead + conversation +
  // persona binding — deletes NO lead row.
  const delMsgs = await prisma.message.deleteMany({
    where: { conversationId: conv.id }
  });
  const delSched = await prisma.scheduledReply.deleteMany({
    where: { conversationId: conv.id }
  });
  await prisma.aISuggestion
    .deleteMany({ where: { conversationId: conv.id } })
    .catch(() => {});
  console.log(
    `cleared messages=${delMsgs.count} scheduledReplies=${delSched.count}`
  );

  await prisma.$executeRaw`
    UPDATE "Conversation"
    SET "capturedDataPoints" = '{}'::jsonb,
        "systemStage" = 'Intro — Experience Level',
        "currentScriptStep" = 1,
        "stageMismatchCount" = 0,
        "aiActive" = true,
        "awaitingHumanReview" = false,
        "distressDetected" = false,
        "distressDetectedAt" = NULL,
        "scheduledCallAt" = NULL,
        "stageOpeningAt" = NULL,
        "stageSituationDiscoveryAt" = NULL,
        "stageGoalEmotionalWhyAt" = NULL,
        "stageUrgencyAt" = NULL,
        "stageSoftPitchCommitmentAt" = NULL,
        "stageFinancialScreeningAt" = NULL,
        "stageBookingAt" = NULL
    WHERE id = ${conv.id}
  `;

  const after = await retry(() =>
    prisma.conversation.findUnique({
      where: { id: conv.id },
      select: {
        systemStage: true,
        currentScriptStep: true,
        capturedDataPoints: true,
        aiActive: true,
        awaitingHumanReview: true
      }
    })
  );
  console.log(
    `AFTER  systemStage="${after?.systemStage}" step=${after?.currentScriptStep} cdpKeys=${Object.keys((after?.capturedDataPoints ?? {}) as object).join(',')} aiActive=${after?.aiActive} awaitingHuman=${after?.awaitingHumanReview}`
  );
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
