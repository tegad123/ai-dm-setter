/* eslint-disable no-console */
// Read-only probe: confirm whether new Conversation columns exist in
// the live DB. If a column is missing, the conversations API throws
// (Prisma client expects the column) — manifests as the page showing
// "No conversations yet".
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
import prisma from '../src/lib/prisma';

async function main() {
  const cols: {
    column_name: string;
    data_type: string;
    is_nullable: string;
  }[] = await prisma.$queryRawUnsafe(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'Conversation'
      ORDER BY column_name;
    `);
  const required = [
    'source',
    'manyChatOpenerMessage',
    'manyChatTriggerType',
    'manyChatCommentText',
    'manyChatFiredAt',
    'typeformSubmittedAt',
    'typeformResponseToken',
    'typeformCapitalConfirmed',
    'typeformCallScheduledAt',
    'typeformAnswers'
  ];
  const present = new Set(cols.map((c) => c.column_name));
  console.log(`Conversation has ${cols.length} columns. Recent additions:`);
  for (const r of required) {
    console.log(`  ${present.has(r) ? '✓' : '✗ MISSING'}  ${r}`);
  }

  const accountCols: { column_name: string }[] = await prisma.$queryRawUnsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'Account' AND column_name = 'manyChatWebhookKey';
  `);
  console.log(
    `\nAccount.manyChatWebhookKey: ${accountCols.length > 0 ? '✓ present' : '✗ MISSING'}`
  );

  // Simulate the conversations API query for daetradez to confirm
  // whether it actually fails or returns 0 rows.
  const account = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: { id: true, slug: true }
  });
  if (account) {
    console.log(`\nProbing conversations.findMany for ${account.slug}...`);
    try {
      const count = await prisma.conversation.count({
        where: { lead: { accountId: account.id } }
      });
      console.log(`  count: ${count}`);
      const sample = await prisma.conversation.findMany({
        where: { lead: { accountId: account.id } },
        include: {
          lead: {
            select: {
              id: true,
              name: true,
              handle: true,
              platform: true,
              stage: true
            }
          },
          messages: {
            orderBy: { timestamp: 'desc' },
            take: 1,
            select: { content: true }
          },
          aiSuggestions: { take: 1, select: { id: true } }
        },
        orderBy: { lastMessageAt: 'desc' },
        take: 3
      });
      console.log(`  findMany returned ${sample.length} rows (no error)`);
      for (const c of sample.slice(0, 2)) {
        console.log(
          `    convo ${c.id.slice(-6)} lead=${c.lead.name} stage=${c.lead.stage} source=${c.source}`
        );
      }
    } catch (err) {
      console.error('  ERROR:', err instanceof Error ? err.message : err);
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
