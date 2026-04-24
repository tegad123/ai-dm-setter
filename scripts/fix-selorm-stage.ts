/**
 * Flip Selorm Benjamin Workey lead.stage from QUALIFIED → UNQUALIFIED.
 *
 * Lead explicitly stated they'd lost capital and needed time to raise
 * funds ("Honestly, I've lost so much in this few days and I will need
 * sometime to raise that fund bro") but was promoted to QUALIFIED via
 * the SOFT_PITCH_COMMITMENT → QUALIFIED default mapping before capital
 * verification ran. Uses transitionLeadStage() so the audit trail
 * records the correction (reason + transitionedBy).
 *
 * Run: npx tsx scripts/fix-selorm-stage.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import { transitionLeadStage } from '../src/lib/lead-stage';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: {
      name: { contains: 'Selorm', mode: 'insensitive' }
    },
    select: { id: true, name: true, stage: true, accountId: true }
  });
  if (!lead) {
    console.error('Selorm lead not found');
    process.exit(1);
  }
  console.log(`Found: ${lead.name} (${lead.id}) — current stage=${lead.stage}`);
  if (lead.stage === 'UNQUALIFIED') {
    console.log('Already UNQUALIFIED — no change.');
  } else {
    const updated = await transitionLeadStage(
      lead.id,
      'UNQUALIFIED',
      'system',
      'capital_below_threshold — lead stated "I will need sometime to raise that fund" + "I\'ve lost so much in this few days" (manual correction after parser gap)'
    );
    console.log(`✓ stage now ${updated.stage}`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
