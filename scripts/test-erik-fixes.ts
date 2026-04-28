/* eslint-disable no-console */
// Regression coverage for Erik Torosian 2026-04-28:
//   1. "canadian dollars" is detected as CAD and converted
//   2. soft hesitation gets probed, not accepted with a free video
//   3. hard no still allows a soft exit
//   4. passing capital overrides debt context

import {
  convertCapitalAmountToUsd,
  detectConversationCurrency,
  detectCurrencyFromText,
  parseLeadCapitalAnswer
} from '../src/lib/ai-engine';
import { scoreVoiceQualityGroup } from '../src/lib/voice-quality-gate';

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

function expectApprox(
  label: string,
  actual: number,
  expected: number,
  tolerance = 1
) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${label}\n      expected: ${expected} ±${tolerance}\n      actual:   ${actual}`
    );
  }
}

async function main() {
  const threshold = 1000;

  console.log('\n[TEST 1] "canadian dollars" detected and converted');
  expect(
    'plain "canadian dollars" detects CAD',
    detectCurrencyFromText('these are canadian dollars'),
    'CAD'
  );
  expect(
    '"in Canadian" detects CAD',
    detectCurrencyFromText('that amount is in Canadian'),
    'CAD'
  );
  const cadCapital = parseLeadCapitalAnswer(
    '$1,400 in stocks, these are canadian dollars'
  );
  expect('CAD capital parses as amount', cadCapital.amount, 1400);
  expect('CAD capital carries CAD currency', cadCapital.currency, 'CAD');
  const cadUsd = convertCapitalAmountToUsd(
    cadCapital.amount ?? 0,
    cadCapital.currency
  );
  expectApprox('CAD 1,400 converts to about $1,036 USD', cadUsd, 1036);
  expect('CAD 1,400 clears $1,000 threshold', cadUsd >= threshold, true);
  expect(
    'detectConversationCurrency catches candidate "canadian dollars"',
    await detectConversationCurrency('not-a-real-conversation', [
      '1400, these are canadian dollars'
    ]),
    'CAD'
  );

  console.log('\n[TEST 2] Soft hesitation probed, not accepted');
  const softExit = scoreVoiceQualityGroup(
    [
      "all good bro, start with the free video: https://youtu.be/example when you're in a better spot hit me up"
    ],
    {
      previousLeadMessage:
        "yeah, i have a couple of thousands, but wouldn't want to do it",
      conversationMessageCount: 10,
      capitalOutcome: 'passed',
      leadStage: 'QUALIFIED'
    }
  );
  expect(
    'premature_exit_on_soft_hesitation fires',
    softExit.softSignals.premature_exit_on_soft_hesitation,
    -0.5
  );

  console.log('\n[TEST 3] Hard no still accepted');
  const hardNoExit = scoreVoiceQualityGroup(
    [
      "all good bro, here's a free video to help: https://youtu.be/example when you're in a better spot hit me up"
    ],
    {
      previousLeadMessage: "no i definitely can't afford anything",
      conversationMessageCount: 18,
      capitalOutcome: 'failed',
      leadStage: 'UNQUALIFIED'
    }
  );
  expect(
    'hard no does not trigger soft-hesitation signal',
    hardNoExit.softSignals.premature_exit_on_soft_hesitation,
    undefined
  );

  console.log('\n[TEST 4] Capital amount overrides debt context');
  const debtCapital = parseLeadCapitalAnswer(
    "I have $1,500 but I'm also paying off debt"
  );
  expect('debt context still parses as amount', debtCapital.kind, 'amount');
  expect('debt context amount is preserved', debtCapital.amount, 1500);
  expect(
    'debt context clears threshold',
    convertCapitalAmountToUsd(debtCapital.amount ?? 0, debtCapital.currency) >=
      threshold,
    true
  );

  console.log('\n[TEST 5] Premature exit signal catches variants');
  const maybeNot = scoreVoiceQualityGroup(
    ["when you're in a better spot hit me up bro"],
    {
      previousLeadMessage: 'maybe not right now',
      conversationMessageCount: 11,
      capitalOutcome: 'passed',
      leadStage: 'QUALIFIED'
    }
  );
  expect(
    'maybe not + better spot fires signal',
    maybeNot.softSignals.premature_exit_on_soft_hesitation,
    -0.5
  );

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
