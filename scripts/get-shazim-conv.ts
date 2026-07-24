import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const SENDER_ID = '27053194794302900';

const p = new PrismaClient({
  datasources: {
    db: {
      url: (process.env.PROD_DATABASE_URL ?? '')
        .replace(':6543/', ':5432/')
        .replace('?pgbouncer=true', '')
    }
  }
});

async function retry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
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
  const lead = await retry(() =>
    p.lead.findFirst({
      where: { platformUserId: SENDER_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true, stage: true }
    })
  );
  if (!lead) {
    console.log('NO LEAD FOUND');
    await p.$disconnect();
    return;
  }
  console.log('leadId:', lead.id, '| stage:', lead.stage);

  const conv = await retry(() =>
    p.conversation.findFirst({
      where: { leadId: lead.id },
      select: {
        id: true,
        capitalVerificationStatus: true,
        capitalVerifiedAmount: true,
        stageMismatchCount: true,
        systemStage: true,
        currentScriptStep: true,
        scheduledCallAt: true,
        capturedDataPoints: true
      }
    })
  );
  if (!conv) {
    console.log('NO CONV FOUND');
    await p.$disconnect();
    return;
  }
  console.log('convId:', conv.id);
  console.log('capitalVerificationStatus:', conv.capitalVerificationStatus);
  console.log('capitalVerifiedAmount:', conv.capitalVerifiedAmount);
  console.log('stageMismatchCount:', conv.stageMismatchCount);
  console.log(
    'systemStage:',
    conv.systemStage,
    '| step:',
    conv.currentScriptStep
  );
  console.log('scheduledCallAt:', conv.scheduledCallAt);
  const cdp = conv.capturedDataPoints as any;
  console.log(
    'cdp.capitalThresholdMet:',
    cdp?.capitalThresholdMet?.value ?? '-'
  );
  console.log('cdp.verifiedCapitalUsd:', cdp?.verifiedCapitalUsd?.value ?? '-');

  await p.$disconnect();
}
main().catch((e) => {
  console.error('FATAL:', e.message);
  p.$disconnect();
});
