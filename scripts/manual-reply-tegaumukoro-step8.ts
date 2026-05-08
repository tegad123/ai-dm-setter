/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// manual-reply-tegaumukoro-step8.ts
// ---------------------------------------------------------------------------
// One-off operator-style manual reply for @tegaumukoro_'s test
// conversation. Ships the daetradez Step 8 question:
//
//   "gotchu bro — and are you thinking of replacing your job
//    completely with trading or just generating some extra income
//    on the side?"
//
// This bypasses the AI engine entirely (which is currently blocked by
// the legacy income_goal_overdue + qualification_stalled gates). The
// new skipLegacyPacingGates flag fixes the gate going forward, but the
// lead's "Around 4k a month" message has been waiting too long — send
// the manual reply now, then let the AI take over on the next inbound.
//
// Phases:
//   1. Disable AI on the conversation (aiActive=false) so the AI
//      doesn't try to generate a competing reply when this human
//      message hits the timeline.
//   2. Cancel any PENDING/PROCESSING ScheduledReply rows.
//   3. Ship the message via Instagram (same path the dashboard's
//      operator-send uses — sendDM helper).
//   4. Persist a Message row with sender=HUMAN so the conversation
//      timeline reflects the manual reply.
//   5. Print a follow-up note: re-enable AI when ready by setting
//      Conversation.aiActive=true OR by sending another manual reply
//      that triggers the next webhook turn naturally.
//
// Usage:
//   npx tsx scripts/manual-reply-tegaumukoro-step8.ts <conversationId>
//   npx tsx scripts/manual-reply-tegaumukoro-step8.ts <conversationId> --dry-run
// ---------------------------------------------------------------------------

import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { sendDM as sendInstagramDM } from '../src/lib/instagram';

const STEP_8_REPLY =
  'gotchu bro — and are you thinking of replacing your job completely with trading or just generating some extra income on the side?';

async function main() {
  const conversationId = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');

  if (!conversationId) {
    console.error(
      'Usage: npx tsx scripts/manual-reply-tegaumukoro-step8.ts <conversationId> [--dry-run]'
    );
    process.exit(1);
  }

  // 1. Verify conversation + lead.
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      lead: {
        select: {
          id: true,
          handle: true,
          accountId: true,
          platform: true,
          platformUserId: true
        }
      }
    }
  });
  if (!convo || !convo.lead) {
    console.error(`Conversation ${conversationId} not found or has no Lead.`);
    process.exit(1);
  }
  if (!/tegaumukoro/i.test(convo.lead.handle)) {
    console.error(
      `Refusing to run: lead handle "@${convo.lead.handle}" doesn't match the expected target.`
    );
    process.exit(1);
  }
  if (convo.lead.platform !== 'INSTAGRAM') {
    console.error(
      `Refusing to run: this script ships via Instagram. Conversation platform is "${convo.lead.platform}".`
    );
    process.exit(1);
  }
  if (!convo.lead.platformUserId) {
    console.error(
      'Lead has no platformUserId — cannot ship via Instagram without a recipient ID.'
    );
    process.exit(1);
  }

  console.log(
    '================================================================'
  );
  console.log(`Conversation: ${convo.id}`);
  console.log(`Lead:         ${convo.lead.id} @${convo.lead.handle}`);
  console.log(`Account:      ${convo.lead.accountId}`);
  console.log(`Recipient:    ${convo.lead.platformUserId}`);
  console.log(`Mode:         ${dryRun ? 'DRY RUN' : 'WRITE + SEND'}`);
  console.log(
    '================================================================'
  );
  console.log('');
  console.log(`Reply to ship: "${STEP_8_REPLY}"`);

  if (dryRun) {
    console.log('');
    console.log('PLANNED STEPS (dry-run, no writes / no Meta send):');
    console.log(
      '  1. Update Conversation: aiActive=false, awaitingAiResponse=false, awaitingSince=null'
    );
    console.log('  2. Cancel PENDING/PROCESSING ScheduledReply rows');
    console.log('  3. Send Step 8 reply via Instagram sendDM');
    console.log(
      '  4. Insert Message row sender=HUMAN with the platformMessageId returned from Meta'
    );
    return;
  }

  // 2. Pause AI before sending the human reply so the AI doesn't
  //    interleave a competing response.
  console.log('');
  console.log('Pausing AI on conversation...');
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      aiActive: false,
      awaitingAiResponse: false,
      awaitingSince: null
    }
  });

  // 3. Cancel pending scheduled replies.
  const cancelled = await prisma.scheduledReply.updateMany({
    where: {
      conversationId,
      status: { in: ['PENDING', 'PROCESSING'] }
    },
    data: { status: 'CANCELLED' }
  });
  console.log(
    `Cancelled ${cancelled.count} pending/processing ScheduledReply row(s).`
  );

  // 4. Ship via Instagram. sendDM uses the account's stored IG token.
  console.log('Shipping via Instagram sendDM...');
  let platformMessageId: string;
  try {
    const ship = await sendInstagramDM(
      convo.lead.accountId,
      convo.lead.platformUserId,
      STEP_8_REPLY
    );
    platformMessageId = ship.messageId;
    console.log(`Meta confirmed delivery. messageId=${platformMessageId}`);
  } catch (err) {
    console.error('Instagram sendDM failed:', err);
    console.log(
      'Re-enabling AI on the conversation since the manual reply did not ship.'
    );
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { aiActive: true }
    });
    process.exit(1);
  }

  // 5. Persist Message row with sender=HUMAN and the messageId Meta
  //    returned. Mirrors what the operator dashboard does on a
  //    successful manual send.
  const now = new Date();
  const messageRow = await prisma.message.create({
    data: {
      conversationId,
      sender: 'HUMAN',
      content: STEP_8_REPLY,
      timestamp: now,
      platformMessageId,
      stage: null,
      subStage: null
    }
  });
  console.log(`Inserted HUMAN Message row id=${messageRow.id}`);

  // Update conversation lastMessageAt so the dashboard re-orders.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: now }
  });

  console.log('');
  console.log(
    '================================================================'
  );
  console.log('DONE');
  console.log(
    '================================================================'
  );
  console.log(
    'Manual Step 8 reply shipped. AI is paused on this conversation.'
  );
  console.log(
    'Next steps: when the lead replies, you can either (a) re-enable AI by setting'
  );
  console.log(
    '  Conversation.aiActive=true (the new skipLegacyPacingGates flag will let it pass'
  );
  console.log(
    '  the gate this time), or (b) keep operating manually from the dashboard.'
  );
}

main()
  .catch((err) => {
    console.error('[manual-reply-tegaumukoro] FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
