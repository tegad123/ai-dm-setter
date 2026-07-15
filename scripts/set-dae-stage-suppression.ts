// Sets disableLeadStageProgression: true on the DAETRADEZ persona's promptConfig.
// This suppresses Lead.stage writes, LeadStageTransition rows, stage timestamp
// backfills, and post-reply scoring for all low-ticket convs on this persona.
//
// Usage: npx tsx scripts/set-dae-stage-suppression.ts
//        npx tsx scripts/set-dae-stage-suppression.ts --verify   # read-only check
//        npx tsx scripts/set-dae-stage-suppression.ts --unset    # remove the flag

import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});

async function retry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
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
  const mode = process.argv[2];

  const acc = await retry(() =>
    prisma.account.findFirst({
      where: { slug: 'daetradez2003' },
      select: { id: true, slug: true }
    })
  );
  if (!acc) throw new Error('daetradez2003 account not found');
  console.log('account:', acc.id, acc.slug);

  const persona = await retry(() =>
    prisma.aIPersona.findFirst({
      where: { accountId: acc.id },
      select: { id: true, personaName: true, promptConfig: true }
    })
  );
  if (!persona) throw new Error('no persona found for daetradez2003');
  console.log('persona:', persona.id, persona.personaName);

  const currentConfig = (
    persona.promptConfig &&
    typeof persona.promptConfig === 'object' &&
    !Array.isArray(persona.promptConfig)
      ? persona.promptConfig
      : {}
  ) as Record<string, unknown>;

  console.log(
    'current disableLeadStageProgression:',
    currentConfig.disableLeadStageProgression ?? '(not set)'
  );

  if (mode === '--verify') {
    console.log('\nFull promptConfig keys:', Object.keys(currentConfig));
    await prisma.$disconnect();
    return;
  }

  const newConfig: Record<string, unknown> = { ...currentConfig };
  if (mode === '--unset') {
    delete newConfig['disableLeadStageProgression'];
  } else {
    newConfig['disableLeadStageProgression'] = true;
  }

  await prisma.$executeRaw`
    UPDATE "AIPersona"
    SET "promptConfig" = ${JSON.stringify(newConfig)}::jsonb
    WHERE id = ${persona.id}
  `;

  const updated = await retry(() =>
    prisma.aIPersona.findUnique({
      where: { id: persona.id },
      select: { promptConfig: true }
    })
  );
  const updatedConfig = (updated?.promptConfig ?? {}) as Record<
    string,
    unknown
  >;
  console.log(
    '\nafter update — disableLeadStageProgression:',
    updatedConfig.disableLeadStageProgression ?? '(not set)'
  );
  console.log(
    mode === '--unset'
      ? 'FLAG REMOVED'
      : 'FLAG SET — stage writes suppressed for daetradez low-ticket convs'
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
