/**
 * Regression coverage for the script-stage self-recovery layer.
 *
 * Run: npx tsx scripts/test-script-state-recovery.ts
 */

import assert from 'node:assert/strict';
import {
  detectAttemptedStepSkip,
  evaluateRoutingCondition,
  extractCapturedDataPointsForTest,
  hasExplicitCapitalConstraintSignal,
  isStepComplete,
  computeSystemStage,
  validateSoftPitchPrerequisites
} from '@/lib/script-state-recovery';
import { scoreVoiceQualityGroup } from '@/lib/voice-quality-gate';
import { buildContextualSilentStopReEngagementForTest } from '@/lib/silent-stop-recovery';

function point<T = unknown>(points: Record<string, any>, key: string) {
  return points[key] as
    | {
        value: T;
        confidence: 'HIGH' | 'MEDIUM' | 'LOW';
        extractionMethod: string;
      }
    | undefined;
}

function assertHigh<T>(
  points: Record<string, any>,
  key: string,
  expectedValue: T,
  label: string
) {
  const p = point<T>(points, key);
  assert.ok(p, `${label}: point exists`);
  assert.equal(p?.confidence, 'HIGH', `${label}: confidence HIGH`);
  assert.deepEqual(p?.value, expectedValue, `${label}: value`);
}

