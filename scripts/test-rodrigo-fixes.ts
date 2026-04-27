/* eslint-disable no-console */
// Verifies the two Rodrigo Moran 2026-04-26 fixes:
//
//   BUG 1 — extractEstablishedFacts() pulls work / years / income / capital
//           / timeline from LEAD-side history; buildEstablishedFactsBlock
//           formats them; ai-engine + buildDynamicSystemPrompt only inject
//           the block when conversation length > 20 messages.
//
//   BUG 2 — voice-quality-gate hard-fails repeated_capital_question when
//           priorCapitalQuestionAskCount >= 1 AND the current reply also
//           contains the capital threshold question. First ask passes;
//           second ask blocks.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import {
  extractEstablishedFacts,
  buildEstablishedFactsBlock,
  countCapitalQuestionAsks,
  looksLikeCapitalQuestion
} from '../src/lib/conversation-facts';
import { scoreVoiceQualityGroup } from '../src/lib/voice-quality-gate';
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
  // ── BUG 1A — extractEstablishedFacts on Rodrigo's actual lead msgs ──
  console.log('\n[BUG 1A] extractEstablishedFacts on Rodrigo Moran inputs');
  const rodrigoLeadMsgs = [
    { content: 'Im a heavy equipment operator' },
    { content: '5 yesrs' },
    { content: 'Fully replace for sure' },
    { content: 'I make $35.5 usd an hour right now' },
    { content: 'At least clear 1200 a week' },
    {
      content:
        "Im getting married in 3 weeks so I'm saving for that after that I can put away a good amount a side"
    },
    { content: 'I can after my wedding' }
  ];
  const facts = extractEstablishedFacts(rodrigoLeadMsgs);
  expect(
    'work pulled from "Im a heavy equipment operator"',
    typeof facts.work === 'string' &&
      facts.work.toLowerCase().includes('heavy'),
    true
  );
  expect(
    'experienceYears matches "5 yesrs"',
    typeof facts.experienceYears === 'string' &&
      /5\s+yesrs/i.test(facts.experienceYears),
    true
  );
  expect(
    'incomeCurrent captured the hourly rate',
    typeof facts.incomeCurrent === 'string' &&
      /35\.5/.test(facts.incomeCurrent) &&
      /hour|hr/i.test(facts.incomeCurrent),
    true
  );
  expect(
    'incomeGoal includes "1200 a week"',
    typeof facts.incomeGoal === 'string' &&
      /1200/.test(facts.incomeGoal) &&
      /week/i.test(facts.incomeGoal),
    true
  );
  expect(
    'timeline mentions wedding / 3 weeks',
    typeof facts.timeline === 'string' &&
      /wedding|3\s+weeks/i.test(facts.timeline),
    true
  );

  // ── BUG 1B — buildEstablishedFactsBlock formats correctly ───────
  console.log('\n[BUG 1B] buildEstablishedFactsBlock output');
  const block = buildEstablishedFactsBlock(facts, 'Rodrigo Moran');
  expect(
    'block starts with the ESTABLISHED FACTS heading',
    block !== null && block.startsWith('## ESTABLISHED FACTS (DO NOT RE-ASK)'),
    true
  );
  expect(
    'block includes "Name: Rodrigo Moran"',
    block !== null && block.includes('Rodrigo Moran'),
    true
  );
  expect(
    'block includes work line',
    block !== null && /Work:.*heavy/i.test(block),
    true
  );

  // ── BUG 1C — empty leadMessages → no block emitted ─────────────
  console.log('\n[BUG 1C] empty input → null block');
  const empty = extractEstablishedFacts([]);
  expect(
    'null block on empty extracted facts',
    buildEstablishedFactsBlock(empty),
    null
  );

  // ── BUG 1D — buildDynamicSystemPrompt prepends block when passed ─
  console.log('\n[BUG 1D] system prompt receives block at top');
  const personaForPrompt = await prisma.aIPersona.findFirst({
    select: { accountId: true }
  });
  if (!personaForPrompt) {
    console.error('No aIPersona row found — skipping prompt-block tests.');
  } else {
    const minimalContext = {
      leadId: 'test',
      leadName: 'Rodrigo Moran',
      handle: 'test_handle',
      platform: 'INSTAGRAM',
      status: 'NEW_LEAD',
      triggerType: 'DM',
      triggerSource: null,
      qualityScore: 0
    } as any;
    const promptWith = await buildDynamicSystemPrompt(
      personaForPrompt.accountId,
      minimalContext,
      undefined,
      undefined,
      undefined,
      undefined,
      block!
    );
    expect(
      'block appears verbatim in prompt',
      promptWith.includes('## ESTABLISHED FACTS (DO NOT RE-ASK)'),
      true
    );
    expect(
      'block appears BEFORE the master template instructions',
      promptWith.indexOf('## ESTABLISHED FACTS') <
        promptWith.indexOf('## YOUR IDENTITY'),
      true
    );
    const promptWithout = await buildDynamicSystemPrompt(
      personaForPrompt.accountId,
      minimalContext
    );
    expect(
      'block absent when not passed',
      promptWithout.includes('## ESTABLISHED FACTS'),
      false
    );
  }

  // ── BUG 2A — looksLikeCapitalQuestion on the two Rodrigo asks ──
  console.log('\n[BUG 2A] looksLikeCapitalQuestion regex coverage');
  expect(
    'first Rodrigo ask matches',
    looksLikeCapitalQuestion(
      'do you already have at least $1k set aside for this or nah?'
    ),
    true
  );
  expect(
    'second Rodrigo ask matches',
    looksLikeCapitalQuestion(
      'sick bro, just to confirm, you got at least $1k in capital ready to start after the wedding?'
    ),
    true
  );
  expect(
    'unrelated AI msg does not match',
    looksLikeCapitalQuestion('bet bro, solid trade'),
    false
  );

  // ── BUG 2B — countCapitalQuestionAsks ──────────────────────────
  console.log('\n[BUG 2B] countCapitalQuestionAsks');
  expect(
    'counts both Rodrigo asks (and ignores filler)',
    countCapitalQuestionAsks([
      { content: 'gotchu bro, big moves' },
      {
        content: 'do you already have at least $1k set aside for this or nah?'
      },
      { content: 'bet bro, solid trade' },
      {
        content:
          'sick bro, just to confirm, you got at least $1k in capital ready to start after the wedding?'
      }
    ]),
    2
  );

  // ── BUG 2C — voice-quality-gate hard-fails second capital ask ──
  console.log(
    '\n[BUG 2C] scoreVoiceQualityGroup hard-fails repeated_capital_question'
  );
  const firstAsk = scoreVoiceQualityGroup(
    [
      'sick bro, just to confirm, you got at least $1k in capital ready to start after the wedding?'
    ],
    {
      priorCapitalQuestionAskCount: 0,
      previousAIMessage: 'bet bro, solid trade'
    }
  );
  expect(
    'first capital ask passes (no prior asks)',
    firstAsk.hardFails.some((f) => f.includes('repeated_capital_question:')),
    false
  );

  const secondAsk = scoreVoiceQualityGroup(
    [
      'sick bro, just to confirm, you got at least $1k in capital ready to start after the wedding?'
    ],
    {
      priorCapitalQuestionAskCount: 1,
      previousAIMessage: 'gotchu bro'
    }
  );
  expect(
    'second capital ask hard-fails (prior count = 1)',
    secondAsk.hardFails.some((f) => f.includes('repeated_capital_question:')),
    true
  );

  // ── BUG 2D — non-capital reply does not trigger the cap ────────
  console.log('\n[BUG 2D] non-capital reply with prior count > 0 still passes');
  const nonCapital = scoreVoiceQualityGroup(["bet bro, that's solid 💪🏿"], {
    priorCapitalQuestionAskCount: 5
  });
  expect(
    'no fire when current reply has no capital pattern',
    nonCapital.hardFails.some((f) => f.includes('repeated_capital_question:')),
    false
  );

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
