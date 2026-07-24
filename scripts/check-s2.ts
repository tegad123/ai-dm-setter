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
  const leads = await retry(() =>
    p.lead.findMany({
      where: { name: { contains: 'Shazim', mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        name: true,
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
    if (!c) {
      console.log(l.name, l.accountId, '— no conv');
      continue;
    }
    console.log(l.name, l.accountId, c.id, 'createdAt:', c.createdAt);
    const cdp = c.capturedDataPoints as any;
    console.log('  CDP capitalThresholdMet:', cdp?.capitalThresholdMet?.value);
    console.log(
      '  CDP capitalVerificationStatus:',
      cdp?.capitalVerificationStatus?.value
    );
    console.log('  CDP capital:', cdp?.capital?.value);
    console.log('  scheduledCallAt:', c.scheduledCallAt);
  }
  await p.$disconnect();
}
main().catch(console.error);
