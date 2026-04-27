/* eslint-disable no-console */
// Inspect the Tega Umukoro FB lead row to see if "Yooo" is properly
// surfacing — and whether anything is filtering it out of the UI.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: { platformUserId: '27311181005150925', platform: 'FACEBOOK' },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { timestamp: 'desc' }, take: 10 }
        }
      },
      tags: { include: { tag: { select: { name: true } } } }
    }
  });

  if (!lead) {
    console.log('No FB lead with platformUserId=27311181005150925');
    process.exit(0);
  }

  console.log('Lead row:');
  console.log({
    id: lead.id,
    accountId: lead.accountId,
    name: lead.name,
    handle: lead.handle,
    platform: lead.platform,
    platformUserId: lead.platformUserId,
    stage: lead.stage,
    triggerType: lead.triggerType,
    createdAt: lead.createdAt.toISOString()
  });

  console.log(
    '\nTags applied:',
    lead.tags.map((t) => t.tag.name)
  );

  if (!lead.conversation) {
    console.log('\nNo conversation row attached.');
    process.exit(0);
  }
  console.log('\nConversation:');
  console.log({
    id: lead.conversation.id,
    aiActive: lead.conversation.aiActive,
    outcome: lead.conversation.outcome,
    unreadCount: lead.conversation.unreadCount,
    lastMessageAt: lead.conversation.lastMessageAt?.toISOString()
  });

  console.log('\nLast 10 messages (most recent first):');
  for (const m of lead.conversation.messages) {
    console.log(
      `  ${m.timestamp.toISOString()} ${m.sender.padEnd(6)} ` +
        `humanSource=${(m.humanSource ?? '—').padEnd(10)} ` +
        `pmid=${(m.platformMessageId ?? '—').slice(0, 24).padEnd(26)} ` +
        `"${m.content.slice(0, 80)}"`
    );
  }

  // Default conversations-list filter — would Tega's row appear?
  // The default filter excludes leads tagged 'cold-pitch'.
  const wouldShow = await prisma.conversation.findFirst({
    where: {
      id: lead.conversation.id,
      lead: {
        accountId: lead.accountId,
        tags: { none: { tag: { name: 'cold-pitch' } } }
      }
    },
    select: { id: true }
  });
  console.log(
    `\nVisible in DEFAULT conversations list (excluding cold-pitch): ${wouldShow ? 'YES' : 'NO (filtered)'}`
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
