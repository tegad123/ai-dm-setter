/* eslint-disable no-console */
// Verifies the cold-pitch / agency-spam auto-ignore (Omar 2026-04-25).
//
//   TEST 1 — Omar's exact message: detected, conversation tagged + outcome=SPAM
//   TEST 2 — Normal lead opener: not detected, processIncomingMessage proceeds
//   TEST 3 — Pitch-shape message AFTER prior conversation: not silenced
//   TEST 4 — Cold-pitch tagged leads excluded from default conversations list
//   TEST 5 — Cold-pitch tagged leads excluded from leadsToday + counted separately
//   TEST 6 — All 7 patterns fire on representative samples; clean leads don't
//
// Each integration test creates a synthetic account/lead/conversation, drives
// the real handler, asserts state, and cleans up.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';
import {
  detectColdPitch,
  COLD_PITCH_PATTERNS,
  COLD_PITCH_TAG_NAME
} from '../src/lib/cold-pitch-detector';
import { processIncomingMessage } from '../src/lib/webhook-processor';

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

async function makeAccount(suffix: string) {
  const stamp = `cold-pitch-${suffix}-${Date.now()}`;
  return prisma.account.create({ data: { name: stamp, slug: stamp } });
}

async function cleanup(accountId: string) {
  // Cascade through everything tied to this account so the test rows
  // don't leak into production analytics.
  await prisma.message.deleteMany({
    where: { conversation: { lead: { accountId } } }
  });
  await prisma.scheduledMessage.deleteMany({ where: { accountId } });
  // ScheduledReply has no relation, only conversationId — list convos first.
  const convoIds = await prisma.conversation.findMany({
    where: { lead: { accountId } },
    select: { id: true }
  });
  await prisma.scheduledReply.deleteMany({
    where: { conversationId: { in: convoIds.map((c) => c.id) } }
  });
  await prisma.leadTag.deleteMany({ where: { lead: { accountId } } });
  await prisma.leadStageTransition.deleteMany({
    where: { lead: { accountId } }
  });
  await prisma.conversation.deleteMany({ where: { lead: { accountId } } });
  await prisma.lead.deleteMany({ where: { accountId } });
  await prisma.tag.deleteMany({ where: { accountId } });
  await prisma.account.delete({ where: { id: accountId } });
}

