/* eslint-disable no-console */
// Diagnostic — for the 7 stuck handles from the dashboard, dump the actual
// state of their Lead + Conversation rows so we can see why the backfill
// filter missed them.

import prisma from '../src/lib/prisma';

const HANDLES = [
  'imarap_nickol',
  'teerawat_prasertkun',
  'iam.ebere',
  'ww.w.davidl',
  'officeenrich',
  '_ibran_ash89',
  'philip.pkfr'
];

async function main() {
  for (const handle of HANDLES) {
    const lead = await prisma.lead.findFirst({
      where: { handle: { equals: handle, mode: 'insensitive' } },
      include: {
        conversation: {
          select: {
            id: true,
            source: true,
            leadSource: true,
            aiActive: true,
            awaitingAiResponse: true,
            awaitingSince: true,
            lastMessageAt: true,
            messages: {
              orderBy: { timestamp: 'desc' },
              take: 1,
              select: { sender: true, content: true, timestamp: true }
            }
          }
        }
      }
    });
    if (!lead) {
      console.log(`[diag] @${handle}: NO LEAD ROW`);
      continue;
    }
    const c = lead.conversation;
    if (!c) {
      console.log(
        `[diag] @${handle}: lead=${lead.id} stage=${lead.stage} — NO CONVERSATION`
      );
      continue;
    }
    const lastMsg = c.messages[0];
    console.log(
      `[diag] @${handle}: lead=${lead.id} stage=${lead.stage} convo=${c.id} ` +
        `source=${c.source} leadSource=${c.leadSource} aiActive=${c.aiActive} ` +
        `awaitingAiResponse=${c.awaitingAiResponse} awaitingSince=${c.awaitingSince?.toISOString() ?? 'null'} ` +
        `lastMsg=${lastMsg ? `${lastMsg.sender}@${lastMsg.timestamp.toISOString()}: "${lastMsg.content.slice(0, 60)}"` : 'NONE'}`
    );
  }
}

main()
  .catch((err) => {
    console.error('[diag] FATAL:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
