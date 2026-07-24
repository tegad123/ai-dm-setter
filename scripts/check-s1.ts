import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const p = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL ?? '' } }
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
  // Check all recent Shazim convs on Daniel's workspace for Scenario 1 evidence
  const leads = await retry(() =>
    p.lead.findMany({
      where: { name: { contains: 'Shazim', mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        name: true,
        stage: true,
        accountId: true,
        conversation: {
          select: {
            id: true,
            capturedDataPoints: true,
            scheduledCallAt: true,
            createdAt: true
          }
        }
      }
    })
  );
  for (const l of leads) {
    const c = l.conversation;
    if (!c) continue;
    const cdp = c.capturedDataPoints as any;
    const cvs = cdp?.capitalVerificationStatus?.value;
    const ctm = cdp?.capitalThresholdMet?.value;
    const cap = cdp?.capital?.value;
    console.log(`${l.name} | ${l.accountId} | ${c.id} | lead.stage=${l.stage}`);
    console.log(
      `  capitalVerificationStatus=${cvs} capitalThresholdMet=${ctm} capital=${cap} scheduledCallAt=${c.scheduledCallAt}`
    );
    console.log(`  createdAt=${c.createdAt}`);
  }
  await p.$disconnect();
}
main().catch(console.error);
