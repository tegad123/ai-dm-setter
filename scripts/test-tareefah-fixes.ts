/* eslint-disable no-console */
// Regression coverage for Tareefah Allen 2026-04-28:
//   1. repeated capital question is caught
//   2. total-savings / tight-funds capital requires clarification
//   3. homework URL is blocked before scheduledCallAt exists

import {
  scoreVoiceQualityGroup,
  stripPreCallHomeworkFromMessages
} from '../src/lib/voice-quality-gate';
import { parseLeadCapitalAnswer } from '../src/lib/ai-engine';
import { countCapitalQuestionAsks } from '../src/lib/conversation-facts';

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

function main() {
  console.log('\n[TEST 1] Repeated capital question caught');
  const repeated = scoreVoiceQualityGroup(
    [
      'damn bro, i feel that. blowing one and still trying again says a lot about your mindset fr',
      'what’s your capital situation like right now?'
    ],
    {
      previousAIMessage: "what's your capital situation like right now?"
    }
  );
  expect(
    'soft signal fires on the exact second ask',
    repeated.softSignals.repeated_question,
    -0.4
  );
  expect(
    'curly apostrophe capital question counts as prior ask',
    countCapitalQuestionAsks([
      { content: 'what’s your capital situation like right now?' }
    ]),
    1
  );

  console.log('\n[TEST 2] Savings context triggers clarification');
  const savings = parseLeadCapitalAnswer(
    "I have $3000 in savings but we're tight right now"
  );
  expect('savings answer is ambiguous, not a pass', savings.kind, 'ambiguous');
  expect(
    'savings answer carries clarification reason',
    savings.reason,
    'total_savings_or_financial_stress'
  );
  const tradingCapital = parseLeadCapitalAnswer(
    'I have $3000 saved for trading'
  );
  expect(
    'explicit trading capital still parses as amount',
    tradingCapital.kind,
    'amount'
  );

  console.log('\n[TEST 3] Homework blocked before scheduledCallAt');
  const homeworkUrl =
    'https://daetradingaccelerator.com/thank-you-confirmation';
  const homeworkNoCall = scoreVoiceQualityGroup(
    [`check the homework page here: ${homeworkUrl}`],
    { scheduledCallAt: null, homeworkUrl }
  );
  expect(
    'soft signal fires when homework URL appears without scheduledCallAt',
    homeworkNoCall.softSignals.homework_sent_before_call_confirmed,
    -0.3
  );
  const stripped = stripPreCallHomeworkFromMessages(
    [
      'for sure bro, you’re good 💪🏿',
      `check the homework page here: ${homeworkUrl}`
    ],
    homeworkUrl
  );
  expect(
    'homework URL is removed from fallback messages',
    stripped.some((message) => message.includes(homeworkUrl)),
    false
  );
  const homeworkWithCall = scoreVoiceQualityGroup(
    [`check the homework page here: ${homeworkUrl}`],
    { scheduledCallAt: new Date('2026-04-29T15:00:00.000Z'), homeworkUrl }
  );
  expect(
    'no homework soft signal after scheduledCallAt exists',
    homeworkWithCall.softSignals.homework_sent_before_call_confirmed,
    undefined
  );

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
