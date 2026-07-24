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
  const DANIEL_ACC_ID = 'cmpy59zy50000ju04u6fs5o2r'; // danielelumelu2003

  const personas = await retry(() =>
    prisma.aIPersona.findMany({
      where: { accountId: DANIEL_ACC_ID },
      select: {
        id: true,
        personaName: true,
        minimumCapitalRequired: true,
        downsellConfig: true
      }
    })
  );
  console.log('Personas:', JSON.stringify(personas));

  const creds = await retry(() =>
    prisma.integrationCredential.findMany({
      where: { accountId: DANIEL_ACC_ID },
      select: { provider: true, metadata: true }
    })
  );
  creds.forEach((c) => {
    const m = c.metadata as Record<string, unknown>;
    const safeKeys = Object.keys(m ?? {}).filter(
      (k) =>
        !k.toLowerCase().includes('token') &&
        !k.toLowerCase().includes('secret') &&
        !k.toLowerCase().includes('key')
    );
    const safe: Record<string, unknown> = {};
    safeKeys.forEach((k) => {
      safe[k] = m[k];
    });
    console.log(`provider=${c.provider}`, JSON.stringify(safe));
  });
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
