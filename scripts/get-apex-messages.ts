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
  const CONV_ID = process.argv[2] || 'cmr3avz2x002ilb04dbfih5j5';
  const conv = await retry(() =>
    prisma.conversation.findUnique({
      where: { id: CONV_ID },
      select: {
        id: true,
        systemStage: true,
        currentScriptStep: true,
        updatedAt: true,
        messages: {
          orderBy: { timestamp: 'asc' },
          select: { sender: true, content: true, timestamp: true }
        }
      }
    })
  );
  if (!conv) {
    console.log('Conv not found:', CONV_ID);
    return;
  }
  console.log(
    'Conv:',
    conv.id,
    '| stage:',
    conv.systemStage,
    '| step:',
    conv.currentScriptStep,
    '| updated:',
    conv.updatedAt.toISOString()
  );
  conv.messages.forEach((m, i) => {
    console.log(
      `[${String(i + 1).padStart(2)}] [${m.sender}] ${m.content.slice(0, 200)}`
    );
  });
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
