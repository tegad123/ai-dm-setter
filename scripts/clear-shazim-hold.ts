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
  await p.$executeRaw`UPDATE "Conversation" SET "awaitingHumanReview"=false, "distressDetected"=false, "distressDetectedAt"=NULL WHERE id='cmruac0ud007slc04lmbpkl98'`;
  const c = await retry(() =>
    p.conversation.findUnique({
      where: { id: 'cmruac0ud007slc04lmbpkl98' },
      select: { awaitingHumanReview: true }
    })
  );
  console.log('cleared. awaitingHumanReview=', c?.awaitingHumanReview);
  await p.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await p.$disconnect();
  process.exit(1);
});
