/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// fix-tegaumukoro-conversation.ts
// ---------------------------------------------------------------------------
// One-off recovery for @tegaumukoro_'s test conversation. Phases:
//
//   1. Resets stale STAGE state only — systemStage=null,
//      currentScriptStep=1, llmEmittedStage=null, stageMismatchCount=0,
//      silentStopCount=0, awaitingAiResponse=true (re-armed),
//      awaitingSince=last lead message timestamp.
//   2. PRESERVES capturedDataPoints — early_obstacle and any other
//      runtime-judgment captures stay intact. Wiping them would force
//      the AI to re-ask qualification questions the lead already
//      answered.
//   3. Cancels any PENDING / PROCESSING ScheduledReply rows so a new
//      schedule starts clean.
//   4. Re-invokes scheduleAIReply — the AI responds to the lead's most
//      recent message (the "Around 4k a month" reply that got dropped).
//      With priorAIMessages.length ≈ 8, the focus-mode injection
//      surfaces Step 8 (Replace vs Supplement) as the current step.
//
// Usage:
//   npx tsx scripts/fix-tegaumukoro-conversation.ts <conversationId>
//   npx tsx scripts/fix-tegaumukoro-conversation.ts <conversationId> --dry-run
//
// Without --dry-run, the script DOES write to the DB and DOES schedule an
// AI reply. With --dry-run, prints the planned changes without writing.
// ---------------------------------------------------------------------------

import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { scheduleAIReply } from '../src/lib/webhook-processor';

