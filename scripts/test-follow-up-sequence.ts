/**
 * Integration tests for follow-up-sequence.ts and the ship-time
 * link-promise guard.
 *
 * Creates a disposable account+lead+conversation, runs the real
 * functions against real Prisma, asserts DB state, then cleans up.
 *
 * Run: npx tsx scripts/test-follow-up-sequence.ts
 */
import 'dotenv/config';
import prisma from '../src/lib/prisma';
import {
  containsBookingLink,
  scheduleBookingLinkFollowup,
  scheduleFollowUp1AfterAiMessage,
  scheduleNextInCascade,
  cancelAllPendingFollowUps,
  TYPEFORM_BOOKING_URL,
  FOLLOW_UP_BODIES
} from '../src/lib/follow-up-sequence';

let pass = 0;
let fail = 0;

function assert(condition: unknown, label: string, detail?: string) {
  if (condition) {
    console.log(`✓ ${label}`);
    pass++;
  } else {
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

async function withTestConvo<T>(
  run: (ctx: {
    accountId: string;
    leadId: string;
    conversationId: string;
  }) => Promise<T>
): Promise<T> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const account = await prisma.account.create({
    data: {
      name: `followup-test-${suffix}`,
      slug: `followup-test-${suffix}`
    }
  });
  const persona = await prisma.aIPersona.create({
    data: {
      accountId: account.id,
      personaName: 'Test Persona',
      fullName: 'Test',
      systemPrompt: '',
      isActive: true
    },
    select: { id: true }
  });
  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      name: `Lead ${suffix}`,
      handle: `lead_${suffix}`,
      platform: 'FACEBOOK',
      platformUserId: `psid_${suffix}`,
      triggerType: 'DM'
    }
  });
  const conversation = await prisma.conversation.create({
    data: {
      leadId: lead.id,
      personaId: persona.id,
      aiActive: true
    }
  });
  try {
    return await run({
      accountId: account.id,
      leadId: lead.id,
      conversationId: conversation.id
    });
  } finally {
    await prisma.scheduledMessage
      .deleteMany({ where: { conversationId: conversation.id } })
      .catch(() => {});
    await prisma.message
      .deleteMany({ where: { conversationId: conversation.id } })
      .catch(() => {});
    await prisma.conversation
      .delete({ where: { id: conversation.id } })
      .catch(() => {});
    await prisma.leadStageTransition
      .deleteMany({ where: { leadId: lead.id } })
      .catch(() => {});
    await prisma.lead.delete({ where: { id: lead.id } }).catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

async function main() {
  // ── TEST 1 — containsBookingLink positive ──────────────────────
  assert(
    containsBookingLink(
      `yo bro, here's the link: ${TYPEFORM_BOOKING_URL} fill it out`
    ),
    'TEST 1 — containsBookingLink matches Typeform booking URL'
  );

  // ── TEST 2 — containsBookingLink negative ──────────────────────
  assert(
    !containsBookingLink("hey what's up no link here"),
    'TEST 2 — containsBookingLink returns false on plain text'
  );
  assert(
    !containsBookingLink('here is some random url https://example.com/xyz'),
    'TEST 2b — containsBookingLink returns false on unrelated URL'
  );

  // ── TEST 3 — scheduleBookingLinkFollowup creates row ────────────
  await withTestConvo(async ({ accountId, conversationId }) => {
    await scheduleBookingLinkFollowup(conversationId, accountId);
    const row = await prisma.scheduledMessage.findFirst({
      where: { conversationId, messageType: 'BOOKING_LINK_FOLLOWUP' }
    });
    assert(
      !!row,
      'TEST 3a — BOOKING_LINK_FOLLOWUP row created',
      row ? undefined : 'no row found'
    );
    assert(
      row?.messageBody === FOLLOW_UP_BODIES.BOOKING_LINK_FOLLOWUP,
      'TEST 3b — body matches expected static template'
    );
    assert(
      row?.generateAtSendTime === false,
      'TEST 3c — generateAtSendTime is false (static body)'
    );
    const diffMs = row ? row.scheduledFor.getTime() - Date.now() : 0;
    assert(
      diffMs > 28 * 60_000 && diffMs < 32 * 60_000,
      'TEST 3d — scheduledFor ≈ 30min from now',
      `diffMs=${diffMs}`
    );
  });

  // ── TEST 4 — scheduleBookingLinkFollowup is idempotent ──────────
  await withTestConvo(async ({ accountId, conversationId }) => {
    await scheduleBookingLinkFollowup(conversationId, accountId);
    await scheduleBookingLinkFollowup(conversationId, accountId);
    const count = await prisma.scheduledMessage.count({
      where: {
        conversationId,
        messageType: 'BOOKING_LINK_FOLLOWUP',
        status: 'PENDING'
      }
    });
    assert(
      count === 1,
      'TEST 4 — scheduleBookingLinkFollowup is idempotent (1 row)',
      `count=${count}`
    );
  });

  // ── TEST 5 — scheduleFollowUp1AfterAiMessage creates row ────────
  await withTestConvo(async ({ accountId, conversationId }) => {
    await scheduleFollowUp1AfterAiMessage(conversationId, accountId);
    const row = await prisma.scheduledMessage.findFirst({
      where: {
        conversationId,
        messageType: 'FOLLOW_UP_1',
        status: 'PENDING'
      }
    });
    assert(!!row, 'TEST 5a — FOLLOW_UP_1 row created on AI-ship hook');
    const diffMs = row ? row.scheduledFor.getTime() - Date.now() : 0;
    assert(
      diffMs > 11 * 60 * 60_000 && diffMs < 13 * 60 * 60_000,
      'TEST 5b — FOLLOW_UP_1 scheduled ≈ 12h from now',
      `diffMs=${diffMs}`
    );
  });

  // ── TEST 6 — scheduleFollowUp1 resets existing chain ────────────
  await withTestConvo(async ({ accountId, conversationId }) => {
    // Simulate a stale chain: FOLLOW_UP_2 in-flight from a prior AI msg
    await prisma.scheduledMessage.create({
      data: {
        conversationId,
        accountId,
        scheduledFor: new Date(Date.now() + 6 * 60 * 60_000),
        messageType: 'FOLLOW_UP_2',
        messageBody: FOLLOW_UP_BODIES.FOLLOW_UP_2,
        generateAtSendTime: false,
        createdBy: 'AI'
      }
    });
    await scheduleFollowUp1AfterAiMessage(conversationId, accountId);
    const stale = await prisma.scheduledMessage.findFirst({
      where: {
        conversationId,
        messageType: 'FOLLOW_UP_2'
      }
    });
    const fresh = await prisma.scheduledMessage.findFirst({
      where: {
        conversationId,
        messageType: 'FOLLOW_UP_1',
        status: 'PENDING'
      }
    });
    assert(
      stale?.status === 'CANCELLED',
      'TEST 6a — stale FOLLOW_UP_2 cancelled on new AI-ship',
      `status=${stale?.status}`
    );
    assert(!!fresh, 'TEST 6b — new FOLLOW_UP_1 scheduled after reset');
  });

  // ── TEST 7 — cascade: FOLLOW_UP_1 → _2 → _3 → _SOFT_EXIT → null ─
  await withTestConvo(async ({ accountId, conversationId }) => {
    const next1 = await scheduleNextInCascade(
      conversationId,
      accountId,
      'FOLLOW_UP_1'
    );
    assert(next1 === 'FOLLOW_UP_2', 'TEST 7a — FOLLOW_UP_1 → FOLLOW_UP_2');
    const next2 = await scheduleNextInCascade(
      conversationId,
      accountId,
      'FOLLOW_UP_2'
    );
    assert(next2 === 'FOLLOW_UP_3', 'TEST 7b — FOLLOW_UP_2 → FOLLOW_UP_3');
    const next3 = await scheduleNextInCascade(
      conversationId,
      accountId,
      'FOLLOW_UP_3'
    );
    assert(
      next3 === 'FOLLOW_UP_SOFT_EXIT',
      'TEST 7c — FOLLOW_UP_3 → FOLLOW_UP_SOFT_EXIT'
    );
    const nextTerminal = await scheduleNextInCascade(
      conversationId,
      accountId,
      'FOLLOW_UP_SOFT_EXIT'
    );
    assert(
      nextTerminal === null,
      'TEST 7d — FOLLOW_UP_SOFT_EXIT → null (chain ends)'
    );
  });

  // ── TEST 8 — cancelAllPendingFollowUps wipes the chain + booking ──
  await withTestConvo(async ({ accountId, conversationId }) => {
    await scheduleFollowUp1AfterAiMessage(conversationId, accountId);
    await scheduleBookingLinkFollowup(conversationId, accountId);
    const before = await prisma.scheduledMessage.count({
      where: { conversationId, status: 'PENDING' }
    });
    assert(before === 2, 'TEST 8a — two PENDING rows before cancel');
    const cancelled = await cancelAllPendingFollowUps(conversationId);
    assert(cancelled === 2, 'TEST 8b — cancelAllPendingFollowUps returns 2');
    const after = await prisma.scheduledMessage.count({
      where: { conversationId, status: 'PENDING' }
    });
    assert(
      after === 0,
      'TEST 8c — zero PENDING rows after cancel',
      `after=${after}`
    );
    const cancelledCount = await prisma.scheduledMessage.count({
      where: { conversationId, status: 'CANCELLED' }
    });
    assert(
      cancelledCount === 2,
      'TEST 8d — two rows now CANCELLED',
      `cancelled=${cancelledCount}`
    );
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('TEST RUNNER CRASHED:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
