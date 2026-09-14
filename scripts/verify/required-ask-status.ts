// M5 item 7 evidence: REQUIRED_ASK_MISSING shadow rows since a time — how
// often a turn at an ask-step shipped without the scripted ask, per account,
// with the expected ask and the turn that went out instead. Read-only.
//
// Run (prod):
//   DATABASE_URL="$PROD_DATABASE_URL" NODE_PATH=$PWD/node_modules npx tsx scripts/verify/required-ask-status.ts [--since 24h] [--account <id>]
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
  const rows = await prisma.egressShadowLog.findMany({
    where: {
      createdAt: { gte: since },
      machineReason: 'REQUIRED_ASK_MISSING',
      ...(accountId ? { accountId } : {})
    },
    orderBy: { createdAt: 'desc' },
    select: {
      accountId: true,
      conversationId: true,
      createdAt: true,
      draftPreview: true
    }
  });
  const convIds = Array.from(
    new Set(rows.map((r) => r.conversationId).filter((x): x is string => !!x))
  );
  const convs = await prisma.conversation.findMany({
    where: { id: { in: convIds } },
    select: {
      id: true,
      currentScriptStep: true,
      lead: {
        select: {
          name: true,
          platform: true,
          account: { select: { name: true } }
        }
      }
    }
  });
  const info = new Map(convs.map((c) => [c.id, c]));
  const byAccount = new Map<string, number>();
  for (const r of rows) {
    const k =
      info.get(r.conversationId ?? '')?.lead.account.name ?? r.accountId;
    byAccount.set(k, (byAccount.get(k) ?? 0) + 1);
  }
  console.log(
    `REQUIRED_ASK_MISSING since ${since.toISOString()}: ${rows.length} turns across ${convIds.length} conversations`
  );
  console.log('by account:', Object.fromEntries(byAccount));
  for (const r of rows) {
    const c = info.get(r.conversationId ?? '');
    console.log(
      `  ${r.createdAt.toISOString()} ${c?.lead.account.name ?? ''} ${c?.lead.platform ?? ''} ${c?.lead.name ?? ''} conv=${r.conversationId}\n     ${r.draftPreview}`
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
