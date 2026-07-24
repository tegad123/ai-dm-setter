// Drives the daetradez prod conversation to the point where the capital
// question has been asked, then stops. Run this, then use prod-dm.ts to
// send the capital answer for each test case.
//
// Usage: npx tsx scripts/drive-dae-to-cap-q.ts

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
async function retry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
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

const SECRET = process.env.META_APP_SECRET!;
const WEBHOOK = 'https://qualifydms.io/api/webhooks/facebook';
const ENTRY_ID = '708196295710896';
const SENDER_ID = process.env.E2E_SENDER_ID || '27053194794302900';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(text: string): Promise<number> {
  const ts = Date.now();
  const payload = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: ENTRY_ID,
        time: ts,
        messaging: [
          {
            sender: { id: SENDER_ID },
            recipient: { id: ENTRY_ID },
            timestamp: ts,
            message: {
              mid: `pd_${ts}_${Math.random().toString(36).slice(2)}`,
              text
            }
          }
        ]
      }
    ]
  });
  const sig =
    'sha256=' +
    crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body: payload
  });
  return res.status;
}

async function getAiMsgCount(): Promise<number> {
  const lead = await retry(() =>
    prisma.lead.findFirst({
      where: { platformUserId: SENDER_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    })
  );
  if (!lead) return 0;
  const conv = await retry(() =>
    prisma.conversation.findFirst({
      where: { leadId: lead.id },
      select: { id: true }
    })
  );
  if (!conv) return 0;
  const msgs = await retry(() =>
    prisma.message.count({ where: { conversationId: conv.id, sender: 'AI' } })
  );
  return msgs;
}

async function waitForAiReply(before: number, label: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const now = await getAiMsgCount();
    if (now > before) {
      process.stdout.write(` ✓ AI replied (${now} total)\n`);
      return;
    }
  }
  console.log(`  ⚠ no reply after 90s for "${label}"`);
}

async function sendAndWait(text: string): Promise<void> {
  const before = await getAiMsgCount();
  await send(text);
  process.stdout.write(`  > "${text}" ...`);
  await waitForAiReply(before, text);
}

const FUNNEL: string[] = [
  'hey man, want to learn trading',
  "I'm in Canada",
  'been trading about 3 months',
  'want to make consistent income, for my family',
  'losing money, no system',
  'its urgent, need to fix this',
  'I work full time',
  'I make 4k a month',
  'want to make 3k a month from trading',
  'for my kids, time freedom',
  'consistency is the problem',
  'yeah I want guidance on a real system',
  'yeah that makes sense, entries trip me up'
];

async function main() {
  if (!SECRET) throw new Error('META_APP_SECRET not set');
  console.log('Driving to capital Q...');
  for (const msg of FUNNEL) {
    await sendAndWait(msg);
  }
  // One more push to trigger the call proposal + capital Q
  await sendAndWait('yeah lets book something');
  console.log(
    '\nDone. Capital Q should now be in conversation. Use prod-dm.ts to answer.'
  );
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
