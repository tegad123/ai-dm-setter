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
  const acc = await retry(() =>
    prisma.account.findFirst({
      where: { slug: 'daetradez2003' },
      select: { id: true, slug: true }
    })
  );
  if (!acc) throw new Error('Account daetradez2003 not found');
  console.log('account:', JSON.stringify(acc));

  const persona = await retry(() =>
    prisma.aIPersona.findFirst({
      where: { accountId: acc.id },
      select: {
        id: true,
        personaName: true,
        minimumCapitalRequired: true,
        downsellConfig: true
      }
    })
  );
  if (!persona) throw new Error('Persona not found for daetradez2003');
  console.log(
    'BEFORE:',
    JSON.stringify(
      {
        minimumCapitalRequired: persona.minimumCapitalRequired,
        downsellConfig: persona.downsellConfig
      },
      null,
      2
    )
  );

  const updated = await retry(() =>
    prisma.aIPersona.update({
      where: { id: persona.id },
      data: { minimumCapitalRequired: 1000 },
      select: {
        id: true,
        personaName: true,
        minimumCapitalRequired: true,
        downsellConfig: true
      }
    })
  );
  console.log(
    'AFTER:',
    JSON.stringify(
      {
        minimumCapitalRequired: updated.minimumCapitalRequired,
        downsellConfig: updated.downsellConfig
      },
      null,
      2
    )
  );
  console.log(
    '\n✅ Done. minimumCapitalRequired set to 1000 on persona:',
    updated.personaName,
    '(id:',
    updated.id + ')'
  );

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
