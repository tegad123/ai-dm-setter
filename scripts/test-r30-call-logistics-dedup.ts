/* eslint-disable no-console */
// Regression coverage for R30 call-logistics deduplication:
//   1. AI self-redundancy after a lead acknowledgment is blocked
//   2. human-to-AI logistics handoff duplication is blocked
//   3. first delivery is allowed
//   4. "quiet day" scheduling language does not count as prior logistics

import {
  callLogisticsAlreadyDeliveredInRecentHistory,
  isAcknowledgmentOnlyLeadMessage,
  scoreVoiceQualityGroup
} from '../src/lib/voice-quality-gate';

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

function hasR30Failure(result: ReturnType<typeof scoreVoiceQualityGroup>) {
  return result.hardFails.some((failure) => failure.includes('r30_'));
}

function main() {
  console.log('\n[TEST 1] Wayne case: AI self-redundancy blocked');
  const wayneHistory = [
    {
      sender: 'AI',
      content: "monday at 3pm cst, make sure you're in a quiet spot"
    },
    { sender: 'LEAD', content: 'Sounds good bro' }
  ];
  const wayne = scoreVoiceQualityGroup(
    ['make sure you are in a quiet spot so you can see the gameplan clearly'],
    {
      callLogisticsAlreadyDelivered:
        callLogisticsAlreadyDeliveredInRecentHistory(wayneHistory),
      lastLeadMessageWasAcknowledgmentOnly: isAcknowledgmentOnlyLeadMessage(
        wayneHistory[1].content
      )
    }
  );
  expect(
    'blocks duplicate logistics after AI already delivered them',
    wayne.hardFails.some((failure) =>
      failure.includes('r30_logistics_redelivery:')
    ),
    true
  );
  expect(
    'blocks logistics after lead acknowledgment',
    wayne.hardFails.some((failure) =>
      failure.includes('r30_logistics_after_acknowledgment:')
    ),
    true
  );

  console.log('\n[TEST 2] Human handoff duplication blocked');
  const handoffHistory = [
    {
      sender: 'HUMAN',
      content: 'be in a quiet area to see the gameplan properly'
    },
    { sender: 'LEAD', content: 'Yes that works' }
  ];
  const handoff = scoreVoiceQualityGroup(
    ["make sure you're in a quiet spot monday at 3pm cst"],
    {
      callLogisticsAlreadyDelivered:
        callLogisticsAlreadyDeliveredInRecentHistory(handoffHistory),
      lastLeadMessageWasAcknowledgmentOnly: isAcknowledgmentOnlyLeadMessage(
        handoffHistory[1].content
      )
    }
  );
  expect(
    'blocks duplicate logistics after human setter',
    hasR30Failure(handoff),
    true
  );

  console.log('\n[TEST 3] First delivery allowed');
  const firstDelivery = scoreVoiceQualityGroup([
    "monday at 3pm cst, make sure you're in a quiet spot"
  ]);
  expect(
    'does not fire R30 on first delivery',
    hasR30Failure(firstDelivery),
    false
  );

  console.log('\n[TEST 4] False-positive guard');
  const falsePositiveHistory = [
    { sender: 'AI', content: "what's a quiet day for you to chat?" },
    { sender: 'LEAD', content: 'wednesdays usually' }
  ];
  expect(
    '"quiet day" does not count as delivered logistics',
    callLogisticsAlreadyDeliveredInRecentHistory(falsePositiveHistory),
    false
  );
  const firstQuietSpot = scoreVoiceQualityGroup(
    ["cool, let's lock wednesday at 2pm, quiet spot helps too"],
    {
      callLogisticsAlreadyDelivered:
        callLogisticsAlreadyDeliveredInRecentHistory(falsePositiveHistory),
      lastLeadMessageWasAcknowledgmentOnly: isAcknowledgmentOnlyLeadMessage(
        falsePositiveHistory[1].content
      )
    }
  );
  expect(
    'first quiet-spot reminder is still allowed',
    hasR30Failure(firstQuietSpot),
    false
  );

  console.log(`\nR30 call-logistics tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
