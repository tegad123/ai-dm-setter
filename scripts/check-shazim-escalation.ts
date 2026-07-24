import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const p = new PrismaClient({
  datasources: {
    db: {
      url: (process.env.PROD_DATABASE_URL ?? '')
        .replace(':6543/', ':5432/')
        .replace('?pgbouncer=true', '')
    }
  }
});
async function retry<T>(fn: () => Promise<T>, t = 12): Promise<T> {
  let l: unknown;
  for (let i = 0; i < t; i++) {
    try {
      return await fn();
    } catch (e) {
      l = e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw l;
}
async function main() {
  const conv = 'cmruac0ud007slc04lmbpkl98';
  const c = await retry(() =>
    p.conversation.findUnique({
      where: { id: conv },
      select: {
        awaitingHumanReview: true,
        distressDetected: true,
        distressDetectedAt: true,
        systemStage: true,
        currentScriptStep: true
      }
    })
  );
  console.log(
    'distressDetected:',
    c?.distressDetected,
    '| distressDetectedAt:',
    c?.distressDetectedAt
  );
  console.log(
    'awaitingHumanReview:',
    c?.awaitingHumanReview,
    '| stage:',
    c?.systemStage,
    'step:',
    c?.currentScriptStep
  );
  const msgs = await retry(() =>
    p.message.findMany({
      where: { conversationId: conv },
      orderBy: { timestamp: 'asc' },
      select: { sender: true, content: true, timestamp: true }
    })
  );
  console.log('\n=== full transcript ===');
  msgs.forEach((m) =>
    console.log(
      `[${m.timestamp.toISOString().slice(11, 19)}] ${m.sender}: ${m.content.slice(0, 90)}`
    )
  );
  await p.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await p.$disconnect();
  process.exit(1);
});
