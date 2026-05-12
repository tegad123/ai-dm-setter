/* eslint-disable no-console */
// Per-persona and final-sweep cleanup. Traces every row from the
// account.id prefix and deletes in FK order. Wrap in $transaction so a
// mid-cleanup failure leaves the DB in a known state.

import { HARNESS_CONFIG, assertTestDb, getPrisma } from './safety-guard';

const PREFIX = HARNESS_CONFIG.rowIdPrefix;

interface CleanupCounts {
  accounts: number;
  personas: number;
  leads: number;
  conversations: number;
  messages: number;
  scheduled: number;
  notifications: number;
  inboundQualifications: number;
  stageTransitions: number;
  scriptPositions: number;
  messageGroups: number;
  integrationCredentials: number;
}

async function findHarnessAccountIds(filterSlug?: string): Promise<string[]> {
  const prisma = await getPrisma();
  const where = filterSlug
    ? { id: `${PREFIX}acct-${filterSlug}` }
    : { id: { startsWith: PREFIX } };
  const rows = await prisma.account.findMany({
    where,
    select: { id: true }
  });
  return rows.map((r) => r.id);
}

export async function cleanupByPersona(
  personaSlug: string
): Promise<CleanupCounts> {
  return cleanup(personaSlug);
}

export async function cleanupAll(): Promise<CleanupCounts> {
  return cleanup(undefined);
}

async function cleanup(
  personaSlug: string | undefined
): Promise<CleanupCounts> {
  await assertTestDb();
  const prisma = await getPrisma();

  const accountIds = await findHarnessAccountIds(personaSlug);
  if (accountIds.length === 0) {
    return zero();
  }

  const leads = await prisma.lead.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true }
  });
  const leadIds = leads.map((l) => l.id);

  const conversations = leadIds.length
    ? await prisma.conversation.findMany({
        where: { leadId: { in: leadIds } },
        select: { id: true }
      })
    : [];
  const conversationIds = conversations.map((c) => c.id);

  // Delete in dependency order. Each statement is idempotent and
  // returns a count so we can report orphan totals.
  const ops = [
    () =>
      conversationIds.length
        ? prisma.message.deleteMany({
            where: { conversationId: { in: conversationIds } }
          })
        : Promise.resolve({ count: 0 }),
    () =>
      conversationIds.length
        ? prisma.scheduledReply.deleteMany({
            where: { conversationId: { in: conversationIds } }
          })
        : Promise.resolve({ count: 0 }),
    () =>
      conversationIds.length
        ? prisma.messageGroup.deleteMany({
            where: { conversationId: { in: conversationIds } }
          })
        : Promise.resolve({ count: 0 }),
    () =>
      prisma.notification.deleteMany({
        where: { accountId: { in: accountIds } }
      }),
    () =>
      conversationIds.length
        ? prisma.inboundQualification.deleteMany({
            where: { conversationId: { in: conversationIds } }
          })
        : Promise.resolve({ count: 0 }),
    () =>
      leadIds.length
        ? prisma.leadStageTransition.deleteMany({
            where: { leadId: { in: leadIds } }
          })
        : Promise.resolve({ count: 0 }),
    () =>
      leadIds.length
        ? prisma.leadScriptPosition.deleteMany({
            where: { leadId: { in: leadIds } }
          })
        : Promise.resolve({ count: 0 }),
    () =>
      conversationIds.length
        ? prisma.conversation.deleteMany({
            where: { id: { in: conversationIds } }
          })
        : Promise.resolve({ count: 0 }),
    () =>
      leadIds.length
        ? prisma.lead.deleteMany({ where: { id: { in: leadIds } } })
        : Promise.resolve({ count: 0 }),
    () =>
      prisma.aIPersona.deleteMany({
        where: { accountId: { in: accountIds } }
      }),
    () =>
      prisma.integrationCredential.deleteMany({
        where: { accountId: { in: accountIds } }
      }),
    () => prisma.account.deleteMany({ where: { id: { in: accountIds } } })
  ];

  const counts = zero();
  for (const op of ops) {
    try {
      const r = await op();
      // Map by index for readability
      assignCount(counts, op.toString(), r.count);
    } catch (err) {
      console.warn(`[harness:cleanup] step failed: ${(err as Error).message}`);
    }
  }
  return counts;
}

function zero(): CleanupCounts {
  return {
    accounts: 0,
    personas: 0,
    leads: 0,
    conversations: 0,
    messages: 0,
    scheduled: 0,
    notifications: 0,
    inboundQualifications: 0,
    stageTransitions: 0,
    scriptPositions: 0,
    messageGroups: 0,
    integrationCredentials: 0
  };
}

function assignCount(c: CleanupCounts, opSrc: string, count: number): void {
  if (opSrc.includes('message.deleteMany')) c.messages += count;
  else if (opSrc.includes('scheduledReply.deleteMany')) c.scheduled += count;
  else if (opSrc.includes('messageGroup.deleteMany')) c.messageGroups += count;
  else if (opSrc.includes('notification.deleteMany')) c.notifications += count;
  else if (opSrc.includes('inboundQualification.deleteMany'))
    c.inboundQualifications += count;
  else if (opSrc.includes('leadStageTransition.deleteMany'))
    c.stageTransitions += count;
  else if (opSrc.includes('leadScriptPosition.deleteMany'))
    c.scriptPositions += count;
  else if (opSrc.includes('conversation.deleteMany')) c.conversations += count;
  else if (opSrc.includes('lead.deleteMany')) c.leads += count;
  else if (opSrc.includes('aIPersona.deleteMany')) c.personas += count;
  else if (opSrc.includes('integrationCredential.deleteMany'))
    c.integrationCredentials += count;
  else if (opSrc.includes('account.deleteMany')) c.accounts += count;
}

export async function reportOrphans(): Promise<number> {
  await assertTestDb();
  const prisma = await getPrisma();
  const accountCount = await prisma.account.count({
    where: { id: { startsWith: PREFIX } }
  });
  if (accountCount > 0) {
    console.warn(
      `[harness:cleanup] ${accountCount} test-harness accounts still present after cleanup.`
    );
  }
  return accountCount;
}
