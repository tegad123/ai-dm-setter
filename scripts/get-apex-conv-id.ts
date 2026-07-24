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
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw last;
}

async function main() {
  const SENDER_ID = '27316153248002036';
  const convos = await retry(() =>
    prisma.conversation.findMany({
      where: { lead: { platformUserId: SENDER_ID } },
      orderBy: { updatedAt: 'desc' },
      take: 3,
      select: {
        id: true,
        systemStage: true,
        currentScriptStep: true,
        updatedAt: true,
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 5,
          select: { sender: true, content: true, timestamp: true }
        }
      }
    })
  );
  convos.forEach((c) => {
    console.log(
      '\n=== Conv:',
      c.id,
      '| stage:',
      c.systemStage,
      '| step:',
      c.currentScriptStep,
      '| updated:',
      c.updatedAt.toISOString()
    );
    c.messages.forEach((m) =>
      console.log(`  [${m.sender}] ${m.content.slice(0, 120)}`)
    );
  });
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
