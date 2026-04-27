/* eslint-disable no-console */
// Verifies the four Kelvin Kelvot 2026-04-25 fixes:
//
//   TEST 1 — No FOLLOW_UP_1 scheduled when AI ships YouTube link
//   TEST 2 — Pending follow-ups cancelled on transitionLeadStage(UNQUALIFIED)
//   TEST 3 — Follow-up still fires for active CALL_PROPOSED leads
//   TEST 4 — No FOLLOW_UP_1 when lead.stage=UNQUALIFIED OR softExit=true
//
// Pure-logic tests of shouldSkipFollowUp + integration tests against a
// synthetic conversation (created + cleaned up).

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';
import {
  shouldSkipFollowUp,
  containsFreeResourceLink,
  scheduleFollowUp1AfterAiMessage,
  TYPEFORM_BOOKING_URL
} from '../src/lib/follow-up-sequence';
import { transitionLeadStage } from '../src/lib/lead-stage';

let pass = 0;
let fail = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

async function makeSyntheticConversation(suffix: string) {
  const stamp = `kk-followup-${suffix}-${Date.now()}`;
  const account = await prisma.account.create({
    data: { name: stamp, slug: stamp }
  });
  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      name: 'KK Test',
      handle: 'kk_test',
      platform: 'INSTAGRAM',
      platformUserId: `pu-${stamp}`,
      stage: 'NEW_LEAD',
      triggerType: 'DM',
      conversation: { create: { aiActive: true } }
    },
    include: { conversation: true }
  });
  return { account, lead, conversationId: lead.conversation!.id };
}

async function cleanup(
  accountId: string,
  leadId: string,
  conversationId: string
) {
  await prisma.scheduledMessage.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.leadStageTransition.deleteMany({ where: { leadId } });
  await prisma.conversation.delete({ where: { id: conversationId } });
  await prisma.lead.delete({ where: { id: leadId } });
  await prisma.account.delete({ where: { id: accountId } });
}

