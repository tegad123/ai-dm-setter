/* eslint-disable no-console */
// Recover Wout Lngrs from the 2026-05-01 P0 disqualification.
//
// What broke (root cause already shipped via f688efa):
//   • R24 re-evaluated post-booking, parser misread "12am" as $12,
//     deterministic fallback shipped a downsell to a qualified +
//     booked lead.
//   • The bad ship cascaded: lead.stage → UNQUALIFIED, aiActive=
//     false, all 3 PRE_CALL_HOMEWORK / CALL_DAY_CONFIRMATION /
//     CALL_DAY_REMINDER scheduled messages got CANCELLED.
//
// What this script restores:
//   1. lead.stage → BOOKED (with stage-transition audit row)
//   2. lead.previousStage → snapshot (currently UNQUALIFIED)
//   3. conversation.aiActive → true
//   4. Re-creates the 3 call-day scheduled messages via the
//      production scheduleCallConfirmationSequence helper, which
//      uses the same bubble templates the original rows used.
//
// Dry-run by default. Pass --apply to execute.
//
// Usage:
//   npx tsx scripts/recover-wout-lngrs.ts            # dry-run
//   npx tsx scripts/recover-wout-lngrs.ts --apply    # apply
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
import prisma from '../src/lib/prisma';
import { scheduleCallConfirmationSequence } from '../src/lib/call-confirmation-sequence';

const APPLY = process.argv.includes('--apply');

async function main() {
  const lead = await prisma.lead.findFirst({
    where: {
      OR: [
        { name: { contains: 'Wout Lngrs', mode: 'insensitive' } },
        { handle: { contains: 'lngrs', mode: 'insensitive' } }
      ]
    },
    include: {
      conversation: {
        select: {
          id: true,
          aiActive: true,
          scheduledCallAt: true,
          callConfirmed: true,
          callConfirmedAt: true,
          leadTimezone: true
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (!lead?.conversation) {
    console.error('✗ Wout Lngrs not found.');
    await prisma.$disconnect();
    process.exit(1);
  }
  const conv = lead.conversation;

  console.log(
    `Lead ${lead.id} @${lead.handle} (${lead.name})\n  current stage=${lead.stage}  previousStage=${lead.previousStage ?? '-'}  aiActive=${conv.aiActive}  scheduledCallAt=${conv.scheduledCallAt?.toISOString() ?? 'null'}`
  );

  if (!conv.scheduledCallAt) {
    console.error(
      '\n✗ scheduledCallAt is null — refusing to restore a call sequence with no booking time. Manual intervention required.'
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  const expectedCallAt = new Date('2026-05-03T22:00:00.000Z');
  if (conv.scheduledCallAt.getTime() !== expectedCallAt.getTime()) {
    console.warn(
      `⚠  scheduledCallAt (${conv.scheduledCallAt.toISOString()}) does not match expected ${expectedCallAt.toISOString()} — proceeding with the live value.`
    );
  }

  // Show the planned scheduled-message timestamps relative to the
  // booking. (scheduleCallConfirmationSequence does the same math.)
  const HOUR_MS = 60 * 60 * 1000;
  const callMs = conv.scheduledCallAt.getTime();
  console.log('\nPlanned restore:');
  console.log('  lead.stage:                UNQUALIFIED → BOOKED');
  console.log(
    `  lead.previousStage:        ${lead.previousStage ?? '-'} → ${lead.stage}`
  );
  console.log(`  conversation.aiActive:     ${conv.aiActive} → true`);
  console.log('  Re-create scheduled messages:');
  console.log(
    `    PRE_CALL_HOMEWORK       at ${new Date(callMs - 20 * HOUR_MS).toISOString()} (call - 20h)`
  );
  console.log(
    `    CALL_DAY_CONFIRMATION   at ${new Date(callMs - 3 * HOUR_MS).toISOString()}  (call - 3h)`
  );
  console.log(
    `    CALL_DAY_REMINDER       at ${new Date(callMs - 2 * HOUR_MS).toISOString()}  (call - 2h)`
  );

  if (!APPLY) {
    console.log('\n(dry-run — no changes applied. Pass --apply to execute.)');
    await prisma.$disconnect();
    return;
  }

  const fromStage = lead.stage;

  // 1. Lead stage transition.
  const now = new Date();
  await prisma.$transaction([
    prisma.lead.update({
      where: { id: lead.id },
      data: {
        stage: 'BOOKED',
        previousStage: fromStage,
        stageEnteredAt: now
      }
    }),
    prisma.leadStageTransition.create({
      data: {
        leadId: lead.id,
        fromStage,
        toStage: 'BOOKED',
        transitionedBy: 'system',
        reason: 'recover-wout-lngrs: P0 disqualification reverted (f688efa)'
      }
    })
  ]);

  // 2. Re-enable AI on the conversation.
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { aiActive: true }
  });

  // 3. Re-schedule the call sequence using the production helper —
  //    same bubble templates, same timing offsets, same idempotent
  //    cancel-then-create transaction. This is the exact code path
  //    that originally created the now-cancelled rows.
  const result = await scheduleCallConfirmationSequence({
    conversationId: conv.id,
    accountId: lead.accountId,
    scheduledCallAt: conv.scheduledCallAt,
    leadTimezone: conv.leadTimezone ?? null,
    createdByUserId: null
  });

  console.log('\nWout Lngrs restored:');
  console.log(`  stage:                    BOOKED`);
  console.log(`  aiActive:                 true`);
  console.log(
    `  scheduledCallAt:          ${conv.scheduledCallAt.toISOString()}`
  );
  const created = [
    result.homeworkId ? 'PRE_CALL_HOMEWORK' : null,
    result.confirmationId ? 'CALL_DAY_CONFIRMATION' : null,
    result.reminderId ? 'CALL_DAY_REMINDER' : null
  ].filter(Boolean);
  console.log(
    `  ${created.length} scheduled message${created.length === 1 ? '' : 's'} re-created: ${created.join(', ')}`
  );
  if (
    result.homeworkId === null &&
    conv.scheduledCallAt.getTime() - 20 * HOUR_MS < now.getTime()
  ) {
    console.log(
      '  (PRE_CALL_HOMEWORK skipped — call - 20h is already in the past.)'
    );
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