function run() {
  const martinPoints = extractCapturedDataPointsForTest({
    minimumCapitalRequired: 1000,
    history: [
      {
        id: 'ai_capital_q',
        sender: 'AI',
        content: 'do you have at least 1000 usd set aside for that right now?',
        timestamp: new Date('2026-05-03T08:00:00Z')
      },
      {
        id: 'lead_yes',
        sender: 'LEAD',
        content: 'Yea I have',
        timestamp: new Date('2026-05-03T08:01:00Z')
      }
    ]
  });
  assertHigh(martinPoints, 'verifiedCapitalUsd', 1000, 'Martin binary yes');
  assertHigh(martinPoints, 'capitalThresholdMet', true, 'Martin threshold');
  assert.equal(
    point(martinPoints, 'capitalAnswerType')?.extractionMethod,
    'binary_yes_at_threshold',
    'Martin extraction method'
  );

  const uncertainPoints = extractCapturedDataPointsForTest({
    minimumCapitalRequired: 1000,
    history: [
      {
        id: 'ai_capital_q',
        sender: 'AI',
        content: 'do you have at least 1000 usd set aside for that right now?',
        timestamp: new Date('2026-05-03T08:00:00Z')
      },
      {
        id: 'lead_probably',
        sender: 'LEAD',
        content: 'probably, i think so',
        timestamp: new Date('2026-05-03T08:01:00Z')
      }
    ]
  });
  assert.notEqual(
    point(uncertainPoints, 'verifiedCapitalUsd')?.confidence,
    'HIGH',
    'uncertain capital must not become HIGH-confidence capital'
  );

  const incomeGoalPoints = extractCapturedDataPointsForTest({
    history: [
      {
        id: 'ai_income_goal_q',
        sender: 'AI',
        content: 'what are you tryna get to with trading?',
        timestamp: new Date('2026-05-09T02:43:00Z')
      },
      {
        id: 'lead_income_goal',
        sender: 'LEAD',
        content: 'I’d need at least 6k a month to replace my nursing income',
        timestamp: new Date('2026-05-09T02:44:00Z')
      }
    ]
  });
  assertHigh(
    incomeGoalPoints,
    'incomeGoal',
    6000,
    'income goal after tryna-get-to prompt'
  );

  const tegaSequencePoints = extractCapturedDataPointsForTest({
    history: [
      {
        id: 'ai_work_q',
        sender: 'AI',
        content: 'yeah bro, that’s the real issue. what do you do for work rn?',
        timestamp: new Date('2026-05-09T02:38:00Z')
      },
      {
        id: 'lead_work',
        sender: 'LEAD',
        content: 'I work as a nurse',
        timestamp: new Date('2026-05-09T02:39:00Z')
      },
      {
        id: 'ai_tenure_q',
        sender: 'AI',
        content: 'damn bro, respect to you fr. how long you been doing that?',
        timestamp: new Date('2026-05-09T02:40:00Z')
      },
      {
        id: 'lead_tenure',
        sender: 'LEAD',
        content: '3 yrs now',
        timestamp: new Date('2026-05-09T02:41:00Z')
      },
      {
        id: 'ai_monthly_q',
        sender: 'AI',
        content:
          'respect bro, 3 years in nursing is no joke. what’s the monthly income looking like for you rn?',
        timestamp: new Date('2026-05-09T02:42:00Z')
      },
      {
        id: 'lead_monthly',
        sender: 'LEAD',
        content: 'Around 4k a month',
        timestamp: new Date('2026-05-09T02:43:00Z')
      },
      {
        id: 'ai_goal_q',
        sender: 'AI',
        content:
          'respect bro, 4k a month is solid. what are you tryna get to with trading?',
        timestamp: new Date('2026-05-09T02:44:00Z')
      },
      {
        id: 'lead_goal',
        sender: 'LEAD',
        content: 'I’d need at least 6k a month to replace my nursing income',
        timestamp: new Date('2026-05-09T02:45:00Z')
      }
    ]
  });
  assertHigh(tegaSequencePoints, 'workBackground', 'nurse', 'Tega work');
  assertHigh(tegaSequencePoints, 'monthlyIncome', 4000, 'Tega monthly income');
  assertHigh(tegaSequencePoints, 'incomeGoal', 6000, 'Tega income goal');
  assert.equal(
    point(tegaSequencePoints, 'deepWhy'),
    undefined,
    'Tega sequence has not captured deepWhy yet'
  );

  const reorderedStep8Step9Points = extractCapturedDataPointsForTest({
    history: [
      {
        id: 'ai_work_q',
        sender: 'AI',
        content: 'what do you do for work rn?',
        timestamp: new Date('2026-05-10T16:38:30Z')
      },
      {
        id: 'lead_work',
        sender: 'LEAD',
        content: 'I work as a nurse',
        timestamp: new Date('2026-05-10T16:39:08Z')
      },
      {
        id: 'ai_monthly_q',
        sender: 'AI',
        content:
          'and as of right now, how much is your job bringing in on a monthly basis?',
        timestamp: new Date('2026-05-10T16:39:40Z')
      },
      {
        id: 'lead_monthly',
        sender: 'LEAD',
        content: 'Around 4k a month',
        timestamp: new Date('2026-05-10T16:40:15Z')
      },
      {
        id: 'ai_goal_q',
        sender: 'AI',
        content:
          'and if trading actually clicked for you, how much would you want it to bring in monthly?',
        timestamp: new Date('2026-05-10T16:40:52Z')
      },
      {
        id: 'lead_goal',
        sender: 'LEAD',
        content: 'I’d need at least 6k a month to replace my nursing income',
        timestamp: new Date('2026-05-10T16:42:13Z')
      },
      {
        id: 'ai_replace_q',
        sender: 'AI',
        content:
          'is that to fully replace the nursing income, or would that just be the start for you?',
        timestamp: new Date('2026-05-10T16:42:48Z')
      },
      {
        id: 'lead_replace',
        sender: 'LEAD',
        content: 'Replace it completely, I’m tired of these 12 hour shifts',
        timestamp: new Date('2026-05-10T16:43:29Z')
      }
    ]
  });
  assertHigh(
    reorderedStep8Step9Points,
    'incomeGoal',
    6000,
    'income goal from "trading clicked / bring in monthly" prompt'
  );
  assertHigh(
    reorderedStep8Step9Points,
    'replaceOrSupplement',
    'replace',
    'replace/supplement from fully-replace-income prompt'
  );

  const nullRuleScript = {
    id: 'script_null_rules',
    steps: Array.from({ length: 10 }, (_, idx) => {
      const stepNumber = idx + 1;
      return {
        stepNumber,
        title:
          stepNumber === 10
            ? 'Desired Outcome — Deep Why'
            : `Step ${stepNumber}`,
        stateKey: null,
        recoveryActionType: null,
        canonicalQuestion: null,
        artifactField: null,
        completionRule: null,
        requiredDataPoints: null,
        routingRules: null,
        actions: [],
        branches:
          stepNumber === 10
            ? [
                {
                  branchLabel: 'Default',
                  conditionDescription: null,
                  sortOrder: 0,
                  actions: [
                    {
                      actionType: 'send_message',
                      content:
                        'I respect that bro, I truly do. I hear so many people talk about cars and materialistic stuff so it is refreshing to hear this haha.'
                    },
                    {
                      actionType: 'ask_question',
                      content:
                        'But why is {{their stated goal}} so important to you though?'
                    },
                    { actionType: 'wait_for_response', content: null }
                  ]
                }
              ]
            : []
      };
    })
  } as any;
  const nullRuleStage = computeSystemStage(
    nullRuleScript,
    reorderedStep8Step9Points,
    []
  );
  assert.equal(
    nullRuleStage.step?.stepNumber,
    1,
    'null completionRule alone does not skip steps from captured data'
  );

  const genericSequentialScript = {
    id: 'generic_sequence',
    steps: [
      {
        stepNumber: 1,
        title: 'Question One',
        stateKey: null,
        recoveryActionType: null,
        canonicalQuestion: null,
        artifactField: null,
        completionRule: null,
        requiredDataPoints: null,
        routingRules: null,
        actions: [
          {
            actionType: 'ask_question',
            content: 'What do you do for work?'
          },
          { actionType: 'wait_for_response', content: null }
        ],
        branches: []
      },
      {
        stepNumber: 2,
        title: 'Question Two',
        stateKey: null,
        recoveryActionType: null,
        canonicalQuestion: null,
        artifactField: null,
        completionRule: null,
        requiredDataPoints: null,
        routingRules: null,
        actions: [
          {
            actionType: 'ask_question',
            content: 'How long have you been doing that?'
          },
          { actionType: 'wait_for_response', content: null }
        ],
        branches: []
      },
      {
        stepNumber: 3,
        title: 'Question Three',
        stateKey: null,
        recoveryActionType: null,
        canonicalQuestion: null,
        artifactField: null,
        completionRule: null,
        requiredDataPoints: null,
        routingRules: null,
        actions: [
          {
            actionType: 'ask_question',
            content: 'What are you trying to make each month?'
          },
          { actionType: 'wait_for_response', content: null }
        ],
        branches: []
      }
    ]
  } as any;
  const genericHistory = [
    {
      sender: 'AI',
      content: 'What do you do for work?',
      timestamp: new Date('2026-05-11T00:00:00Z')
    },
    {
      sender: 'LEAD',
      content: 'I work as a nurse',
      timestamp: new Date('2026-05-11T00:01:00Z')
    }
  ];
  assert.equal(
    computeSystemStage(genericSequentialScript, {}, genericHistory).step
      ?.stepNumber,
    2,
    'generic null-rule script advances from Step 1 to Step 2 only after Step 1 ask gets a lead reply'
  );
  assert.equal(
    computeSystemStage(genericSequentialScript, {}, genericHistory, {
      previousCurrentScriptStep: 1,
      maxAdvanceSteps: 1
    }).step?.stepNumber,
    2,
    'generic sequencer allows exactly one step of advancement per lead turn'
  );
  const twoCompletedStepsHistory = [
    ...genericHistory,
    {
      sender: 'AI',
      content: 'How long have you been doing that?',
      timestamp: new Date('2026-05-11T00:02:00Z')
    },
    {
      sender: 'LEAD',
      content: '2 years',
      timestamp: new Date('2026-05-11T00:03:00Z')
    }
  ];
  assert.equal(
    computeSystemStage(genericSequentialScript, {}, twoCompletedStepsHistory)
      .step?.stepNumber,
    3,
    'generic sequencer can derive later position from ordered history when uncapped'
  );
  assert.equal(
    computeSystemStage(genericSequentialScript, {}, twoCompletedStepsHistory, {
      previousCurrentScriptStep: 1,
      maxAdvanceSteps: 1
    }).step?.stepNumber,
    2,
    'generic sequencer caps stale recomputation to one step beyond persisted state'
  );

  const msgWaitScript = {
    id: 'generic_msg_wait_sequence',
    steps: [
      {
        stepNumber: 1,
        title: 'Silent Ack',
        stateKey: null,
        recoveryActionType: null,
        canonicalQuestion: null,
        artifactField: null,
        completionRule: null,
        requiredDataPoints: null,
        routingRules: null,
        actions: [
          { actionType: 'send_message', content: 'I hear you bro.' },
          { actionType: 'wait_for_response', content: null }
        ],
        branches: []
      },
      {
        stepNumber: 2,
        title: 'Next Question',
        stateKey: null,
        recoveryActionType: null,
        canonicalQuestion: null,
        artifactField: null,
        completionRule: null,
        requiredDataPoints: null,
        routingRules: null,
        actions: [
          {
            actionType: 'ask_question',
            content: 'What happened next?'
          },
          { actionType: 'wait_for_response', content: null }
        ],
        branches: []
      }
    ]
  } as any;
  assert.equal(
    computeSystemStage(msgWaitScript, {}, [
      {
        sender: 'AI',
        content: 'I hear you bro.',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        sender: 'LEAD',
        content: 'yeah it was rough',
        timestamp: new Date('2026-05-11T00:01:00Z')
      }
    ]).step?.stepNumber,
    2,
    'generic [MSG]+[WAIT] step completes only after the lead replies'
  );

  const prematureCapitalAfterIncomeGoal = scoreVoiceQualityGroup(
    [
      "real quick, what's your capital situation like for the markets right now?"
    ],
    {
      aiMessageCount: 13,
      skipLegacyPacingGates: true,
      capturedDataPoints: tegaSequencePoints
    }
  );
  assert.ok(
    prematureCapitalAfterIncomeGoal.hardFails.some((failure) =>
      failure.includes('capital_question_premature:')
    ),
    'Tega sequence blocks capital immediately after income goal'
  );

  assert.equal(
    hasExplicitCapitalConstraintSignal(
      'capital and lack of knowledge is my problem'
    ),
    true,
    'explicit capital + knowledge signal is caught'
  );

  assert.equal(
    evaluateRoutingCondition({
      condition: 'value >= minimumCapitalRequired',
      value: 1000,
      minimumCapitalRequired: 1000
    }),
    true,
    'threshold route matches'
  );
  assert.equal(
    evaluateRoutingCondition({
      condition: 'value < minimumCapitalRequired',
      value: 500,
      minimumCapitalRequired: 1000
    }),
    true,
    'downsell route matches'
  );

  const step = {
    completionRule: {
      type: 'data_captured',
      fields: ['verifiedCapitalUsd']
    }
  } as any;
  assert.equal(
    isStepComplete(step, martinPoints),
    true,
    'HIGH-confidence data completes the step'
  );
  assert.equal(
    isStepComplete(step, uncertainPoints),
    false,
    'LOW/MEDIUM confidence does not complete the step'
  );

  const script = {
    id: 'script_test',
    steps: [
      {
        stepNumber: 8,
        title: 'Capital Qualification',
        stateKey: 'CAPITAL_QUALIFICATION',
        recoveryActionType: 'ASK_QUESTION',
        canonicalQuestion:
          'what capital do you have set aside for the markets right now?',
        artifactField: null,
        completionRule: {
          type: 'data_captured',
          fields: ['verifiedCapitalUsd']
        },
        requiredDataPoints: null,
        routingRules: null,
        actions: [],
        branches: []
      },
      {
        stepNumber: 9,
        title: 'Route Based on Capital',
        stateKey: 'ROUTE_BY_CAPITAL',
        recoveryActionType: 'ROUTE_DECISION',
        canonicalQuestion: null,
        artifactField: null,
        completionRule: {
          type: 'route_decision',
          field: 'verifiedCapitalUsd'
        },
        requiredDataPoints: null,
        routingRules: {
          field: 'verifiedCapitalUsd',
          branches: [
            {
              condition: 'value >= minimumCapitalRequired',
              nextStep: 10
            }
          ]
        },
        actions: [],
        branches: []
      },
      {
        stepNumber: 10,
        title: 'Send Application Link',
        stateKey: 'SEND_APPLICATION_LINK',
        recoveryActionType: 'DELIVER_ARTIFACT',
        canonicalQuestion: null,
        artifactField: 'applicationFormUrl',
        completionRule: {
          type: 'artifact_delivered',
          field: 'applicationFormUrl'
        },
        requiredDataPoints: null,
        routingRules: null,
        actions: [],
        branches: []
      }
    ]
  } as any;
  const missingCapitalSnapshot = {
    conversationId: 'conv_skip',
    leadId: 'lead_skip',
    script,
    currentStep: script.steps[0],
    currentScriptStep: 8,
    activeBranch: null,
    selectedBranchLabel: null,
    systemStage: 'CAPITAL_QUALIFICATION',
    capturedDataPoints: {},
    persona: null,
    reason: 'first_incomplete_step'
  };
  const skip = detectAttemptedStepSkip({
    snapshot: missingCapitalSnapshot,
    plannedAction: 'would you be open to a quick call with anthony?'
  });
  assert.equal(skip.skip, true, 'soft pitch before capital is detected');
  assert.equal(
    skip.recoveryStep?.stateKey,
    'CAPITAL_QUALIFICATION',
    'skip recovery targets missed capital step'
  );

  const blockedSoftPitch = validateSoftPitchPrerequisites({
    snapshot: missingCapitalSnapshot,
    action: 'would you be open to a quick call with anthony?'
  });
  assert.equal(
    blockedSoftPitch.allowed,
    false,
    'soft pitch is blocked when capital prerequisite is missing'
  );
  assert.deepEqual(
    blockedSoftPitch.missingPrerequisites,
    ['verifiedCapitalUsd'],
    'missing prerequisite is derived from script completion rules'
  );
  const capitalMetSnapshot = {
    ...missingCapitalSnapshot,
    capturedDataPoints: martinPoints
  };
  assert.equal(
    validateSoftPitchPrerequisites({
      snapshot: capitalMetSnapshot,
      action: 'would you be open to a quick call with anthony?'
    }).allowed,
    true,
    'soft pitch is allowed after high-confidence capital capture'
  );

  const recoveryQuality = scoreVoiceQualityGroup(
    [
      "bet bro, here's the application: https://form.typeform.com/to/AGUtPdmb",
      "fill it out and lmk once it's sent through"
    ],
    {
      capturedDataPoints: {
        workBackground: 'nurse',
        monthlyIncome: 4000,
        replaceOrSupplement: 'replace',
        incomeGoal: 6000,
        deepWhy: 'family freedom',
        obstacle: 'emotions',
        beliefBreakDelivered: 'complete',
        buyInConfirmed: true
      }
    }
  );
  assert.equal(
    recoveryQuality.hardFails.length,
    0,
    `deterministic recovery message has no hard voice-gate failures: ${recoveryQuality.hardFails.join(', ')}`
  );

  // ── R39 positive_volunteered_disclosure (Jefferson @namejeffe 2026-05-03) ──
  // Lead self-reports forward motion ("Im already on a paper trade
  // account so part 1 of the plan in progress"). Today the AI freezes
  // for 17+ minutes because none of the existing R39 patterns match.
  // The new bridge must classify the pattern and return one of three
  // capital-bridge templates.
  const jeffersonPositiveDisclosure =
    'Im already on a paper trade account so part 1 of the plan in progress';
  const positiveDraft = buildContextualSilentStopReEngagementForTest(
    jeffersonPositiveDisclosure
  );
  assert.ok(
    positiveDraft,
    'R39: positive_volunteered_disclosure returns a draft (not null)'
  );
  assert.equal(
    positiveDraft?.action,
    'positive_disclosure_capital_bridge',
    'R39: bridge action tag'
  );
  assert.equal(
    positiveDraft?.reason,
    'positive_disclosure_bridge',
    'R39: reason tag'
  );
  assert.equal(positiveDraft?.stage, 'FINANCIAL_SCREENING', 'R39: stage');
  assert.equal(
    positiveDraft?.subStage,
    'CAPITAL_QUALIFICATION',
    'R39: subStage'
  );
  assert.equal(
    positiveDraft?.capitalOutcome,
    'not_asked',
    'R39: capitalOutcome'
  );
  assert.equal(
    positiveDraft?.messages.length,
    1,
    'R39: bridge produces exactly one message'
  );
  // The randomized template selection means we can't pin to one
  // string. Assert the message references "capital" — the load-bearing
  // bridge content — and the "you're already" / "ahead" / "moving on
  // it" acknowledgment vocabulary that defines the three variants.
  const positiveMsg = positiveDraft?.messages[0] ?? '';
  assert.ok(
    /capital/i.test(positiveMsg),
    `R39: bridge message references capital — got: "${positiveMsg.slice(0, 120)}"`
  );
  assert.ok(
    /(already|ahead|wassup|fire|respect)/i.test(positiveMsg),
    `R39: bridge message acknowledges before bridging — got: "${positiveMsg.slice(0, 120)}"`
  );

  // Pattern-classifier must place positive_volunteered_disclosure
  // BEFORE vague_motivation. Probe: a message that contains both
  // "started reading" (positive disclosure) and "eventually" (vague
  // motivation) must classify as the positive bridge.
  const overlap = buildContextualSilentStopReEngagementForTest(
    'started reading some books eventually want to figure it out'
  );
  assert.equal(
    overlap?.reason,
    'positive_disclosure_bridge',
    'R39: positive disclosure wins over overlapping vague_motivation'
  );

  // Negative case: pure vague-motivation phrasing without disclosure
  // keywords still classifies as vague_motivation, not the new bridge.
  const vague = buildContextualSilentStopReEngagementForTest(
    'just want to eventually figure it out you know'
  );
  assert.equal(
    vague?.reason,
    'vague_motivation_bridge',
    'R39: pure vague_motivation regression — new bridge does not over-fire'
  );

  // Voice-quality regression on every randomized template: each must
  // pass the gate with zero hard fails so the bridge ships clean.
  for (let i = 0; i < 12; i++) {
    const draft = buildContextualSilentStopReEngagementForTest(
      jeffersonPositiveDisclosure
    );
    if (!draft) continue;
    const q = scoreVoiceQualityGroup(draft.messages, {
      capturedDataPoints: {
        deepWhy: 'family freedom',
        obstacle: 'needs structure',
        beliefBreakDelivered: 'complete',
        buyInConfirmed: true,
        callProposalAccepted: true
      }
    });
    assert.equal(
      q.hardFails.length,
      0,
      `R39 template iter ${i}: voice gate must pass — fails: ${q.hardFails.join(', ')}`
    );
  }

  console.log('script-state recovery tests passed');
}

run();
