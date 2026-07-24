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
  // Search all accounts for Avery Greene
  const lead = await retry(() =>
    p.lead.findFirst({
      where: { name: { contains: 'Avery', mode: 'insensitive' } },
      select: {
        id: true,
        name: true,
        handle: true,
        stage: true,
        accountId: true,
        conversation: {
          select: {
            id: true,
            capturedDataPoints: true,
            scheduledCallAt: true,
            messages: {
              orderBy: { timestamp: 'asc' },
              select: {
                id: true,
                sender: true,
                content: true,
                timestamp: true,
                stage: true,
                subStage: true
              }
            }
          }
        }
      }
    })
  );
  if (!lead) {
    console.log('Avery not found in any account');
    await p.$disconnect();
    return;
  }
  console.log(
    'Lead:',
    lead.name,
    lead.handle,
    '| stage:',
    lead.stage,
    '| accountId:',
    lead.accountId
  );
  console.log('Conv:', lead.conversation?.id);
  const cdp = lead.conversation?.capturedDataPoints as any;
  console.log(
    'CDP downsellInterestConfirmed:',
    cdp?.downsellInterestConfirmed?.value
  );
  console.log('CDP capitalThresholdMet:', cdp?.capitalThresholdMet?.value);
  console.log('scheduledCallAt:', lead.conversation?.scheduledCallAt);
  const msgs = lead.conversation?.messages ?? [];
  console.log('Total messages:', msgs.length);
  console.log('\n--- Messages ---');
  for (const m of msgs) {
    const ts = m.timestamp
      ? new Date(m.timestamp).toISOString().slice(11, 16)
      : '??:??';
    const preview = (m.content ?? '').slice(0, 100).replace(/\n/g, ' ');
    console.log(
      `${ts} [${m.sender}] stage=${m.stage ?? '-'} sub=${m.subStage ?? '-'} | ${preview}`
    );
  }
  await p.$disconnect();
}
main().catch(console.error);
