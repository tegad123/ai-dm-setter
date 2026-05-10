/* eslint-disable no-console */

import { readFileSync } from 'fs';
import {
  buildJudgeClassificationDirective,
  detectJudgeBranchViolation,
  resolveOrStripTemplateVariables,
  shouldForceColdStartStep1Inbound
} from '../src/lib/ai-engine';

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

  const cleanedPrompt = resolveOrStripTemplateVariables(
    'Goal: {{incomeGoal}}. Unknown: {{customize to their stated goal}}. Lead: {{leadName}}.',
    {
      capturedDataPoints: {
        incomeGoal: {
          value: '6k a month',
          confidence: 'HIGH',
          extractedFromMessageId: 'm2',
          extractionMethod: 'test',
          extractedAt: new Date().toISOString()
        }
      },
      leadContext: { leadName: 'Nick' }
    }
  );

  expect(
    'template sanitizer resolves known script variables',
    cleanedPrompt.text.includes('6k a month'),
    true
  );
  expect(
    'template sanitizer strips unresolved script variables',
    /\{\{[^}]+\}\}/.test(cleanedPrompt.text),
    false
  );

  const judgeStep = {
    stepNumber: 3,
    title: 'Experience Branch',
    canonicalQuestion: null,
    actions: [
      {
        actionType: 'runtime_judgment',
        content: 'Classify whether the lead is beginner or already active.'
      }
    ],
    branches: [
      {
        branchLabel: 'Beginner',
        conditionDescription:
          'Lead is new, not currently active, or looking to start',
        actions: [
          {
            actionType: 'send_message',
            content: 'Hell yeah man, good spot to be in.'
          },
          {
            actionType: 'ask_question',
            content: 'What do you do for work right now?'
          }
        ]
      },
      {
        branchLabel: 'Already Active',
        conditionDescription: 'Lead is already currently active',
        actions: [
          {
            actionType: 'ask_question',
            content: "What's been the main thing taking you out?"
          }
        ]
      }
    ]
  };

  const judgeDirective = buildJudgeClassificationDirective({
    step: judgeStep,
    latestLeadMessage: 'looking to start'
  });

  expect(
    'judge directive classifies start signal into matching branch',
    judgeDirective.includes('matches "Beginner"'),
    true
  );

  const judgeViolation = detectJudgeBranchViolation({
    step: judgeStep,
    latestLeadMessage: 'looking to start',
    generatedMessages: ["What's been the main thing taking you out?"]
  });

  expect('judge gate blocks wrong branch action', judgeViolation.blocked, true);
  expect(
    'judge gate provides deterministic matched-branch fallback',
    judgeViolation.fallbackMessages[0],
    'Hell yeah man, good spot to be in.'
  );

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
