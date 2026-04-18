/**
 * One-shot: put daetradez back into ONBOARDING so Phase 1 training signal
 * starts accumulating again. Diagnostic showed the account was grandfathered
 * to ACTIVE by the original backfill despite having zero training corpus.
 *
 * This script:
 *   1. Sets trainingPhase='ONBOARDING'
 *   2. Resets trainingOverrideCount=0
 *   3. Clears trainingPhaseCompletedAt
 *   4. Sets trainingPhaseStartedAt=now()
 *
 * Run:       npx tsx scripts/reset-daetradez-onboarding.ts
 * Dry run:   npx tsx scripts/reset-daetradez-onboarding.ts --dry-run
 */
import prisma from '../src/lib/prisma';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const account = await prisma.account.findFirst({
    where: {
      OR: [
        { name: { contains: 'daetrad', mode: 'insensitive' } },
        { slug: { contains: 'daetrad', mode: 'insensitive' } }
      ]
    },
    select: {
      id: true,
      name: true,
      slug: true,
      trainingPhase: true,
      trainingPhaseStartedAt: true,
      trainingPhaseCompletedAt: true,
      trainingOverrideCount: true,
      trainingTargetOverrideCount: true
    }
  });

  if (!account) {
    console.error('Could not find daetradez account.');
    process.exit(1);
  }

  console.log('Before:');
  console.log(JSON.stringify(account, null, 2));

  if (!dryRun) {
    const updated = await prisma.account.update({
      where: { id: account.id },
      data: {
        trainingPhase: 'ONBOARDING',
        trainingPhaseStartedAt: new Date(),
        trainingPhaseCompletedAt: null,
        trainingOverrideCount: 0
      },
      select: {
        id: true,
        name: true,
        trainingPhase: true,
        trainingPhaseStartedAt: true,
        trainingPhaseCompletedAt: true,
        trainingOverrideCount: true,
        trainingTargetOverrideCount: true
      }
    });

    console.log('\nAfter:');
    console.log(JSON.stringify(updated, null, 2));
  } else {
    console.log('\n[DRY RUN] would set trainingPhase=ONBOARDING, counter=0');
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
