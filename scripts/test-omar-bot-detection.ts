/* eslint-disable no-console */
// Verifies the Omar Moore 2026-04-27 bot-detection fixes.
//
//   TEST 1 — "hbu" gets answered (prompt rule + directive)
//   TEST 2 — "what's your favorite prop" gets a real answer
//   TEST 3 — Personal question mid-discovery doesn't fire when answered
//   TEST 4 — Ignored personal question caught (-0.5)
//   TEST 5 — 3 consecutive pure questions → soft signal fires
//   TEST 6 — Specific detail acknowledgment passes
//   TEST 7 — Generic acknowledgment caught (-0.2)
//   TEST 8 — Genuine acknowledgment passes (no signal)

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import {
  detectPersonalQuestion,
  replyContainsFirstPerson,
  extractSpecificDetails,
  extractRecentLeadDetails,
  replyAcknowledgesSpecificDetail,
  isPureQuestion,
  countConsecutivePureQuestions,
  isGenericAcknowledgmentOnly
} from '../src/lib/conversation-detail-extractor';
import { scoreVoiceQuality } from '../src/lib/voice-quality-gate';
import { buildDynamicSystemPrompt } from '../src/lib/ai-prompts';
import prisma from '../src/lib/prisma';

let pass = 0;
let fail = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

