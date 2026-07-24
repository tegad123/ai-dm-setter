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
  // Check both scenario convs
  const convIds = ['cmrkjawuq0009l304u9sq6pqz', 'cmrkjzvah0041l004nj7tnt4f'];
  for (const id of convIds) {
    const c = await retry(() =>
      p.conversation.findUnique({
        where: { id },
        select: {
          id: true,
          capturedDataPoints: true,
          scheduledCallAt: true,
          createdAt: true,
          lead: { select: { name: true, stage: true } }
        }
      })
    );
    if (!c) {
      console.log(id, '— not found');
      continue;
    }
    const cdp = c.capturedDataPoints as any;
    console.log(
      'conv:',
      c.id,
      '| lead:',
      c.lead?.name,
      '| stage:',
      c.lead?.stage
    );
    console.log(
      '  capitalVerificationStatus:',
      cdp?.capitalVerificationStatus?.value
    );
    console.log('  capitalThresholdMet:', cdp?.capitalThresholdMet?.value);
    console.log('  capital:', cdp?.capital?.value);
    console.log('  scheduledCallAt:', c.scheduledCallAt);
    console.log('  createdAt:', c.createdAt);
    console.log('');
  }
  await p.$disconnect();
}
main().catch(console.error);
