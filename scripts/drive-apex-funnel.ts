// Apex Trades / Marcus Rivera — full end-to-end adaptive funnel driver.
//
// Mirrors drive-prod-funnel.ts but targets the ScaleVault AI page and uses
// a lead persona with capital BELOW the £2,000 threshold so the downsell
// path is exercised end-to-end alongside the normal qualification flow.
//
// Usage:
//   npx tsx scripts/drive-apex-funnel.ts            # run the funnel
//   npx tsx scripts/drive-apex-funnel.ts --cleanup  # delete the test lead

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
import { callHaikuText } from '../src/lib/haiku-text';

config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});

const SECRET = process.env.META_APP_SECRET;
const WEBHOOK = 'https://qualifydms.io/api/webhooks/facebook';
const ENTRY_ID = '1006770499175916'; // ScaleVault AI / Apex Trades page
const SENDER_ID = '27316153248002036'; // Shazim's PSID on this page
const MAX_TURNS = 40;

// Lead persona: qualified on everything EXCEPT capital (£1,200 — below £2,000
// threshold). This forces the downsell path and verifies Fix 1 end-to-end.
const PERSONA = `You are a real Facebook lead replying to a trading mentor's DM setter. Stay in character as a casual prospect — short, lowercase, natural UK English, ONE message per turn. Never break character or mention AI.

YOUR CONSISTENT FACTS (reveal naturally when asked, don't dump everything at once):
- been trading ~18 months, keep blowing accounts, never consistent
- based in Birmingham, UK
- biggest problem: over-leveraging and no risk management system
- you work in IT support, take home about £2,200/month, want out of the 9-5
- you want trading to fully replace your job
- income goal: £5,000/month from trading
- deeper why: want to spend more time with your daughter, sick of the commute
- main obstacle: no proper system, learned off YouTube, inconsistent results
- you're motivated and ready to do something about it
- capital: you have about £500 saved that you could put toward this right now
- when asked about capital be honest: "I've got about £500 I can put toward this"
- when offered a cheaper course/self-paced option: be open to it, ask what it covers
- when they send a course link or Calendly link: say you'll check it out and ask what's included
- if pushed back to booking the main call after downsell: say you'd rather start with the course first

Reply ONLY with the lead's next message — nothing else.`;

async function sendWebhook(text: string): Promise<number> {
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
              mid: `apex_${ts}_${Math.random().toString(36).slice(2)}`,
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

async function retry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(600);
    }
  }
  throw last;
}

async function getState() {
  return retry(async () => {
    const lead = await prisma.lead.findFirst({
      where: { platformUserId: SENDER_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true, stage: true }
    });
    if (!lead) return null;
    const convo = await prisma.conversation.findFirst({
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
    });
    return { lead, convo };
  });
}

async function aiReplies(convoId: string): Promise<string[]> {
  return retry(async () => {
    const rows = await prisma.message.findMany({
      where: { conversationId: convoId, sender: 'AI' },
      orderBy: { timestamp: 'asc' },
      select: { content: true }
    });
    return rows.map((r) => r.content);
  });
}

async function transcript(convoId: string): Promise<string> {
  return retry(async () => {
    const msgs = await prisma.message.findMany({
      where: { conversationId: convoId },
      orderBy: { timestamp: 'asc' },
      select: { sender: true, content: true }
    });
    return msgs
      .map((m) => `${m.sender === 'LEAD' ? 'LEAD' : 'COACH'}: ${m.content}`)
      .join('\n');
  });
}