async function main() {
  // ── Pure-logic tests for shouldSkipFollowUp ─────────────────
  console.log('\n[PURE] shouldSkipFollowUp gate logic');
  expect(
    'skips when leadStage=UNQUALIFIED',
    shouldSkipFollowUp({ leadStage: 'UNQUALIFIED' }),
    { skip: true, reason: 'lead_unqualified' }
  );
  expect(
    'skips when softExit=true',
    shouldSkipFollowUp({ softExit: true, leadStage: 'QUALIFYING' }),
    { skip: true, reason: 'soft_exit_flag' }
  );
  expect(
    'skips when conversationOutcome=DORMANT',
    shouldSkipFollowUp({ conversationOutcome: 'DORMANT' }),
    { skip: true, reason: 'conversation_outcome_dormant' }
  );
  expect(
    'skips when conversationOutcome=SOFT_EXIT',
    shouldSkipFollowUp({ conversationOutcome: 'SOFT_EXIT' }),
    { skip: true, reason: 'conversation_outcome_soft_exit' }
  );
  expect(
    'skips when replyText contains youtube.com/watch',
    shouldSkipFollowUp({
      replyText:
        'check this out bro https://youtube.com/watch?v=e7Ujmb019gE — solid intro to the markets'
    }),
    { skip: true, reason: 'free_resource_url_sent' }
  );
  expect(
    'skips when replyText contains youtu.be',
    shouldSkipFollowUp({
      replyText: 'peep this https://youtu.be/abc123'
    }),
    { skip: true, reason: 'free_resource_url_sent' }
  );
  expect(
    'does NOT skip when none of the conditions match',
    shouldSkipFollowUp({
      leadStage: 'CALL_PROPOSED',
      softExit: false,
      conversationOutcome: 'ONGOING',
      replyText: `let's get you booked bro: ${TYPEFORM_BOOKING_URL} — fill it out + I'll lock you in 💪🏿`
    }),
    { skip: false, reason: null }
  );
  expect(
    'containsFreeResourceLink: true on YouTube URL',
    containsFreeResourceLink('https://youtube.com/watch?v=abc'),
    true
  );
  expect(
    'containsFreeResourceLink: false on Typeform URL',
    containsFreeResourceLink(TYPEFORM_BOOKING_URL),
    false
  );

  // ── TEST 1: No FOLLOW_UP_1 scheduled when YouTube link sent ─
  console.log('\n[TEST 1] YouTube-link send must not schedule FOLLOW_UP_1');
  {
    const { account, lead, conversationId } =
      await makeSyntheticConversation('1');
    try {
      await scheduleFollowUp1AfterAiMessage(conversationId, account.id, {
        leadStage: 'QUALIFYING',
        softExit: false,
        conversationOutcome: 'ONGOING',
        replyText:
          'aight bro, no worries — peep this real quick https://youtube.com/watch?v=e7Ujmb019gE'
      });
      const pending = await prisma.scheduledMessage.findMany({
        where: { conversationId, status: 'PENDING' }
      });
      expect('zero PENDING follow-ups after YouTube ship', pending.length, 0);
    } finally {
      await cleanup(account.id, lead.id, conversationId);
    }
  }

  // ── TEST 2: transitionLeadStage(UNQUALIFIED) cancels pending ─
  console.log(
    '\n[TEST 2] transitionLeadStage(UNQUALIFIED) must cancel pending follow-ups'
  );
  {
    const { account, lead, conversationId } =
      await makeSyntheticConversation('2');
    try {
      // Plant a fake PENDING follow-up.
      await prisma.scheduledMessage.create({
        data: {
          conversationId,
          accountId: account.id,
          scheduledFor: new Date(Date.now() + 12 * 3600 * 1000),
          messageType: 'FOLLOW_UP_1',
          messageBody: 'yo bro you still there?',
          generateAtSendTime: false,
          createdBy: 'AI'
        }
      });
      await transitionLeadStage(lead.id, 'UNQUALIFIED', 'system', 'test');
      const stillPending = await prisma.scheduledMessage.count({
        where: { conversationId, status: 'PENDING' }
      });
      const cancelled = await prisma.scheduledMessage.count({
        where: { conversationId, status: 'CANCELLED' }
      });
      expect('no PENDING follow-ups after UNQUALIFIED', stillPending, 0);
      expect('1 CANCELLED follow-up after UNQUALIFIED', cancelled, 1);
    } finally {
      await cleanup(account.id, lead.id, conversationId);
    }
  }

  // ── TEST 3: Active lead — follow-up still schedules ──────────
  console.log(
    '\n[TEST 3] Active CALL_PROPOSED lead — FOLLOW_UP_1 still schedules'
  );
  {
    const { account, lead, conversationId } =
      await makeSyntheticConversation('3');
    try {
      await scheduleFollowUp1AfterAiMessage(conversationId, account.id, {
        leadStage: 'CALL_PROPOSED',
        softExit: false,
        conversationOutcome: 'ONGOING',
        replyText: `here's the link bro: ${TYPEFORM_BOOKING_URL}`
      });
      const pending = await prisma.scheduledMessage.findMany({
        where: {
          conversationId,
          status: 'PENDING',
          messageType: 'FOLLOW_UP_1'
        }
      });
      expect(
        'exactly 1 PENDING FOLLOW_UP_1 for active CALL_PROPOSED lead',
        pending.length,
        1
      );
    } finally {
      await cleanup(account.id, lead.id, conversationId);
    }
  }

  // ── TEST 4: Downsell-decline / soft_exit=true — no schedule ──
  console.log(
    '\n[TEST 4] softExit=true (downsell declined) must not schedule FOLLOW_UP_1'
  );
  {
    const { account, lead, conversationId } =
      await makeSyntheticConversation('4');
    try {
      await scheduleFollowUp1AfterAiMessage(conversationId, account.id, {
        leadStage: 'QUALIFYING',
        softExit: true, // ← this alone should skip
        conversationOutcome: 'ONGOING',
        replyText:
          "no worries bro, the offer's still there if you change your mind"
      });
      const pending = await prisma.scheduledMessage.count({
        where: { conversationId, status: 'PENDING' }
      });
      expect('zero PENDING follow-ups when softExit=true', pending, 0);

      // Bonus: same convo, different ship — leadStage=UNQUALIFIED.
      await scheduleFollowUp1AfterAiMessage(conversationId, account.id, {
        leadStage: 'UNQUALIFIED',
        softExit: false,
        conversationOutcome: 'ONGOING',
        replyText: 'okay bro, all good'
      });
      const pendingAfter = await prisma.scheduledMessage.count({
        where: { conversationId, status: 'PENDING' }
      });
      expect(
        'still zero PENDING after a 2nd ship with leadStage=UNQUALIFIED',
        pendingAfter,
        0
      );
    } finally {
      await cleanup(account.id, lead.id, conversationId);
    }
  }

  // ── TEST 5: Stale chain teardown — gate=skip still cancels existing ─
  console.log(
    '\n[TEST 5] scheduleFollowUp1 with skip-gate still cancels stale PENDING rows'
  );
  {
    const { account, lead, conversationId } =
      await makeSyntheticConversation('5');
    try {
      // Plant a stale PENDING from an earlier turn.
      await prisma.scheduledMessage.create({
        data: {
          conversationId,
          accountId: account.id,
          scheduledFor: new Date(Date.now() + 12 * 3600 * 1000),
          messageType: 'FOLLOW_UP_1',
          messageBody: 'yo bro you still there?',
          generateAtSendTime: false,
          createdBy: 'AI'
        }
      });
      // Now ship something soft-exit-ish — gate should skip new schedule
      // BUT cancel the stale row.
      await scheduleFollowUp1AfterAiMessage(conversationId, account.id, {
        leadStage: 'QUALIFYING',
        softExit: true,
        replyText: 'aight bro, all good'
      });
      const stillPending = await prisma.scheduledMessage.count({
        where: { conversationId, status: 'PENDING' }
      });
      const cancelled = await prisma.scheduledMessage.count({
        where: { conversationId, status: 'CANCELLED' }
      });
      expect('stale PENDING was torn down', stillPending, 0);
      expect('stale row landed in CANCELLED', cancelled, 1);
    } finally {
      await cleanup(account.id, lead.id, conversationId);
    }
  }

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
