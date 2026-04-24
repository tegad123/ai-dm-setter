/**
 * Flip daetradez back to OpenAI (gpt-5.4-mini) for main generation. The
 * new OPENAI_DEFAULT_MODEL in ai-engine.ts routes them to gpt-5.4-mini
 * automatically once aiProvider='openai'.
 *
 * Run: npx tsx scripts/set-daetradez-openai.ts
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
    select: { id: true, name: true, slug: true, aiProvider: true }
  });
  if (!account) {
    console.error('daetradez account not found');
    process.exit(1);
  }
  console.log(
    `Found: id=${account.id} slug="${account.slug}" aiProvider=${account.aiProvider}`
  );
  if (account.aiProvider === 'openai') {
    console.log('Already on openai — no change.');
  } else {
    await prisma.account.update({
      where: { id: account.id },
      data: { aiProvider: 'openai' }
    });
    console.log(`✓ Set aiProvider → openai for ${account.slug}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
