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
  // Find Apex account via page ID on the integration credential
  const cred = await retry(() =>
    prisma.integrationCredential.findFirst({
      where: { metadata: { path: ['pageId'], equals: '1006770499175916' } },
      select: { accountId: true }
    })
  );
  const acc = cred
    ? await retry(() =>
        prisma.account.findUnique({
          where: { id: cred.accountId },
          select: { id: true, slug: true, name: true }
        })
      )
    : null;
  console.log('Apex account:', JSON.stringify(acc));
  if (!acc) return;

  // Search for Ali Raza and Ali Hassan
  const leads = await retry(() =>
    prisma.lead.findMany({
      where: {
        accountId: acc.id,
        name: {
          in: ['Ali Raza', 'Ali Hassan', 'Alee Hassan'],
          mode: 'insensitive'
        }
      },
      select: {
        id: true,
        name: true,
        platformUserId: true,
        stage: true,
        createdAt: true,
        conversation: {
          select: { id: true, systemStage: true, updatedAt: true }
        }
      }
    })
  );

  // Also try partial name search
  const leadsPartial = await retry(() =>
    prisma.lead.findMany({
      where: {
        accountId: acc.id,
        name: { contains: 'ali', mode: 'insensitive' }
      },
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
      take: 20
    })
  );

  console.log('\n--- Exact matches ---');
  leads.forEach((l) =>
    console.log(
      JSON.stringify({
        id: l.id,
        name: l.name,
        psid: l.platformUserId,
        stage: l.stage,
        convId: l.conversation?.id,
        convStage: l.conversation?.systemStage,
        created: l.createdAt
      })
    )
  );

  console.log('\n--- Partial "ali" matches (recent 20) ---');
  leadsPartial.forEach((l) =>
    console.log(
      JSON.stringify({
        id: l.id,
        name: l.name,
        psid: l.platformUserId,
        stage: l.stage,
        convId: l.conversation?.id,
        convStage: l.conversation?.systemStage,
        created: l.createdAt
      })
    )
  );

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
