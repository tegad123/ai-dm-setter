/* eslint-disable no-console */
// Verification suite for the Rodrigo Moran 2026-04-26 capital-question
// humanization pass.
//
//   TEST 1 — "real quick tho" hard-banned (BANNED_PHRASES)
//   TEST 2 — "or nah?" question tail hard-fails
//   TEST 3 — overused_transition_phrase soft signal fires when prior
//            "real quick" count > 2 AND current reply also uses it
//   TEST 4 — implicit-no signal: capital question hard-fails when lead
//            already self-declared no money
//   TEST 5 — no false fire on clean text
//   TEST 6 — leadHasImplicitNoCapitalSignal coverage
//   TEST 7 — countRealQuickPhraseUsage coverage
//   TEST 8 — master prompt now uses open-ended default phrasing

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import {
  scoreVoiceQualityGroup,
  scoreVoiceQuality
} from '../src/lib/voice-quality-gate';
import {
  leadHasImplicitNoCapitalSignal,
  countRealQuickPhraseUsage
} from '../src/lib/conversation-facts';
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
  // ── TEST 1: "real quick tho" banned ────────────────────────────
  console.log('\n[TEST 1] "real quick tho" hard-banned');
  const r1 = scoreVoiceQuality(
    "real quick tho, what's your capital situation?"
  );
  expect(
    'hard-fails on "real quick tho" prefix',
    r1.hardFails.some((f) => f.includes('real quick tho')),
    true
  );
  // Variant without "tho" should NOT hit the banned phrase (it might
  // hit the soft-signal overuse later, but the bare "real quick" in
  // a single message is fine).
  const r1b = scoreVoiceQuality("real quick — what's the capital like?");
  expect(
    'standalone "real quick" (no tho) does not fire BANNED_PHRASES',
    r1b.hardFails.some((f) => f.includes('"real quick tho"')),
    false
  );

  // ── TEST 2: "or nah?" question tail hard-fail ──────────────────
  console.log('\n[TEST 2] "or nah?" question tail');
  const r2 = scoreVoiceQuality('do you have at least $1k or nah?');
  expect(
    'hard-fails on "...or nah?" tail',
    r2.hardFails.some((f) => f.includes('or_nah_question_tail:')),
    true
  );
  const r2b = scoreVoiceQuality(
    "yeah I'd say save up $1k or maybe a bit less and we can figure it out"
  );
  expect(
    'no fire when "or" appears mid-sentence (not as question tail)',
    r2b.hardFails.some((f) => f.includes('or_nah_question_tail:')),
    false
  );

  // ── TEST 3: overused_transition_phrase soft signal ────────────
  console.log('\n[TEST 3] overused_transition_phrase soft signal');
  // priorRealQuickPhraseCount=4 (>2), current uses "real quick" too
  // → soft signal fires at -0.3 * (4-2) = -0.6
  const r3 = scoreVoiceQuality(
    "real quick — what's been the biggest blocker for you?",
    { priorRealQuickPhraseCount: 4 }
  );
  expect(
    'fires overused_transition_phrase at expected weight',
    r3.softSignals.overused_transition_phrase,
    -0.3 * (4 - 2)
  );
  // priorCount=2 (NOT > 2) — should NOT fire even with current usage
  const r3b = scoreVoiceQuality('real quick — capital situation?', {
    priorRealQuickPhraseCount: 2
  });
  expect(
    'does NOT fire when prior count == 2 (need > 2)',
    r3b.softSignals.overused_transition_phrase,
    undefined
  );
  // priorCount=5 but current does NOT use "real quick" — no fire
  const r3c = scoreVoiceQuality("yo bro what's the capital like?", {
    priorRealQuickPhraseCount: 5
  });
  expect(
    'does NOT fire when current reply lacks "real quick"',
    r3c.softSignals.overused_transition_phrase,
    undefined
  );

  // ── TEST 4: capital_q_after_implicit_no hard-fail ──────────────
  console.log('\n[TEST 4] capital question after implicit-no');
  const r4 = scoreVoiceQualityGroup(
    ['do you already have at least $1k set aside for this?'],
    { leadImplicitlySignaledNoCapital: true }
  );
  expect(
    'hard-fails when leadImplicitlySignaledNoCapital=true',
    r4.hardFails.some((f) => f.includes('capital_q_after_implicit_no:')),
    true
  );
  // open-ended capital still fires under the same gate
  const r4b = scoreVoiceQualityGroup(
    ["what's your capital situation like right now?"],
    { leadImplicitlySignaledNoCapital: true }
  );
  expect(
    'open-ended phrasing also blocked once implicit-no signaled',
    r4b.hardFails.some((f) => f.includes('capital_q_after_implicit_no:')),
    true
  );
  // no fire when flag false
  const r4c = scoreVoiceQualityGroup(
    ["what's your capital situation like right now?"],
    { leadImplicitlySignaledNoCapital: false }
  );
  expect(
    'no fire when implicit-no flag is false',
    r4c.hardFails.some((f) => f.includes('capital_q_after_implicit_no:')),
    false
  );

  // ── TEST 5: clean text doesn't false-fire any of these ─────────
  console.log('\n[TEST 5] clean text — no false fires');
  const r5 = scoreVoiceQuality('yo bro caught your story 💪🏿', {
    priorRealQuickPhraseCount: 0,
    leadImplicitlySignaledNoCapital: false
  });
  expect(
    'no banned-phrase failures',
    r5.hardFails.some(
      (f) =>
        f.includes('"real quick tho"') ||
        f.includes('or_nah_question_tail:') ||
        f.includes('capital_q_after_implicit_no:')
    ),
    false
  );

  // ── TEST 6: leadHasImplicitNoCapitalSignal coverage ────────────
  console.log('\n[TEST 6] leadHasImplicitNoCapitalSignal');
  const positives = [
    "I'm a student no money right now",
    'broke bro, just lost my job',
    'I got nothing rn',
    'unemployed currently',
    'still in college',
    "i can't afford that"
  ];
  for (const p of positives) {
    expect(
      `positive: "${p}"`,
      leadHasImplicitNoCapitalSignal([{ content: p }]),
      true
    );
  }
  const negatives = [
    'I have $5k saved',
    'ready to invest',
    "what's the price?",
    'yes',
    "I'm in tech as a software engineer"
  ];
  for (const n of negatives) {
    expect(
      `negative: "${n}"`,
      leadHasImplicitNoCapitalSignal([{ content: n }]),
      false
    );
  }

  // ── TEST 7: countRealQuickPhraseUsage ──────────────────────────
  console.log('\n[TEST 7] countRealQuickPhraseUsage');
  expect(
    'counts "real quick" across messages',
    countRealQuickPhraseUsage([
      { content: 'yo bro' },
      { content: 'real quick tho, what about capital?' },
      { content: 'real quick — your timeline?' },
      { content: 'how much capital you got?' }
    ]),
    2
  );

  // ── TEST 8: master prompt uses open-ended default phrasing ─────
  console.log('\n[TEST 8] master prompt — open-ended capital phrasing');
  const persona = await prisma.aIPersona.findFirst({
    where: { minimumCapitalRequired: { gt: 0 } },
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
      'prompt contains open-ended capital question',
      prompt.includes("what's your capital situation"),
      true
    );
    expect(
      'prompt mentions IMPLICIT-NO RULE',
      prompt.includes('IMPLICIT-NO RULE'),
      true
    );
    expect(
      'prompt forbids "or nah" question tail',
      prompt.includes('"or nah?"') ||
        prompt.includes('or nah?') ||
        prompt.includes('or nah'),
      true
    );
    expect(
      'prompt forbids "real quick tho" prefix',
      prompt.includes('real quick tho'),
      true
    );
    expect(
      'prompt mentions ASK CAP (max twice)',
      prompt.includes('AT MOST TWICE') || prompt.includes('ASK CAP'),
      true
    );
    expect(
      'prompt no longer contains the legacy "just to confirm — you got at least" default',
      prompt.includes('sick bro, just to confirm — you got at least'),
      false
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
