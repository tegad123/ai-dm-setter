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
  const convs = [
    { id: 'cmoxa4c4p003kl504zpt511m1', name: 'Goodluck C Ezekiel' },
    { id: 'cmp32eku9003pl704resbz1sq', name: 'noahbrave21' },
    { id: 'cmox485zr002vik04kwsf22ih', name: 'musoni_06' }
  ];
  for (const c of convs) {
    const conv = await retry(() =>
      p.conversation.findUnique({
        where: { id: c.id },
        select: {
          id: true,
          stageMismatchCount: true,
          systemStage: true,
          currentScriptStep: true,
          capitalVerificationStatus: true,
          capitalVerifiedAmount: true,
          capturedDataPoints: true,
          _count: { select: { messages: true } }
        }
      })
    );
    if (!conv) {
      console.log(c.name, '- NOT FOUND');
      continue;
    }
    const cdp = conv.capturedDataPoints as any;
    console.log(`\n=== ${c.name} ===`);
    console.log(`  convId: ${conv.id}`);
    console.log(`  stageMismatchCount: ${conv.stageMismatchCount}`);
    console.log(
      `  systemStage: ${conv.systemStage} | step: ${conv.currentScriptStep}`
    );
    console.log(
      `  capitalVerificationStatus: ${conv.capitalVerificationStatus}`
    );
    console.log(`  capitalVerifiedAmount: ${conv.capitalVerifiedAmount}`);
    console.log(`  messageCount: ${conv._count.messages}`);
    console.log(
      `  cdp.capitalThresholdMet: ${cdp?.capitalThresholdMet?.value ?? '-'}`
    );
  }
  await p.$disconnect();
}
main().catch((e) => {
  console.error('FATAL:', e.message);
  p.$disconnect();
});
