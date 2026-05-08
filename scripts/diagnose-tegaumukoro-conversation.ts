/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// diagnose-tegaumukoro-conversation.ts
// ---------------------------------------------------------------------------
// Read-only inspection of @tegaumukoro_'s test conversation under
// daetradez2003's account. Reports:
//   - conversation row state (systemStage, currentScriptStep, awaitingAiResponse,
//     aiActive, capturedDataPoints, lastMessageAt)
//   - last 15 messages (sender + content + timestamp)
//   - any pending ScheduledReply rows
//   - ScriptStep that "DIDNT_RECEIVE_HOMEWORK" maps to (so the operator can
//     confirm the stage drift)
//
// Run:
//   npx tsx scripts/diagnose-tegaumukoro-conversation.ts
// ---------------------------------------------------------------------------

import 'dotenv/config';
import prisma from '../src/lib/prisma';

const TARGET_HANDLE = 'tegaumukoro_';

async function main() {
  // 1. Find lead — handle may have varied casing / underscore drift.
  const lead = await prisma.lead.findFirst({
    where: {
      handle: { contains: 'tegaumukoro', mode: 'insensitive' }
    },
    include: { conversation: true }
  });
  if (!lead) {
    console.error(`No Lead found matching handle ~ ${TARGET_HANDLE}`);
    process.exit(1);
  }
  if (!lead.conversation) {
    console.error(`Lead ${lead.id} (@${lead.handle}) has no Conversation row.`);
    process.exit(1);
  }

  console.log(
    '================================================================'
  );
  console.log(
    `Lead:         ${lead.id}  @${lead.handle}  (name="${lead.name}")`
  );
  console.log(`Account:      ${lead.accountId}`);
  console.log(`Conversation: ${lead.conversation.id}`);
  console.log(
    '================================================================'
  );

  // 2. Pull the conversation again with full state fields.
  const convo = await prisma.conversation.findUnique({
    where: { id: lead.conversation.id },
    select: {
      id: true,
      aiActive: true,
      awaitingAiResponse: true,
      awaitingSince: true,
      lastMessageAt: true,
      unreadCount: true,
      systemStage: true,
      currentScriptStep: true,
      llmEmittedStage: true,
      stageMismatchCount: true,
      silentStopCount: true,
      capturedDataPoints: true,
      outcome: true,
      personaId: true,
      stageOpeningAt: true,
      stageSituationDiscoveryAt: true,
      stageGoalEmotionalWhyAt: true,
      stageUrgencyAt: true,
      stageSoftPitchCommitmentAt: true,
      stageFinancialScreeningAt: true,
      stageBookingAt: true
    }
  });
  if (!convo) {
    console.error('Conversation row vanished?');
    process.exit(1);
  }

  console.log('');
  console.log('CONVERSATION STATE');
  console.log(
    '----------------------------------------------------------------'
  );
  console.log(`  aiActive:           ${convo.aiActive}`);
  console.log(`  awaitingAiResponse: ${convo.awaitingAiResponse}`);
  console.log(
    `  awaitingSince:      ${convo.awaitingSince?.toISOString() ?? 'null'}`
  );
  console.log(
    `  lastMessageAt:      ${convo.lastMessageAt?.toISOString() ?? 'null'}`
  );
  console.log(`  unreadCount:        ${convo.unreadCount}`);
  console.log(`  systemStage:        ${convo.systemStage ?? 'null'}`);
  console.log(`  currentScriptStep:  ${convo.currentScriptStep}`);
  console.log(`  llmEmittedStage:    ${convo.llmEmittedStage ?? 'null'}`);
  console.log(`  stageMismatchCount: ${convo.stageMismatchCount}`);
  console.log(`  silentStopCount:    ${convo.silentStopCount}`);
  console.log(`  outcome:            ${convo.outcome}`);
  console.log(`  personaId:          ${convo.personaId}`);
  console.log(
    `  stageOpeningAt:     ${convo.stageOpeningAt?.toISOString() ?? 'null'}`
  );
  console.log(
    `  stageBookingAt:     ${convo.stageBookingAt?.toISOString() ?? 'null'}`
  );
  console.log(
    `  capturedDataPoints: ${JSON.stringify(convo.capturedDataPoints, null, 2)}`
  );

  // 3. If systemStage is set, find the matching ScriptStep so the operator
  //    can confirm the drift.
  if (convo.systemStage) {
    const matchingStep = await prisma.scriptStep.findFirst({
      where: {
        scriptId: {
          in: (
            await prisma.script.findMany({
              where: { accountId: lead.accountId, isActive: true },
              select: { id: true }
            })
          ).map((s) => s.id)
        },
        OR: [
          { stateKey: convo.systemStage },
          { title: { contains: convo.systemStage, mode: 'insensitive' } }
        ]
      },
      select: {
        id: true,
        scriptId: true,
        stepNumber: true,
        title: true,
        stateKey: true
      }
    });
    if (matchingStep) {
      console.log('');
      console.log(`systemStage="${convo.systemStage}" matches:`);
      console.log(
        `  Step ${matchingStep.stepNumber}: ${matchingStep.title} (id=${matchingStep.id})`
      );
    } else {
      console.log('');
      console.log(
        `systemStage="${convo.systemStage}" does NOT match any active script step (likely stale enum from before clear-conversation reset shipped).`
      );
    }
  }

  // 4. Last 15 messages.
  console.log('');
  console.log('LAST 15 MESSAGES (oldest → newest)');
  console.log(
    '----------------------------------------------------------------'
  );
  const messages = await prisma.message.findMany({
    where: { conversationId: convo.id },
    orderBy: { timestamp: 'desc' },
    take: 15,
    select: {
      id: true,
      sender: true,
      content: true,
      timestamp: true,
      stage: true,
      subStage: true,
      deletedAt: true
    }
  });
  for (const m of messages.reverse()) {
    const tag = m.deletedAt ? `[DELETED ${m.sender}]` : `[${m.sender}]`;
    const stage = m.stage
      ? ` stage=${m.stage}${m.subStage ? '/' + m.subStage : ''}`
      : '';
    const ts = m.timestamp.toISOString();
    const preview = (m.content || '').slice(0, 200).replace(/\n/g, ' ');
    console.log(`  ${ts} ${tag}${stage}`);
    console.log(`    ${preview}`);
  }

  // 5. Pending scheduled replies.
  console.log('');
  console.log('SCHEDULED REPLIES on this conversation');
  console.log(
    '----------------------------------------------------------------'
  );
  const scheduled = await prisma.scheduledReply.findMany({
    where: { conversationId: convo.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      status: true,
      scheduledFor: true,
      processedAt: true,
      attempts: true,
      lastError: true,
      createdAt: true
    }
  });
  if (scheduled.length === 0) {
    console.log('  (none)');
  } else {
    for (const s of scheduled) {
      console.log(
        `  ${s.id} status=${s.status} scheduledFor=${s.scheduledFor?.toISOString() ?? 'null'} processedAt=${s.processedAt?.toISOString() ?? 'null'} attempts=${s.attempts}`
      );
      if (s.lastError) {
        console.log(`    lastError: ${s.lastError.slice(0, 200)}`);
      }
    }
  }

  // 6. Recommendation summary.
  console.log('');
  console.log(
    '================================================================'
  );
  console.log('RECOMMENDATION');
  console.log(
    '================================================================'
  );
  const drifted =
    convo.systemStage === 'DIDNT_RECEIVE_HOMEWORK' ||
    convo.systemStage === 'didnt_receive_homework';
  if (drifted) {
    console.log(
      `Stage drift confirmed: systemStage="${convo.systemStage}". Run:`
    );
    console.log(
      `  npx tsx scripts/fix-tegaumukoro-conversation.ts ${convo.id}`
    );
  } else if (convo.systemStage) {
    console.log(
      `systemStage="${convo.systemStage}" is set but doesn't match the reported drift. Inspect manually before running the fix script.`
    );
  } else {
    console.log(
      `systemStage is already null. The reported "Didnt Receive Homework" badge may be coming from another field (currentScriptStep=${convo.currentScriptStep}). Check the dashboard component that renders the stage chip.`
    );
  }
  if (!convo.awaitingAiResponse) {
    console.log(
      'awaitingAiResponse=false: AI is NOT armed for the next lead message. The fix script also re-arms.'
    );
  }
}

main()
  .catch((err) => {
    console.error('[diagnose-tegaumukoro] FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
