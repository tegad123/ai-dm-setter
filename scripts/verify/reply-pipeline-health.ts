// Outbound reply pipeline health. Run FIRST when "no reply came".
//   NODE_PATH=$PWD/node_modules npx tsx scripts/verify/reply-pipeline-health.ts
// Healthy: PROCESSING ~0, overdue ~0, last SENT recent, last AI message recent.
// The Sept 5-6 2026 outage looked like: PROCESSING 244, last SENT 35h old.
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
async function retry<T>(fn: () => Promise<T>, t = 12): Promise<T> {
  let l: unknown;
  for (let i = 0; i < t; i++) {
    try {
      return await fn();
    } catch (e) {
      l = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw l;
}
(async () => {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600e3);
  console.log('=== reply pipeline @', now.toISOString(), '===');
  console.log(
    'PROCESSING rows:',
    await retry(() =>
      prisma.scheduledReply.count({ where: { status: 'PROCESSING' } })
    )
  );
  console.log(
    'PENDING overdue (inside 24h window):',
    await retry(() =>
      prisma.scheduledReply.count({
        where: { status: 'PENDING', scheduledFor: { lte: now, gte: dayAgo } }
      })
    )
  );
  const lastSent = await retry(() =>
    prisma.scheduledReply.findFirst({
      where: { status: 'SENT' },
      orderBy: { processedAt: 'desc' },
      select: { processedAt: true }
    })
  );
  console.log('last SENT:', lastSent?.processedAt?.toISOString());
  const lastAI = await retry(() =>
    prisma.message.findFirst({
      where: { sender: 'AI' },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true, content: true, platformMessageId: true }
    })
  );
  console.log(
    'last AI message:',
    lastAI?.timestamp?.toISOString(),
    JSON.stringify(lastAI?.content?.slice(0, 70)),
    lastAI?.platformMessageId ? '[delivered]' : '[no platformMessageId]'
  );
  console.log(
    'conversations awaitingAiResponse > 10 min:',
    await retry(() =>
      prisma.conversation.count({
        where: {
          awaitingAiResponse: true,
          awaitingSince: { lt: new Date(now.getTime() - 10 * 60e3) }
        }
      })
    )
  );
  const recent = await retry(() =>
    prisma.scheduledReply.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - 2 * 3600e3) } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: {
        status: true,
        attempts: true,
        scheduledFor: true,
        processedAt: true,
        terminalReasonCode: true,
        lastError: true
      }
    })
  );
  console.log('\nScheduledReply rows created in the last 2h:');
  recent.forEach((r) =>
    console.log(
      ' ',
      r.status.padEnd(9),
      'att',
      r.attempts,
      'for',
      r.scheduledFor.toISOString().slice(11, 19),
      'proc',
      r.processedAt?.toISOString().slice(11, 19) ?? '-',
      'reason',
      r.terminalReasonCode ?? '-',
      r.lastError ? '| ' + r.lastError.slice(0, 80) : ''
    )
  );
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
