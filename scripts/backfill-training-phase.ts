/**
 * One-time backfill: set trainingPhase for existing accounts.
 *
 * Corrected grandfathering rule (2026-04-18 rev):
 *   - 0 AI messages → ONBOARDING (brand-new account)
 *   - AI messages but no uploaded training corpus → ONBOARDING
 *     (existing account that never learned the user's voice; they need the
 *      structured training UX to start capturing human-override signal)
 *   - AI messages AND ≥1 TrainingConversation rows → ACTIVE
 *     (account has already trained via the upload path)
 *
 * The earlier version grandfathered ANY account with AI messages to ACTIVE,
 * which wrongly excluded legitimately-untrained accounts from the onboarding
 * UX and the corresponding training-override counter. See diag-training-signal
 * for the daetradez case that surfaced this.
 *
 * Safe to run multiple times — idempotent per-account:
 *   - An account currently in ACTIVE stays ACTIVE only if the corpus rule
 *     still holds; otherwise it's demoted to ONBOARDING.
 *   - Pass --dry-run to preview without writing.
 *
 * Usage: npx tsx scripts/backfill-training-phase.ts [--dry-run]
 */

import prisma from '../src/lib/prisma';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(
    `[backfill-training-phase] Starting (${dryRun ? 'DRY RUN' : 'LIVE'})...`
  );

  const accounts = await prisma.account.findMany({
    select: {
      id: true,
      name: true,
      createdAt: true,
      trainingPhase: true,
      trainingPhaseStartedAt: true
    }
  });

  console.log(`[backfill-training-phase] Found ${accounts.length} accounts`);

  let toActive = 0;
  let toOnboarding = 0;
  let unchanged = 0;

  for (const account of accounts) {
    const [aiMessageCount, trainingConvoCount] = await Promise.all([
      prisma.message.count({
        where: {
          sender: 'AI',
          conversation: { lead: { accountId: account.id } }
        }
      }),
      prisma.trainingConversation.count({ where: { accountId: account.id } })
    ]);

    const targetPhase: 'ACTIVE' | 'ONBOARDING' =
      aiMessageCount > 0 && trainingConvoCount > 0 ? 'ACTIVE' : 'ONBOARDING';

    // Skip if the account is PAUSED — admin made a deliberate choice we
    // don't want to override.
    if (account.trainingPhase === 'PAUSED') {
      unchanged++;
      console.log(
        `  [skip PAUSED] ${account.name || account.id}: leave as-is (ai=${aiMessageCount}, corpus=${trainingConvoCount})`
      );
      continue;
    }

    if (account.trainingPhase === targetPhase) {
      unchanged++;
      console.log(
        `  [ok] ${account.name || account.id}: already ${targetPhase} (ai=${aiMessageCount}, corpus=${trainingConvoCount})`
      );
      continue;
    }

    const patch: Record<string, unknown> = { trainingPhase: targetPhase };
    if (targetPhase === 'ONBOARDING') {
      // Re-entering or entering onboarding: reset the session start, clear
      // the "completed" timestamp, and zero the counter so the new session
      // starts fresh.
      patch.trainingPhaseStartedAt = new Date();
      patch.trainingPhaseCompletedAt = null;
      patch.trainingOverrideCount = 0;
    }

    console.log(
      `  [${account.trainingPhase} → ${targetPhase}] ${account.name || account.id}: ai=${aiMessageCount}, corpus=${trainingConvoCount}`
    );
    if (!dryRun) {
      await prisma.account.update({
        where: { id: account.id },
        data: patch
      });
    }
    if (targetPhase === 'ACTIVE') toActive++;
    else toOnboarding++;
  }

  console.log(
    `\n[backfill-training-phase] Done: ${toActive} moved to ACTIVE, ${toOnboarding} moved to ONBOARDING, ${unchanged} unchanged.`
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[backfill-training-phase] Error:', err);
  process.exit(1);
});
