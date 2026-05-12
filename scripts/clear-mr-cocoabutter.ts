/* eslint-disable no-console */
// One-shot wipe of mr.cocoabutter's lead/conversation on daetradez so a
// fresh ManyChat follow re-creates the row from scratch.
//
// More aggressive than the in-app "clear conversation" DM command (which
// only resets state) — this fully deletes the Lead + Conversation +
// Messages + dependent rows so the next IG webhook / ManyChat handoff
// creates a brand-new lead end-to-end.

import prisma from '../src/lib/prisma';

const ACCOUNT_SLUG = 'daetradez2003';
const HANDLE = 'mr.cocoabutter';

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: ACCOUNT_SLUG },
    select: { id: true }
  });
  if (!account) throw new Error(`account ${ACCOUNT_SLUG} not found`);

  const lead = await prisma.lead.findFirst({
    where: {
      accountId: account.id,
      handle: { equals: HANDLE, mode: 'insensitive' }
    },
    select: {
      id: true,
      handle: true,
      platformUserId: true,
      conversation: { select: { id: true } }
    }
  });
  if (!lead) {
    console.log(
      `No lead found for @${HANDLE} on ${ACCOUNT_SLUG} — already clean`
    );
    return;
  }
  console.log(
    `Found lead ${lead.id} (@${lead.handle}, platformUserId=${lead.platformUserId})`
  );
  const convId = lead.conversation?.id;

  if (convId) {
    // Delete in dependency order. Most child tables don't cascade from
    // Conversation, so explicit deleteMany per relation is safest.
    const ops: Array<{ label: string; promise: Promise<{ count: number }> }> = [
      {
        label: 'Message',
        promise: prisma.message.deleteMany({
          where: { conversationId: convId }
        })
      },
      {
        label: 'AISuggestion',
        promise: prisma.aISuggestion.deleteMany({
          where: { conversationId: convId }
        })
      },
      {
        label: 'ScheduledReply',
        promise: prisma.scheduledReply.deleteMany({
          where: { conversationId: convId }
        })
      },
      {
        label: 'ScheduledMessage',
        promise: prisma.scheduledMessage.deleteMany({
          where: { conversationId: convId }
        })
      },
      {
        label: 'TrainingEvent',
        promise: prisma.trainingEvent.deleteMany({
          where: { conversationId: convId }
        })
      },
      {
        label: 'SelfRecoveryEvent',
        promise: prisma.selfRecoveryEvent.deleteMany({
          where: { conversationId: convId }
        })
      },
      {
        label: 'SilentStopEvent',
        promise: prisma.silentStopEvent.deleteMany({
          where: { conversationId: convId }
        })
      },
      {
        label: 'InboundQualification',
        promise: prisma.inboundQualification.deleteMany({
          where: { conversationId: convId }
        })
      }
    ];
    for (const { label, promise } of ops) {
      const r = await promise.catch((err) => {
        console.warn(`  ${label}: skipped (${err.message})`);
        return { count: 0 };
      });
      console.log(`  deleted ${r.count} ${label} row(s)`);
    }
    await prisma.conversation.delete({ where: { id: convId } });
    console.log(`  deleted Conversation ${convId}`);
  }

  await prisma.lead.delete({ where: { id: lead.id } });
  console.log(`  deleted Lead ${lead.id}`);
  console.log('');
  console.log(
    `@${HANDLE} on ${ACCOUNT_SLUG}: fully wiped. Ready for fresh test.`
  );
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
