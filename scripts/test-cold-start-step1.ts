/* eslint-disable no-console */

import { readFileSync } from 'fs';
import {
  buildJudgeClassificationDirective,
  detectJudgeBranchViolation,
  isManyChatRecentlyActive,
  resolveOrStripTemplateVariables,
  shouldForceColdStartStep1Inbound
} from '../src/lib/ai-engine';
import {
  resolveStep1BranchMode,
  selectStep1BranchesForPrompt
} from '../src/lib/script-serializer';

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

async function main() {
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
    'first lead-only history forces Step 1 even when source metadata is absent',
    shouldForceColdStartStep1Inbound({
      conversationHistory: [
        {
          id: 'm1',
          sender: 'LEAD',
          content: 'Hey bro',
          timestamp: new Date()
        }
      ],
      hasActiveScript: true,
      conversationSource: null,
      leadSource: null,
      systemStage: null,
      currentScriptStep: 1,
      conversationMessageCount: 1
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
    'does not force manual upload conversations',
    shouldForceColdStartStep1Inbound({
      conversationHistory: [
        {
          id: 'm1',
          sender: 'LEAD',
          content: 'imported message',
          timestamp: new Date()
        }
      ],
      hasActiveScript: true,
      conversationSource: 'MANUAL_UPLOAD',
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

  const nowMs = Date.parse('2026-05-10T12:00:00.000Z');
  const staleManyChatFiredAt = '2026-05-04T12:00:00.000Z';
  const recentManyChatFiredAt = '2026-05-10T11:30:00.000Z';

  expect(
    'stale ManyChat (>2h) is not recently active',
    isManyChatRecentlyActive(
      'MANYCHAT',
      staleManyChatFiredAt,
      2 * 60 * 60 * 1000
    ),
    false
  );

  expect(
    'stale MANYCHAT + leadSource OUTBOUND still forces warm Step 1 when lead re-engages',
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
      conversationSource: 'MANYCHAT',
      leadSource: 'OUTBOUND',
      manyChatFiredAt: staleManyChatFiredAt,
      conversationMessageCount: 1
    }),
    true
  );

  expect(
    'Step 1 branch mode: recent MANYCHAT routes to CTA branch',
    resolveStep1BranchMode({
      conversationSource: 'MANYCHAT',
      leadSource: 'OUTBOUND',
      manyChatFiredAt: recentManyChatFiredAt,
      nowMs
    }),
    'manychat_cta'
  );

  expect(
    'Step 1 branch mode: stale MANYCHAT routes to Warm Inbound',
    resolveStep1BranchMode({
      conversationSource: 'MANYCHAT',
      leadSource: 'OUTBOUND',
      manyChatFiredAt: staleManyChatFiredAt,
      nowMs
    }),
    'warm_inbound'
  );

  const step1Branches = [
    {
      branchLabel: 'CTA Inbound (clicked ManyChat automation)',
      actions: []
    },
    { branchLabel: "CTA Inbound — didn't click button", actions: [] },
    { branchLabel: 'Outbound (story views / post likes)', actions: [] },
    { branchLabel: "Warm Inbound (DM'd directly)", actions: [] }
  ];

  expect(
    'Step 1 branch filter: stale MANYCHAT shows only Warm Inbound branch',
    selectStep1BranchesForPrompt(step1Branches, {
      conversationSource: 'MANYCHAT',
      leadSource: 'OUTBOUND',
      manyChatFiredAt: staleManyChatFiredAt,
      nowMs
    }).map((b) => b.branchLabel),
    ["Warm Inbound (DM'd directly)"]
  );

  expect(
    'Step 1 branch filter: recent MANYCHAT shows clicked CTA branch',
    selectStep1BranchesForPrompt(step1Branches, {
      conversationSource: 'MANYCHAT',
      leadSource: 'OUTBOUND',
      manyChatFiredAt: recentManyChatFiredAt,
      nowMs
    }).map((b) => b.branchLabel),
    ['CTA Inbound (clicked ManyChat automation)']
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
  const serializerSource = readFileSync('src/lib/script-serializer.ts', 'utf8');
  expect(
    'script serializer injects send_message as REQUIRED MESSAGE',
    serializerSource.includes('REQUIRED MESSAGE (send verbatim'),
    true
  );
  expect(
    'script serializer injects ask_question as REQUIRED QUESTION',
    serializerSource.includes('REQUIRED QUESTION (') &&
      serializerSource.includes('use this exact'),
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

  const judgeDirective = await buildJudgeClassificationDirective({
    step: judgeStep,
    latestLeadMessage: 'looking to start'
  });

  expect(
    'judge directive classifies start signal into matching branch',
    judgeDirective.includes('matches "Beginner"'),
    true
  );

  const judgeViolation = await detectJudgeBranchViolation({
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

  const skippedAffirmationViolation = await detectJudgeBranchViolation({
    step: judgeStep,
    latestLeadMessage: 'looking to start',
    generatedMessages: [
      'gotchu bro, are you doing this full time or do you have something on the side too?'
    ]
  });

  expect(
    'judge gate blocks matched branch when first required message is skipped',
    skippedAffirmationViolation.blocked,
    true
  );
  expect(
    'judge gate fallback restores the skipped beginner affirmation',
    skippedAffirmationViolation.fallbackMessages[0],
    'Hell yeah man, good spot to be in.'
  );

  const completeBranchViolation = await detectJudgeBranchViolation({
    step: judgeStep,
    latestLeadMessage: 'looking to start',
    generatedMessages: [
      'Hell yeah man, good spot to be in.',
      'What do you do for work right now?'
    ]
  });

  expect(
    'judge gate allows complete matched branch action sequence',
    completeBranchViolation.blocked,
    false
  );

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
