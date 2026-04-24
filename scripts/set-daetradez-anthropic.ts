/**
 * Flip daetradez onto Anthropic (Sonnet 4.6) for main generation. Other
 * accounts are untouched. Reads currently, sets, reads again so the log
 * shows the delta.
 *
 * Run: npx tsx scripts/set-daetradez-anthropic.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';

async function main() {
  const account = await prisma.account.findFirst({
    where: {
      OR: [
        { slug: { contains: 'daetradez', mode: 'insensitive' } },
        { name: { contains: 'daetradez', mode: 'insensitive' } },
        { name: { contains: 'dae', mode: 'insensitive' } }
      ]
    },
    select: { id: true, name: true, slug: true, aiProvider: true }
  });
  if (!account) {
    console.error('daetradez account not found — check slug/name');
    process.exit(1);
  }
  console.log(
    `Found: id=${account.id} name="${account.name}" slug="${account.slug}" aiProvider=${account.aiProvider}`
  );
  if (account.aiProvider === 'anthropic') {
    console.log('Already on anthropic — no change.');
  } else {
    await prisma.account.update({
      where: { id: account.id },
      data: { aiProvider: 'anthropic' }
    });
    console.log(`✓ Set aiProvider → anthropic for ${account.slug}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
