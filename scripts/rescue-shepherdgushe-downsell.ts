// In-flight rescue for @shepherdgushe.zw 2026-05-05.
//
// The AI shipped "bet bro, that's the move / hop on a quick call with my
// right hand man Anthony" to an UNQUALIFIED lead ($5 capital) who had
// just affirmed downsell interest with "Yes yes". The R40 fix is now in
// the code; this script:
//   1. Calls Meta DELETE on each bad AI bubble so the lead's IG no
//      longer shows the call CTA
//   2. Soft-deletes the rows in our DB (deletedAt + deletedBy +
//      deletedSource='DASHBOARD') so the dashboard reflects the
//      rescue
//   3. Re-fires scheduleAIReply so the AI generates the correct
//      next move (deliver the $497 course URL) using the new R40
//      prompt rule + gate.
import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { unsendDM } from '../src/lib/instagram';
import { scheduleAIReply } from '../src/lib/webhook-processor';
import { broadcastMessageDeleted } from '../src/lib/realtime';

const CONVERSATION_ID = 'cmorvaw09000jie04qg1qafir';
const BAD_GROUP_ID = 'cmosueaoq001fky047wreefvx';

async function main() {
  const conv = await prisma.conversation.findUnique({
    where: { id: CONVERSATION_ID },
    include: { lead: true }
  });
  if (!conv) throw new Error(`Conversation ${CONVERSATION_ID} not found`);
  const accountId = conv.lead.accountId;
  console.log(
    `Conversation ${CONVERSATION_ID} (lead=${conv.lead.handle}, account=${accountId})`
  );

  // 1. Find the bad AI bubbles in the group
  const badBubbles = await prisma.message.findMany({
    where: { messageGroupId: BAD_GROUP_ID, deletedAt: null },
    select: {
      id: true,
      platformMessageId: true,
      content: true,
      conversationId: true,
      timestamp: true
    }
  });
  console.log(`\n${badBubbles.length} bad bubbles to unsend:`);
  for (const b of badBubbles) {
    console.log(
      `  - ${b.id} @ ${b.timestamp.toISOString()} pmid=${b.platformMessageId?.slice(0, 30)}... "${b.content.slice(0, 60)}..."`
    );
  }
  if (badBubbles.length === 0) {
    console.log('Nothing to unsend; aborting.');
    return;
  }

  // 2. Unsend each via Meta + soft-delete locally
  for (const bubble of badBubbles) {
    if (!bubble.platformMessageId) {
      console.warn(`  ! skipping ${bubble.id}: no platformMessageId`);
      continue;
    }
    console.log(`\nUnsending ${bubble.id} via Meta...`);
    const result = await unsendDM(accountId, bubble.platformMessageId);
    if (!result.ok) {
      console.error(
        `  ! Meta unsend failed (status=${result.status}):`,
        result.error
      );
      continue;
    }
    const deletedAt = new Date();
    await prisma.message.update({
      where: { id: bubble.id },
      data: {
        deletedAt,
        deletedBy: 'rescue-script',
        deletedSource: 'DASHBOARD'
      }
    });
    broadcastMessageDeleted(accountId, {
      id: bubble.id,
      conversationId: bubble.conversationId,
      deletedAt: deletedAt.toISOString(),
      deletedBy: 'rescue-script',
      deletedSource: 'DASHBOARD'
    });
    console.log(`  ✓ unsent + soft-deleted`);
  }

  // 3. Re-arm conversation + fire scheduleAIReply inline
  console.log('\nRe-arming conversation + firing scheduleAIReply...');
  await prisma.conversation.update({
    where: { id: CONVERSATION_ID },
    data: {
      aiActive: true,
      // pre-deploy: this still drives the dual-gate. post-deploy
      // (commit 349f6f5+) the gate is aiActive-only and this is moot.
      autoSendOverride: true,
      awaitingAiResponse: true,
      awaitingSince: new Date()
    }
  });
  await scheduleAIReply(CONVERSATION_ID, accountId, { skipDelayQueue: true });
  console.log('scheduleAIReply complete.');

  // 4. Confirm what landed
  const latest = await prisma.message.findFirst({
    where: { conversationId: CONVERSATION_ID, sender: 'AI' },
    orderBy: { timestamp: 'desc' },
    select: { id: true, content: true, timestamp: true, deletedAt: true }
  });
  console.log(
    `\nLatest AI message: ${latest?.id} @ ${latest?.timestamp.toISOString()}`
  );
  console.log(`  content: ${latest?.content}`);
  console.log(`  deletedAt: ${latest?.deletedAt}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
