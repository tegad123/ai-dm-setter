// APEX TRADES account prod DM test tool
// Targets: ScaleVault AI Facebook page (Page ID: 1006770499175916)
// Uses Shazim's FB sender ID (same as Daniel account tests)
//
// Usage:
//   npx tsx scripts/prod-dm-apex.ts "hey interested in this"
//   npx tsx scripts/prod-dm-apex.ts --state
//   npx tsx scripts/prod-dm-apex.ts --cleanup

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});

async function retry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}

const SECRET = process.env.META_APP_SECRET;
const WEBHOOK = 'https://qualifydms.io/api/webhooks/facebook';
const ENTRY_ID = '1006770499175916'; // ScaleVault AI FB page (Apex Trades account)
const SENDER_ID = process.env.E2E_SENDER_ID || '27316153248002036'; // Shazim's PSID on ScaleVault AI page

const SOP_PANEL: Array<[string, string]> = [
  ['stageOpeningAt', 'Opening'],
  ['stageSituationDiscoveryAt', 'Discovery'],
  ['stageGoalEmotionalWhyAt', 'Goal/Why'],
  ['stageUrgencyAt', 'Urgency'],
  ['stageSoftPitchCommitmentAt', 'SoftPitch'],
  ['stageFinancialScreeningAt', 'Financial'],
  ['stageBookingAt', 'Booking']
];

async function send(text: string) {
  const ts = Date.now();
  const payload = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: ENTRY_ID,
        time: ts,
        messaging: [
          {
            sender: { id: SENDER_ID },
            recipient: { id: ENTRY_ID },
            timestamp: ts,
            message: {
              mid: `pd_${ts}_${Math.random().toString(36).slice(2)}`,
              text
            }
          }
        ]
      }
    ]
  });
  const sig =
    'sha256=' +
    crypto.createHmac('sha256', SECRET!).update(payload).digest('hex');
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body: payload
  });
  return res.status;
}

async function state() {
  const lead = await retry(() =>
    prisma.lead.findFirst({
      where: { platformUserId: SENDER_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true, stage: true }
    })
  );
  if (!lead) return null;
  const convo = await retry(() =>
    prisma.conversation.findFirst({
      where: { leadId: lead.id },
      select: {
        id: true,
        systemStage: true,
        currentScriptStep: true,
        stageMismatchCount: true,
        scheduledCallAt: true,
        capturedDataPoints: true,
        aiActive: true,
        awaitingHumanReview: true,
        stageOpeningAt: true,
        stageSituationDiscoveryAt: true,
        stageGoalEmotionalWhyAt: true,
        stageUrgencyAt: true,
        stageSoftPitchCommitmentAt: true,
        stageFinancialScreeningAt: true,
        stageBookingAt: true
      }
    })
  );
  return { lead, convo };
}

async function aiMsgs(convoId: string) {
  return retry(() =>
    prisma.message.findMany({
      where: { conversationId: convoId, sender: 'AI' },
      orderBy: { timestamp: 'asc' },
      select: { content: true }
    })
  );
}

function printState(s: Awaited<ReturnType<typeof state>>) {
  const c = s?.convo;
  const cdp = (c?.capturedDataPoints ?? {}) as any;
  const lit = SOP_PANEL.filter(([k]) => (c as any)?.[k] != null).map(
    ([, l]) => l
  );
  console.log(`  lead.stage      = ${s?.lead.stage}`);
  console.log(
    `  systemStage     = ${c?.systemStage}  (step ${c?.currentScriptStep}, mismatch ${c?.stageMismatchCount})`
  );
  console.log(
    `  aiActive=${c?.aiActive}  awaitingHuman=${c?.awaitingHumanReview}`
  );
  console.log(
    `  incomeGoal=${cdp?.incomeGoal?.value ?? '-'}  capital=${cdp?.verifiedCapitalUsd?.value ?? '-'}  thresholdMet=${cdp?.capitalThresholdMet?.value ?? '-'}`
  );
  console.log(`  scheduledCallAt = ${c?.scheduledCallAt ?? '-'}`);
  console.log(`  stage panel lit = [${lit.join(', ')}]`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!SECRET) throw new Error('META_APP_SECRET not set');
  const arg = process.argv[2];

  if (arg === '--cleanup') {
    const leads = await prisma.lead.findMany({
      where: { platformUserId: SENDER_ID },
      select: { id: true }
    });
    for (const l of leads) {
      const cs = await prisma.conversation.findMany({
        where: { leadId: l.id },
        select: { id: true }
      });
      for (const c of cs) {
        await prisma.message.deleteMany({ where: { conversationId: c.id } });
        await prisma.scheduledReply.deleteMany({
          where: { conversationId: c.id }
        });
        await prisma.aISuggestion
          .deleteMany({ where: { conversationId: c.id } })
          .catch(() => {});
      }
      await prisma.conversation.deleteMany({ where: { leadId: l.id } });
      await prisma.lead.delete({ where: { id: l.id } });
    }
    console.log(`cleaned ${leads.length} test lead(s)`);
    await prisma.$disconnect();
    return;
  }

  if (arg === '--state') {
    const s = await state();
    if (!s) console.log('no test lead yet');
    else {
      printState(s);
      const msgs = s.convo ? await aiMsgs(s.convo.id) : [];
      console.log(`  --- AI replies so far (${msgs.length}) ---`);
      msgs.forEach((m) => console.log(`  🤖 ${m.content}`));
    }
    await prisma.$disconnect();
    return;
  }

  const text = arg;
  if (!text)
    throw new Error('usage: prod-dm-apex.ts "<message>" | --state | --cleanup');
  const pre = await state();
  const before = pre?.convo ? (await aiMsgs(pre.convo.id)).length : 0;
  const status = await send(text);
  console.log(`👤 SENT: ${text}  (webhook ${status})`);

  for (let i = 0; i < 33; i++) {
    await sleep(3000);
    const s = await state();
    if (!s?.convo) continue;
    const msgs = await aiMsgs(s.convo.id);
    if (msgs.length > before) {
      await sleep(6000);
      const s2 = await state();
      const msgs2 = s2?.convo ? await aiMsgs(s2.convo.id) : msgs;
      console.log(`\n🤖 AI replied:`);
      msgs2.slice(before).forEach((m) => console.log(`   ${m.content}`));
      console.log(`\n📊 state:`);
      printState(s2 ?? s);
      await prisma.$disconnect();
      return;
    }
  }
  const sr = await prisma.scheduledReply.findFirst({
    where: pre?.convo ? { conversationId: pre.convo.id } : {},
    orderBy: { createdAt: 'desc' },
    select: { status: true, lastError: true, generatedResult: true }
  });
  console.log(
    `\n⚠️  no AI reply in ~100s. sr.status=${sr?.status} err=${(sr?.lastError ?? 'none').slice(0, 140)}`
  );
  const gr = sr?.generatedResult as any;
  if (gr)
    console.log(
      `   (generated but not delivered: ${JSON.stringify(gr.messages ?? gr.reply ?? '').slice(0, 160)})`
    );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
