/**
 * Enable multi-bubble on daetradez's active persona. The persona's
 * `promptConfig.multiBubbleEnabled` flag gates the schema extension
 * that instructs the LLM to emit messages[] instead of a single
 * formatted string — without it, long replies come back as numbered
 * lists with markdown in ONE bubble.
 *
 * Run: npx tsx scripts/enable-multibubble-daetradez.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';

async function main() {
  const account = await prisma.account.findFirst({
    where: {
      OR: [
        { slug: { contains: 'daetradez', mode: 'insensitive' } },
        { name: { contains: 'daetradez', mode: 'insensitive' } }
      ]
    },
    select: { id: true, slug: true }
  });
  if (!account) {
    console.error('daetradez account not found');
    process.exit(1);
  }
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId: account.id, isActive: true },
    orderBy: { updatedAt: 'desc' }
  });
  if (!persona) {
    console.error(`No active persona for ${account.slug}`);
    process.exit(2);
  }
  const prev = (persona.promptConfig as Record<string, unknown> | null) ?? {};
  const next = { ...prev, multiBubbleEnabled: true };
  const wasEnabled = prev.multiBubbleEnabled === true;

  console.log(
    `persona=${persona.personaName} (${persona.id}) multiBubbleEnabled: was=${prev.multiBubbleEnabled ?? '—'} → ${next.multiBubbleEnabled}`
  );
  if (wasEnabled) {
    console.log('Already enabled — no change.');
  } else {
    await prisma.aIPersona.update({
      where: { id: persona.id },
      data: { promptConfig: next }
    });
    console.log('✓ multiBubbleEnabled = true written.');
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(3);
});
