import prisma from '../src/lib/prisma';
import { detectMetadataLeak } from '../src/lib/voice-quality-gate';

const lookbackDays = Number(process.env.LOOKBACK_DAYS ?? '60');
const accountId = process.env.ACCOUNT_ID || null;
const handle = process.env.HANDLE || null;
const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

async function main() {
  const rows = await prisma.message.findMany({
    where: {
      sender: 'AI',
      timestamp: { gte: since },
      ...(handle
        ? { conversation: { lead: { handle: { contains: handle } } } }
        : accountId
          ? { conversation: { lead: { accountId } } }
          : {}),
      OR: [
        { content: { contains: 'stage_confidence', mode: 'insensitive' } },
        { content: { contains: 'quality_score', mode: 'insensitive' } },
        { content: { contains: 'priority_score', mode: 'insensitive' } },
        { content: { contains: 'current_stage', mode: 'insensitive' } },
        { content: { contains: 'script_step', mode: 'insensitive' } },
        { content: { contains: 'next_action', mode: 'insensitive' } },
        { content: { contains: 'stage:', mode: 'insensitive' } },
        { content: { contains: 'intent:', mode: 'insensitive' } },
        { content: { contains: 'sentiment:', mode: 'insensitive' } },
        { content: { contains: '{{', mode: 'insensitive' } },
        { content: { contains: '[BOOKING', mode: 'insensitive' } },
        { content: { contains: '[URL', mode: 'insensitive' } },
        { content: { contains: '[LINK', mode: 'insensitive' } },
        { content: { contains: '(debug:', mode: 'insensitive' } },
        { content: { contains: '(system:', mode: 'insensitive' } },
        { content: { contains: '(internal:', mode: 'insensitive' } }
      ]
    },
    select: {
      id: true,
      conversationId: true,
      content: true,
      timestamp: true,
      conversation: {
        select: {
          lead: {
            select: {
              id: true,
              accountId: true,
              name: true,
              handle: true
            }
          }
        }
      }
    },
    orderBy: { timestamp: 'desc' },
    take: 5000
  });

  const matches = rows
    .map((row) => ({ row, leak: detectMetadataLeak(row.content) }))
    .filter((item) => item.leak.leak);

  const byAccount = new Map<string, number>();
  for (const match of matches) {
    const acct = match.row.conversation.lead.accountId;
    byAccount.set(acct, (byAccount.get(acct) ?? 0) + 1);
  }

  console.log(
    `Historical metadata leak diagnostic (report-only): ${matches.length} match(es) in last ${lookbackDays} day(s)`
  );
  console.log('Counts by account:');
  for (const [acct, count] of Array.from(byAccount.entries()).sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`  ${acct}: ${count}`);
  }

  console.log('\nRecent matches:');
  for (const match of matches.slice(0, 50)) {
    const lead = match.row.conversation.lead;
    const preview = match.row.content.replace(/\s+/g, ' ').slice(0, 140);
    console.log(
      [
        match.row.timestamp.toISOString(),
        lead.accountId,
        `@${lead.handle}`,
        lead.name,
        match.row.conversationId,
        match.row.id,
        `matched=${JSON.stringify(match.leak.matchedText)}`,
        preview
      ].join(' | ')
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
