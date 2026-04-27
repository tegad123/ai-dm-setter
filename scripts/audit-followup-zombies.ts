/* eslint-disable no-console */
// Audit + (with --apply) backfill cancellation of zombie follow-ups on
// daetradez. A "zombie" is a PENDING ScheduledMessage on a conversation
// where any of:
//   - lead.stage = UNQUALIFIED
//   - conversation.outcome ∈ {DORMANT, SOFT_EXIT}
//   - the latest AI Message contains a free-resource (YouTube) URL
//
// Pre-this-commit, those would fire 12h after the soft-exit ship. Now
// the gate prevents NEW ones; this script tears down the existing ones.
//
// Usage:
//   pnpm tsx scripts/audit-followup-zombies.ts            # report only
//   pnpm tsx scripts/audit-followup-zombies.ts --apply    # cancel them

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';
import { containsFreeResourceLink } from '../src/lib/follow-up-sequence';

async function main() {
  const apply = process.argv.includes('--apply');
  const account = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } }
  });
  if (!account) {
    console.error('No daetradez account found.');
    process.exit(1);
  }

  const pending = await prisma.scheduledMessage.findMany({
    where: {
      accountId: account.id,
      status: 'PENDING',
      messageType: {
        in: [
          'FOLLOW_UP_1',
          'FOLLOW_UP_2',
          'FOLLOW_UP_3',
          'FOLLOW_UP_SOFT_EXIT',
          'BOOKING_LINK_FOLLOWUP'
        ]
      }
    },
    include: {
      conversation: {
        select: {
          id: true,
          outcome: true,
          lead: { select: { id: true, name: true, handle: true, stage: true } }
        }
      }
    }
  });

  console.log(`Total PENDING follow-up rows on daetradez: ${pending.length}`);

  // Match the latest AI message for each conversation in one batch
  // so we can detect YouTube-link sends.
  const convIds = Array.from(new Set(pending.map((p) => p.conversationId)));
  const latestAiByConv = new Map<string, string>();
  for (const cid of convIds) {
    const m = await prisma.message.findFirst({
      where: { conversationId: cid, sender: 'AI' },
      orderBy: { timestamp: 'desc' },
      select: { content: true }
    });
    if (m) latestAiByConv.set(cid, m.content);
  }

  const zombies = pending.filter((p) => {
    const lead = p.conversation.lead;
    if (lead.stage === 'UNQUALIFIED') return true;
    if (
      p.conversation.outcome === 'DORMANT' ||
      p.conversation.outcome === 'SOFT_EXIT'
    )
      return true;
    const lastAi = latestAiByConv.get(p.conversationId) || '';
    if (containsFreeResourceLink(lastAi)) return true;
    return false;
  });

  console.log(`Zombie rows (will be cancelled): ${zombies.length}\n`);
  for (const z of zombies) {
    const lead = z.conversation.lead;
    console.log(
      `  ${z.messageType.padEnd(22)} stage=${lead.stage.padEnd(15)} outcome=${(z.conversation.outcome || '').padEnd(12)} ${lead.name} (@${lead.handle})`
    );
  }

  if (!apply) {
    console.log('\nRe-run with --apply to cancel these rows.');
    await prisma.$disconnect();
    return;
  }

  if (zombies.length === 0) {
    console.log('Nothing to cancel.');
    await prisma.$disconnect();
    return;
  }

  const res = await prisma.scheduledMessage.updateMany({
    where: {
      id: { in: zombies.map((z) => z.id) },
      status: 'PENDING'
    },
    data: { status: 'CANCELLED' }
  });
  console.log(`\nCancelled ${res.count} zombie follow-up row(s).`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
