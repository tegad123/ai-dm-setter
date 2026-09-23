// Full chain for one conversation (or the newest lead of an account/platform):
// messages (delivered?), ScheduledReply status/errors, generation traces,
// egress shadow rows. This is the evidence block Tega's closure standard asks for.
//
//   NODE_PATH=$PWD/node_modules npx tsx scripts/verify/watch-conversation.ts <conversationId>
//   ACCOUNT_ID=<id> PLATFORM=INSTAGRAM npx tsx scripts/verify/watch-conversation.ts   # newest lead
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
async function retry<T>(fn: () => Promise<T>, t = 12): Promise<T> {
  let l: unknown;
  for (let i = 0; i < t; i++) {
    try {
      return await fn();
    } catch (e) {
      l = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw l;
}
(async () => {
  let convId: string | undefined = process.argv[2];
  if (!convId) {
    const acct = process.env.ACCOUNT_ID || 'cmpy59zy50000ju04u6fs5o2r';
    const platform = (process.env.PLATFORM || 'INSTAGRAM') as any;
    const lead = await retry(() =>
      prisma.lead.findFirst({
        where: { accountId: acct, platform },
        orderBy: { createdAt: 'desc' },
        select: { name: true, conversation: { select: { id: true } } }
      })
    );
    convId = lead?.conversation?.id;
    console.log(
      `newest ${platform} lead on ${acct}: ${JSON.stringify(lead?.name)} conv=${convId}`
    );
    if (!convId) process.exit(1);
  }
  const c = await retry(() =>
    prisma.conversation.findUnique({
      where: { id: convId! },
      select: {
        id: true,
        aiActive: true,
        autoSendOverride: true,
        awaitingAiResponse: true,
        awaitingHumanReview: true,
        distressDetected: true,
        source: true,
        leadSource: true,
        systemStage: true,
        currentScriptStep: true,
        lead: {
          select: {
            name: true,
            platform: true,
            platformUserId: true,
            accountId: true
          }
        },
        messages: {
          orderBy: { timestamp: 'asc' },
          select: {
            sender: true,
            content: true,
            timestamp: true,
            platformMessageId: true
          }
        }
      }
    })
  );
  if (!c) return console.log('conversation not found');
  console.log(
    `\nCONV ${c.id} | ${c.lead.platform} ${JSON.stringify(c.lead.name)} psid=${c.lead.platformUserId} acct=${c.lead.accountId}`
  );
  console.log(
    `  aiActive=${c.aiActive} autoSendOverride=${c.autoSendOverride} awaitingAi=${c.awaitingAiResponse} held=${c.awaitingHumanReview} distress=${c.distressDetected} source=${c.source}/${c.leadSource} stage=${c.systemStage} step=${c.currentScriptStep}`
  );
  console.log('\nMESSAGES');
  c.messages.forEach((m) =>
    console.log(
      `  ${m.timestamp.toISOString().slice(5, 19)} ${String(m.sender).padEnd(5)} ${JSON.stringify((m.content ?? '').slice(0, 130))}${m.platformMessageId ? ' [DELIVERED]' : ''}`
    )
  );
  const sr = await retry(() =>
    prisma.scheduledReply.findMany({
      where: { conversationId: convId! },
      orderBy: { createdAt: 'asc' },
      select: {
        status: true,
        attempts: true,
        scheduledFor: true,
        processedAt: true,
        terminalReasonCode: true,
        terminalAt: true,
        claimSnapshot: true,
        generationTraceId: true,
        lastError: true
      }
    })
  );
  console.log('\nSCHEDULED REPLIES');
  sr.forEach((s) =>
    console.log(
      `  ${s.status.padEnd(19)} att=${s.attempts} for=${s.scheduledFor.toISOString().slice(5, 19)} proc=${s.processedAt?.toISOString().slice(5, 19) ?? '-'} reason=${s.terminalReasonCode ?? '-'} claim=${s.claimSnapshot ? 'yes' : 'no'} trace=${s.generationTraceId ?? '-'}${s.lastError ? ' | ' + s.lastError.slice(0, 120) : ''}`
    )
  );
  const tr = await retry(() =>
    prisma.generationTurnTrace.findMany({
      where: { conversationId: convId! },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        stepNumber: true,
        branchSelected: true,
        systemStage: true,
        stageEmitted: true,
        replyPreview: true,
        qualityHardFails: true
      }
    })
  );
  console.log('\nGENERATION TRACES');
  tr.forEach((t) =>
    console.log(
      `  ${t.createdAt.toISOString().slice(5, 19)} step=${t.stepNumber} branch=${JSON.stringify(t.branchSelected)} stage=${t.systemStage} emitted=${t.stageEmitted} reply=${JSON.stringify((t.replyPreview ?? '').slice(0, 100))} hf=${JSON.stringify(t.qualityHardFails)}`
    )
  );
  const eg = await retry(() =>
    prisma.egressShadowLog.findMany({
      where: { conversationId: convId! },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        sendPath: true,
        machineAllow: true,
        machineReason: true,
        machineHold: true,
        agreed: true,
        draftPreview: true
      }
    })
  );
  console.log('\nEGRESS SHADOW ROWS');
  eg.forEach((e) =>
    console.log(
      `  ${e.createdAt.toISOString().slice(5, 19)} path=${e.sendPath} allow=${e.machineAllow} reason=${e.machineReason ?? '-'} hold=${e.machineHold ?? '-'} agreed=${e.agreed} ${JSON.stringify((e.draftPreview ?? '').slice(0, 60))}`
    )
  );
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
