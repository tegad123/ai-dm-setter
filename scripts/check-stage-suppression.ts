// Verifies that stage writes did NOT happen for a given conv.
// Run after a low-ticket test conv to produce the DB snapshot Tega needs.
//
// Usage: npx tsx scripts/check-stage-suppression.ts <convId>
//        npx tsx scripts/check-stage-suppression.ts --latest   # uses most recent daetradez conv

import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});

async function retry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw last;
}

async function main() {
  const arg = process.argv[2];

  let convId: string;

  if (!arg || arg === '--latest') {
    const acc = await retry(() =>
      prisma.account.findFirst({
        where: { slug: 'daetradez2003' },
        select: { id: true }
      })
    );
    if (!acc) throw new Error('daetradez2003 account not found');
    const lead = await retry(() =>
      prisma.lead.findFirst({
        where: { accountId: acc.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          stage: true,
          previousStage: true,
          stageEnteredAt: true
        }
      })
    );
    if (!lead) throw new Error('no lead found');
    const conv = await retry(() =>
      prisma.conversation.findFirst({
        where: { leadId: lead.id },
        select: { id: true }
      })
    );
    if (!conv) throw new Error('no conv found');
    convId = conv.id;
    console.log('using latest daetradez conv:', convId);
    console.log(
      'lead.stage:',
      lead.stage,
      '| previousStage:',
      lead.previousStage ?? 'null'
    );
  } else {
    convId = arg;
  }

  const conv = await retry(() =>
    prisma.conversation.findUnique({
      where: { id: convId },
      select: {
        id: true,
        outcome: true,
        capitalVerificationStatus: true,
        capturedDataPoints: true,
        scheduledCallAt: true,
        typeformFilledNoBooking: true,
        stageOpeningAt: true,
        stageSituationDiscoveryAt: true,
        stageGoalEmotionalWhyAt: true,
        stageUrgencyAt: true,
        stageSoftPitchCommitmentAt: true,
        stageFinancialScreeningAt: true,
        stageBookingAt: true,
        lead: {
          select: {
            id: true,
            stage: true,
            previousStage: true
          }
        }
      }
    })
  );
  if (!conv) throw new Error(`conv ${convId} not found`);

  const transitions = await retry(() =>
    prisma.leadStageTransition.findMany({
      where: { leadId: conv.lead.id },
      orderBy: { createdAt: 'asc' },
      select: {
        fromStage: true,
        toStage: true,
        transitionedBy: true,
        createdAt: true
      }
    })
  );

  console.log('\n=== STAGE SUPPRESSION SNAPSHOT ===');
  console.log('convId:', convId);
  console.log('lead.id:', conv.lead.id);
  console.log('lead.stage:', conv.lead.stage);
  console.log('lead.previousStage:', conv.lead.previousStage ?? 'null');
  console.log('\n--- LeadStageTransition rows ---');
  if (transitions.length === 0) {
    console.log('ZERO rows ✓ — no stage transitions written');
  } else {
    transitions.forEach((t) =>
      console.log(
        `  ${t.fromStage} → ${t.toStage} (by ${t.transitionedBy}) at ${t.createdAt}`
      )
    );
    console.log(
      `TOTAL: ${transitions.length} rows — stage writes NOT suppressed ✗`
    );
  }

  console.log('\n--- Conversation stage timestamps ---');
  const stamps = [
    ['stageOpeningAt', conv.stageOpeningAt],
    ['stageSituationDiscoveryAt', conv.stageSituationDiscoveryAt],
    ['stageGoalEmotionalWhyAt', conv.stageGoalEmotionalWhyAt],
    ['stageUrgencyAt', conv.stageUrgencyAt],
    ['stageSoftPitchCommitmentAt', conv.stageSoftPitchCommitmentAt],
    ['stageFinancialScreeningAt', conv.stageFinancialScreeningAt],
    ['stageBookingAt', conv.stageBookingAt]
  ];
  const setStamps = stamps.filter(([, v]) => v !== null);
  if (setStamps.length === 0) {
    console.log('ALL null ✓ — no stage timestamp backfills');
  } else {
    setStamps.forEach(([k, v]) => console.log(`  ${k}: ${v} ✗`));
  }

  console.log('\n--- Conversation outcome ---');
  console.log('outcome:', conv.outcome ?? 'null (not written)');

  // Leak #3 (R24 engine injection): assert the capital machine never touched
  // this conv — status stays UNVERIFIED, no capital CDP keys, no capital
  // question in any AI message, no typeform screen-out, no booking state.
  console.log('\n--- Capital / screening / booking state ---');
  const capStatus: string =
    (conv.capitalVerificationStatus as string) ?? 'null';
  const cdp = (conv.capturedDataPoints ?? {}) as Record<string, unknown>;
  const capitalCdpKeys = [
    'capitalThresholdMet',
    'verifiedCapitalUsd',
    'capital',
    'capitalQAskedCount',
    'capitalAnswerType',
    'downsellInterestConfirmed'
  ].filter((k) => cdp[k] !== undefined);
  const capClean =
    (capStatus === 'UNVERIFIED' || capStatus === 'null') &&
    capitalCdpKeys.length === 0 &&
    conv.scheduledCallAt === null &&
    conv.typeformFilledNoBooking !== true &&
    conv.outcome !== 'UNQUALIFIED_REDIRECT';
  console.log(
    `capitalVerificationStatus: ${capStatus} ${capStatus === 'UNVERIFIED' || capStatus === 'null' ? '✓' : '✗'}`
  );
  console.log(
    `capital CDP keys: ${capitalCdpKeys.length === 0 ? 'none ✓' : capitalCdpKeys.join(', ') + ' ✗'}`
  );
  console.log(`scheduledCallAt: ${conv.scheduledCallAt ?? 'null ✓'}`);
  console.log(
    `typeformFilledNoBooking: ${conv.typeformFilledNoBooking ? 'true ✗' : 'false ✓'}`
  );

  // Blocker 2 (reopened): assert the ENGINE emits no funnel stage — every AI
  // Message.stage must be null. This is the store-C leak Tega flagged.
  const aiMsgs = await retry(() =>
    prisma.message.findMany({
      where: { conversationId: convId, sender: 'AI' },
      orderBy: { timestamp: 'asc' },
      select: { stage: true, subStage: true, content: true }
    })
  );

  // R24 text probe: no AI message may contain a capital/financial-screening ask.
  const CAPITAL_Q_RE =
    /\b(capital|how much (do you|you got|money).{0,30}(set aside|saved|invest|trading)|set aside for trading|credit (score|card)|how much are you working with)\b/i;
  const capitalTextHits = aiMsgs.filter((m) =>
    CAPITAL_Q_RE.test(m.content ?? '')
  );
  console.log(
    `AI messages containing capital/screening language: ${capitalTextHits.length === 0 ? 'none ✓' : capitalTextHits.length + ' ✗'}`
  );
  capitalTextHits.forEach((m) =>
    console.log(`  ✗ "${(m.content ?? '').slice(0, 90)}"`)
  );
  console.log('\n--- AI Message.stage (engine output) ---');
  const stampedMsgs = aiMsgs.filter((m) => m.stage != null);
  if (aiMsgs.length === 0) {
    console.log('(no AI messages yet)');
  } else if (stampedMsgs.length === 0) {
    console.log(
      `ALL ${aiMsgs.length} AI messages have stage=null ✓ — engine emits no funnel stage`
    );
  } else {
    stampedMsgs.forEach((m) =>
      console.log(
        `  stage=${m.stage} subStage=${m.subStage ?? '-'} | "${(m.content ?? '').slice(0, 50)}" ✗`
      )
    );
    console.log(
      `${stampedMsgs.length}/${aiMsgs.length} AI messages carry a funnel stage — engine NOT gated ✗`
    );
  }

  const pass =
    transitions.length === 0 &&
    setStamps.length === 0 &&
    stampedMsgs.length === 0 &&
    capClean &&
    capitalTextHits.length === 0;
  console.log(
    '\n' +
      (pass
        ? 'PASS ✓ — zero stage writes, no funnel stage, no capital/screening/booking state'
        : 'FAIL ✗ — engine state detected')
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
