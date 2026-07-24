import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prodUrl = (process.env.PROD_DATABASE_URL ?? '')
  .replace(':6543/', ':5432/')
  .replace('?pgbouncer=true', '');

const p = new PrismaClient({
  datasources: { db: { url: prodUrl } },
  log: []
});

async function retry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
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

const LEAD_ID = 'cmr3m70oa00fkl404u5rfbu38';
const ACCOUNT_ID = 'cmpy59zy50000ju04u6fs5o2r';

async function main() {
  // 1. Account + persona
  console.log('=== ACCOUNT & PERSONA ===');
  const acct = await retry(() =>
    p.account.findFirst({
      where: { id: ACCOUNT_ID },
      select: {
        id: true,
        slug: true,
        personas: {
          select: {
            id: true,
            personaName: true,
            closerName: true,
            minimumCapitalRequired: true,
            downsellConfig: true,
            setupComplete: true
          }
        }
      }
    })
  );
  console.log(JSON.stringify(acct, null, 2));

  // 2. Find conversation by leadId
  console.log('\n=== FINDING CONVERSATION ===');
  const conv = await retry(() =>
    p.conversation.findFirst({
      where: { leadId: LEAD_ID },
      select: {
        id: true,
        systemStage: true,
        currentScriptStep: true,
        capitalVerificationStatus: true,
        capitalVerifiedAmount: true,
        capitalQAskedCount: true,
        scheduledCallAt: true,
        capturedDataPoints: true,
        createdAt: true
      }
    })
  );
  console.log(JSON.stringify(conv, null, 2));

  if (!conv) {
    console.log('NO CONVERSATION FOUND');
    await p.$disconnect();
    return;
  }

  // 3. Full conversation messages
  console.log('\n=== CONVERSATION MESSAGES ===');
  const msgs = await retry(() =>
    p.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { timestamp: 'asc' },
      select: { id: true, sender: true, content: true, timestamp: true }
    })
  );
  msgs.forEach((m) =>
    console.log(`[${m.timestamp.toISOString()}] ${m.sender}: ${m.content}`)
  );

  await p.$disconnect();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  p.$disconnect();
});
