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
  const acc = await retry(() =>
    prisma.account.findFirst({
      where: { slug: 'daetradez2003' },
      select: { id: true, slug: true }
    })
  );
  console.log('account:', JSON.stringify(acc));

  const cred = await retry(() =>
    prisma.integrationCredential.findFirst({
      where: {
        accountId: acc!.id,
        provider: { in: ['FACEBOOK', 'INSTAGRAM'] as any }
      },
      select: { provider: true, metadata: true }
    })
  );
  console.log('meta cred:', JSON.stringify(cred));

  const persona = await retry(() =>
    prisma.aIPersona.findFirst({
      where: { accountId: acc!.id },
      select: { id: true, personaName: true }
    })
  );
  console.log('persona:', JSON.stringify(persona));

  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const convos = await retry(() =>
    prisma.conversation.findMany({
      where: { lead: { accountId: acc!.id }, updatedAt: { gte: cutoff } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        systemStage: true,
        currentScriptStep: true,
        updatedAt: true,
        capturedDataPoints: true,
        scheduledCallAt: true,
        awaitingHumanReview: true,
        aiActive: true,
        lead: { select: { platformUserId: true, name: true } }
      }
    })
  );
  console.log('recent convos (72h):', convos.length);
  convos.forEach((c) => {
    const cdp = c.capturedDataPoints as any;
    console.log(
      JSON.stringify({
        id: c.id,
        step: c.currentScriptStep,
        stage: c.systemStage,
        capital: cdp?.verifiedCapitalUsd?.value ?? '-',
        thresholdMet: cdp?.capitalThresholdMet?.value ?? '-',
        booked: c.scheduledCallAt ? 'YES' : '-',
        humanReview: c.awaitingHumanReview,
        aiActive: c.aiActive,
        leadPsid: c.lead?.platformUserId,
        leadName: c.lead?.name,
        updatedAt: c.updatedAt
      })
    );
  });

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
