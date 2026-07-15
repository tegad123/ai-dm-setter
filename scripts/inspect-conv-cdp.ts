// Read-only: dumps the current Shazim test conv's transcript + incomeGoal /
// tradingExperienceDuration CDP points + stepCompletionTrace so we can see
// exactly why the goal step did or did not auto-complete.
//
// Usage: npx tsx scripts/inspect-conv-cdp.ts [convId]

import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
const SENDER_ID = process.env.E2E_SENDER_ID || '27053194794302900';

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
  let convId = process.argv[2];
  if (!convId) {
    const lead = await retry(() =>
      prisma.lead.findFirst({
        where: { platformUserId: SENDER_ID },
        orderBy: { createdAt: 'desc' },
        select: { conversation: { select: { id: true } } }
      })
    );
    convId = lead?.conversation?.id ?? '';
  }
  if (!convId) throw new Error('no conv');

  const conv = await retry(() =>
    prisma.conversation.findUnique({
      where: { id: convId },
      select: {
        id: true,
        currentScriptStep: true,
        systemStage: true,
        capturedDataPoints: true,
        messages: {
          orderBy: { timestamp: 'asc' },
          select: { sender: true, content: true, timestamp: true }
        }
      }
    })
  );
  if (!conv) throw new Error('conv not found');

  console.log(
    'CONV',
    conv.id,
    '| step',
    conv.currentScriptStep,
    '|',
    conv.systemStage
  );
  console.log('\n--- TRANSCRIPT ---');
  conv.messages.forEach((m) => {
    const t = new Date(m.timestamp).toISOString().slice(11, 19);
    console.log(
      `[${t}] ${m.sender === 'LEAD' ? 'LEAD' : ' AI '}: ${(m.content ?? '').slice(0, 130)}`
    );
  });

  const cdp = (conv.capturedDataPoints ?? {}) as Record<string, unknown>;
  console.log('\n--- incomeGoal ---');
  console.log(JSON.stringify(cdp['incomeGoal'] ?? null));
  console.log('\n--- tradingExperienceDuration ---');
  console.log(JSON.stringify(cdp['tradingExperienceDuration'] ?? null));
  console.log('\n--- lastStepCompletionTrace ---');
  console.log(JSON.stringify(cdp['lastStepCompletionTrace'] ?? null, null, 2));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
