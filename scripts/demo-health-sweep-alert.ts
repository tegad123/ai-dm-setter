import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
// Force the singleton prisma onto the direct 5432 URL before it's imported.
process.env.DATABASE_URL = (process.env.PROD_DATABASE_URL ?? '')
  .replace(':6543/', ':5432/')
  .replace('?pgbouncer=true', '');
async function main() {
  const { runHealthChecks, rollupStatus } = await import(
    '../src/lib/admin-health'
  );
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } }
  });
  const acct = 'cmpy59zy50000ju04u6fs5o2r';
  const seedConv = 'cmrp4fxl1005qle047vnnmcp6';
  const orig = await prisma.conversation.findUnique({
    where: { id: seedConv },
    select: { distressDetected: true, distressDetectedAt: true, aiActive: true }
  });
  await prisma.$executeRawUnsafe(
    `UPDATE "Conversation" SET "distressDetected"=true,"distressDetectedAt"=$1,"aiActive"=true WHERE id=$2`,
    new Date(Date.now() - 2 * 3600 * 1000),
    seedConv
  );

  const results = await runHealthChecks(acct);
  const rollup = rollupStatus(results);
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log('rollup:', rollup);
  results.forEach((r) => console.log(`  [${r.status}] ${r.id}: ${r.detail}`));
  console.log('\n>>> ALERT WOULD FIRE:', rollup === 'CRITICAL');
  console.log(
    '>>> failing:',
    failed.map((f) => `${f.id} (${f.detail})`).join(' | ')
  );

  // restore
  await prisma.$executeRawUnsafe(
    `UPDATE "Conversation" SET "distressDetected"=$1,"distressDetectedAt"=$2,"aiActive"=$3 WHERE id=$4`,
    orig?.distressDetected ?? false,
    orig?.distressDetectedAt ?? null,
    orig?.aiActive ?? true,
    seedConv
  );
  console.log('\nrestored.');
  await prisma.$disconnect();
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
