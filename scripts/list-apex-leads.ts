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
  const ACCOUNT_ID = 'cmod688i00000oa84aolhuk0j'; // Apex / Tega workspace
  const leads = await retry(() =>
    prisma.lead.findMany({
      where: { accountId: ACCOUNT_ID },
      select: {
        id: true,
        name: true,
        platformUserId: true,
        stage: true,
        createdAt: true,
        conversation: {
          select: { id: true, systemStage: true, updatedAt: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    })
  );

  console.log(`Total leads found: ${leads.length}\n`);
  leads.forEach((l, i) => {
    console.log(
      `[${String(i + 1).padStart(2)}] name="${l.name}" | stage=${l.stage} | created=${l.createdAt.toISOString().slice(0, 10)} | leadId=${l.id} | convId=${l.conversation?.id ?? '-'} | convStage=${l.conversation?.systemStage ?? '-'}`
    );
  });

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
