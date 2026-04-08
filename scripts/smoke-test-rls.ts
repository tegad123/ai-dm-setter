/**
 * Smoke-test: confirm Prisma can still read every table after RLS was enabled.
 * Counts rows on a representative subset of models.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/smoke-test-rls.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('\nRunning Prisma smoke-test against RLS-enabled tables...\n');

  const checks: Array<[string, () => Promise<number>]> = [
    ['Account', () => prisma.account.count()],
    ['User', () => prisma.user.count()],
    ['Lead', () => prisma.lead.count()],
    ['Conversation', () => prisma.conversation.count()],
    ['Message', () => prisma.message.count()],
    ['Notification', () => prisma.notification.count()],
    ['AIPersona', () => prisma.aIPersona.count()],
    ['IntegrationCredential', () => prisma.integrationCredential.count()],
    ['Tag', () => prisma.tag.count()],
    ['LeadTag', () => prisma.leadTag.count()],
    ['TeamNote', () => prisma.teamNote.count()],
    ['ContentAttribution', () => prisma.contentAttribution.count()],
    ['ScheduledReply', () => prisma.scheduledReply.count()]
  ];

  let ok = 0;
  let failed = 0;

  for (const [name, fn] of checks) {
    try {
      const n = await fn();
      console.log(`  ✔ ${name.padEnd(24)} ${n} rows`);
      ok++;
    } catch (e: any) {
      console.error(`  ✘ ${name.padEnd(24)} ${e?.message ?? e}`);
      failed++;
    }
  }

  console.log(`\nResult: ${ok} passed, ${failed} failed`);

  if (failed > 0) {
    console.error(
      '\n⚠  Prisma is being blocked by RLS — investigate the connection role.'
    );
    process.exit(1);
  } else {
    console.log('\n✔  Prisma reads work normally with RLS enabled.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
