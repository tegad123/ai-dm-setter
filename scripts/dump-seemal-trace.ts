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
  const conv = 'cmrp4fxl1005qle047vnnmcp6';
  const traces = await retry(() =>
    p.generationTurnTrace.findMany({
      where: { conversationId: conv },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        createdAt: true,
        replyPreview: true,
        qualityHardFails: true,
        stageEmitted: true,
        stepNumber: true,
        branchSelected: true
      }
    })
  );
  for (const t of traces) {
    console.log(
      `\n[${t.createdAt.toISOString()}] step=${t.stepNumber} stage=${t.stageEmitted} branch="${t.branchSelected}"`
    );
    console.log(`  reply: ${t.replyPreview}`);
    console.log(`  hardFails: ${JSON.stringify(t.qualityHardFails)}`);
  }
  console.log('\n=== actual shipped AI messages (last 6) ===');
  const msgs = await retry(() =>
    p.message.findMany({
      where: { conversationId: conv, sender: 'AI' },
      orderBy: { timestamp: 'desc' },
      take: 6,
      select: { timestamp: true, content: true }
    })
  );
  msgs
    .reverse()
    .forEach((m) =>
      console.log(`  [${m.timestamp.toISOString()}] ${m.content}`)
    );
  await p.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await p.$disconnect();
  process.exit(1);
});