async function main() {
  // ── PURE LOGIC: detector helpers ─────────────────────────────
  console.log('\n[helpers] detectPersonalQuestion');
  const personalSamples = [
    'Hbu',
    'hbu',
    'h.b.u.',
    'how about you',
    'how bout you',
    'what about you',
    'what about you though',
    "what's your favorite prop firm?",
    "what's your fav broker",
    'how long have you been trading',
    'what pairs do you trade',
    'have you ever blown an account?',
    'do you trade gold?'
  ];
  for (const s of personalSamples) {
    expect(`detects: "${s}"`, detectPersonalQuestion(s).detected, true);
  }
  const nonPersonal = [
    "I'm a heavy equipment operator",
    'yeah I had to think about it bro',
    'lucid is a newer one',
    'my goal is to fully replace income'
  ];
  for (const s of nonPersonal) {
    expect(
      `silent on: "${s.slice(0, 40)}"`,
      detectPersonalQuestion(s).detected,
      false
    );
  }

  console.log('\n[helpers] replyContainsFirstPerson');
  expect(
    'detects "I"',
    replyContainsFirstPerson("I've been trading for years"),
    true
  );
  expect(
    'detects "im"',
    replyContainsFirstPerson('im at it for a few years'),
    true
  );
  expect(
    'detects "my"',
    replyContainsFirstPerson('my favorite is alpha'),
    true
  );
  expect(
    'silent on no first-person',
    replyContainsFirstPerson('what do you do for work?'),
    false
  );

  console.log('\n[helpers] extractSpecificDetails');
  const omarDetails = extractSpecificDetails(
    'I trade alpha and topstep, about to get into lucid'
  );
  expect(
    'pulls 3 prop firms',
    omarDetails.filter((d) => d.category === 'prop_firm').length,
    3
  );
  const stratDetails = extractSpecificDetails(
    'I use the AMD model with ORB opening'
  );
  expect(
    'pulls strategies',
    stratDetails.filter((d) => d.category === 'strategy').length >= 2,
    true
  );
  const ctxDetails = extractSpecificDetails(
    "Im getting married in 3 weeks so I'm saving for that"
  );
  expect(
    'pulls family/timeline context',
    ctxDetails.some((d) => d.category === 'context'),
    true
  );

  console.log('\n[helpers] replyAcknowledgesSpecificDetail');
  expect(
    'reply with "Lucid" matches',
    replyAcknowledgesSpecificDetail(
      'lucid is interesting, newer one bro',
      omarDetails
    ),
    true
  );
  expect(
    "reply without any detail token doesn't match",
    replyAcknowledgesSpecificDetail(
      'love that bro, what are you tryna make monthly?',
      omarDetails
    ),
    false
  );

  console.log('\n[helpers] isPureQuestion + countConsecutivePureQuestions');
  const recentDetails = omarDetails;
  expect(
    'pure question (no detail)',
    isPureQuestion('what do you do for work rn?', recentDetails),
    true
  );
  expect(
    'not pure: references Lucid',
    isPureQuestion(
      'lucid is interesting bro, what made you go multi-prop?',
      recentDetails
    ),
    false
  );
  expect(
    'not pure: no question mark',
    isPureQuestion('lucid is interesting bro', recentDetails),
    false
  );
  expect(
    'count 3 trailing pure questions',
    countConsecutivePureQuestions(
      [
        { content: 'lucid is fire bro' },
        { content: 'what do you do for work?' },
        { content: 'what are you tryna make monthly?' },
        { content: "what's been holding you back?" }
      ],
      recentDetails
    ),
    3
  );
  expect(
    'count breaks at non-pure',
    countConsecutivePureQuestions(
      [
        { content: 'what do you trade?' },
        { content: 'lucid is fire bro' },
        { content: 'what about your goals?' }
      ],
      recentDetails
    ),
    1
  );

  console.log('\n[helpers] isGenericAcknowledgmentOnly');
  expect(
    'fires on "love that bro"',
    isGenericAcknowledgmentOnly('love that bro'),
    true
  );
  expect(
    'fires on "love that bro, big moves"',
    isGenericAcknowledgmentOnly('love that bro, big moves'),
    true
  );
  expect(
    "doesn't fire when there's a question after",
    isGenericAcknowledgmentOnly(
      'love that bro, what are you tryna make monthly?'
    ),
    false
  );
  expect(
    "doesn't fire on substantive content",
    isGenericAcknowledgmentOnly('lucid is interesting, newer rules'),
    false
  );

  // ── TEST 1: ignored "hbu" → soft signal -0.5 ──────────────────
  console.log("\n[TEST 1] AI ignores 'hbu' → ignored_personal_question fires");
  const t1 = scoreVoiceQuality('what do you do for work rn?', {
    previousLeadMessage: 'Hbu'
  });
  expect('soft signal -0.5', t1.softSignals.ignored_personal_question, -0.5);

  // ── TEST 2: AI deflects with no first-person → still fires ────
  console.log(
    "\n[TEST 2] AI deflects 'favorite prop' question with no I/my → fires"
  );
  const t2 = scoreVoiceQuality(
    'prop-firm specifics depend a lot on the lead bro',
    { previousLeadMessage: "what's your favorite prop firm?" }
  );
  expect(
    'no first-person → fires',
    t2.softSignals.ignored_personal_question,
    -0.5
  );

  // ── TEST 3: AI answers "hbu" → no fire ────────────────────────
  console.log("\n[TEST 3] AI answers 'hbu' from first-person → no fire");
  const t3 = scoreVoiceQuality(
    'been at it for a few years bro, lost a lot before it clicked fr. what do you do for work?',
    { previousLeadMessage: 'Hbu' }
  );
  expect(
    'no soft signal when answered',
    t3.softSignals.ignored_personal_question,
    undefined
  );

  // ── TEST 4: ignored personal question on a non-personal prev → no fire
  console.log('\n[TEST 4] non-personal previous lead msg → no false fire');
  const t4 = scoreVoiceQuality('what do you do for work rn?', {
    previousLeadMessage: 'fully replace income'
  });
  expect(
    'no fire when prev was not a personal question',
    t4.softSignals.ignored_personal_question,
    undefined
  );

  // ── TEST 5: 3 consecutive pure questions → soft signal fires ──
  console.log(
    '\n[TEST 5] 3 consecutive pure-question turns → scripted_question_sequence fires'
  );
  const t5 = scoreVoiceQuality("what's been holding you back so far?", {
    priorConsecutivePureQuestionCount: 2,
    recentLeadDetails: [{ category: 'prop_firm', token: 'Lucid' }]
  });
  expect(
    'fires when total run >= 3',
    typeof t5.softSignals.scripted_question_sequence === 'number' &&
      t5.softSignals.scripted_question_sequence < 0,
    true
  );

  // ── TEST 5b: question that DOES acknowledge a detail → no fire
  console.log(
    "\n[TEST 5b] reply that acknowledges 'Lucid' → no scripted-sequence fire"
  );
  const t5b = scoreVoiceQuality(
    'lucid is a newer one bro, solid move. what made you go multi-prop?',
    {
      priorConsecutivePureQuestionCount: 5,
      recentLeadDetails: [{ category: 'prop_firm', token: 'Lucid' }]
    }
  );
  expect(
    'silent when acknowledged detail',
    t5b.softSignals.scripted_question_sequence,
    undefined
  );

  // ── TEST 6: extractRecentLeadDetails over 2 lead messages ─────
  console.log('\n[TEST 6] extractRecentLeadDetails dedups + aggregates');
  const t6 = extractRecentLeadDetails([
    { content: 'I trade alpha' },
    { content: 'just got into Lucid too, alpha is solid' }
  ]);
  expect(
    'dedups Alpha across messages',
    t6.filter((d) => d.token.toLowerCase() === 'alpha').length,
    1
  );
  expect(
    'pulls Lucid from 2nd message',
    t6.some((d) => d.token === 'Lucid'),
    true
  );

  // ── TEST 7: generic acknowledgment caught ─────────────────────
  console.log(
    "\n[TEST 7] 'love that bro' alone → generic_acknowledgment fires"
  );
  const t7 = scoreVoiceQuality('love that bro');
  expect('soft signal -0.2', t7.softSignals.generic_acknowledgment, -0.2);

  // ── TEST 8: genuine acknowledgment passes ─────────────────────
  console.log("\n[TEST 8] 'lucid is interesting, ...' → no generic-ack fire");
  const t8 = scoreVoiceQuality(
    'lucid is an interesting pick, newer rules but solid payouts. are you trying to fully replace factory income?',
    {
      previousLeadMessage: 'I trade alpha and topstep, about to get into lucid'
    }
  );
  expect(
    'no generic_acknowledgment',
    t8.softSignals.generic_acknowledgment,
    undefined
  );
  expect(
    'no scripted_question_sequence',
    t8.softSignals.scripted_question_sequence,
    undefined
  );
  // Note: ignored_personal_question won't fire here either — the
  // lead message wasn't a personal question shape.

  // ── PROMPT: master prompt now contains both rules ─────────────
  console.log('\n[PROMPT] master prompt contains the two new rules');
  const persona = await prisma.aIPersona.findFirst({
    select: { accountId: true }
  });
  if (persona) {
    const minimalContext = {
      leadId: 'test',
      leadName: 'Test',
      handle: 'test_handle',
      platform: 'INSTAGRAM',
      status: 'NEW_LEAD',
      triggerType: 'DM',
      qualityScore: 0
    } as any;
    const prompt = await buildDynamicSystemPrompt(
      persona.accountId,
      minimalContext
    );
    expect(
      'PERSONAL QUESTION RULE present',
      prompt.includes('## PERSONAL QUESTION RULE'),
      true
    );
    expect(
      'CONVERSATION VARIETY RULE present',
      prompt.includes('## CONVERSATION VARIETY RULE'),
      true
    );
    expect(
      'prompt warns "love that bro" alone is filler',
      prompt.toLowerCase().includes('love that bro'),
      true
    );
    expect(
      'prompt mentions hbu / how about you',
      prompt.toLowerCase().includes('hbu') &&
        prompt.toLowerCase().includes('how about you'),
      true
    );
  }

  await prisma.$disconnect();

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
