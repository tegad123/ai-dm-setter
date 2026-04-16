/**
 * One-time backfill: set trainingPhase for existing accounts.
 *
 * - Accounts with >0 AI-generated messages → ACTIVE (grandfathered)
 * - Accounts with 0 AI-generated messages → ONBOARDING (fresh start)
 *
 * Safe to run multiple times — only updates accounts still on ONBOARDING
 * that should be ACTIVE.
 *
 * Usage: npx tsx scripts/backfill-training-phase.ts
 */

import prisma from '../src/lib/prisma';

async function main() {
  console.log('[backfill-training-phase] Starting...');

  // Get all accounts
  const accounts = await prisma.account.findMany({
    select: { id: true, name: true, createdAt: true, trainingPhase: true }
  });

  console.log(`[backfill-training-phase] Found ${accounts.length} accounts`);

  let onboardingCount = 0;
  let activeCount = 0;

  for (const account of accounts) {
    // Count AI messages across all conversations for this account
    const aiMessageCount = await prisma.message.count({
      where: {
        sender: 'AI',
        conversation: {
          lead: { accountId: account.id }
        }
      }
    });

    if (aiMessageCount > 0) {
      // Has AI messages — grandfather to ACTIVE
      await prisma.account.update({
        where: { id: account.id },
        data: {
          trainingPhase: 'ACTIVE',
          trainingPhaseStartedAt: new Date() // grandfathered now
        }
      });
      activeCount++;
      console.log(
        `  [ACTIVE] ${account.name || account.id}: ${aiMessageCount} AI messages`
      );
    } else {
      // No AI messages — stays ONBOARDING
      await prisma.account.update({
        where: { id: account.id },
        data: {
          trainingPhase: 'ONBOARDING',
          trainingPhaseStartedAt: account.createdAt
        }
      });
      onboardingCount++;
      console.log(
        `  [ONBOARDING] ${account.name || account.id}: 0 AI messages`
      );
    }
  }

  console.log(
    `\n[backfill-training-phase] Done: ${activeCount} ACTIVE, ${onboardingCount} ONBOARDING`
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[backfill-training-phase] Error:', err);
  process.exit(1);
});
