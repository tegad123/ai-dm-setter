/* eslint-disable no-console */
// Wipe all leads + conversations + messages from the smoke-test
// account. Account + persona + credentials persist for re-runs.
//
// Refuses to run if smoke-config's safety guards aren't satisfied.

import { SMOKE_CONFIG } from './smoke-config';

async function main() {
  const prisma = (await import('../../src/lib/prisma')).default;

  const account = await prisma.account.findUnique({
    where: { slug: SMOKE_CONFIG.testAccountSlug },
    select: { id: true }
  });
  if (!account) {
    console.log('[cleanup] no smoke-test-account found, nothing to clean.');
    return;
  }

  const leads = await prisma.lead.findMany({
    where: { accountId: account.id },
    select: { id: true }
  });
  const leadIds = leads.map((l) => l.id);
  if (leadIds.length === 0) {
    console.log('[cleanup] no test leads, account is clean.');
    return;
  }

  const convos = await prisma.conversation.findMany({
    where: { leadId: { in: leadIds } },
    select: { id: true }
  });
  const convoIds = convos.map((c) => c.id);

  await prisma.message.deleteMany({
    where: { conversationId: { in: convoIds } }
  });
  await prisma.scheduledReply.deleteMany({
    where: { conversationId: { in: convoIds } }
  });
  await prisma.conversation.deleteMany({
    where: { id: { in: convoIds } }
  });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });

  console.log(
    `[cleanup] removed ${leads.length} leads, ${convos.length} conversations, all messages.`
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('cleanup failed:', e);
  process.exit(1);
});