async function main() {
  const conversationId = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');

  if (!conversationId) {
    console.error(
      'Usage: npx tsx scripts/fix-tegaumukoro-conversation.ts <conversationId> [--dry-run]'
    );
    process.exit(1);
  }

  // 1. Verify the conversation exists and is the one we expect.
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      lead: { select: { id: true, handle: true, accountId: true, stage: true } }
    }
  });
  if (!convo) {
    console.error(`Conversation ${conversationId} not found.`);
    process.exit(1);
  }
  if (!convo.lead) {
    console.error(`Conversation ${conversationId} has no Lead row.`);
    process.exit(1);
  }
  if (!/tegaumukoro/i.test(convo.lead.handle)) {
    console.error(
      `Refusing to run: lead handle "@${convo.lead.handle}" doesn't match the expected target. ` +
        `If this is intentional, edit the script's safety check.`
    );
    process.exit(1);
  }

  console.log(
    '================================================================'
  );
  console.log(`Conversation: ${convo.id}`);
  console.log(`Lead:         ${convo.lead.id} @${convo.lead.handle}`);
  console.log(`Account:      ${convo.lead.accountId}`);
  console.log(`Mode:         ${dryRun ? 'DRY RUN' : 'WRITE'}`);
  console.log(
    '================================================================'
  );

  // 2. Show current state for the audit log.
  console.log('');
  console.log('BEFORE:');
  console.log(`  systemStage:        ${convo.systemStage ?? 'null'}`);
  console.log(`  currentScriptStep:  ${convo.currentScriptStep}`);
  console.log(`  awaitingAiResponse: ${convo.awaitingAiResponse}`);
  console.log(
    `  awaitingSince:      ${convo.awaitingSince?.toISOString() ?? 'null'}`
  );
  console.log(`  llmEmittedStage:    ${convo.llmEmittedStage ?? 'null'}`);
  console.log(`  stageMismatchCount: ${convo.stageMismatchCount}`);
  console.log(`  silentStopCount:    ${convo.silentStopCount}`);
  console.log(
    `  capturedDataPoints: ${JSON.stringify(convo.capturedDataPoints)}`
  );

  // 3. Find the most recent LEAD message — that's the message the AI
  //    needs to respond to.
  const lastLead = await prisma.message.findFirst({
    where: { conversationId, sender: 'LEAD', deletedAt: null },
    orderBy: { timestamp: 'desc' },
    select: { id: true, timestamp: true, content: true }
  });
  if (!lastLead) {
    console.error('No LEAD message found on this conversation — bailing.');
    process.exit(1);
  }
  console.log('');
  console.log(
    `Last LEAD message at ${lastLead.timestamp.toISOString()}: "${(lastLead.content || '').slice(0, 120)}"`
  );

  if (dryRun) {
    console.log('');
    console.log('PLANNED UPDATES (dry-run, no writes):');
    console.log(
      '  Conversation: systemStage=null, currentScriptStep=1, awaitingAiResponse=true, awaitingSince=<last lead ts>, llmEmittedStage=null, stageMismatchCount=0, silentStopCount=0'
    );
    console.log(
      '  capturedDataPoints PRESERVED (no wipe — keeps early_obstacle etc.)'
    );
    console.log(
      '  ScheduledReply: cancel all PENDING/PROCESSING rows on this conversation'
    );
    console.log(
      "  scheduleAIReply: would be invoked to generate a fresh response to the lead's last message"
    );
    return;
  }

  // 4. Cancel pending scheduled replies.
  const cancelled = await prisma.scheduledReply.updateMany({
    where: {
      conversationId,
      status: { in: ['PENDING', 'PROCESSING'] }
    },
    data: { status: 'CANCELLED' }
  });
  console.log('');
  console.log(
    `Cancelled ${cancelled.count} pending/processing ScheduledReply row(s).`
  );

  // 5. Reset STAGE state. Preserves capturedDataPoints intentionally —
  //    early_obstacle and any other runtime captures remain valid for
  //    this conversation.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      systemStage: null,
      currentScriptStep: 1,
      llmEmittedStage: null,
      stageMismatchCount: 0,
      silentStopCount: 0,
      awaitingAiResponse: true,
      awaitingSince: lastLead.timestamp,
      aiActive: true
    }
  });
  console.log(
    'Stage state reset (systemStage=null, currentScriptStep=1, llmEmittedStage=null, stageMismatchCount=0, silentStopCount=0, re-armed for AI). capturedDataPoints preserved.'
  );

  // 6. Re-fetch + show AFTER state.
  const after = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      systemStage: true,
      currentScriptStep: true,
      awaitingAiResponse: true,
      awaitingSince: true,
      capturedDataPoints: true,
      llmEmittedStage: true,
      stageMismatchCount: true,
      silentStopCount: true,
      aiActive: true
    }
  });
  console.log('');
  console.log('AFTER:');
  console.log(`  systemStage:        ${after?.systemStage ?? 'null'}`);
  console.log(`  currentScriptStep:  ${after?.currentScriptStep}`);
  console.log(`  awaitingAiResponse: ${after?.awaitingAiResponse}`);
  console.log(
    `  awaitingSince:      ${after?.awaitingSince?.toISOString() ?? 'null'}`
  );
  console.log(`  llmEmittedStage:    ${after?.llmEmittedStage ?? 'null'}`);
  console.log(`  stageMismatchCount: ${after?.stageMismatchCount}`);
  console.log(`  silentStopCount:    ${after?.silentStopCount}`);
  console.log(`  aiActive:           ${after?.aiActive}`);
  console.log(
    `  capturedDataPoints: ${JSON.stringify(after?.capturedDataPoints)}`
  );

  // 7. Trigger AI generation. scheduleAIReply enqueues the reply via
  //    the existing pipeline so the LLM call + voice-quality gate +
  //    Meta send all run identically to a real webhook event.
  console.log('');
  console.log('Invoking scheduleAIReply...');
  await scheduleAIReply(conversationId, convo.lead.accountId);
  console.log(
    'scheduleAIReply returned. The reply will deliver via the normal scheduled-message cron / pipeline.'
  );
  console.log('');
  console.log(
    'Watch Vercel logs for [ai-engine] / [webhook-processor] entries on this conversation. Expect Step 8 (replace-vs-supplement) since lead just stated 4k income goal.'
  );
}

main()
  .catch((err) => {
    console.error('[fix-tegaumukoro] FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
