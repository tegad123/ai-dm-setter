/**
 * Backfill stage timestamp fields for conversations whose systemStage has
 * advanced past OPENING but no stage timestamps were ever recorded.
 *
 * The UI's "Stage Progression" sidebar reads dedicated timestamp fields
 * (stageOpeningAt, stageSituationDiscoveryAt, etc.) — when those are null
 * the sidebar shows zero checkmarks even though the AI is correctly past
 * those stages. Going forward, the patched recordStageTimestamp backfills
 * earlier stages on each call. This script fixes the existing rows.
 *
 * Usage:
 *   DRY_RUN=true  pnpm exec tsx scripts/backfill-stage-timestamps.ts
 *   DRY_RUN=false pnpm exec tsx scripts/backfill-stage-timestamps.ts
 */

import prisma from '@/lib/prisma';
import { recordStageTimestamp } from '@/lib/conversation-state-machine';

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  console.log(`\n=== Backfill stage timestamps (DRY_RUN=${DRY_RUN}) ===\n`);

  const candidates = await prisma.conversation.findMany({
    where: {
      systemStage: { not: null },
      stageOpeningAt: null
    },
    select: {
      id: true,
      systemStage: true,
      lead: { select: { handle: true } }
    }
  });

  console.log(`Found ${candidates.length} candidates.\n`);
  if (candidates.length === 0) {
    await prisma.$disconnect();
    return;
  }

  let backfilled = 0;
  for (const c of candidates) {
    const stage = c.systemStage!;
    if (DRY_RUN) {
      console.log(`  WOULD backfill @${c.lead.handle}: stage=${stage}`);
      backfilled++;
      continue;
    }
    try {
      await recordStageTimestamp(c.id, stage);
      backfilled++;
    } catch (err) {
      console.error(`  ERROR @${c.lead.handle}:`, (err as Error).message);
    }
  }

  console.log(`\nBackfilled: ${backfilled}/${candidates.length}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
