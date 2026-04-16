/**
 * Test the inbound qualification classifier against the 5 scenarios from
 * the spec. Uses the real Haiku API, so it requires an Anthropic key to
 * be configured for at least one account.
 *
 * Usage: npx tsx scripts/test-inbound-classifier.ts
 */

import prisma from '../src/lib/prisma';
import {
  classifyInboundQualification,
  applySkipCap,
  stageNumberToName
} from '../src/lib/inbound-qualification-classifier';

interface TestCase {
  name: string;
  messages: string[];
  isInbound: boolean;
  expect: string; // plain-english expectation
}

const CASES: TestCase[] = [
  {
    name: 'TEST 1 — Cold outbound, no context',
    messages: ['yeah bro'],
    isInbound: false,
    expect: 'Stage 1 (OPENING), no skip'
  },
  {
    name: 'TEST 2 — Warm inbound, light context',
    messages: ['hey love your content, I trade gold too'],
    isInbound: true,
    expect: 'Stage 2 (SITUATION_DISCOVERY), skip Opening only'
  },
  {
    name: 'TEST 3 — Hot inbound, pre-qualified (Steven Petty scenario)',
    messages: [
      'Hi Daetradez, ive been following you for a week or two now and I can honestly say ive never even thought about 1:1 RR and its working but id love to know more about your strategy please. Thanks Steve',
      'Im currently on 100k verification for FTMO but im not doing so great. Something in my strategy shifted and im struggling to be honest. My account is down to 92k im determined not to blow it.',
      'Ive passed step one nicely but step 2 has been not so good'
    ],
    isInbound: true,
    expect: 'Stage 4-5 (URGENCY or SOFT_PITCH), skip Opening + Discovery + Goal'
  },
  {
    name: 'TEST 4 — Direct buyer',
    messages: ['how much is your mentorship? I want to join'],
    isInbound: true,
    expect: 'Stage 5-6 (SOFT_PITCH or FINANCIAL_SCREENING)'
  },
  {
    name: 'TEST 5 — Bot question / skeptic (not qualification data)',
    messages: ['is this a bot or Daniel?'],
    isInbound: true,
    expect: 'Stage 1-2 (OPENING or SITUATION_DISCOVERY), no skip'
  }
];

async function main() {
  const account = await prisma.account.findFirst();
  if (!account) {
    console.error('No account found in DB.');
    process.exit(1);
  }

  console.log(
    `Running ${CASES.length} tests against account: ${account.name}\n`
  );

  for (const tc of CASES) {
    console.log(`━━━ ${tc.name} ━━━`);
    console.log(`Expected: ${tc.expect}`);
    console.log(`Messages (${tc.messages.length}):`);
    for (const m of tc.messages) {
      console.log(`  • ${m}`);
    }

    const t0 = Date.now();
    const result = await classifyInboundQualification(
      account.id,
      tc.messages,
      tc.isInbound
    );
    const ms = Date.now() - t0;

    const cap = applySkipCap(result.suggestedStartStage, tc.isInbound, 1);
    const finalName = stageNumberToName(cap.finalStartStage);

    console.log(`\nClassifier (${ms}ms):`);
    console.log(`  suggestedStartStage: ${result.suggestedStartStage}`);
    console.log(
      `  → capped to:          ${cap.finalStartStage} (${finalName})${cap.capped ? ' [CAPPED]' : ''}`
    );
    console.log(`  confidence:          ${result.confidence.toFixed(2)}`);
    console.log(`  reason:              ${result.stageSkipReason}`);
    console.log(`  extracted:`);
    const ex = result.extractedData;
    if (ex.experienceLevel)
      console.log(`    experience: ${ex.experienceLevel}`);
    if (ex.painPointSummary)
      console.log(`    pain:       ${ex.painPointSummary}`);
    if (ex.goalSummary) console.log(`    goal:       ${ex.goalSummary}`);
    if (ex.urgencySummary) console.log(`    urgency:    ${ex.urgencySummary}`);
    if (ex.financialSummary)
      console.log(`    financial:  ${ex.financialSummary}`);
    if (ex.intentType) console.log(`    intent:     ${ex.intentType}`);
    if (
      !ex.hasExperience &&
      !ex.hasPainPoint &&
      !ex.hasGoal &&
      !ex.hasUrgency &&
      !ex.hasFinancialInfo &&
      !ex.hasExplicitIntent
    )
      console.log(`    (no facts extracted)`);
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
