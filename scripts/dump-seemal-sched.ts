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
  const srs = await retry(() =>
    p.scheduledReply.findMany({
      where: { conversationId: conv },
      orderBy: { createdAt: 'asc' }
    })
  );
  console.log('=== scheduledReply rows (all fields) ===');
  for (const s of srs) {
    const gr = (s as any).generatedResult;
    console.log(
      `\n[${s.createdAt.toISOString().slice(11, 19)}] status=${s.status} scheduledFor=${s.scheduledFor?.toISOString().slice(11, 19)} attempts=${s.attempts} type=${(s as any).messageType}`
    );
    if (gr?.messages)
      console.log(
        `   gen.messages=${JSON.stringify(gr.messages).slice(0, 260)}`
      );
    if (gr?.reply)
      console.log(`   gen.reply=${JSON.stringify(gr.reply).slice(0, 200)}`);
  }
  await p.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await p.$disconnect();
  process.exit(1);
});