async function cleanup() {
  const leads = await retry(() =>
    prisma.lead.findMany({
      where: { platformUserId: SENDER_ID },
      select: { id: true }
    })
  );
  for (const l of leads) {
    const convos = await retry(() =>
      prisma.conversation.findMany({
        where: { leadId: l.id },
        select: { id: true }
      })
    );
    for (const c of convos) {
      await retry(() =>
        prisma.message.deleteMany({ where: { conversationId: c.id } })
      );
      await retry(() =>
        prisma.scheduledReply.deleteMany({ where: { conversationId: c.id } })
      );
      await retry(() =>
        prisma.aISuggestion
          .deleteMany({ where: { conversationId: c.id } })
          .catch(() => {})
      );
    }
    await retry(() =>
      prisma.conversation.deleteMany({ where: { leadId: l.id } })
    );
    await retry(() => prisma.lead.delete({ where: { id: l.id } }));
  }
  console.log(`cleaned ${leads.length} test lead(s)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SOP_PANEL = [
  'stageOpeningAt',
  'stageSituationDiscoveryAt',
  'stageGoalEmotionalWhyAt',
  'stageUrgencyAt',
  'stageSoftPitchCommitmentAt',
  'stageFinancialScreeningAt',
  'stageBookingAt'
] as const;

function snapshot(st: Awaited<ReturnType<typeof getState>>): string {
  const cdp = (st?.convo?.capturedDataPoints ?? {}) as any;
  const lit = SOP_PANEL.filter((k) => (st?.convo as any)?.[k] != null).map(
    (k) => k.replace('stage', '').replace('At', '')
  );
  return `[stage=${st?.lead.stage} sys=${st?.convo?.systemStage} step=${st?.convo?.currentScriptStep} capital=${cdp?.verifiedCapitalUsd?.value ?? '-'} thresholdMet=${cdp?.capitalThresholdMet?.value ?? '-'} downsell=${cdp?.downsellInterestConfirmed?.value ?? '-'} panel=[${lit.join(',')}]]`;
}

const STALL_PHRASES = [
  "i don't wanna point you wrong here bro",
  'give me a sec to double-check',
  'lemme have the team double-check',
  'double-check the right next step'
];

function verifyTurn(params: {
  turn: number;
  freshReplies: string[];
  st: Awaited<ReturnType<typeof getState>>;
  prevLeadStage: string | null;
  prevStep: number | null;
}): { lines: string[]; failures: number } {
  const { freshReplies, st, prevLeadStage, prevStep } = params;
  const lines: string[] = [];
  let failures = 0;
  const ok = (label: string) => lines.push(`        ✅ ${label}`);
  const bad = (label: string) => {
    lines.push(`        ❌ ${label}`);
    failures++;
  };
  const warn = (label: string) => lines.push(`        ⚠️  ${label}`);

  const convo = st?.convo;
  const cdp = (convo?.capturedDataPoints ?? {}) as any;

  if (freshReplies.length > 0) ok('AI replied');
  else bad('AI SILENT — no reply');

  if (convo?.aiActive !== false) ok('aiActive=true');
  else bad('aiActive=false (AI paused — human takeover)');

  if (!convo?.awaitingHumanReview) ok('not awaiting human review');
  else bad('awaitingHumanReview=true (escalated prematurely)');

  const stalledReply = freshReplies.find((r) =>
    STALL_PHRASES.some((p) => r.toLowerCase().includes(p))
  );
  if (stalledReply)
    bad(`STALL PHRASE detected: "${stalledReply.slice(0, 80)}"`);
  else ok('no stall phrase');

  const order = [
    'NEW_LEAD',
    'ENGAGED',
    'QUALIFYING',
    'QUALIFIED',
    'CALL_PROPOSED',
    'BOOKED'
  ];
  const cur = order.indexOf(st?.lead.stage ?? '');
  const prev = order.indexOf(prevLeadStage ?? '');
  if (prevLeadStage === null || cur < 0 || prev < 0 || cur >= prev)
    ok(`lead.stage ${prevLeadStage ?? '-'}→${st?.lead.stage}`);
  else bad(`lead.stage REGRESSED (${prevLeadStage}→${st?.lead.stage})`);

  const step = convo?.currentScriptStep ?? 0;
  if (prevStep === null || step >= prevStep)
    ok(`step ${prevStep ?? '-'}→${step}`);
  else bad(`step REGRESSED (${prevStep}→${step})`);

  if (cdp?.verifiedCapitalUsd?.value != null) {
    const c = cdp.verifiedCapitalUsd.value;
    if (typeof c === 'number' && c > 0)
      ok(`capital captured = $${Math.round(c)}`);
    else bad(`capital invalid (${c})`);
  }

  if (cdp?.capitalThresholdMet?.value === false) {
    warn(
      'capitalThresholdMet=false — lead on downsell path (expected for this persona)'
    );
  }

  return { lines, failures };
}

async function main() {
  if (!SECRET) throw new Error('META_APP_SECRET not set');
  if (process.argv.includes('--cleanup')) {
    await cleanup();
    await prisma.$disconnect();
    return;
  }

  // Clear any leftover test lead before starting
  await cleanup().catch(() => {});

  console.log(
    `\n=== APEX TRADES FULL E2E FUNNEL (page ${ENTRY_ID}, sender ${SENDER_ID}) ===`
  );
  console.log(
    `=== Persona: UK lead, Birmingham, capital £500 (below threshold) ===\n`
  );

  let nextLeadMsg =
    'hey man saw your reels on trading, been trying it myself but keep losing money';
  let convoId: string | null = null;
  let prevLeadStage: string | null = null;
  let prevStep: number | null = null;
  let totalFailures = 0;
  let stallCount = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const before = convoId ? await aiReplies(convoId) : [];
    const status = await sendWebhook(nextLeadMsg);
    console.log(`\n[T${turn}] 👤 LEAD: ${nextLeadMsg}  (webhook ${status})`);

    // Wait up to 100s for AI reply
    let fresh: string[] = [];
    for (let i = 0; i < 34; i++) {
      await sleep(3000);
      const st = await getState();
      if (!st?.convo) continue;
      convoId = st.convo.id;
      const now = await aiReplies(convoId);
      if (now.length > before.length) {
        // Wait one extra tick for multi-bubble delivery
        await sleep(5000);
        const now2 = await aiReplies(convoId);
        fresh = now2.slice(before.length);
        break;
      }
    }

    const st = await getState();
    for (const f of fresh) console.log(`     🤖 AI: ${f}`);
    console.log(`     ${snapshot(st)}`);

    const check = verifyTurn({
      turn,
      freshReplies: fresh,
      st,
      prevLeadStage,
      prevStep
    });
    console.log(`     ── checks ──`);
    check.lines.forEach((l) => console.log(l));
    totalFailures += check.failures;

    const stalledThisTurn = fresh.some((r) =>
      STALL_PHRASES.some((p) => r.toLowerCase().includes(p))
    );
    if (stalledThisTurn) stallCount++;

    prevLeadStage = st?.lead.stage ?? prevLeadStage;
    prevStep = st?.convo?.currentScriptStep ?? prevStep;

    // Terminal conditions
    if (st?.lead.stage === 'BOOKED' || st?.convo?.scheduledCallAt) {
      console.log(`\n🎉 BOOKED — ${snapshot(st)}`);
      break;
    }
    const cdp = (st?.convo?.capturedDataPoints ?? {}) as any;
    const downsellDone = cdp?.downsellInterestConfirmed?.value === true;
    if (
      downsellDone &&
      fresh.some((r) => /calendly|course|link|self.?pac/i.test(r))
    ) {
      console.log(`\n🎉 DOWNSELL LINK DELIVERED — ${snapshot(st)}`);
      break;
    }
    if (fresh.length === 0) {
      const sr = await retry(() =>
        prisma.scheduledReply.findFirst({
          where: convoId ? { conversationId: convoId } : {},
          orderBy: { createdAt: 'desc' },
          select: { status: true, lastError: true }
        })
      );
      console.log(
        `     >>> NO REPLY in ~100s — sr.status=${sr?.status} err=${(sr?.lastError ?? 'none').slice(0, 100)}`
      );
      break;
    }
    if (turn === MAX_TURNS) {
      console.log(`\n=== MAX_TURNS reached — ${snapshot(st)} ===`);
      break;
    }

    // Generate natural lead reply via Haiku
    const convoText = convoId ? await transcript(convoId) : '';
    const leadPrompt = `${PERSONA}\n\nConversation so far:\n${convoText}\n\nThe coach just said:\n"${fresh.join(' ')}"\n\nReply as the lead (one short natural message):`;
    let replyText: string | null = null;
    for (let attempt = 1; attempt <= 4 && !replyText; attempt++) {
      const result = await callHaikuText({
        accountId: null,
        prompt: leadPrompt,
        maxTokens: 100,
        temperature: 0.7,
        timeoutMs: 30000,
        logPrefix: `[apex-e2e t${turn} a${attempt}]`
      });
      replyText = result?.text ?? null;
      if (!replyText) await sleep(2000);
    }
    if (!replyText) {
      console.log(`     >>> lead-reply failed. Stopping.`);
      break;
    }
    nextLeadMsg = replyText.trim().replace(/^["']|["']$/g, '');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`STALL PHRASES fired: ${stallCount}`);
  console.log(
    `VERIFICATION: ${totalFailures === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + totalFailures + ' FAILURE(S)'}`
  );
  console.log('='.repeat(60));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
