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

const LEAD_IDS = [
  'cmr4w97w600ccl104szqvmekx', // Alee Hasan
  'cmr3juye6000dl404kwy3z39r', // Ale Hassan
  'cmr2i38ts000tkv04yvii52ca', // Alii Raza
  'cmr15nd6j00eak104oq5m6hnn', // Raza Alii
  'cmr0xk771001vld04aa6fcpkh' // ALi Raza
];

async function main() {
  for (const leadId of LEAD_IDS) {
    const lead = await retry(() =>
      prisma.lead.findUnique({
        where: { id: leadId },
        select: { id: true, name: true, conversation: { select: { id: true } } }
      })
    );
    if (!lead) {
      console.log(`SKIP ${leadId} — not found`);
      continue;
    }

    console.log(
      `Deleting "${lead.name}" (${leadId}) conv=${lead.conversation?.id ?? 'none'} ...`
    );
    await retry(() => prisma.lead.delete({ where: { id: leadId } }));
    console.log(`  ✅ deleted`);
  }

  console.log('\nDone. Verifying...');
  const remaining = await retry(() =>
    prisma.lead.findMany({
      where: { id: { in: LEAD_IDS } },
      select: { id: true, name: true }
    })
  );
  if (remaining.length === 0) {
    console.log('✅ All 5 leads confirmed deleted from production.');
  } else {
    console.log('⚠️  Still present:', remaining.map((l) => l.name).join(', '));
  }

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
