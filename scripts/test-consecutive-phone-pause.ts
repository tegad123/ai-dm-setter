/* eslint-disable no-console */
// Integration test for the consecutive-PHONE auto-pause heuristic added
// to processAdminMessage. Creates a synthetic test account / lead /
// conversation, exercises the handler twice in a row, and asserts:
//
//   1. After ONE PHONE message → conversation.aiActive stays TRUE
//   2. After a SECOND PHONE message (no LEAD msg between) → aiActive flips FALSE
//
// Cleans up all created rows on completion (success or failure).

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';
import { processAdminMessage } from '../src/lib/webhook-processor';

let pass = 0;
let fail = 0;

function assert(label: string, actual: unknown, expected: unknown) {
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

async function main() {
  // ── Setup ─────────────────────────────────────────────────────
  const stamp = `consecutive-phone-test-${Date.now()}`;
  console.log(`\nCreating synthetic account "${stamp}"…`);
  const account = await prisma.account.create({
    data: { name: stamp, slug: stamp }
  });
  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      name: 'Test Lead',
      handle: 'test_lead',
      platform: 'INSTAGRAM',
      platformUserId: `pu-${stamp}`,
      stage: 'NEW_LEAD',
      triggerType: 'DM',
      conversation: { create: { aiActive: true } }
    },
    include: { conversation: true }
  });
  const conversationId = lead.conversation!.id;

  try {
    // ── Test 1: single PHONE message → aiActive stays TRUE ──────
    console.log('\n[1] Single PHONE message — aiActive must stay TRUE');
    await processAdminMessage({
      accountId: account.id,
      platformUserId: lead.platformUserId!,
      platform: 'INSTAGRAM',
      messageText: 'Daniel typing context line 1',
      platformMessageId: `mid-1-${stamp}`
    });
    let convo = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { aiActive: true }
    });
    assert('aiActive after 1 PHONE msg', convo.aiActive, true);

    // ── Test 2: second consecutive PHONE → aiActive flips FALSE ─
    console.log('\n[2] Second consecutive PHONE — aiActive must flip FALSE');
    await processAdminMessage({
      accountId: account.id,
      platformUserId: lead.platformUserId!,
      platform: 'INSTAGRAM',
      messageText: 'Daniel typing context line 2',
      platformMessageId: `mid-2-${stamp}`
    });
    convo = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { aiActive: true }
    });
    assert('aiActive after 2 consecutive PHONE msgs', convo.aiActive, false);

    // ── Test 3: with a LEAD msg in between, NO auto-pause ───────
    // Reset and verify the gating: PHONE → LEAD → PHONE should NOT
    // pause (the LEAD reply broke the consecutive run).
    console.log(
      '\n[3] PHONE → LEAD → PHONE (interrupted) — aiActive must stay TRUE'
    );
    // Wipe messages + restore aiActive on the existing conversation so
    // we can re-test the same conversation row.
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { aiActive: true }
    });
    await processAdminMessage({
      accountId: account.id,
      platformUserId: lead.platformUserId!,
      platform: 'INSTAGRAM',
      messageText: 'PHONE msg before lead reply',
      platformMessageId: `mid-3-${stamp}`
    });
    // Inject a LEAD message to break the run.
    await prisma.message.create({
      data: {
        conversationId,
        sender: 'LEAD',
        content: 'lead reply between',
        timestamp: new Date(Date.now() + 1)
      }
    });
    await processAdminMessage({
      accountId: account.id,
      platformUserId: lead.platformUserId!,
      platform: 'INSTAGRAM',
      messageText: 'PHONE msg after lead reply',
      platformMessageId: `mid-4-${stamp}`
    });
    convo = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { aiActive: true }
    });
    assert('aiActive after PHONE→LEAD→PHONE', convo.aiActive, true);

    // ── Test 4: humanSource=PHONE check is required (DASHBOARD doesn't count) ─
    console.log(
      '\n[4] DASHBOARD before PHONE — aiActive must stay TRUE (different humanSource)'
    );
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { aiActive: true }
    });
    // Synthesize a HUMAN/DASHBOARD send (as if from the dashboard
    // composer, not the phone echo path).
    await prisma.message.create({
      data: {
        conversationId,
        sender: 'HUMAN',
        humanSource: 'DASHBOARD',
        content: 'dashboard send',
        timestamp: new Date()
      }
    });
    await processAdminMessage({
      accountId: account.id,
      platformUserId: lead.platformUserId!,
      platform: 'INSTAGRAM',
      messageText: 'PHONE msg after dashboard send',
      platformMessageId: `mid-5-${stamp}`
    });
    convo = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { aiActive: true }
    });
    assert('aiActive after DASHBOARD→PHONE', convo.aiActive, true);
  } finally {
    // ── Cleanup ───────────────────────────────────────────────
    console.log('\nCleaning up synthetic data…');
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.scheduledReply.deleteMany({ where: { conversationId } });
    await prisma.conversation.delete({ where: { id: conversationId } });
    await prisma.lead.delete({ where: { id: lead.id } });
    await prisma.account.delete({ where: { id: account.id } });
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
