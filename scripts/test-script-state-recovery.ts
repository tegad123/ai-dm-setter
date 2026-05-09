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
        beliefBreakDelivered: true,
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
        beliefBreakDelivered: true,
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
