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
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}

async function main() {
  // Find daetradez2003 account
  const acc = await retry(() =>
    prisma.account.findFirst({
      where: { slug: 'daetradez2003' },
      select: {
        id: true,
        slug: true,
        responseDelayMin: true,
        responseDelayMax: true
      }
    })
  );
  if (!acc) throw new Error('daetradez2003 not found');
  console.log('BEFORE:', JSON.stringify(acc));

  await retry(() =>
    prisma.account.update({
      where: { id: acc.id },
      data: { responseDelayMin: 0, responseDelayMax: 0 }
    })
  );

  const after = await retry(() =>
    prisma.account.findUnique({
      where: { id: acc.id },
      select: { responseDelayMin: true, responseDelayMax: true }
    })
  );
  console.log('AFTER:', JSON.stringify(after));
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
