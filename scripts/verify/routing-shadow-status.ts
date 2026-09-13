// M5 items 2–4 evidence: compiler/migration state in prod + RoutingShadowLog
// agreement summary. Read-only.
//
// Run (prod):
//   DATABASE_URL="$PROD_DATABASE_URL" NODE_PATH=$PWD/node_modules npx tsx scripts/verify/routing-shadow-status.ts [--since 24h] [--account <id>]
import 'dotenv/config';
import prisma from '@/lib/prisma';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function sinceMs(spec: string | undefined): number {
  const m = /^(\d+)([hd])$/.exec(spec ?? '24h');
  if (!m) return 24 * 3600e3;
  return Number(m[1]) * (m[2] === 'd' ? 86400e3 : 3600e3);
}

async function main() {
  const since = new Date(Date.now() - sinceMs(arg('since')));
  const accountId = arg('account');

  const migrations = await prisma.$queryRawUnsafe<
    { migration_name: string; finished_at: Date | null }[]
  >(
    `select migration_name, finished_at from _prisma_migrations where migration_name like '2026091%' order by migration_name desc limit 5`
  );
  console.log('migrations:');
  for (const m of migrations)
    console.log(
      `  ${m.migration_name}  ${m.finished_at?.toISOString() ?? 'PENDING'}`
    );

  const scripts = await prisma.script.findMany({
    where: { isActive: true, ...(accountId ? { accountId } : {}) },
    select: {
      id: true,
      name: true,
      accountId: true,
      compiledFsmVersion: true,
      compiledFsm: true,
      account: { select: { name: true } }
    }
  });
  console.log(`\nactive scripts: ${scripts.length}`);
  for (const s of scripts) {
    const fsm = s.compiledFsm as {
      nodes?: unknown[];
      diagnostics?: { severity: string }[];
    } | null;
    const errs =
      fsm?.diagnostics?.filter((d) => d.severity === 'error').length ?? 0;
    const warns =
      fsm?.diagnostics?.filter((d) => d.severity === 'warning').length ?? 0;
    console.log(
      `  ${s.account.name.padEnd(22)} v${s.compiledFsmVersion ?? '-'} nodes=${fsm?.nodes?.length ?? '-'} errors=${errs} warnings=${warns}  ${s.id}`
    );
  }

  const rows = await prisma.routingShadowLog.findMany({
    where: { createdAt: { gte: since }, ...(accountId ? { accountId } : {}) },
    orderBy: { createdAt: 'desc' }
  });
  const branchRows = rows.filter(
    (r) => r.fsmBranchLabel != null || r.legacyBranchLabel != null
  );
  const advRows = rows.filter((r) => r.advanceAgreed != null);
  console.log(
    `\nRoutingShadowLog since ${since.toISOString()}: ${rows.length} rows`
  );
  console.log(
    `  branch: ${branchRows.length} rows, agreed=${branchRows.filter((r) => r.branchAgreed).length}, disagreed=${branchRows.filter((r) => !r.branchAgreed).length}`
  );
  console.log(
    `  advance: ${advRows.length} rows, agreed=${advRows.filter((r) => r.advanceAgreed).length}, disagreed=${advRows.filter((r) => r.advanceAgreed === false).length}`
  );
  const bad = rows.filter(
    (r) =>
      (r.fsmBranchLabel != null && !r.branchAgreed) || r.advanceAgreed === false
  );
  if (bad.length) {
    console.log('\ndisagreements (newest first, max 30):');
    for (const r of bad.slice(0, 30)) {
      console.log(
        `  ${r.createdAt.toISOString()} conv=${r.conversationId} step=${r.stepNumber} ` +
          `branch legacy=${JSON.stringify(r.legacyBranchLabel)} fsm=${JSON.stringify(r.fsmBranchLabel)} (${r.fsmReason}) ` +
          `advance legacy=${r.legacyNextStep ?? '-'} fsm=${r.fsmNextStep ?? '-'}`
      );
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
