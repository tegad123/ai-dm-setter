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
  console.log('account:', JSON.stringify(acc));

  const persona = await retry(() =>
    prisma.aIPersona.findFirst({
      where: { accountId: acc!.id },
      select: {
        id: true,
        personaName: true,
        closerName: true,
        minimumCapitalRequired: true,
        downsellConfig: true
      }
    })
  );
  console.log('persona:', JSON.stringify(persona, null, 2));

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
