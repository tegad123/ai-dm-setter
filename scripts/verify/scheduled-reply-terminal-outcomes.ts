// Read-only release-gate check for ScheduledReply terminal evidence.
//
//   NODE_PATH=$PWD/node_modules npx tsx scripts/verify/scheduled-reply-terminal-outcomes.ts
//   HOURS=48 NODE_PATH=$PWD/node_modules npx tsx scripts/verify/scheduled-reply-terminal-outcomes.ts
//
// Exits non-zero when a new terminal row lacks a coded reason or terminal
// timestamp. Historical rows are explicitly labelled by the migration and are
// reported separately rather than reverse-engineered from free text.
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.resolve(process.cwd(), '.env'), override: true });

if (!process.env.PROD_DATABASE_URL) {
  console.error('PROD_DATABASE_URL is required');
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});

async function retry<T>(fn: () => Promise<T>, attempts = 12): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

async function main() {
  const hours = Math.max(1, Number(process.env.HOURS ?? 24));
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const terminalStatuses = [
    'SENT',
    'CANCELLED',
    'FAILED',
    'FAILED_QUALITY_GATE'
  ] as const;

  const rows = await retry(() =>
    prisma.scheduledReply.findMany({
      where: {
        createdAt: { gte: since },
        status: { in: [...terminalStatuses] }
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        conversationId: true,
        status: true,
        terminalReasonCode: true,
        terminalAt: true,
        claimSnapshot: true,
        generationTraceId: true,
        lastError: true,
        createdAt: true
      }
    })
  );

  const missing = rows.filter(
    (row) => !row.terminalReasonCode || !row.terminalAt
  );
  const reasonCounts = new Map<string, number>();
  for (const row of rows) {
    const reason = row.terminalReasonCode ?? 'MISSING';
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  console.log(
    `ScheduledReply terminal outcomes since ${since.toISOString()} (${rows.length} rows)`
  );
  for (const [reason, count] of Array.from(reasonCounts.entries()).sort()) {
    console.log(`  ${reason}: ${count}`);
  }
  console.log(
    `claim snapshots: ${rows.filter((row) => row.claimSnapshot).length}/${rows.length}`
  );
  console.log(
    `generation trace links: ${rows.filter((row) => row.generationTraceId).length}/${rows.length}`
  );

  if (missing.length > 0) {
    console.error(
      `\nFAIL: ${missing.length} terminal row(s) lack coded evidence:`
    );
    for (const row of missing.slice(0, 25)) {
      console.error(
        `  ${row.id} ${row.status} conv=${row.conversationId} created=${row.createdAt.toISOString()} reason=${row.terminalReasonCode ?? '-'} terminalAt=${row.terminalAt?.toISOString() ?? '-'} error=${row.lastError?.slice(0, 100) ?? '-'}`
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      '\nPASS: every recent terminal row has a coded reason and terminal timestamp.'
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
