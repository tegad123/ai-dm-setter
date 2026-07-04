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
  const DAE_ACCOUNT_ID = 'cmnc6h63r0000l904c72g18aq';
  // Look at ManyChat cred metadata for IG account IDs
  const creds = await retry(() =>
    prisma.integrationCredential.findMany({
      where: { accountId: DAE_ACCOUNT_ID },
      select: { provider: true, metadata: true }
    })
  );
  creds.forEach((c) => {
    const m = c.metadata as Record<string, unknown>;
    // Print all keys but not values that look like tokens
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
  // Also check webhookSubscription table if it exists
  const persona = await retry(() =>
    prisma.aIPersona.findFirst({
      where: { accountId: DAE_ACCOUNT_ID },
      select: { id: true, personaName: true, minimumCapitalRequired: true }
    })
  );
  console.log('Persona:', JSON.stringify(persona));
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
