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
  const DAE_ACCOUNT_ID = 'cmnc6h63r0000l904c72g18aq'; // daetradez2003
  const creds = await retry(() =>
    prisma.integrationCredential.findMany({
      where: { accountId: DAE_ACCOUNT_ID },
      select: { provider: true, metadata: true }
    })
  );
  creds.forEach((c) => {
    const m = c.metadata as Record<string, unknown>;
    console.log(
      `provider=${c.provider} pageId=${m?.pageId ?? '-'} pageName=${m?.pageName ?? '-'} psid=${m?.psid ?? '-'}`
    );
  });
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
