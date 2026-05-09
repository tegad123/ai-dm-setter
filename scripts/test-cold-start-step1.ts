/* eslint-disable no-console */

import { readFileSync } from 'fs';
import { shouldForceColdStartStep1Inbound } from '../src/lib/ai-engine';

let pass = 0;
let fail = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    console.log(
      `  FAIL ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

function main() {
  console.log('\n[TEST] Cold-start Step 1 Inbound gate');

  expect(
    'first inbound lead message with active script forces Step 1',
    shouldForceColdStartStep1Inbound({
      conversationHistory: [
        {
          id: 'm1',
          sender: 'LEAD',
          content: 'hey bro',
          timestamp: new Date()
        }
      ],
      hasActiveScript: true,
      conversationSource: 'INBOUND',
      systemStage: null,
      currentScriptStep: 1,
      conversationMessageCount: 1
    }),
    true
  );

  expect(
    'first inbound empty-history generation also forces Step 1',
    shouldForceColdStartStep1Inbound({
      conversationHistory: [],
      hasActiveScript: true,
      conversationSource: 'INBOUND',
      systemStage: 'INIT',
      currentScriptStep: null,
      conversationMessageCount: 0
    }),
    true
  );

  expect(
    'does not force without an active script',
    shouldForceColdStartStep1Inbound({
      conversationHistory: [
        {
          id: 'm1',
          sender: 'LEAD',
          content: 'hey bro',
          timestamp: new Date()
        }
      ],
      hasActiveScript: false,
      conversationSource: 'INBOUND',
      conversationMessageCount: 1
    }),
    false
  );

  expect(
    'does not force outbound conversations',
    shouldForceColdStartStep1Inbound({
      conversationHistory: [
        {
          id: 'm1',
          sender: 'LEAD',
          content: 'send it',
          timestamp: new Date()
        }
      ],
      hasActiveScript: true,
      conversationSource: 'MANYCHAT',
      leadSource: 'OUTBOUND',
      conversationMessageCount: 1
    }),
    false
  );

  expect(
    'does not force once a setter message exists',
    shouldForceColdStartStep1Inbound({
      conversationHistory: [
        {
          id: 'm1',
          sender: 'LEAD',
          content: 'hey bro',
          timestamp: new Date()
        },
        {
          id: 'm2',
          sender: 'AI',
          content: 'yo bro',
          timestamp: new Date()
        }
      ],
      hasActiveScript: true,
      conversationSource: 'INBOUND',
      conversationMessageCount: 2
    }),
    false
  );

  expect(
    'does not force after DB message count moves past first message',
    shouldForceColdStartStep1Inbound({
      conversationHistory: [
        {
          id: 'm1',
          sender: 'LEAD',
          content: 'hey bro',
          timestamp: new Date()
        }
      ],
      hasActiveScript: true,
      conversationSource: 'INBOUND',
      conversationMessageCount: 2
    }),
    false
  );

  expect(
    'script serializer contains prompt-level cold-start rule',
    readFileSync('src/lib/script-serializer.ts', 'utf8').includes(
      'Their opening message is never small talk'
    ),
    true
  );

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
