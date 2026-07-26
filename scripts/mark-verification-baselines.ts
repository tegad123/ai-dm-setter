// Flags verification-baseline conversations so the DELETE endpoints refuse to
// remove them (standing rule 2026-07-26: never delete a baseline verification
// conversation — replay on a copy).
//
// Usage: npx tsx scripts/mark-verification-baselines.ts
import { PrismaClient, Prisma } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: (process.env.PROD_DATABASE_URL ?? '')
        .replace(':6543/', ':5432/')
        .replace('?pgbouncer=true', '')
    }
  }
});

const BASELINES = [
  'cmrzgulcs000rjm047g6w3t7q', // Tega's run-2 adversarial conversation
  'cms0ic2xg0003kt04wsbri1qg', // Run B + capital 3x repro (Shazim FB lead)
  'cms0lugpg001il204ub2z8g7u', // Run C (Seemal FB lead)
  'cms0wb34q000mjx049tlnt7ht', // Ali SQA re-run — Ali Hamza
  'cms0wdztc001hjx04f24v76ue', // Ali SQA re-run — Ahmed Shah
  'cmrci72yx002pi604qs96y5m6' // Shazim's protected long-standing test conversation
];

async function main() {
  for (const id of BASELINES) {
    const row = await prisma.conversation.findUnique({
      where: { id },
      select: { capturedDataPoints: true, lead: { select: { name: true } } }
    });
    if (!row) {
      console.log(`MISSING: ${id}`);
      continue;
    }
    const cdp = (row.capturedDataPoints ?? {}) as Record<string, unknown>;
    if (cdp.verificationBaseline === true) {
      console.log(`ALREADY FLAGGED: ${id} (${row.lead?.name})`);
      continue;
    }
    cdp.verificationBaseline = true;
    await prisma.conversation.update({
      where: { id },
      data: { capturedDataPoints: cdp as Prisma.InputJsonValue }
    });
    console.log(`FLAGGED: ${id} (${row.lead?.name})`);
  }
}
main().finally(() => prisma.$disconnect());
