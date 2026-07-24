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
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}
async function main() {
  const DAE_ACCOUNT_ID = 'cmnc6h63r0000l904c72g18aq';
  // Find a recent conversation to get the IG recipient ID (page/account IG ID)
  const conv = await retry(() =>
    prisma.conversation.findFirst({
      where: { lead: { accountId: DAE_ACCOUNT_ID, platform: 'INSTAGRAM' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        lead: { select: { platformUserId: true, name: true } },
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 1,
          select: { platformMessageId: true }
        }
      }
    })
  );
  console.log(
    'Recent IG conv:',
    JSON.stringify({
      convId: conv?.id,
      leadName: conv?.lead?.name,
      leadIgsid: conv?.lead?.platformUserId,
      lastMsgId: conv?.messages?.[0]?.platformMessageId
    })
  );

  // Check any INSTAGRAM cred on daetradez
  const igCreds = await retry(() =>
    prisma.integrationCredential.findMany({
      where: { accountId: DAE_ACCOUNT_ID, provider: 'INSTAGRAM' as any },
      select: { metadata: true }
    })
  );
  igCreds.forEach((c) => {
    const m = c.metadata as Record<string, unknown>;
    console.log(
      `IG cred: igAccountId=${m?.igAccountId ?? '-'} igUsername=${m?.igUsername ?? '-'} pageId=${m?.pageId ?? '-'}`
    );
  });
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
