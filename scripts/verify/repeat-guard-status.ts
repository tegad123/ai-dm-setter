// M5 item 7 evidence: VERBATIM_REPEAT guard verdicts since a time, with the
// conversation, the refused bubble, when the same copy was first delivered,
// and whether a duplicate still slipped through. Read-only.
//
// Run (prod):
//   DATABASE_URL="$PROD_DATABASE_URL" NODE_PATH=$PWD/node_modules npx tsx scripts/verify/repeat-guard-status.ts [--since 6h] [--account <id>]
import 'dotenv/config';
import prisma from '@/lib/prisma';
import { findVerbatimRepeat } from '@/lib/state-machine/copy-match';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function sinceMs(spec: string | undefined): number {
  const m = /^(\d+)([hd])$/.exec(spec ?? '6h');
  if (!m) return 6 * 3600e3;
  return Number(m[1]) * (m[2] === 'd' ? 86400e3 : 3600e3);
}

async function main() {
  const since = new Date(Date.now() - sinceMs(arg('since')));
  const accountId = arg('account');
  const rows = await prisma.egressShadowLog.findMany({
    where: {
      createdAt: { gte: since },
      machineReason: 'VERBATIM_REPEAT',
      ...(accountId ? { accountId } : {})
    },
    orderBy: { createdAt: 'desc' },
    select: {
      accountId: true,
      conversationId: true,
      createdAt: true,
      draftPreview: true,
      sendPath: true
    }
  });
  console.log(
    `VERBATIM_REPEAT verdicts since ${since.toISOString()}: ${rows.length}`
  );
  for (const r of rows) {
    const conv = r.conversationId
      ? await prisma.conversation.findUnique({
          where: { id: r.conversationId },
          select: {
            lead: {
              select: {
                name: true,
                platform: true,
                account: { select: { name: true } }
              }
            },
            messages: {
              where: {
                sender: { in: ['AI', 'HUMAN'] },
                platformMessageId: { not: null }
              },
              orderBy: { timestamp: 'asc' },
              select: { content: true, timestamp: true }
            }
          }
        })
      : null;
    const prior = conv?.messages.filter((m) => m.timestamp < r.createdAt) ?? [];
    const first = findVerbatimRepeat(
      r.draftPreview ?? '',
      prior.map((m) => m.content)
    );
    const firstAt = prior.find((m) => m.content === first)?.timestamp;
    const after =
      conv?.messages.filter(
        (m) =>
          m.timestamp >= r.createdAt &&
          findVerbatimRepeat(m.content, [r.draftPreview ?? ''])
      ) ?? [];
    console.log(
      `  ${r.createdAt.toISOString()} ${conv?.lead.account.name ?? r.accountId} ${conv?.lead.platform ?? ''} ${conv?.lead.name ?? ''} conv=${r.conversationId}\n` +
        `     refused: "${(r.draftPreview ?? '').slice(0, 100)}"\n` +
        `     first delivered: ${firstAt ? firstAt.toISOString() : 'not found in delivered history'}\n` +
        `     slipped through afterwards: ${after.length ? after.map((m) => m.timestamp.toISOString()).join(', ') : 'no'}`
    );
  }

  // Are there duplicates the guard did NOT catch (delivered twice after `since`)?
  const delivered = await prisma.message.findMany({
    where: {
      sender: 'AI',
      platformMessageId: { not: null },
      timestamp: { gte: since },
      ...(accountId ? { conversation: { lead: { accountId } } } : {})
    },
    orderBy: { timestamp: 'asc' },
    select: { conversationId: true, content: true, timestamp: true }
  });
  const byConv = new Map<string, { content: string; timestamp: Date }[]>();
  for (const m of delivered)
    byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), m]);
  let dupes = 0;
  byConv.forEach((msgs, convId) => {
    for (let i = 1; i < msgs.length; i++) {
      const hit = findVerbatimRepeat(
        msgs[i].content,
        msgs.slice(0, i).map((m) => m.content)
      );
      if (hit) {
        dupes++;
        console.log(
          `  DUPLICATE DELIVERED conv=${convId} at ${msgs[i].timestamp.toISOString()}: "${msgs[i].content.slice(0, 80)}"`
        );
      }
    }
  });
  console.log(
    `delivered duplicates since ${since.toISOString()}: ${dupes} (across ${byConv.size} conversations, ${delivered.length} AI messages)`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
