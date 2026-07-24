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
  // Persona ID from check: cmpy59zz30002ju04v1bjdwzw (danielelumelu2003 / Dae)
  const PERSONA_ID = 'cmpy59zz30002ju04v1bjdwzw';
  const before = await retry(() =>
    prisma.aIPersona.findUnique({
      where: { id: PERSONA_ID },
      select: { personaName: true, minimumCapitalRequired: true }
    })
  );
  console.log('BEFORE:', JSON.stringify(before));
  await retry(() =>
    prisma.aIPersona.update({
      where: { id: PERSONA_ID },
      data: { minimumCapitalRequired: 1000 }
    })
  );
  const after = await retry(() =>
    prisma.aIPersona.findUnique({
      where: { id: PERSONA_ID },
      select: { personaName: true, minimumCapitalRequired: true }
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
