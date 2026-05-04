/**
 * Smoke test for the three CRITICAL escalation paths.
 *
 * Fires `escalate()` once per type (`scheduling_conflict`, `distress`,
 * `ai_stuck`) with synthetic payload. Each call:
 *   1. Writes an in-app Notification row.
 *   2. Resolves the account ADMIN's email.
 *   3. Sends the alert via Resend (if RESEND_API_KEY is set + the
 *      notifyOn{Type} preference is on).
 *
 * Usage:
 *   pnpm tsx scripts/test-escalation-emails.ts <accountId>
 *
 * If you don't pass an accountId we auto-pick the oldest account so you
 * can run this with zero args during development.
 *
 * Cleanup: each Notification row written by this script is deleted at
 * the end so the dashboard isn't polluted with fake URGENT rows.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import { escalate, type EscalationType } from '../src/lib/escalation-dispatch';

interface TestCase {
  type: EscalationType;
  title: string;
  body: string;
  details: string;
}

const CASES: TestCase[] = [
  {
    type: 'scheduling_conflict',
    title: 'Scheduling conflict — TEST',
    body:
      'Lead requested a time outside available booking slots. Operator ' +
      'review needed before the AI proposes an alternative.',
    details: 'Sunday 6pm Romania (EET/UTC+2), wants phone call'
  },
  {
    type: 'distress',
    title: 'Distress signal detected — TEST',
    body:
      'Lead message contained a distress phrase ("I can\'t do this anymore"). ' +
      'AI paused all replies on this conversation pending operator review.',
    details: 'Trigger phrase: "I can\'t do this anymore"'
  },
  {
    type: 'ai_stuck',
    title: 'Lead stuck — AI cannot help — TEST',
    body:
      'AI exhausted its retry budget on this lead and cannot determine a ' +
      'next-message strategy. Operator handoff requested.',
    details: 'Loop detected after 4 voice-quality-gate hard-fails in 5 turns'
  }
];

async function main() {
  const accountId =
    process.argv[2] ??
    (
      await prisma.account.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { id: true }
      })
    )?.id;

  if (!accountId) {
    console.error('No accountId given and no Account row found. Aborting.');
    process.exit(1);
  }

  // Sanity check the destination
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      notifyOnSchedulingConflict: true,
      notifyOnDistress: true,
      notifyOnAIStuck: true
    }
  });
  if (!account) {
    console.error(`Account ${accountId} not found.`);
    process.exit(1);
  }

  const owner =
    (await prisma.user.findFirst({
      where: { accountId, role: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
      select: { email: true, name: true }
    })) ??
    (await prisma.user.findFirst({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
      select: { email: true, name: true }
    }));

  console.log(`\n=== Escalation email smoke test ===`);
  console.log(`Account:                    ${account.id}`);
  console.log(`Email recipient:            ${owner?.email ?? '(none)'}`);
  console.log(
    `notifyOnSchedulingConflict: ${account.notifyOnSchedulingConflict}`
  );
  console.log(`notifyOnDistress:           ${account.notifyOnDistress}`);
  console.log(`notifyOnAIStuck:            ${account.notifyOnAIStuck}`);
  console.log(``);
  if (!owner?.email) {
    console.error(
      `\n[abort] No user email on this account — escalation cannot deliver. ` +
        `Add a user with role ADMIN before re-running.`
    );
    process.exit(1);
  }

  // Find any lead on this account so the email body has a name
  const lead = await prisma.lead.findFirst({
    where: { accountId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      handle: true,
      conversation: { select: { id: true } }
    }
  });

  console.log(
    `Test lead: ${lead?.name ?? '(synthetic)'} ${lead?.handle ? `@${lead.handle}` : ''}\n`
  );

  const createdNotificationIds: string[] = [];

  for (const tc of CASES) {
    console.log(`→ Firing ${tc.type}...`);
    const res = await escalate({
      type: tc.type,
      accountId: account.id,
      leadId: lead?.id,
      conversationId: lead?.conversation?.id,
      leadName: lead?.name ?? 'Test Lead',
      leadHandle: lead?.handle ?? 'test_handle',
      title: tc.title,
      body: tc.body,
      details: tc.details,
      link: lead?.conversation?.id
        ? `https://qualifydms.io/dashboard/conversations?conversationId=${lead.conversation.id}`
        : undefined
    });

    console.log(
      `  notificationId=${res.notificationId ?? 'null'}, ` +
        `emailOk=${res.emailOk}, ` +
        `channels=[${res.channels.join(',')}]` +
        (res.emailError ? `, emailError=${res.emailError}` : '')
    );

    if (res.notificationId) createdNotificationIds.push(res.notificationId);
  }

  // Cleanup: delete the synthetic Notification rows so the dashboard
  // doesn't show fake URGENT rows after the test.
  if (createdNotificationIds.length > 0) {
    const del = await prisma.notification.deleteMany({
      where: { id: { in: createdNotificationIds } }
    });
    console.log(`\n[cleanup] Deleted ${del.count} test Notification rows.`);
  }

  console.log(
    `\n✓ Test complete. Check inbox at ${owner.email} for 3 emails:\n` +
      `  • 🚨 Scheduling conflict — …\n` +
      `  • 🚨 Distress signal detected — …\n` +
      `  • 🚨 Lead stuck — AI cannot help — …`
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
