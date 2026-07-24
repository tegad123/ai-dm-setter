// Resets only the R24/capital gate state on the current test conversation
// so we can re-test different capital answers without re-driving the full funnel.
//
// Usage: npx tsx scripts/reset-dae-r24.ts

import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
const SENDER_ID = process.env.E2E_SENDER_ID || '27053194794302900';

async function retry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}

async function main() {
  const lead = await retry(() =>
    prisma.lead.findFirst({
      where: { platformUserId: SENDER_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    })
  );
  if (!lead) throw new Error('no test lead found');

  const conv = await retry(() =>
    prisma.conversation.findFirst({
      where: { leadId: lead.id },
      select: {
        id: true,
        capitalVerificationStatus: true,
        capturedDataPoints: true
      }
    })
  );
  if (!conv) throw new Error('no conversation found');

  console.log(
    'BEFORE capitalStatus=',
    conv.capitalVerificationStatus,
    'convId=',
    conv.id
  );

  // Strip capitalThresholdMet + verifiedCapitalUsd from CDP
  const cdp = (conv.capturedDataPoints ?? {}) as Record<string, unknown>;
  delete cdp['capitalThresholdMet'];
  delete cdp['verifiedCapitalUsd'];
  delete cdp['capital'];

  // Use $executeRaw to bypass Prisma enum type restriction on null
  await prisma.$executeRaw`
    UPDATE "Conversation"
    SET "capitalVerificationStatus" = NULL,
        "capitalVerifiedAt" = NULL,
        "capitalVerifiedAmount" = NULL,
        "capturedDataPoints" = ${JSON.stringify(cdp)}::jsonb
    WHERE id = ${conv.id}
  `;

  const after = await retry(() =>
    prisma.conversation.findUnique({
      where: { id: conv.id },
      select: { capitalVerificationStatus: true }
    })
  );
  console.log('AFTER capitalStatus=', after?.capitalVerificationStatus);
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