async function main() {
  // ── Pure-pattern tests on detectColdPitch ────────────────────
  console.log('\n[PURE] detectColdPitch surface-area sweep');
  const omarMessage =
    'Helped a coach go from 800 to 55K followers with 8 Instagram posts and generate over $500K from that same content. Want me to send it over?';
  const omarRes = detectColdPitch(omarMessage);
  expect('Omar exact message → detected', omarRes.detected, true);

  const positives: Array<{ label: string; text: string }> = [
    {
      label: 'social growth claim',
      text: 'I helped a creator grow from 5k to 100k followers in 3 months'
    },
    {
      label: 'revenue claim',
      text: 'we generated $250k for a client last quarter'
    },
    {
      label: '"want me to send"',
      text: 'want me to send you the case study?'
    },
    {
      label: 'quick video pitch',
      text: 'I put together a quick video breakdown for you'
    },
    {
      label: 'volume claim',
      text: 'helped 12 coaches scale their Instagram'
    },
    {
      label: 'system claim',
      text: 'Our framework has helped dozens of brands close more deals'
    },
    {
      label: 'are you open to',
      text: 'are you open to a quick chat to see how this could work?'
    }
  ];
  for (const p of positives) {
    const r = detectColdPitch(p.text);
    expect(`positive: ${p.label}`, r.detected, true);
  }

  const negatives = [
    'hey bro',
    "I've been watching your videos for a while now",
    'caught your story about market structure',
    'do you have content on supply zones?',
    "what's good g, saw you posted about ORB"
  ];
  for (const n of negatives) {
    const r = detectColdPitch(n);
    expect(`negative: "${n}"`, r.detected, false);
  }

  expect('COLD_PITCH_PATTERNS count is 7', COLD_PITCH_PATTERNS.length, 7);

  // ── TEST 1: Omar end-to-end through processIncomingMessage ──
  console.log(
    "\n[TEST 1] Omar's exact message — processIncomingMessage marks SPAM + tags"
  );
  {
    const account = await makeAccount('omar');
    try {
      const result = await processIncomingMessage({
        accountId: account.id,
        platformUserId: `pu-omar-${account.id}`,
        platform: 'INSTAGRAM',
        senderName: 'Omar Cold Pitch',
        senderHandle: 'omar_smma',
        messageText: omarMessage,
        triggerType: 'DM'
      });
      expect('skipReply=true on cold pitch', result.skipReply, true);

      const convo = await prisma.conversation.findUniqueOrThrow({
        where: { id: result.conversationId },
        select: {
          outcome: true,
          aiActive: true,
          lead: {
            select: {
              tags: { include: { tag: { select: { name: true } } } }
            }
          }
        }
      });
      expect('outcome=SPAM after detection', convo.outcome, 'SPAM');
      // aiActive invariant — cold-pitch detection MUST NOT TOGGLE this
      // flag. Brand-new leads without account-level away mode default
      // to aiActive=false (lead-creation behaviour), so we verify the
      // detection didn't flip it; we DON'T require it to be true since
      // the default is already false. A separate sub-test below uses a
      // pre-created aiActive=true conversation to verify the no-toggle
      // contract directly.
      expect('aiActive unchanged from creation default', convo.aiActive, false);
    } finally {
      await cleanup(account.id);
    }
  }

  // ── TEST 1b: aiActive preservation under cold pitch ──────────
  console.log(
    '\n[TEST 1b] aiActive=true before cold pitch must still be true after'
  );
  {
    const account = await makeAccount('aiactive-preserve');
    try {
      // Plant the lead + conversation with aiActive=true ahead of time
      // (simulating an account with away mode enabled or a manual
      // operator override).
      const lead = await prisma.lead.create({
        data: {
          accountId: account.id,
          name: 'AIActive Preserve',
          handle: 'preserve_test',
          platform: 'INSTAGRAM',
          platformUserId: `pu-preserve-${account.id}`,
          stage: 'NEW_LEAD',
          triggerType: 'DM',
          conversation: { create: { aiActive: true } }
        }
      });
      const result = await processIncomingMessage({
        accountId: account.id,
        platformUserId: lead.platformUserId!,
        platform: 'INSTAGRAM',
        senderName: lead.name,
        senderHandle: lead.handle,
        messageText: omarMessage,
        triggerType: 'DM'
      });
      const convo = await prisma.conversation.findUniqueOrThrow({
        where: { id: result.conversationId },
        select: { outcome: true, aiActive: true }
      });
      expect('outcome=SPAM (re-confirm)', convo.outcome, 'SPAM');
      expect(
        'aiActive preserved as true (cold pitch must NOT pause)',
        convo.aiActive,
        true
      );
    } finally {
      await cleanup(account.id);
    }
  }

  // ── TEST 1c: tag + zero-AI invariants on a separate Omar run ──
  console.log(
    '\n[TEST 1c] cold-pitch tag applied + zero AI / ScheduledReply rows'
  );
  {
    const account = await makeAccount('omar-side');
    try {
      const result = await processIncomingMessage({
        accountId: account.id,
        platformUserId: `pu-omar2-${account.id}`,
        platform: 'INSTAGRAM',
        senderName: 'Omar Side',
        senderHandle: 'omar_side',
        messageText: omarMessage,
        triggerType: 'DM'
      });
      const convo = await prisma.conversation.findUniqueOrThrow({
        where: { id: result.conversationId },
        select: {
          lead: {
            select: {
              tags: { include: { tag: { select: { name: true } } } }
            }
          }
        }
      });
      const tagNames = convo.lead.tags.map((lt) => lt.tag.name);
      expect(
        'lead tagged cold-pitch',
        tagNames.includes(COLD_PITCH_TAG_NAME),
        true
      );
      const aiMsgs = await prisma.message.count({
        where: { conversationId: result.conversationId, sender: 'AI' }
      });
      expect('zero AI messages generated', aiMsgs, 0);
      const scheduled = await prisma.scheduledReply.count({
        where: { conversationId: result.conversationId }
      });
      expect('zero ScheduledReply rows', scheduled, 0);
    } finally {
      await cleanup(account.id);
    }
  }

  // ── TEST 2: Normal opener — no detection, normal processing ──
  console.log(
    '\n[TEST 2] Normal lead opener — no detection, downstream proceeds'
  );
  {
    const account = await makeAccount('normal');
    try {
      const result = await processIncomingMessage({
        accountId: account.id,
        platformUserId: `pu-normal-${account.id}`,
        platform: 'INSTAGRAM',
        senderName: 'Normal Lead',
        senderHandle: 'normal_lead',
        messageText: "hey bro I've been watching your videos",
        triggerType: 'DM'
      });
      // skipReply may be true OR false depending on aiActive default
      // (newly created lead with no away mode → AI off; that's fine).
      // What MUST be true: outcome != SPAM, no cold-pitch tag.
      const convo = await prisma.conversation.findUniqueOrThrow({
        where: { id: result.conversationId },
        select: {
          outcome: true,
          lead: {
            select: {
              tags: { include: { tag: { select: { name: true } } } }
            }
          }
        }
      });
      expect('outcome != SPAM on normal opener', convo.outcome, 'ONGOING');
      const tagNames = convo.lead.tags.map((lt) => lt.tag.name);
      expect(
        'no cold-pitch tag applied',
        tagNames.includes(COLD_PITCH_TAG_NAME),
        false
      );
    } finally {
      await cleanup(account.id);
    }
  }

  // ── TEST 3: Pitch-shape message AFTER prior history — NOT silenced ──
  console.log(
    '\n[TEST 3] Pitch-shape message after prior history — NOT silenced'
  );
  {
    const account = await makeAccount('midconvo');
    try {
      // First message: normal opener.
      const r1 = await processIncomingMessage({
        accountId: account.id,
        platformUserId: `pu-mid-${account.id}`,
        platform: 'INSTAGRAM',
        senderName: 'Mid Convo Lead',
        senderHandle: 'mid_convo',
        messageText: 'hey bro caught your last reel',
        triggerType: 'DM'
      });
      // Plant a fake AI reply so the second LEAD message lands at
      // aiMsgCount=1, leadMsgCount=2 — NOT first-contact.
      await prisma.message.create({
        data: {
          conversationId: r1.conversationId,
          sender: 'AI',
          content: 'yo bro appreciate it 💪🏿',
          timestamp: new Date()
        }
      });
      // Second LEAD message has agency-pitch shape but lands mid-convo.
      const r2 = await processIncomingMessage({
        accountId: account.id,
        platformUserId: `pu-mid-${account.id}`,
        platform: 'INSTAGRAM',
        senderName: 'Mid Convo Lead',
        senderHandle: 'mid_convo',
        messageText:
          'btw I helped a coach grow from 800 to 55k followers — figured it might resonate with you',
        triggerType: 'DM'
      });
      const convo = await prisma.conversation.findUniqueOrThrow({
        where: { id: r2.conversationId },
        select: {
          outcome: true,
          lead: {
            select: {
              tags: { include: { tag: { select: { name: true } } } }
            }
          }
        }
      });
      expect(
        'outcome NOT SPAM on mid-convo pitch shape',
        convo.outcome === 'SPAM',
        false
      );
      const tagNames = convo.lead.tags.map((lt) => lt.tag.name);
      expect(
        'no cold-pitch tag mid-convo',
        tagNames.includes(COLD_PITCH_TAG_NAME),
        false
      );
    } finally {
      await cleanup(account.id);
    }
  }

  // ── TEST 4: Default conversation-list query excludes cold-pitch ──
  console.log(
    '\n[TEST 4] Default conversation-list filter excludes cold-pitch tag'
  );
  {
    const account = await makeAccount('listfilter');
    try {
      // Plant 1 cold pitch + 1 normal lead.
      await processIncomingMessage({
        accountId: account.id,
        platformUserId: `pu-cp1-${account.id}`,
        platform: 'INSTAGRAM',
        senderName: 'Cold Pitch 1',
        senderHandle: 'cp1',
        messageText: omarMessage,
        triggerType: 'DM'
      });
      await processIncomingMessage({
        accountId: account.id,
        platformUserId: `pu-clean-${account.id}`,
        platform: 'INSTAGRAM',
        senderName: 'Normal Lead 1',
        senderHandle: 'clean1',
        messageText: 'hey bro',
        triggerType: 'DM'
      });

      // Mirror the conversations route's leadFilter shape (default).
      const defaultList = await prisma.conversation.count({
        where: {
          lead: {
            accountId: account.id,
            tags: { none: { tag: { name: COLD_PITCH_TAG_NAME } } }
          }
        }
      });
      expect('default list shows 1 (excluding cold-pitch)', defaultList, 1);

      // Tag-only filter shows the cold pitch.
      const coldOnly = await prisma.conversation.count({
        where: {
          lead: {
            accountId: account.id,
            tags: { some: { tag: { name: COLD_PITCH_TAG_NAME } } }
          }
        }
      });
      expect('tag=cold-pitch list shows 1', coldOnly, 1);
    } finally {
      await cleanup(account.id);
    }
  }

  // ── TEST 5: leadsToday count excludes cold pitch ──────────────
  console.log('\n[TEST 5] leadsToday metric excludes cold-pitch leads');
  {
    const account = await makeAccount('metric');
    try {
      await processIncomingMessage({
        accountId: account.id,
        platformUserId: `pu-cp2-${account.id}`,
        platform: 'INSTAGRAM',
        senderName: 'Cold Pitch 2',
        senderHandle: 'cp2',
        messageText: omarMessage,
        triggerType: 'DM'
      });
      await processIncomingMessage({
        accountId: account.id,
        platformUserId: `pu-clean2-${account.id}`,
        platform: 'INSTAGRAM',
        senderName: 'Normal Lead 2',
        senderHandle: 'clean2',
        messageText: 'whats good g',
        triggerType: 'DM'
      });

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // Mirror the analytics/overview endpoint.
      const leadsToday = await prisma.lead.count({
        where: {
          accountId: account.id,
          createdAt: { gte: todayStart },
          tags: { none: { tag: { name: COLD_PITCH_TAG_NAME } } }
        }
      });
      const leadsTodayFiltered = await prisma.lead.count({
        where: {
          accountId: account.id,
          createdAt: { gte: todayStart },
          tags: { some: { tag: { name: COLD_PITCH_TAG_NAME } } }
        }
      });
      expect('leadsToday excludes cold-pitch', leadsToday, 1);
      expect('leadsTodayFiltered counts cold-pitch', leadsTodayFiltered, 1);
    } finally {
      await cleanup(account.id);
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
