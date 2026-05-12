// Unit tests for script-step-progression — the call-proposal prereq
// gate, belief-break detection, current-step inference, and the
// fixture-style end-to-end check from the bug-24 spec
// (@daniel_elumelu 2026-05-08 incident: AI skipped 12 steps and
// proposed the call after only 4 exchanges).
//
// Run:
//   npx tsx --test tests/unit/script-step-progression.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CALL_PROPOSAL_PREREQS,
  CAPITAL_QUESTION_PREREQS,
  MANDATORY_ASK_STEPS,
  buildCurrentStepBlock,
  checkCallProposalPrereqs,
  checkCapitalQuestionPrereqs,
  checkMandatoryAsksFired,
  countConversationTurns,
  containsQuestion,
  countQuestionMarks,
  detectAcknowledgmentOpener,
  detectAskFiredInHistory,
  detectBeliefBreakDeliveryStage,
  detectBeliefBreakDelivered,
  detectBeliefBreakInMessage,
  detectCallProposalAttempt,
  detectCapitalQuestionAttempt,
  detectCapitalQuestionPremature,
  detectMandatoryAskSkipped,
  detectStep10Skipped,
  detectStep12PlusContent,
  detectStepDistanceViolation,
  getStepActionShape,
  hasCapturedDataPoint,
  incomeGoalSatisfiedByExpectedStep,
  inferCurrentStepNumber,
  inferStepFromReply,
  inferStepLabelFromReply,
  jaccardSimilarity,
  maxQuestionSimilarityToScript,
  type CompactScriptStep
} from '../../src/lib/script-step-progression';
import {
  detectJudgeBranchViolation,
  selectJudgeBranchForLead
} from '../../src/lib/ai-engine';
import {
  detectFabricatedUrlInReply,
  detectMsgBubbleSequenceViolation,
  detectMsgVerbatimViolation,
  extractRequiredQuotes,
  containsIncomeGoalQuestion,
  scoreVoiceQualityGroup
} from '../../src/lib/voice-quality-gate';
import { computeSystemStage } from '../../src/lib/script-state-recovery';
import {
  selectBranchesForPrompt,
  selectStep1BranchesForPrompt
} from '../../src/lib/script-serializer';
import {
  getCurrentlyRelevantUrlsFromScript,
  shouldExposePersonaAssetUrl
} from '../../src/lib/ai-prompts';
import { sanitizeMessageGroupUrls } from '../../src/lib/url-allowlist';

function step9IncomeGoalPoint(value: number | string = 4000) {
  return {
    value,
    confidence: 'HIGH',
    extractedFromMessageId: 'lead_step9',
    extractionMethod: 'amount_after_step_9_prompt',
    extractedAt: '2026-05-11T15:05:00.000Z',
    sourceFieldName: 'incomeGoal',
    sourceStepNumber: 9
  };
}

function step9CompletedEvent() {
  return {
    eventType: 'step_completed',
    stepNumber: 9,
    stepTitle: 'Income Goal',
    selectedBranchLabel: 'Wants to supplement',
    completedAt: '2026-05-11T15:05:00.000Z'
  };
}

function step9SelectedEvent() {
  return {
    eventType: 'branch_selected',
    stepNumber: 9,
    stepTitle: 'Income Goal',
    selectedBranchLabel: 'Wants to supplement',
    sentAt: '2026-05-11T15:04:00.000Z'
  };
}

function step13CompletedEvent() {
  return {
    eventType: 'step_completed',
    stepNumber: 13,
    stepTitle: 'Belief Break — Reframe',
    selectedBranchLabel: 'Psychology / Discipline symptom',
    completedAt: '2026-05-11T15:13:00.000Z'
  };
}

// ---------------------------------------------------------------------------
// hasCapturedDataPoint — accepts both flat and {value,confidence} shapes
// ---------------------------------------------------------------------------

describe('hasCapturedDataPoint', () => {
  it('returns false for null/undefined', () => {
    assert.equal(hasCapturedDataPoint(null, 'x'), false);
    assert.equal(hasCapturedDataPoint(undefined, 'x'), false);
  });

  it('reads flat string captures (runtime-judgment shape)', () => {
    assert.equal(
      hasCapturedDataPoint(
        { early_obstacle: 'blowing accounts' },
        'early_obstacle'
      ),
      true
    );
    assert.equal(hasCapturedDataPoint({ x: '' }, 'x'), false);
    assert.equal(hasCapturedDataPoint({ x: '   ' }, 'x'), false);
  });

  it('reads structured captures ({value, confidence} shape)', () => {
    const points = {
      workBackground: { value: 'engineer', confidence: 'HIGH' }
    };
    assert.equal(hasCapturedDataPoint(points, 'workBackground'), true);
  });

  it('bug-001-normalizes-camel-snake-captured-keys', () => {
    assert.equal(
      hasCapturedDataPoint({ incomeGoal: '$1k' }, 'income_goal'),
      true
    );
    assert.equal(
      hasCapturedDataPoint({ income_goal: '$1k' }, 'incomeGoal'),
      true
    );
    assert.equal(
      hasCapturedDataPoint(
        { beliefBreakDelivered: { value: 'complete' } },
        'belief_break_delivered'
      ),
      true
    );
    assert.equal(
      hasCapturedDataPoint(
        { belief_break_delivered: { value: 'complete' } },
        'beliefBreakDelivered'
      ),
      true
    );
  });

  it('treats boolean flat captures correctly', () => {
    assert.equal(
      hasCapturedDataPoint({ buyInConfirmed: true }, 'buyInConfirmed'),
      true
    );
    assert.equal(
      hasCapturedDataPoint({ buyInConfirmed: false }, 'buyInConfirmed'),
      false
    );
  });

  it('returns false for missing keys', () => {
    assert.equal(hasCapturedDataPoint({ other: 'x' }, 'missing'), false);
  });
});

// ---------------------------------------------------------------------------
// detectCallProposalAttempt — regex coverage for daetradez script shapes
// ---------------------------------------------------------------------------

describe('detectCallProposalAttempt', () => {
  it('detects the daetradez Step 16 default-branch call pitch', () => {
    const reply =
      'If it makes sense we can set up a time with my right hand guy Anthony to break down a roadmap for you to reach your goals. Would that help?';
    assert.equal(detectCallProposalAttempt(reply), true);
  });

  it('detects "hop on a quick call"', () => {
    assert.equal(
      detectCallProposalAttempt('wanna hop on a quick call this week?'),
      true
    );
  });

  it('detects "set you up with my right hand"', () => {
    assert.equal(
      detectCallProposalAttempt(
        'Let me set you up with my right hand guy Anthony'
      ),
      true
    );
  });

  it('detects "locked in with Anthony"', () => {
    assert.equal(
      detectCallProposalAttempt(
        'got you locked in with my head coach Anthony for tomorrow'
      ),
      true
    );
  });

  it('detects booking link / typeform language', () => {
    assert.equal(
      detectCallProposalAttempt(
        'schedule a date for the call. Booking Typeform: ...'
      ),
      true
    );
  });

  it('does NOT trigger on innocent language', () => {
    assert.equal(
      detectCallProposalAttempt("yo bro how's your day going"),
      false
    );
    assert.equal(detectCallProposalAttempt('what do you do for work?'), false);
    assert.equal(
      detectCallProposalAttempt('how have the markets been treating you?'),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// checkCallProposalPrereqs — the eight-prereq gate
// ---------------------------------------------------------------------------

describe('checkCallProposalPrereqs', () => {
  it('returns ALL prereqs when capturedDataPoints is empty', () => {
    const missing = checkCallProposalPrereqs({});
    assert.equal(missing.length, CALL_PROPOSAL_PREREQS.length);
    // First missing should be Step 5 (workBackground)
    assert.equal(missing[0].id, 'work_background');
    assert.equal(missing[0].stepNumber, 5);
  });

  it('returns no missing prereqs when all eight are captured', () => {
    const points = {
      workBackground: 'engineer',
      monthlyIncome: '5000',
      replaceOrSupplement: 'replace',
      incomeGoal: '15000',
      desiredOutcome: 'family freedom',
      obstacle: "can't stick to a system",
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true'
    };
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('requires beliefBreakDelivered to be complete, not merely truthy', () => {
    const points = {
      workBackground: 'engineer',
      monthlyIncome: '5000',
      replaceOrSupplement: 'replace',
      incomeGoal: '15000',
      desiredOutcome: 'family freedom',
      obstacle: "can't stick to a system",
      beliefBreakDelivered: 'bubble1',
      buyInConfirmed: 'true'
    };
    const missing = checkCallProposalPrereqs(points);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].id, 'belief_break_delivered');
  });

  it('bug-58-requires-income-goal-from-step-9-when-branch-history-exists', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: {
        value: 8000,
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_step8',
        extractionMethod: 'volunteered_incomeGoal_for_upcoming_ask',
        extractedAt: '2026-05-11T22:34:54.390Z',
        sourceFieldName: 'incomeGoal',
        sourceStepNumber: 8
      },
      deepWhy: 'provide for family',
      obstacle: 'emotional control',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true',
      branchHistory: [
        {
          eventType: 'step_completed',
          stepNumber: 8,
          stepTitle: 'Replace vs Supplement',
          selectedBranchLabel: 'Default',
          completedAt: '2026-05-11T22:34:54.390Z'
        }
      ]
    };

    assert.equal(incomeGoalSatisfiedByExpectedStep(points, 9), false);
    const missing = checkCallProposalPrereqs(points);
    assert.equal(missing[0].id, 'income_goal');
  });

  it('bug-58-accepts-income-goal-captured-from-step-9-own-ask', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: {
        value: 4000,
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_step9',
        extractionMethod: 'amount_after_step_9_prompt',
        extractedAt: '2026-05-11T22:35:54.390Z',
        sourceFieldName: 'incomeGoal',
        sourceStepNumber: 9
      },
      deepWhy: 'provide for family',
      obstacle: 'emotional control',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true',
      branchHistory: [
        {
          eventType: 'step_completed',
          stepNumber: 9,
          stepTitle: 'Income Goal',
          selectedBranchLabel: 'Wants to supplement',
          completedAt: '2026-05-11T22:35:54.390Z'
        }
      ]
    };

    assert.equal(incomeGoalSatisfiedByExpectedStep(points, 9), true);
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('bug-001-call-prereqs-accept-camelcase-captures-with-durable-step-history', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: '$1k',
      deep_why: 'help with bills without stressing every month',
      obstacle: 'revenge trading',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: true,
      branchHistory: [step9CompletedEvent()]
    };

    assert.equal(incomeGoalSatisfiedByExpectedStep(points, 9), true);
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('bug-001-call-prereqs-accept-flat-income-goal-after-step-9-selection', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: '$1k',
      deep_why: 'help with bills without stressing every month',
      obstacle: 'revenge trading',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: true,
      branchHistory: [step9SelectedEvent()]
    };

    assert.equal(incomeGoalSatisfiedByExpectedStep(points, 9), true);
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('bug-001-call-prereqs-accept-completed-belief-break-history', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: '$1k',
      deep_why: 'help with bills without stressing every month',
      obstacle: 'revenge trading',
      beliefBreakDelivered: 'bubble2',
      buyInConfirmed: true,
      branchHistory: [step9CompletedEvent(), step13CompletedEvent()]
    };

    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('bug-001b-call-prereqs-normalize-incomeGoal-to-income_goal', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: {
        value: '$1k',
        confidence: 'HIGH',
        sourceFieldName: 'incomeGoal',
        sourceStepNumber: 9
      },
      deep_why: 'help with bills without stressing every month',
      obstacle: 'revenge trading',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: true,
      branchHistory: [step9CompletedEvent(), step13CompletedEvent()]
    };

    assert.equal(hasCapturedDataPoint(points, 'income_goal'), true);
    assert.equal(incomeGoalSatisfiedByExpectedStep(points, 9), true);
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('bug-008-call-prereqs-trust-step-9-incomeGoal-source-even-when-branch-history-is-incomplete', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: {
        value: '$1k',
        confidence: 'HIGH',
        sourceFieldName: 'incomeGoal',
        sourceStepNumber: 9
      },
      deep_why: 'help with bills without stressing every month',
      obstacle: 'revenge trading',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: true,
      branchHistory: [step13CompletedEvent()]
    };

    assert.equal(incomeGoalSatisfiedByExpectedStep(points, 9), true);
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('bug-009-call-prereqs-trust-late-sourced-incomeGoal-after-step-9-history', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: {
        value: 1000,
        confidence: 'HIGH',
        sourceFieldName: 'incomeGoal',
        sourceStepNumber: 10
      },
      deep_why: 'be home for bath time and story time',
      obstacle: 'emotional control',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: true,
      branchHistory: [step9CompletedEvent(), step13CompletedEvent()]
    };

    assert.equal(incomeGoalSatisfiedByExpectedStep(points, 9), true);
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('bug-012-call-prereqs-trust-late-sourced-incomeGoal-after-later-step-history', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: {
        value: 1000,
        confidence: 'HIGH',
        sourceFieldName: 'incomeGoal',
        sourceStepNumber: 10
      },
      deep_why: 'be home for bath time and story time',
      obstacle: 'emotional control',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: true,
      branchHistory: [step13CompletedEvent()]
    };

    assert.equal(incomeGoalSatisfiedByExpectedStep(points, 9), true);
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('bug-014-call-prereqs-trust-flat-numeric-incomeGoal-after-step-9-ask-fired', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: '1000',
      deep_why: 'be home for bath time and story time',
      obstacle: 'emotional control',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: true,
      branchHistory: [
        {
          eventType: 'step_completed',
          stepNumber: 8,
          stepTitle: 'Replace vs Supplement',
          selectedBranchLabel: 'Default',
          completedAt: '2026-05-11T15:08:00.000Z'
        }
      ]
    };

    assert.equal(incomeGoalSatisfiedByExpectedStep(points, 9), false);
    assert.equal(
      incomeGoalSatisfiedByExpectedStep(points, 9, {
        expectedStepAsked: true
      }),
      true
    );
    assert.deepEqual(checkCallProposalPrereqs(points), [
      CALL_PROPOSAL_PREREQS.find((p) => p.id === 'income_goal')
    ]);
    assert.deepEqual(
      checkCallProposalPrereqs(points, { incomeGoalAsked: true }),
      []
    );
  });

  it('bug-014-does-not-trust-incomeGoal-explicitly-sourced-before-step-9', () => {
    const points = {
      workBackground: 'retail',
      monthlyIncome: '2000',
      replaceOrSupplement: 'supplement',
      incomeGoal: {
        value: 1000,
        confidence: 'HIGH',
        sourceFieldName: 'incomeGoal',
        sourceStepNumber: 8
      },
      deep_why: 'be home for bath time and story time',
      obstacle: 'emotional control',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: true,
      branchHistory: [
        {
          eventType: 'step_completed',
          stepNumber: 8,
          stepTitle: 'Replace vs Supplement',
          selectedBranchLabel: 'Default',
          completedAt: '2026-05-11T15:08:00.000Z'
        }
      ]
    };

    assert.equal(
      incomeGoalSatisfiedByExpectedStep(points, 9, {
        expectedStepAsked: true
      }),
      false
    );
    assert.equal(
      checkCallProposalPrereqs(points, { incomeGoalAsked: true })[0].id,
      'income_goal'
    );
  });

  it('bug-014-detects-script-exact-income-goal-question-with-money-word', () => {
    assert.equal(
      containsIncomeGoalQuestion(
        'Got it. So how much money are you trying to make with trading on a monthly basis?'
      ),
      true
    );
  });

  it('bug-006-call-prereqs-use-unified-captured-key-normalization', () => {
    const points = {
      work_background: 'retail',
      monthly_income: '2000',
      replace_or_supplement: 'supplement',
      incomeGoal: {
        value: '$1k',
        confidence: 'HIGH',
        sourceFieldName: 'incomeGoal',
        sourceStepNumber: 9
      },
      deepWhy: 'help with bills without stressing every month',
      earlyObstacle: 'revenge trading',
      belief_break_delivered: 'complete',
      buy_in_confirmed: true,
      branchHistory: [step9CompletedEvent(), step13CompletedEvent()]
    };

    assert.equal(hasCapturedDataPoint(points, 'workBackground'), true);
    assert.equal(hasCapturedDataPoint(points, 'income_goal'), true);
    assert.equal(hasCapturedDataPoint(points, 'beliefBreakDelivered'), true);
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('accepts early_obstacle as a substitute for obstacle', () => {
    const points = {
      workBackground: 'engineer',
      monthlyIncome: '5000',
      replaceOrSupplement: 'replace',
      incomeGoal: '15000',
      desiredOutcome: 'family freedom',
      early_obstacle: 'blowing accounts',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true'
    };
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('accepts deepWhy as a substitute for desiredOutcome', () => {
    const points = {
      workBackground: 'engineer',
      monthlyIncome: '5000',
      replaceOrSupplement: 'supplement',
      incomeGoal: '4000',
      deepWhy: 'want to retire my mom',
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true'
    };
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('accepts completed deep-why branchHistory as desired outcome prereq', () => {
    const points = {
      workBackground: 'engineer',
      monthlyIncome: '5000',
      replaceOrSupplement: 'supplement',
      incomeGoal: step9IncomeGoalPoint(),
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true',
      branchHistory: [
        step9CompletedEvent(),
        {
          eventType: 'step_completed',
          stepNumber: 11,
          stepTitle: 'Desired Outcome — Probe if Surface',
          selectedBranchLabel: 'Surface — needs second probe',
          completedAt: '2026-05-11T15:07:11.508Z'
        }
      ]
    };

    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('bug-C: accepts completed clear buy-in branchHistory as buy_in_confirmed', () => {
    const points = {
      workBackground: 'engineer',
      monthlyIncome: '5000',
      replaceOrSupplement: 'supplement',
      incomeGoal: step9IncomeGoalPoint(),
      deepWhy: 'want to retire my mom',
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      branchHistory: [
        step9CompletedEvent(),
        {
          eventType: 'step_completed',
          stepNumber: 14,
          stepTitle: 'Buy-in confirmation',
          selectedBranchLabel: 'Clear buy-in',
          completedAt: '2026-05-11T07:00:00.000Z'
        }
      ]
    };

    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('does not treat hesitant buy-in branchHistory as buy_in_confirmed', () => {
    const points = {
      workBackground: 'engineer',
      monthlyIncome: '5000',
      replaceOrSupplement: 'supplement',
      incomeGoal: step9IncomeGoalPoint(),
      deepWhy: 'want to retire my mom',
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      branchHistory: [
        step9CompletedEvent(),
        {
          eventType: 'step_completed',
          stepNumber: 14,
          stepTitle: 'Buy-in confirmation',
          selectedBranchLabel: 'Not ready / hesitant',
          completedAt: '2026-05-11T07:00:00.000Z'
        }
      ]
    };

    const missing = checkCallProposalPrereqs(points);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].id, 'buy_in_confirmed');
  });

  it('returns the FIRST missing prereq in script-step order', () => {
    // Captured everything except beliefBreakDelivered (Step 13).
    const points = {
      workBackground: 'engineer',
      monthlyIncome: '5000',
      replaceOrSupplement: 'replace',
      incomeGoal: '15000',
      desiredOutcome: 'family freedom',
      obstacle: 'no system',
      buyInConfirmed: 'true'
    };
    const missing = checkCallProposalPrereqs(points);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].id, 'belief_break_delivered');
    assert.equal(missing[0].stepNumber, 13);
  });

  it('handles structured ({value, confidence}) captures', () => {
    const points = {
      workBackground: { value: 'engineer', confidence: 'HIGH' },
      monthlyIncome: { value: '5000', confidence: 'HIGH' },
      replaceOrSupplement: { value: 'replace', confidence: 'HIGH' },
      incomeGoal: { value: '15000', confidence: 'HIGH' },
      desiredOutcome: { value: 'family', confidence: 'HIGH' },
      obstacle: { value: 'no system', confidence: 'HIGH' },
      beliefBreakDelivered: { value: 'complete', confidence: 'HIGH' },
      buyInConfirmed: { value: true, confidence: 'HIGH' }
    };
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });

  it('accepts monthly_income_skipped (judge-condition skip path)', () => {
    const points = {
      workBackground: 'doctor',
      monthlyIncomeSkipped: 'true', // Step 7 judge skipped income for high earners
      replaceOrSupplement: 'replace',
      incomeGoal: '20000',
      desiredOutcome: 'family',
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true'
    };
    assert.deepEqual(checkCallProposalPrereqs(points), []);
  });
});

// ---------------------------------------------------------------------------
// Belief-break detection
// ---------------------------------------------------------------------------

describe('detectBeliefBreakInMessage', () => {
  it('detects the "99% of traders" reframe', () => {
    const msg =
      "Bro what if I told you 99% of traders that say that actually don't know what the real problem is? Let me explain.";
    assert.equal(detectBeliefBreakInMessage(msg), true);
  });

  it('detects the systems-vs-discipline reframe', () => {
    const msg =
      'discipline takes time to build, and almost all strategies work';
    assert.equal(detectBeliefBreakInMessage(msg), true);
  });

  it('detects the "systems you have in place" reframe', () => {
    const msg =
      "It's the systems you have in place that actually make a profitable trader profitable.";
    assert.equal(detectBeliefBreakInMessage(msg), true);
  });

  it('detects the beginner-branch "totally normal / bad habits" reframe', () => {
    const msg =
      "Brother, that's totally normal. And believe it or not, it's actually a good spot to be in because you're not carrying all the bad habits most traders pick up";
    assert.equal(detectBeliefBreakInMessage(msg), true);
  });

  it('does NOT trigger on unrelated AI replies', () => {
    assert.equal(
      detectBeliefBreakInMessage("yo bro what's been your main struggle?"),
      false
    );
    assert.equal(
      detectBeliefBreakInMessage('how long you been in the markets for?'),
      false
    );
    assert.equal(detectBeliefBreakInMessage(''), false);
  });
});

describe('detectBeliefBreakDelivered', () => {
  it('returns true when ANY prior AI message contains a trigger', () => {
    const messages = [
      { content: 'yo welcome back' },
      {
        content:
          "Bro what if I told you 99% of traders don't know what the real problem is"
      },
      { content: 'what would that do for your trading?' }
    ];
    assert.equal(detectBeliefBreakDelivered(messages), true);
  });

  it('returns false when no AI message contains a trigger', () => {
    const messages = [
      { content: "yo what's up" },
      { content: 'how long you been at it?' }
    ];
    assert.equal(detectBeliefBreakDelivered(messages), false);
  });

  it('handles null/empty content safely', () => {
    const messages = [{ content: null }, { content: '' }];
    assert.equal(detectBeliefBreakDelivered(messages), false);
  });
});

describe('bug-31-belief-break-three-bubbles', () => {
  it('tracks the three-message belief break through bubble1, bubble2, complete', () => {
    const bubble1 = {
      content:
        "Bro what if I told you 99% of traders that say that actually don't know what the real problem is? Let me explain."
    };
    const bubble2 = {
      content:
        "When people come into the markets, they believe they need more discipline or the best strategy in the world to be successful. But here's the thing discipline takes time to build, and almost all strategies work. It's the person behind them using it that matters."
    };
    const bubble3 = {
      content:
        "So what's really the bottleneck? It's the systems you have in place. A detailed, structured system that tells you every single thing to do from point A to point B."
    };
    const ask = {
      content:
        'Now if you had a system like that, one that guided you from A to B and removed the guesswork. what would that do for your trading bro?'
    };

    assert.equal(detectBeliefBreakDeliveryStage([bubble1]), 'bubble1');
    assert.equal(detectBeliefBreakDeliveryStage([bubble1, bubble2]), 'bubble2');
    assert.equal(
      detectBeliefBreakDeliveryStage([bubble1, bubble2, bubble3]),
      'bubble2'
    );
    assert.equal(
      detectBeliefBreakDeliveryStage([bubble1, bubble2, bubble3, ask]),
      'complete'
    );
  });
});

// ---------------------------------------------------------------------------
// inferCurrentStepNumber — robust against missing completionRule
// ---------------------------------------------------------------------------

describe('inferCurrentStepNumber', () => {
  it('uses snapshot value when plausible', () => {
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: 5,
        totalSteps: 22,
        aiMessageCount: 10
      }),
      5
    );
  });

  it('caps snapshot at AI-turn floor (prevents the "all steps complete" bug)', () => {
    // Snapshot points to Step 22 (because completionRule is null and
    // computeSystemStage returns the last step), but only 3 AI messages
    // have been sent. Floor = 4. Result must be 4, not 22.
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: 22,
        totalSteps: 22,
        aiMessageCount: 3
      }),
      4
    );
  });

  it('falls back to AI-turn floor when snapshot is missing', () => {
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: null,
        totalSteps: 22,
        aiMessageCount: 6
      }),
      7
    );
  });

  it('returns 1 minimum even when no AI messages have been sent', () => {
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: null,
        totalSteps: 22,
        aiMessageCount: 0
      }),
      1
    );
  });

  it('clamps to totalSteps', () => {
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: null,
        totalSteps: 22,
        aiMessageCount: 50
      }),
      22
    );
  });
});

// ---------------------------------------------------------------------------
// buildCurrentStepBlock — current + next preview
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<CompactScriptStep>): CompactScriptStep {
  return {
    stepNumber: 1,
    title: 'Untitled',
    objective: null,
    canonicalQuestion: null,
    directActions: [],
    branches: [],
    ...overrides
  };
}

describe('buildCurrentStepBlock', () => {
  it('renders both current and next steps when provided', () => {
    const current = makeStep({
      stepNumber: 5,
      title: 'Current Situation — Job',
      directActions: [
        {
          actionType: 'send_message',
          content: 'give me a bit of context bro.'
        },
        { actionType: 'ask_question', content: 'What do you do for work?' },
        { actionType: 'wait_for_response' }
      ]
    });
    const next = makeStep({
      stepNumber: 6,
      title: 'Job Acknowledgment',
      directActions: [
        { actionType: 'ask_question', content: 'How long you been doing that?' }
      ]
    });
    const block = buildCurrentStepBlock(current, next);
    assert.ok(block);
    assert.match(block!, /CURRENT STEP/);
    assert.match(block!, /Step 5: Current Situation — Job/);
    assert.match(block!, /What do you do for work/);
    assert.match(block!, /NEXT STEP/);
    assert.match(block!, /Step 6: Job Acknowledgment/);
    assert.match(block!, /DO NOT improvise your way to a later stage/);
  });

  it('returns null when both current and next are null', () => {
    assert.equal(buildCurrentStepBlock(null, null), null);
  });

  it('emits only current when next is null (last step of script)', () => {
    const current = makeStep({
      stepNumber: 22,
      title: 'didnt receive homework'
    });
    const block = buildCurrentStepBlock(current, null);
    assert.ok(block);
    assert.match(block!, /Step 22/);
    assert.equal(block!.includes('NEXT STEP'), false);
  });

  it('renders immediate [MSG] + [ASK] as one same-reply turn', () => {
    const current = makeStep({
      stepNumber: 1,
      title: 'Warm Inbound',
      directActions: [
        {
          actionType: 'send_message',
          content:
            "Hey, respect for reaching out! Let's see if I can help you out here"
        },
        {
          actionType: 'ask_question',
          content:
            'So are you new in the markets or have you been trading for a while?'
        },
        { actionType: 'wait_for_response' }
      ]
    });

    const block = buildCurrentStepBlock(current, null);
    assert.ok(block);
    assert.match(block!, /REQUIRED SAME-REPLY SEQUENCE/);
    assert.match(
      block!,
      /No \[WAIT\] appears between this \[MSG\] and \[ASK\]/
    );
    assert.match(
      block!,
      /REQUIRED QUESTION \(ask immediately after the preceding \[MSG\], in the same reply; use this exact wording\)/
    );
    assert.match(block!, /\[WAIT\] Wait for response/);
  });

  it('renders placeholder [MSG] as a runtime directive, not verbatim text', () => {
    const current = makeStep({
      stepNumber: 3,
      title: 'Market Assessment',
      directActions: [
        {
          actionType: 'send_message',
          content: '{{acknowledge their experience}}'
        },
        {
          actionType: 'ask_question',
          content:
            'Nice, so how have the markets been treating you so far? Any main problems coming up?'
        },
        { actionType: 'wait_for_response' }
      ]
    });

    const block = buildCurrentStepBlock(current, null);

    assert.ok(block);
    assert.match(block!, /RUNTIME MESSAGE DIRECTIVE/);
    assert.match(
      block!,
      /do NOT output the braces or directive text literally/
    );
    assert.doesNotMatch(
      block!,
      /REQUIRED MESSAGE \(send verbatim[^)]*\): \{\{acknowledge their experience\}\}/
    );
    assert.match(
      block!,
      /REQUIRED QUESTION \(ask immediately after the preceding \[MSG\], in the same reply; use this exact wording\)/
    );
  });

  it('renders literal [MSG] with variable slots as exact wording plus substitution', () => {
    const current = makeStep({
      stepNumber: 7,
      title: 'Monthly Income',
      directActions: [
        {
          actionType: 'send_message',
          content:
            "Yeah I feel you, I mean I'm not an expert in {{their field}} haha but I do know it's quite different than trading man."
        },
        {
          actionType: 'ask_question',
          content:
            'And as of right now, how much is your job bringing in on a monthly basis?'
        },
        { actionType: 'wait_for_response' }
      ]
    });

    const block = buildCurrentStepBlock(current, null);

    assert.ok(block);
    assert.match(block!, /send exact wording; substitute variables/);
    assert.match(block!, /do not output braces or placeholder text/);
    assert.doesNotMatch(block!, /RUNTIME MESSAGE DIRECTIVE/);
  });

  it('does not mark [MSG] and [ASK] as same-reply when [WAIT] separates them', () => {
    const current = makeStep({
      stepNumber: 1,
      title: 'Separated Turns',
      directActions: [
        { actionType: 'send_message', content: 'Hey, quick one.' },
        { actionType: 'wait_for_response' },
        { actionType: 'ask_question', content: 'How long have you traded?' }
      ]
    });

    const block = buildCurrentStepBlock(current, null);
    assert.ok(block);
    assert.equal(block!.includes('REQUIRED SAME-REPLY SEQUENCE'), false);
    assert.equal(
      block!.includes('ask immediately after the preceding [MSG]'),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// bug-24-script-step-enforcement — fixture-style end-to-end check
// ---------------------------------------------------------------------------

describe('bug-24-script-step-enforcement (acceptance criteria)', () => {
  it('AI cannot propose call when capturedDataPoints is empty + currentStep=2', () => {
    const capturedDataPoints = {}; // empty — daetradez clear-conversation start
    const aiReply =
      'Aight let me set you up with my right hand guy Anthony to break down a roadmap.';

    // Gate must fire: prereq missing.
    assert.equal(detectCallProposalAttempt(aiReply), true);
    const missing = checkCallProposalPrereqs(capturedDataPoints);
    assert.equal(missing.length, 8, 'all 8 prereqs missing');
    // The regen directive will point the LLM back to Step 5 (work background).
    assert.equal(missing[0].stepNumber, 5);
  });

  it('AI CAN propose call when all eight prereqs captured', () => {
    const capturedDataPoints = {
      workBackground: 'engineer',
      monthlyIncome: '7000',
      replaceOrSupplement: 'replace',
      incomeGoal: '20000',
      deepWhy: 'want to retire my parents',
      early_obstacle: 'blowing accounts',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true'
    };
    const aiReply =
      'If it makes sense we can set up a time with my right hand guy Anthony to break down a roadmap.';

    assert.equal(detectCallProposalAttempt(aiReply), true);
    assert.deepEqual(checkCallProposalPrereqs(capturedDataPoints), []);
  });

  it('non-call AI replies bypass the gate entirely (no false positives on valid Step 3 questions)', () => {
    const capturedDataPoints = {}; // still empty
    const aiReply =
      'Nice, so how have the markets been treating you so far? Any main problems coming up?';

    // detectCallProposalAttempt returns false → gate doesn't even check
    // prereqs. Step 3's question is allowed when capturedDataPoints is empty.
    assert.equal(detectCallProposalAttempt(aiReply), false);
  });
});

// ---------------------------------------------------------------------------
// Question + acknowledgment detection (Step 4 silent-branch enforcement)
// ---------------------------------------------------------------------------

describe('countQuestionMarks / containsQuestion', () => {
  it('counts each ? in a reply', () => {
    assert.equal(countQuestionMarks('what? when? how?'), 3);
    assert.equal(countQuestionMarks('no question here.'), 0);
    assert.equal(countQuestionMarks('one only?'), 1);
  });

  it('containsQuestion is true iff > 0 marks', () => {
    assert.equal(containsQuestion('how about you?'), true);
    assert.equal(containsQuestion('appreciate that bro.'), false);
  });
});

describe('detectAcknowledgmentOpener', () => {
  it("detects 'that's real bro'", () => {
    assert.equal(detectAcknowledgmentOpener("that's real bro"), true);
  });

  it("detects 'I hear you'", () => {
    assert.equal(detectAcknowledgmentOpener('I hear you on that one'), true);
  });

  it("detects 'respect that'", () => {
    assert.equal(
      detectAcknowledgmentOpener('respect that bro, takes balls to share that'),
      true
    );
  });

  it("detects 'damn bro'", () => {
    assert.equal(detectAcknowledgmentOpener('damn bro that hits home'), true);
  });

  it("detects 'gotcha'", () => {
    assert.equal(
      detectAcknowledgmentOpener('gotcha, I appreciate the openness'),
      true
    );
  });

  it('does NOT trigger on neutral openers', () => {
    assert.equal(
      detectAcknowledgmentOpener('how long have you been trading'),
      false
    );
    assert.equal(detectAcknowledgmentOpener('what do you do for work'), false);
  });
});

// ---------------------------------------------------------------------------
// getStepActionShape — silent branch detection
// ---------------------------------------------------------------------------

describe('getStepActionShape', () => {
  it('flags a [MSG] + [WAIT] only branch as silent', () => {
    const script = {
      steps: [
        {
          stepNumber: 4,
          actions: [],
          branches: [
            {
              branchLabel: 'Obstacle given — detailed and emotional',
              actions: [
                { actionType: 'send_message', content: 'sit in it bro' },
                { actionType: 'wait_for_response' }
              ]
            }
          ]
        }
      ]
    };
    const shape = getStepActionShape(script, 4);
    assert.ok(shape);
    assert.equal(shape!.hasSilentBranch, true);
    assert.equal(shape!.hasAnyAskAction, false);
    assert.deepEqual(shape!.silentBranchLabels, [
      'Obstacle given — detailed and emotional'
    ]);
  });

  it('does NOT flag branches that have [ASK]', () => {
    const script = {
      steps: [
        {
          stepNumber: 5,
          actions: [],
          branches: [
            {
              branchLabel: 'Default',
              actions: [
                { actionType: 'send_message', content: 'context bro' },
                {
                  actionType: 'ask_question',
                  content: 'What do you do for work?'
                },
                { actionType: 'wait_for_response' }
              ]
            }
          ]
        }
      ]
    };
    const shape = getStepActionShape(script, 5);
    assert.ok(shape);
    assert.equal(shape!.hasSilentBranch, false);
    assert.equal(shape!.hasAnyAskAction, true);
    assert.deepEqual(shape!.scriptedQuestionContents, [
      'What do you do for work?'
    ]);
    assert.deepEqual(shape!.requiredMessageContents, ['context bro']);
  });

  it('does not treat placeholder-only [MSG] actions as required verbatim text', () => {
    const script = {
      steps: [
        {
          stepNumber: 6,
          actions: [],
          branches: [
            {
              branchLabel: 'Default',
              actions: [
                {
                  actionType: 'send_message',
                  content:
                    '{{Comment on their job genuinely — "I respect that" / acknowledge it.}}'
                },
                {
                  actionType: 'ask_question',
                  content: 'How long have you been doing that?'
                },
                { actionType: 'wait_for_response' }
              ]
            }
          ]
        }
      ]
    };

    const shape = getStepActionShape(script, 6);

    assert.ok(shape);
    assert.equal(shape!.hasAnyAskAction, true);
    assert.deepEqual(shape!.requiredMessageContents, []);
    assert.deepEqual(shape!.scriptedQuestionContents, [
      'How long have you been doing that?'
    ]);
  });

  it('collects direct [MSG] content as required verbatim text', () => {
    const script = {
      steps: [
        {
          stepNumber: 10,
          actions: [
            {
              actionType: 'send_message',
              content: 'I respect that bro, I truly do.'
            },
            {
              actionType: 'ask_question',
              content: 'But why is {{their stated goal}} so important?'
            }
          ],
          branches: []
        }
      ]
    };
    const shape = getStepActionShape(script, 10);
    assert.ok(shape);
    assert.deepEqual(shape!.requiredMessageContents, [
      'I respect that bro, I truly do.'
    ]);
  });

  it('collects late-step literal [MSG] content the same as early steps', () => {
    const script = {
      steps: [
        {
          stepNumber: 20,
          actions: [
            {
              actionType: 'send_message',
              content:
                'Send me your full name, email, phone number, and the best time to call.'
            }
          ],
          branches: []
        }
      ]
    };
    const shape = getStepActionShape(script, 20);
    assert.ok(shape);
    assert.deepEqual(shape!.requiredMessageContents, [
      'Send me your full name, email, phone number, and the best time to call.'
    ]);
  });

  it('collects branch-contained [MSG] content as required verbatim text', () => {
    const script = {
      steps: [
        {
          stepNumber: 10,
          actions: [],
          branches: [
            {
              branchLabel: 'Default',
              actions: [
                {
                  actionType: 'runtime_judgment',
                  content: 'Use judgment'
                },
                {
                  actionType: 'send_message',
                  content: 'I respect that bro, I truly do.'
                },
                {
                  actionType: 'ask_question',
                  content: 'But why is {{their stated goal}} so important?'
                }
              ]
            }
          ]
        }
      ]
    };
    const shape = getStepActionShape(script, 10);
    assert.ok(shape);
    assert.deepEqual(shape!.requiredMessageContents, [
      'I respect that bro, I truly do.'
    ]);
  });

  it('counts conversation turns by lead turns, not AI bubble rows', () => {
    const messages = [
      { sender: 'LEAD' },
      { sender: 'AI' },
      { sender: 'AI' },
      { sender: 'AI' },
      { sender: 'LEAD' },
      { sender: 'AI' },
      { sender: 'AI' },
      { sender: 'LEAD' }
    ];
    assert.equal(countConversationTurns(messages), 3);
  });

  it('handles a step with mixed branches (some silent, some with ASK)', () => {
    const script = {
      steps: [
        {
          stepNumber: 4,
          actions: [],
          branches: [
            {
              branchLabel: 'Going well',
              actions: [
                { actionType: 'send_message', content: 'love that' },
                {
                  actionType: 'ask_question',
                  content: 'what next level look like?'
                },
                { actionType: 'wait_for_response' }
              ]
            },
            {
              branchLabel: 'Obstacle given — detailed and emotional',
              actions: [
                {
                  actionType: 'send_message',
                  content: 'acknowledge using their words'
                },
                { actionType: 'wait_for_response' }
              ]
            }
          ]
        }
      ]
    };
    const shape = getStepActionShape(script, 4);
    assert.ok(shape);
    assert.equal(shape!.hasSilentBranch, true);
    assert.equal(shape!.hasAnyAskAction, true);
    assert.deepEqual(shape!.silentBranchLabels, [
      'Obstacle given — detailed and emotional'
    ]);
    assert.deepEqual(shape!.scriptedQuestionContents, [
      'what next level look like?'
    ]);
  });

  it('returns null for missing step number or null script', () => {
    assert.equal(getStepActionShape(null, 5), null);
    assert.equal(getStepActionShape({ steps: [] }, 5), null);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity / maxQuestionSimilarityToScript
// ---------------------------------------------------------------------------

describe('jaccardSimilarity', () => {
  it('returns 1 for identical content (modulo stopwords)', () => {
    const sim = jaccardSimilarity(
      'what do you do for work',
      'what do you do for work'
    );
    assert.ok(sim >= 0.9, `expected ≥0.9 got ${sim}`);
  });

  it('returns < 0.2 for the @daniel_elumelu off-script question vs Step 5 ASK', () => {
    // The AI improvised "If that kept happening for another 6 months,
    // what would it cost you?" — which is NOT in the script's Step 5 ASK
    // ("What do you do for work?"). Word overlap should be low.
    const offScript =
      'If that kept happening for another 6 months, what would it cost you?';
    const scripted = 'What do you do for work?';
    assert.ok(jaccardSimilarity(offScript, scripted) < 0.2);
  });

  it('returns 0 for empty inputs', () => {
    assert.equal(jaccardSimilarity('', 'anything'), 0);
    assert.equal(jaccardSimilarity('anything', ''), 0);
  });
});

describe('maxQuestionSimilarityToScript', () => {
  it('returns 1 (no comparison possible) when reply has no questions', () => {
    assert.equal(
      maxQuestionSimilarityToScript('appreciate that bro.', [
        'What do you do?'
      ]),
      1
    );
  });

  it('returns 1 when there are no scripted asks', () => {
    assert.equal(maxQuestionSimilarityToScript('what next?', []), 1);
  });

  it('returns the BEST overlap when reply has multiple questions and asks', () => {
    const reply =
      'how long you been at it bro? what do you do for work right now?';
    const scripted = ['What do you do for work?', 'How have the markets been?'];
    const sim = maxQuestionSimilarityToScript(reply, scripted);
    // The "what do you do for work" question is a near match to scripted[0].
    assert.ok(sim > 0.3, `expected >0.3 got ${sim}`);
  });

  it('flags improvised question with low max similarity', () => {
    // @daniel_elumelu Turn 2 incident: "If that kept happening for
    // another 6 months, what would it cost you?" vs scripted asks for
    // Step 4 emotional branch (which has NO ASK so this would be empty
    // — but exercise the off-script path with Step 5 asks).
    const offScript =
      'If that kept happening for another 6 months, what would it cost you?';
    const scripted = [
      'What do you do for work?',
      'How long you been doing that?'
    ];
    const sim = maxQuestionSimilarityToScript(offScript, scripted);
    assert.ok(sim < 0.2, `expected <0.2 got ${sim}`);
  });
});

// ---------------------------------------------------------------------------
// bug-25-silent-branch-enforcement (acceptance criteria for Step 4 fix)
// ---------------------------------------------------------------------------

describe('bug-25-silent-branch-enforcement (acceptance criteria)', () => {
  it('@daniel_elumelu Turn 1: AI on silent branch + emotional opener + question = block', () => {
    // Reply text mirrors the actual production output that triggered
    // the bug: short acknowledgment opener + improvised follow-up.
    const reply =
      "that's real bro, sit with that for a sec. what's been the heaviest part of it?";
    assert.equal(detectAcknowledgmentOpener(reply), true);
    assert.equal(containsQuestion(reply), true);
    // Combined with currentStepHasSilentBranch=true (passed via options
    // in voice-quality-gate), the gate emits the
    // silent_branch_violated_with_question hard fail.
  });

  it('@daniel_elumelu Turn 2: improvised pain-future-pacing fires off-script signal', () => {
    const reply =
      'I hear you. If that kept happening for another 6 months, what would it cost you?';
    assert.equal(detectAcknowledgmentOpener(reply), true);
    assert.equal(containsQuestion(reply), true);
    // No scripted ask exists for Step 4's silent branch → the gate
    // also fires silent_branch_violated_with_question.
  });

  it('multiple-questions hard fail catches turn-stacking', () => {
    const reply =
      "respect that bro. what's pushing you? when did it start? how do you feel about it?";
    assert.equal(countQuestionMarks(reply), 3);
    // 3 ?s → multiple_questions_in_reply hard fail in gate (>= 2 trigger).
  });

  it('valid silent-branch acknowledgment passes (no question)', () => {
    const reply =
      'that takes real strength to share bro. honestly respect you opening up like that.';
    assert.equal(detectAcknowledgmentOpener(reply), true);
    assert.equal(containsQuestion(reply), false);
    // No `?` → silent_branch_violated_with_question does NOT fire.
  });

  it('valid Step 5 reply with scripted-ish question passes off-script check', () => {
    const reply =
      'alright so give me a bit of context bro. What do you do for work?';
    const scripted = ['What do you do for work?'];
    assert.ok(maxQuestionSimilarityToScript(reply, scripted) > 0.5);
  });
});

// ---------------------------------------------------------------------------
// bug-34-llm-branch-classifier (Path B classifier fallback)
// ---------------------------------------------------------------------------

const bug34JudgeStep = {
  stepNumber: 4,
  title: 'How are the markets going?',
  canonicalQuestion: 'how are the markets going?',
  actions: [{ actionType: 'runtime_judgment', content: null }],
  branches: [
    {
      branchLabel: 'Going well',
      conditionDescription: 'positive current performance no major problems',
      actions: [
        { actionType: 'send_message', content: 'love to see it bro.' },
        {
          actionType: 'ask_question',
          content: 'what has been helping you stay consistent?'
        }
      ]
    },
    {
      branchLabel: 'Obstacle given — detailed and emotional',
      conditionDescription: 'lead gives a painful detailed trading challenge',
      actions: [
        {
          actionType: 'send_message',
          content: 'that is real bro, revenge can spiral fast.'
        },
        { actionType: 'wait_for_response', content: null }
      ]
    }
  ]
};

describe('bug-34-llm-branch-classifier', () => {
  it('bug-34-llm-branch-classifier-obstacle: revenge trading routes to obstacle branch', async () => {
    let calls = 0;
    const match = await selectJudgeBranchForLead(
      bug34JudgeStep,
      "It's revenge trading mostly, I lose a trade and then i jump back in trying to make it back",
      {
        classifier: async () => {
          calls++;
          return 'Obstacle given — detailed and emotional';
        }
      }
    );

    assert.equal(calls, 1);
    assert.equal(match.branchLabel, 'Obstacle given — detailed and emotional');
    assert.equal(match.confidence, 'llm_classified');
  });

  it('bug-34-llm-branch-classifier-going-well: profitable statement routes to going-well branch', async () => {
    let calls = 0;
    const match = await selectJudgeBranchForLead(
      bug34JudgeStep,
      'markets going great, been profitable',
      {
        classifier: async () => {
          calls++;
          return 'Going well';
        }
      }
    );

    assert.equal(calls, 1);
    assert.equal(match.branchLabel, 'Going well');
    assert.equal(match.confidence, 'llm_classified');
  });

  it('bug-34-llm-branch-classifier-timeout: classifier failure falls back gracefully', async () => {
    const match = await selectJudgeBranchForLead(
      bug34JudgeStep,
      'none of those words line up',
      {
        classifier: async () => {
          throw new Error('aborted');
        }
      }
    );

    assert.equal(match.branchLabel, null);
    assert.equal(match.confidence, 'none');
  });

  it('bug-34-close-token-margin-runs-classifier: narrow token lead is treated as ambiguous', async () => {
    const closeMarginStep = {
      stepNumber: 4,
      title: 'Market response routing',
      actions: [{ actionType: 'runtime_judgment', content: null }],
      branches: [
        {
          branchLabel: 'Going badly - vague',
          conditionDescription: 'loss red trading',
          actions: [
            {
              actionType: 'ask_question',
              content: 'what is the main obstacle?'
            }
          ]
        },
        {
          branchLabel: 'Obstacle given - detailed and emotional',
          conditionDescription: 'loss red revenge trading detailed emotional',
          actions: [
            {
              actionType: 'send_message',
              content: 'give me a bit more context'
            }
          ]
        }
      ]
    };
    let calls = 0;
    const match = await selectJudgeBranchForLead(
      closeMarginStep,
      'loss red revenge trading',
      {
        classifier: async () => {
          calls++;
          return 'Obstacle given - detailed and emotional';
        }
      }
    );

    assert.equal(calls, 1);
    assert.equal(match.branchLabel, 'Obstacle given - detailed and emotional');
    assert.equal(match.confidence, 'llm_classified');
  });

  it('uses classifier for medium token confidence instead of force-routing a sibling branch', async () => {
    const exactHarnessStep = {
      stepNumber: 4,
      title: 'Market Response Routing',
      actions: [{ actionType: 'runtime_judgment', content: null }],
      branches: [
        {
          branchLabel: 'Going well',
          conditionDescription:
            'lead says markets are good, profitable, no major issues',
          actions: [
            {
              actionType: 'runtime_judgment',
              content:
                "If they say things are fine but there's nothing to work toward, the convo is dead. You need to find a gap."
            },
            { actionType: 'send_message', content: 'Love to see it bro.' },
            {
              actionType: 'ask_question',
              content:
                "So are you looking to scale up, or what's the next level look like for you?"
            },
            { actionType: 'wait_for_response', content: null }
          ]
        },
        {
          branchLabel: 'Going badly — vague',
          conditionDescription:
            "vague: lead says not going well but doesn't specify why",
          actions: [
            {
              actionType: 'send_message',
              content: 'Gotcha, I appreciate you being real about that.'
            },
            {
              actionType: 'ask_question',
              content:
                'What would you say is the main obstacle stopping you from getting where you want to be?'
            },
            { actionType: 'wait_for_response', content: null }
          ]
        },
        {
          branchLabel:
            'Obstacle given — surface level (one word like "discipline" or "psychology")',
          conditionDescription:
            'lead gives one word answer like "discipline", "psychology", "mindset", "emotions"',
          actions: [
            {
              actionType: 'runtime_judgment',
              content:
                'A one-word answer isn\'t enough. Probe deeper — you need specifics. "Discipline" could mean 10 different things. Don\'t accept the surface answer and move on. Keep asking until they have given a deep enough obstacle that we can use.'
            },
            { actionType: 'send_message', content: '{{acknowledge it}}' },
            {
              actionType: 'ask_question',
              content:
                "Can you break that down for me bro? Like what does that actually look like when you're in a trade?"
            },
            { actionType: 'wait_for_response', content: null }
          ]
        },
        {
          branchLabel: 'Obstacle given — detailed and emotional',
          conditionDescription:
            'lead describes specific struggle with emotional weight — mentions specific behaviors, feelings, or situations',
          actions: [
            {
              actionType: 'runtime_judgment',
              content:
                'Store as {{obstacle}}. When someone opens up about their pain without being asked, their buying temperature is significantly higher. Do NOT gloss over this. Acknowledge specifically using their exact words. Then bridge naturally to job context (Step 5) — skip Steps 3 and 4 if {{early_obstacle}} was already captured in Step 2. The obstacle is already stored. Move to "give me a bit more context on your situation" and advance to Step 5.'
            },
            {
              actionType: 'send_message',
              content:
                '{{acknowledge specifically using their own words — 1 sentence. Then add: "give me a bit more context on your situation though" to keep momentum}}'
            },
            { actionType: 'wait_for_response', content: null }
          ]
        }
      ]
    };
    let calls = 0;
    const match = await selectJudgeBranchForLead(
      exactHarnessStep,
      "honestly bro it's been brutal, i keep blowing my small accounts revenge trading. started with 2k, now i'm down to like 800 bucks and my wife doesn't even know",
      {
        classifier: async () => {
          calls++;
          return 'Obstacle given — detailed and emotional';
        }
      }
    );

    assert.equal(calls, 1);
    assert.equal(match.branchLabel, 'Obstacle given — detailed and emotional');
    assert.equal(match.confidence, 'llm_classified');
    assert.equal(match.tokenScoringResult?.confidence, 'medium');
  });

  it('does not call classifier for high token confidence', async () => {
    let calls = 0;
    const match = await selectJudgeBranchForLead(
      bug34JudgeStep,
      'positive current performance with no major problems',
      {
        classifier: async () => {
          calls++;
          return 'Obstacle given — detailed and emotional';
        }
      }
    );

    assert.equal(calls, 0);
    assert.equal(match.branchLabel, 'Going well');
    assert.equal(match.confidence, 'high');
  });

  it('bug-005b routes clear conviction language using branch runtime judgment criteria', async () => {
    let calls = 0;
    const match = await selectJudgeBranchForLead(
      {
        stepNumber: 14,
        title: 'Buy-In Confirmation',
        actions: [{ actionType: 'runtime_judgment', content: null }],
        branches: [
          {
            branchLabel: 'Clear buy-in',
            conditionDescription: 'lead has real conviction and buy-in',
            actions: [
              {
                actionType: 'runtime_judgment',
                content:
                  'Clear buy-in = "yes bro that is exactly what I need" / "100%" / "that would change everything" / "man that is literally my problem" / any affirmative with real energy behind it.'
              },
              {
                actionType: 'ask_question',
                content: 'you ready to do what it takes to actually fix this?'
              }
            ]
          },
          {
            branchLabel: 'Lukewarm buy-in',
            conditionDescription: 'lead shows weak or uncertain interest',
            actions: [
              {
                actionType: 'runtime_judgment',
                content:
                  'Lukewarm = "yeah that could work" / "maybe" / "possibly" / "yeah that would help I guess" / anything without conviction.'
              },
              {
                actionType: 'send_message',
                content: "what's really on your mind?"
              },
              { actionType: 'wait_for_response', content: null }
            ]
          }
        ]
      },
      'honestly bro that would change everything for me and my family',
      {
        classifier: async () => {
          calls++;
          return 'Lukewarm buy-in';
        }
      }
    );

    assert.equal(calls, 0);
    assert.equal(match.branchLabel, 'Clear buy-in');
    assert.ok(match.confidence === 'medium' || match.confidence === 'high');
  });

  it('ignores placeholder-only [MSG] actions when checking judge branch violations', async () => {
    const step = {
      stepNumber: 6,
      title: 'Job acknowledgment',
      actions: [{ actionType: 'runtime_judgment', content: null }],
      branches: [
        {
          branchLabel: 'Default',
          conditionDescription: 'lead gave their job',
          actions: [
            {
              actionType: 'send_message',
              content:
                '{{Comment on their job genuinely — "I respect that" / acknowledge it.}}'
            },
            {
              actionType: 'ask_question',
              content: 'How long have you been doing that?'
            }
          ]
        }
      ]
    };

    const violation = await detectJudgeBranchViolation({
      step,
      latestLeadMessage: 'I work as a nurse',
      generatedMessages: [
        'respect that bro, nurses do real work. How long have you been doing that?'
      ],
      classifier: async () => 'Default'
    });

    assert.equal(violation.blocked, false);
  });
});

// ---------------------------------------------------------------------------
// bug-35-missing-question-on-ask-step
// ---------------------------------------------------------------------------

describe('bug-35-missing-question-on-ask-step', () => {
  it('hard-fails when an active ask branch ships no question', () => {
    const quality = scoreVoiceQualityGroup(['love to see it bro.'], {
      currentStepHasAskBranch: true,
      currentStepActiveBranchIsSilent: false,
      currentStepActiveBranchIsJudgeOnly: false,
      currentScriptStepNumber: 4
    });

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('missing_required_question_on_ask_step:')
      )
    );
  });

  it('[MSG]+[WAIT] silent branch does not fire missing-question gate', () => {
    const quality = scoreVoiceQualityGroup(['that is real bro.'], {
      currentStepHasAskBranch: false,
      currentStepActiveBranchIsSilent: true,
      currentScriptStepNumber: 4
    });

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('missing_required_question_on_ask_step:')
      ),
      false
    );
  });

  it('JUDGE-only branch with no ask_question does not fire', () => {
    const quality = scoreVoiceQualityGroup(['checking that now bro.'], {
      currentStepHasAskBranch: false,
      currentStepActiveBranchIsJudgeOnly: true,
      currentScriptStepNumber: 4
    });

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('missing_required_question_on_ask_step:')
      ),
      false
    );
  });

  it('Step 17+ booking/link-sending steps do not fire', () => {
    const quality = scoreVoiceQualityGroup(['sending that over now bro.'], {
      currentStepHasAskBranch: true,
      currentScriptStepNumber: 17
    });

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('missing_required_question_on_ask_step:')
      ),
      false
    );
  });

  it('allows multi-bubble [MSG]+[ASK] replies when any bubble contains the required question', () => {
    const quality = scoreVoiceQualityGroup(
      [
        "Hey bro, respect for reaching out! Let's see if I can help you out here 💪🏿",
        'So are you new in the markets or have you been trading for a while?'
      ],
      {
        currentStepHasAskBranch: true,
        activeBranchHasAskAction: true,
        currentStepActiveBranchIsSilent: false,
        currentStepActiveBranchIsJudgeOnly: false,
        currentScriptStepNumber: 1
      }
    );

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('missing_required_question_on_ask_step:')
      ),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// bug-36..40-active-branch-scoped-quality-gates
// ---------------------------------------------------------------------------

describe('active-branch-scoped quality gates', () => {
  const obstaclePlaceholder =
    '{{acknowledge specifically using their own words — 1 sentence. Then add: "give me a bit more context on your situation though" to keep momentum}}';

  it('bug-36-active-branch-scoped-verbatim: does not enforce sibling branch messages', () => {
    const quality = scoreVoiceQualityGroup(
      [
        'damn bro, that red screen can mess with you fast. give me a bit more context on your situation though'
      ],
      {
        activeBranchRequiredMessages: [
          {
            content: obstaclePlaceholder,
            isPlaceholder: true,
            embeddedQuotes: [
              'give me a bit more context on your situation though'
            ]
          }
        ],
        currentStepRequiredMessages: [
          'Love to see it bro.',
          'Gotcha, I appreciate you being real about that.'
        ]
      }
    );

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('Gotcha, I appreciate you being real')
      ),
      false
    );
    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      ),
      false
    );
  });

  it('bug-37-placeholder-embedded-quote: enforces embedded quote only', () => {
    const quality = scoreVoiceQualityGroup(
      ['damn bro, that red screen can mess with you fast'],
      {
        activeBranchRequiredMessages: [
          {
            content: obstaclePlaceholder,
            isPlaceholder: true,
            embeddedQuotes: [
              'give me a bit more context on your situation though'
            ]
          }
        ]
      }
    );

    assert.ok(
      quality.hardFails.some(
        (failure) =>
          failure.includes('msg_verbatim_violation:') &&
          failure.includes('give me a bit more context')
      )
    );
  });

  it('bug-50-example-quotes-not-enforced: ignores quoted placeholder alternatives', () => {
    const examplePlaceholder =
      '{{Comment on their job genuinely — "I respect that" / "I\'ve been there" / acknowledge it.}}';

    const extraction = extractRequiredQuotes(examplePlaceholder);
    assert.deepEqual(extraction.requiredQuotes, []);
    assert.deepEqual(extraction.exampleQuotes, [
      'I respect that',
      "I've been there"
    ]);

    const quality = scoreVoiceQualityGroup(
      ['damn bro, nurse work is no joke. How long you been doing that?'],
      {
        activeBranchRequiredMessages: [
          {
            content: examplePlaceholder,
            isPlaceholder: true
          }
        ]
      }
    );

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      ),
      false
    );
  });

  it('bug-51-required-quotes-enforced: requires imperative placeholder quotes', () => {
    const requiredPlaceholder =
      '{{acknowledge specifically using their own words — 1 sentence. Then add: "give me a bit more context" to keep momentum}}';

    const extraction = extractRequiredQuotes(requiredPlaceholder);
    assert.deepEqual(extraction.requiredQuotes, ['give me a bit more context']);
    assert.deepEqual(extraction.exampleQuotes, []);

    const quality = scoreVoiceQualityGroup(
      ['damn bro, that red screen can mess with you fast'],
      {
        activeBranchRequiredMessages: [
          {
            content: requiredPlaceholder,
            isPlaceholder: true
          }
        ]
      }
    );

    assert.ok(
      quality.hardFails.some(
        (failure) =>
          failure.includes('msg_verbatim_violation:') &&
          failure.includes('give me a bit more context')
      )
    );
  });

  it('bug-52-single-quote-default-required: treats a lone placeholder quote as required', () => {
    const placeholder =
      '{{acknowledge them briefly and close with "send me a bit more context"}}';

    assert.deepEqual(extractRequiredQuotes(placeholder).requiredQuotes, [
      'send me a bit more context'
    ]);

    const quality = scoreVoiceQualityGroup(['got you bro'], {
      activeBranchRequiredMessages: [
        {
          content: placeholder,
          isPlaceholder: true
        }
      ]
    });

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      )
    );
  });

  it('bug-53-literal-msg-unaffected: still enforces literal messages', () => {
    const quality = scoreVoiceQualityGroup(['I hear you bro.'], {
      activeBranchRequiredMessages: [
        {
          content: 'I respect that bro, I truly do.',
          isPlaceholder: false
        }
      ]
    });

    assert.ok(
      quality.hardFails.some(
        (failure) =>
          failure.includes('msg_verbatim_violation:') &&
          failure.includes('I respect that bro, I truly do')
      )
    );
  });

  it('bug-57-repeated-message-structure-is-soft-warning-only', () => {
    const quality = scoreVoiceQualityGroup(
      [
        'love that bro, i can see the commitment just by the way you speak.',
        'what do you feel is the main thing holding you back that you would ideally want some guidance on man?'
      ],
      {
        priorMessageStructures: [
          'two_short_reaction_question',
          'two_short_reaction_question'
        ]
      }
    );

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('repeated_message_structure:')
      ),
      false
    );
    assert.equal(
      typeof quality.softSignals.repeated_message_structure,
      'number'
    );
  });

  it('bug-38-active-branch-silent: silent branch on mixed step does not require a question', () => {
    const quality = scoreVoiceQualityGroup(['gotcha bro, that makes sense.'], {
      currentStepHasAnyAskAction: true,
      currentStepHasAskBranch: true,
      activeBranchHasAskAction: false,
      activeBranchHasSilentBranch: true,
      currentStepActiveBranchIsSilent: true,
      currentScriptStepNumber: 4
    });

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('missing_required_question_on_ask_step:')
      ),
      false
    );
  });

  it('bug-39-active-branch-fallback: preserves step-global enforcement when no branch is selected', () => {
    const quality = scoreVoiceQualityGroup(['damn bro, that is tough'], {
      currentStepRequiredMessages: [
        'Gotcha, I appreciate you being real about that.'
      ]
    });

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      )
    );
  });

  it('bug-40-literal-msg-still-enforced: active branch literal messages still hard-fail', () => {
    const quality = scoreVoiceQualityGroup(
      ['what would getting 50k a month do for you and your sons?'],
      {
        activeBranchRequiredMessages: [
          {
            content:
              'I respect that bro, I truly do. I hear so many people talk about cars and materialistic stuff so it is refreshing to hear this haha.',
            isPlaceholder: false
          }
        ]
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      )
    );
  });

  it('Step 1 warm inbound active branch does not enforce outbound opener', () => {
    const warmMessage =
      "Hey bro, respect for reaching out! Let's see if I can help you out here 💪🏿";
    const warmQuestion =
      'So are you new in the markets or have you been trading for a while?';

    const quality = scoreVoiceQualityGroup([warmMessage, warmQuestion], {
      activeBranchRequiredMessages: [
        { content: warmMessage, isPlaceholder: false }
      ],
      currentStepRequiredMessages: [
        "{{NAME}}, I see you've been rocking with the content! Respect my guy"
      ],
      currentStepHasAskBranch: true,
      activeBranchHasAskAction: true,
      currentScriptStepNumber: 1
    });

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('rocking with the content')
      ),
      false
    );
    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      ),
      false
    );
  });

  it('selects Step 1 warm inbound branch for an inbound first message', () => {
    const branches = [
      {
        branchLabel: "Warm Inbound (DM'd directly)",
        actions: []
      },
      {
        branchLabel: 'outbound',
        actions: []
      }
    ];

    const selected = selectStep1BranchesForPrompt(branches, {
      conversationSource: 'INBOUND',
      leadSource: 'INBOUND'
    });

    assert.deepEqual(
      selected.map((branch) => branch.branchLabel),
      ["Warm Inbound (DM'd directly)"]
    );
  });

  it('bug-49-locked-branch-prompt-filter: selected branch hides sibling branch actions', () => {
    const step = {
      stepNumber: 4,
      branches: [
        {
          branchLabel: 'Going badly - vague',
          actions: [
            {
              actionType: 'ask_question',
              content: 'what is the main obstacle?'
            }
          ]
        },
        {
          branchLabel: 'Obstacle given - detailed and emotional',
          actions: [
            {
              actionType: 'send_message',
              content: 'I appreciate you being real about that.'
            },
            {
              actionType: 'wait_for_response',
              content: null
            }
          ]
        }
      ]
    };

    const selected = selectBranchesForPrompt(step, {
      selectedBranchStepNumber: 4,
      selectedBranchLabel: 'Obstacle given - detailed and emotional'
    });

    assert.deepEqual(
      selected.map((branch) => branch.branchLabel),
      ['Obstacle given - detailed and emotional']
    );
    assert.equal(
      selected[0].actions.some((action) =>
        action.content?.includes('main obstacle')
      ),
      false
    );
  });

  it('bug-49-locked-branch-fallback: null classifier result preserves all branches', () => {
    const step = {
      stepNumber: 4,
      branches: [
        { branchLabel: 'Branch A', actions: [] },
        { branchLabel: 'Branch B', actions: [] }
      ]
    };

    assert.deepEqual(
      selectBranchesForPrompt(step, {}).map((branch) => branch.branchLabel),
      ['Branch A', 'Branch B']
    );
  });

  it('bug-49-placeholder-branch-selected: placeholder MSG branch remains visible when locked', () => {
    const step = {
      stepNumber: 8,
      branches: [
        {
          branchLabel: 'Generic follow-up',
          actions: [
            {
              actionType: 'ask_question',
              content: 'can you tell me more?'
            }
          ]
        },
        {
          branchLabel: 'Emotional disclosure',
          actions: [
            {
              actionType: 'runtime_judgment',
              content: 'store the disclosed obstacle'
            },
            {
              actionType: 'send_message',
              content:
                '{{acknowledge their words. Then add: "give me a bit more context"}}'
            },
            {
              actionType: 'wait_for_response',
              content: null
            }
          ]
        }
      ]
    };

    const selected = selectBranchesForPrompt(step, {
      selectedBranchStepNumber: 8,
      selectedBranchLabel: 'Emotional disclosure'
    });

    assert.equal(selected.length, 1);
    assert.equal(selected[0].branchLabel, 'Emotional disclosure');
    assert.equal(
      selected[0].actions.some((action) =>
        action.content?.includes('give me a bit more context')
      ),
      true
    );
  });

  it('bug-49-judge-only-branch-selected: routing-only branch can be locked into the prompt', () => {
    const step = {
      stepNumber: 12,
      branches: [
        {
          branchLabel: 'Continue normal path',
          actions: [
            {
              actionType: 'send_message',
              content: 'continue here'
            }
          ]
        },
        {
          branchLabel: 'Route to qualified path',
          actions: [
            {
              actionType: 'runtime_judgment',
              content: 'if qualified, advance to the qualified path'
            }
          ]
        }
      ]
    };

    const selected = selectBranchesForPrompt(step, {
      selectedBranchStepNumber: 12,
      selectedBranchLabel: 'Route to qualified path'
    });

    assert.deepEqual(
      selected.map((branch) => branch.branchLabel),
      ['Route to qualified path']
    );
    assert.deepEqual(
      selected[0].actions.map((action) => action.actionType),
      ['runtime_judgment']
    );
  });

  it('title_case_opener is never hard-unshippable for natural sentence starters', () => {
    const quality = scoreVoiceQualityGroup([
      'Hey bro, respect for reaching out!'
    ]);

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('title_case_opener:')
      ),
      false
    );
  });

  it('bug-40-literal-msg-still-enforced: active branch multi-message sequence still requires separate bubbles', () => {
    const requiredMessages = [
      'Bro what if I told you 99% of traders that say that actually do not know what the real problem is?',
      'When people come into the markets, they believe they need more discipline.',
      'So what is really the bottleneck? It is the systems you have in place.'
    ];

    const quality = scoreVoiceQualityGroup([requiredMessages.join(' ')], {
      activeBranchRequiredMessages: requiredMessages.map((content) => ({
        content,
        isPlaceholder: false
      }))
    });

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('required_message_not_in_separate_bubble')
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Placeholder [MSG]+[WAIT] step completion (bug-41 through bug-44)
// ---------------------------------------------------------------------------

type RecoveryScriptInput = NonNullable<
  Parameters<typeof computeSystemStage>[0]
>;

function makeRecoveryScriptForTest(
  steps: Array<Record<string, unknown>>
): RecoveryScriptInput {
  return { steps } as RecoveryScriptInput;
}

function stepForCompletionTest(overrides: Record<string, unknown>) {
  return {
    stepNumber: 4,
    title: 'Market Response Routing',
    stateKey: null,
    canonicalQuestion: null,
    completionRule: null,
    actions: [],
    branches: [],
    ...overrides
  };
}

const nextCompletionTestStep = stepForCompletionTest({
  stepNumber: 5,
  title: 'Current Situation — Job',
  actions: [
    {
      actionType: 'ask_question',
      content: 'What do you do for work?'
    }
  ]
});

describe('placeholder [MSG]+[WAIT] history completion', () => {
  it('bug-41-placeholder-msg-wait-completes-on-lead-reply', () => {
    const script = makeRecoveryScriptForTest([
      stepForCompletionTest({
        branches: [
          {
            branchLabel: 'Going well',
            actions: [
              { actionType: 'send_message', content: 'Love to see it bro.' },
              { actionType: 'wait_for_response', content: null }
            ]
          },
          {
            branchLabel: 'Obstacle given — detailed and emotional',
            actions: [
              { actionType: 'runtime_judgment', content: 'store obstacle' },
              {
                actionType: 'send_message',
                content:
                  '{{acknowledge specifically using their own words. Then add: "give me a bit more context" to keep momentum}}'
              },
              { actionType: 'wait_for_response', content: null }
            ]
          }
        ]
      }),
      nextCompletionTestStep
    ]);

    const stage = computeSystemStage(script, {}, [
      {
        sender: 'AI',
        content: 'give me a bit more context on your situation though',
        timestamp: '2026-05-11T05:16:24.000Z'
      },
      {
        sender: 'LEAD',
        content: 'I get tilted and keep adding more to recover',
        timestamp: '2026-05-11T05:18:14.000Z'
      }
    ]);

    assert.equal(stage.step?.stepNumber, 5);
  });

  it('completes selected placeholder branch when recovery history carries suggestionId', () => {
    const script = makeRecoveryScriptForTest([
      stepForCompletionTest({
        branches: [
          {
            branchLabel: 'Obstacle given — detailed and emotional',
            actions: [
              { actionType: 'runtime_judgment', content: 'store obstacle' },
              {
                actionType: 'send_message',
                content:
                  '{{acknowledge specifically using their own words. Then add: "give me a bit more context" to keep momentum}}'
              },
              { actionType: 'wait_for_response', content: null }
            ]
          }
        ]
      }),
      nextCompletionTestStep
    ]);
    const points = {
      branchHistory: [
        {
          eventType: 'branch_selected',
          stepNumber: 4,
          stepTitle: 'Market Response Routing',
          selectedBranchLabel: 'Obstacle given — detailed and emotional',
          suggestionId: 'sug_step_4',
          aiMessageId: null,
          aiMessageIds: [],
          leadMessageId: 'lead_prior',
          sentAt: null,
          completedAt: null,
          createdAt: '2026-05-11T05:16:00.000Z'
        }
      ]
    } as unknown as Parameters<typeof computeSystemStage>[1];

    const stage = computeSystemStage(script, points, [
      {
        id: 'ai_obstacle_msg',
        suggestionId: 'sug_step_4',
        sender: 'AI',
        content: 'give me a bit more context on your situation though',
        timestamp: '2026-05-11T05:16:24.000Z'
      },
      {
        id: 'lead_context',
        sender: 'LEAD',
        content: 'I keep adding more to recover after the trade goes red',
        timestamp: '2026-05-11T05:18:14.000Z'
      }
    ]);

    assert.equal(stage.step?.stepNumber, 5);
  });

  it('uses the classifier-selected placeholder branch when branch shapes differ', () => {
    const script = makeRecoveryScriptForTest([
      stepForCompletionTest({
        branches: [
          {
            branchLabel: 'Short placeholder branch',
            actions: [
              {
                actionType: 'send_message',
                content: '{{acknowledge briefly}}'
              },
              { actionType: 'wait_for_response', content: null }
            ]
          },
          {
            branchLabel: 'Selected two-bubble branch',
            actions: [
              {
                actionType: 'send_message',
                content: '{{acknowledge in their words}}'
              },
              {
                actionType: 'send_message',
                content: '{{ask for one more bit of context}}'
              },
              { actionType: 'wait_for_response', content: null }
            ]
          }
        ]
      }),
      nextCompletionTestStep
    ]);
    const points = {
      lastClassifierTrace: {
        stepNumber: 4,
        finalSelectedLabel: 'Selected two-bubble branch'
      }
    } as unknown as Parameters<typeof computeSystemStage>[1];

    const incomplete = computeSystemStage(script, points, [
      {
        sender: 'AI',
        content: 'that sounds frustrating bro',
        timestamp: '2026-05-11T05:16:24.000Z'
      },
      {
        sender: 'LEAD',
        content: 'yeah exactly',
        timestamp: '2026-05-11T05:18:14.000Z'
      }
    ]);
    assert.equal(incomplete.step?.stepNumber, 4);

    const complete = computeSystemStage(script, points, [
      {
        sender: 'AI',
        content: 'that sounds frustrating bro',
        timestamp: '2026-05-11T05:16:24.000Z'
      },
      {
        sender: 'AI',
        content: 'give me a bit more context on that',
        timestamp: '2026-05-11T05:16:39.000Z'
      },
      {
        sender: 'LEAD',
        content: 'yeah exactly',
        timestamp: '2026-05-11T05:18:14.000Z'
      }
    ]);
    assert.equal(complete.step?.stepNumber, 5);
  });

  it('literal [MSG]+[WAIT] still completes via content match', () => {
    const script = makeRecoveryScriptForTest([
      stepForCompletionTest({
        branches: [
          {
            branchLabel: 'Literal branch',
            actions: [
              {
                actionType: 'send_message',
                content: 'Gotcha, I appreciate you being real about that.'
              },
              { actionType: 'wait_for_response', content: null }
            ]
          }
        ]
      }),
      nextCompletionTestStep
    ]);

    const stage = computeSystemStage(script, {}, [
      {
        sender: 'AI',
        content: 'Gotcha, I appreciate you being real about that.',
        timestamp: '2026-05-11T05:16:24.000Z'
      },
      {
        sender: 'LEAD',
        content: 'yeah it is rough',
        timestamp: '2026-05-11T05:18:14.000Z'
      }
    ]);

    assert.equal(stage.step?.stepNumber, 5);
  });

  it('bug-42-placeholder-msg-no-wait-does-not-complete', () => {
    const script = makeRecoveryScriptForTest([
      stepForCompletionTest({
        branches: [
          {
            branchLabel: 'Placeholder no wait',
            actions: [
              { actionType: 'runtime_judgment', content: 'store obstacle' },
              {
                actionType: 'send_message',
                content: '{{acknowledge in your own words}}'
              }
            ]
          }
        ]
      }),
      nextCompletionTestStep
    ]);

    const stage = computeSystemStage(script, {}, [
      {
        sender: 'AI',
        content: 'that sounds frustrating bro',
        timestamp: '2026-05-11T05:16:24.000Z'
      },
      {
        sender: 'LEAD',
        content: 'yeah exactly',
        timestamp: '2026-05-11T05:18:14.000Z'
      }
    ]);

    assert.equal(stage.step?.stepNumber, 4);
  });

  it('bug-43-judge-only-branch-does-not-complete', () => {
    const script = makeRecoveryScriptForTest([
      stepForCompletionTest({
        branches: [
          {
            branchLabel: 'Judge only',
            actions: [
              { actionType: 'runtime_judgment', content: 'store obstacle' }
            ]
          }
        ]
      }),
      nextCompletionTestStep
    ]);

    const stage = computeSystemStage(script, {}, [
      {
        sender: 'LEAD',
        content: 'I keep revenge trading',
        timestamp: '2026-05-11T05:18:14.000Z'
      }
    ]);

    assert.equal(stage.step?.stepNumber, 4);
  });

  it('bug-44-multi-bubble-placeholder-completion waits for the last bubble', () => {
    const script = makeRecoveryScriptForTest([
      stepForCompletionTest({
        branches: [
          {
            branchLabel: 'Multi bubble placeholder',
            actions: [
              {
                actionType: 'send_message',
                content: '{{acknowledge in your own words}}'
              },
              {
                actionType: 'send_message',
                content: '{{add one short bridge sentence}}'
              },
              { actionType: 'wait_for_response', content: null }
            ]
          }
        ]
      }),
      nextCompletionTestStep
    ]);

    const incomplete = computeSystemStage(script, {}, [
      {
        sender: 'AI',
        content: 'that sounds frustrating bro',
        timestamp: '2026-05-11T05:16:24.000Z'
      },
      {
        sender: 'LEAD',
        content: 'yeah exactly',
        timestamp: '2026-05-11T05:18:14.000Z'
      }
    ]);
    assert.equal(incomplete.step?.stepNumber, 4);

    const complete = computeSystemStage(script, {}, [
      {
        sender: 'AI',
        content: 'that sounds frustrating bro',
        timestamp: '2026-05-11T05:16:24.000Z'
      },
      {
        sender: 'AI',
        content: 'give me a bit more context on that',
        timestamp: '2026-05-11T05:16:39.000Z'
      },
      {
        sender: 'LEAD',
        content: 'yeah exactly',
        timestamp: '2026-05-11T05:18:14.000Z'
      }
    ]);
    assert.equal(complete.step?.stepNumber, 5);
  });
});

// ---------------------------------------------------------------------------
// inferCurrentStepNumber stale-snapshot guard (bug-26)
// ---------------------------------------------------------------------------

describe('inferCurrentStepNumber — stale-snapshot guard (bug-26)', () => {
  it('snapshot=1 with 2+ AI turns is treated as stale and uses AI-turn floor', () => {
    // After completionRule=null defaults to INCOMPLETE,
    // computeSystemStage returns Step 1 even when the AI has progressed
    // several turns past it. The stale-snapshot guard must prefer the
    // AI-turn floor in that case.
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: 1,
        totalSteps: 22,
        aiMessageCount: 8
      }),
      9
    );
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: 1,
        totalSteps: 22,
        aiMessageCount: 2
      }),
      3
    );
  });

  it('snapshot=1 with 0 AI turns is legitimately at Step 1', () => {
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: 1,
        totalSteps: 22,
        aiMessageCount: 0
      }),
      1
    );
  });

  it('snapshot=1 with exactly 1 AI turn (just the opener) stays at Step 1', () => {
    // aiMessageCount=1 means the AI has sent the opener and the lead
    // hasn't replied yet. Snapshot=1 is correct here, not stale.
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: 1,
        totalSteps: 22,
        aiMessageCount: 1
      }),
      1
    );
  });

  it('preserves cap-at-floor behavior for snapshot > 1', () => {
    // Existing test from prior suite — snapshot=22 with aiCount=3 should
    // cap at 4 (the AI-turn floor) so a faulty all-complete reading
    // doesn't push past the conversation's actual progress.
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: 22,
        totalSteps: 22,
        aiMessageCount: 3
      }),
      4
    );
  });

  it('preserves snapshot when both snapshot and floor are usable and snapshot > 1', () => {
    assert.equal(
      inferCurrentStepNumber({
        snapshotCurrentStep: 5,
        totalSteps: 22,
        aiMessageCount: 10
      }),
      5
    );
  });
});

// ---------------------------------------------------------------------------
// detectStep12PlusContent / detectStep10Skipped (bug-27)
// ---------------------------------------------------------------------------

describe('detectStep12PlusContent', () => {
  it('detects obstacle re-ask phrasing (Step 12)', () => {
    assert.equal(
      detectStep12PlusContent(
        'What do you feel is the main thing holding you back that you would ideally want some guidance on?'
      ),
      true
    );
  });

  it('detects belief-break opener (Step 13)', () => {
    assert.equal(
      detectStep12PlusContent(
        "Bro what if I told you 99% of traders don't know what the real problem is?"
      ),
      true
    );
  });

  it('detects buy-in confirmation phrasing (Step 14)', () => {
    assert.equal(
      detectStep12PlusContent(
        'Now if you had a system like that, would that kind of structure help your trading?'
      ),
      true
    );
  });

  it('detects urgency ask (Step 15)', () => {
    assert.equal(
      detectStep12PlusContent(
        'I mean bro — is now the time to actually overcome these obstacles?'
      ),
      true
    );
  });

  it('detects call proposal language (Step 16)', () => {
    assert.equal(
      detectStep12PlusContent(
        'Let me set you up with my right hand guy Anthony to break down a roadmap.'
      ),
      true
    );
  });

  it('does NOT trigger on Step 10 deep-why ask', () => {
    assert.equal(
      detectStep12PlusContent(
        'But why is providing for your family so important to you though? Asking since the more I know the better I can help.'
      ),
      false
    );
  });

  it('does NOT trigger on neutral discovery questions', () => {
    assert.equal(detectStep12PlusContent('What do you do for work?'), false);
    assert.equal(
      detectStep12PlusContent('How long you been doing that?'),
      false
    );
  });
});

describe('detectStep10Skipped', () => {
  it('fires when incomeGoal captured + deepWhy missing + reply contains Step 12+ content', () => {
    const captured = { incomeGoal: '15000', early_obstacle: 'emotions' };
    const reply =
      'What do you feel is the main thing holding you back from getting where you want to be?';
    assert.equal(detectStep10Skipped(reply, captured), true);
  });

  it('fires for call-proposal language too (Step 16 jump)', () => {
    const captured = { incomeGoal: '15000' };
    const reply =
      'Let me set you up with my right hand guy Anthony to break down a roadmap for you.';
    assert.equal(detectStep10Skipped(reply, captured), true);
  });

  it('does NOT fire when deepWhy is captured', () => {
    const captured = {
      incomeGoal: '15000',
      deepWhy: 'wants to retire mom'
    };
    const reply = 'What do you feel is the main thing holding you back?';
    assert.equal(detectStep10Skipped(reply, captured), false);
  });

  it('accepts desiredOutcome as substitute for deepWhy', () => {
    const captured = {
      incomeGoal: '15000',
      desiredOutcome: 'family freedom'
    };
    const reply = 'What do you feel is the main thing holding you back?';
    assert.equal(detectStep10Skipped(reply, captured), false);
  });

  it('bug-54-deep-why-branch-history: completed deep-why step allows Step 12 content', () => {
    const captured = {
      incomeGoal: step9IncomeGoalPoint(15000),
      branchHistory: [
        step9CompletedEvent(),
        {
          eventType: 'step_completed',
          stepNumber: 10,
          stepTitle: 'Desired Outcome — Deep Why',
          selectedBranchLabel: 'Default',
          completedAt: '2026-05-11T15:06:04.857Z'
        }
      ]
    };
    const reply = 'What do you feel is the main thing holding you back?';

    assert.equal(detectStep10Skipped(reply, captured), false);
  });

  it('bug-55-deep-why-branch-history-missing: still blocks Step 12 when deep why was not completed', () => {
    const captured = {
      incomeGoal: step9IncomeGoalPoint(15000),
      branchHistory: [
        {
          eventType: 'step_completed',
          stepNumber: 9,
          stepTitle: 'Income Goal',
          selectedBranchLabel: 'Wants to replace',
          completedAt: '2026-05-11T15:04:53.437Z'
        }
      ]
    };
    const reply = 'What do you feel is the main thing holding you back?';

    assert.equal(detectStep10Skipped(reply, captured), true);
  });

  it('bug-56-deep-why-different-step-number: detects generic deep-why completion titles', () => {
    const captured = {
      incomeGoal: step9IncomeGoalPoint(15000),
      branchHistory: [
        step9CompletedEvent(),
        {
          eventType: 'step_completed',
          stepNumber: 4,
          stepTitle: 'Personal reason behind the goal',
          selectedBranchLabel: 'Default',
          completedAt: '2026-05-11T15:06:04.857Z'
        }
      ]
    };
    const reply = 'What do you feel is the main thing holding you back?';

    assert.equal(detectStep10Skipped(reply, captured), false);
  });

  it('does NOT fire before incomeGoal is captured (still in Step 9 or earlier)', () => {
    const captured = { early_obstacle: 'emotions' };
    const reply = 'What do you feel is the main thing holding you back?';
    // Without incomeGoal captured yet, skip-detection is inactive —
    // the gate only enforces Step 10 AFTER Step 9 has completed.
    assert.equal(detectStep10Skipped(reply, captured), false);
  });

  it('does NOT fire on Step 10 deep-why ask itself', () => {
    const captured = { incomeGoal: '15000' };
    const reply =
      'But why is providing for your family so important to you though?';
    assert.equal(detectStep10Skipped(reply, captured), false);
  });

  it('does NOT fire on neutral non-step-12+ replies', () => {
    const captured = { incomeGoal: '15000' };
    assert.equal(detectStep10Skipped('appreciate that bro.', captured), false);
    assert.equal(
      detectStep10Skipped('how do you feel about all that?', captured),
      false
    );
  });

  it('handles null capturedDataPoints safely', () => {
    assert.equal(
      detectStep10Skipped('what is the main thing holding you back?', null),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// bug-27 acceptance: @tegaumukoro_-style Step 9 → Step 12 jump
// ---------------------------------------------------------------------------

describe('bug-27-step-10-deep-why-enforcement (acceptance)', () => {
  it('@tegaumukoro_ scenario: incomeGoal=4k captured, AI tries to obstacle re-ask → BLOCKED', () => {
    const captured = {
      incomeGoal: '4000',
      early_obstacle: "can't follow my rules, emotions"
    };
    const offendingReply =
      'alright, what do you feel is the main thing holding you back from getting where you want to be?';
    assert.equal(detectStep10Skipped(offendingReply, captured), true);
  });

  it('valid Step 10 ask passes', () => {
    const captured = {
      incomeGoal: '4000',
      early_obstacle: "can't follow my rules, emotions"
    };
    const validReply =
      'I respect that bro, I truly do. But why is making 4k a month from trading so important to you though?';
    assert.equal(detectStep10Skipped(validReply, captured), false);
  });

  it('after deepWhy is captured, Step 12 progression is allowed', () => {
    const captured = {
      incomeGoal: '4000',
      early_obstacle: "can't follow my rules, emotions",
      deepWhy: 'want to retire my parents and have time freedom'
    };
    const step12Reply = 'What do you feel is the main thing holding you back?';
    assert.equal(detectStep10Skipped(step12Reply, captured), false);
  });

  it('CALL_PROPOSAL_PREREQS contains the Step 10 prereq', () => {
    const step10Prereq = CALL_PROPOSAL_PREREQS.find((p) => p.stepNumber === 10);
    assert.ok(step10Prereq);
    assert.equal(step10Prereq!.id, 'desired_outcome_or_deep_why');
    assert.deepEqual(step10Prereq!.acceptableKeys, [
      'desiredOutcome',
      'desired_outcome',
      'deepWhy',
      'deep_why'
    ]);
  });
});

// ---------------------------------------------------------------------------
// detectCapitalQuestionAttempt + Step 18 prereq gate (bug-28)
// ---------------------------------------------------------------------------

describe('detectCapitalQuestionAttempt', () => {
  it('detects "what\'s your capital situation"', () => {
    assert.equal(
      detectCapitalQuestionAttempt(
        "real quick, what's your capital situation like for the markets right now?"
      ),
      true
    );
  });

  it('detects "how much do you have set aside"', () => {
    assert.equal(
      detectCapitalQuestionAttempt(
        'gotcha, how much do you have set aside for trading?'
      ),
      true
    );
  });

  it('detects "how much capital do you have"', () => {
    assert.equal(
      detectCapitalQuestionAttempt(
        'so how much capital do you have to start with?'
      ),
      true
    );
  });

  it('detects "how much can you invest"', () => {
    assert.equal(
      detectCapitalQuestionAttempt('how much can you invest in this?'),
      true
    );
  });

  it('detects "what budget can you put toward"', () => {
    assert.equal(
      detectCapitalQuestionAttempt(
        'what budget can you put toward getting started?'
      ),
      true
    );
  });

  it('does NOT trigger on neutral discovery', () => {
    assert.equal(
      detectCapitalQuestionAttempt('how long you been at it?'),
      false
    );
    assert.equal(
      detectCapitalQuestionAttempt('what got you into trading?'),
      false
    );
    assert.equal(
      detectCapitalQuestionAttempt('What do you do for work?'),
      false
    );
  });
});

describe('checkCapitalQuestionPrereqs', () => {
  it('returns ALL 5 prereqs when capturedDataPoints is empty', () => {
    const missing = checkCapitalQuestionPrereqs({});
    assert.equal(missing.length, CAPITAL_QUESTION_PREREQS.length);
    // First missing should be Step 10 (deepWhy)
    assert.equal(missing[0].id, 'desired_outcome_or_deep_why');
    assert.equal(missing[0].stepNumber, 10);
  });

  it('passes when all five prereqs are captured', () => {
    const points = {
      deepWhy: 'family freedom',
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true',
      callInterestConfirmed: 'true'
    };
    assert.deepEqual(checkCapitalQuestionPrereqs(points), []);
  });

  it('does not allow capital question until belief break is complete', () => {
    const points = {
      deepWhy: 'family freedom',
      obstacle: 'no system',
      beliefBreakDelivered: 'bubble2',
      buyInConfirmed: 'true',
      callInterestConfirmed: 'true'
    };
    const missing = checkCapitalQuestionPrereqs(points);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].id, 'belief_break_delivered');
  });

  it('accepts callProposalAccepted as substitute for callInterestConfirmed', () => {
    const points = {
      deepWhy: 'family freedom',
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true',
      callProposalAccepted: 'true'
    };
    assert.deepEqual(checkCapitalQuestionPrereqs(points), []);
  });

  it('accepts completed clear buy-in branchHistory for capital prereqs too', () => {
    const points = {
      deepWhy: 'family freedom',
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      callProposalAccepted: 'true',
      branchHistory: [
        {
          eventType: 'step_completed',
          stepNumber: 14,
          stepTitle: 'Buy-in confirmation',
          selectedBranchLabel: 'Clear buy-in',
          completedAt: '2026-05-11T07:00:00.000Z'
        }
      ]
    };

    assert.deepEqual(checkCapitalQuestionPrereqs(points), []);
  });

  it('returns the FIRST missing prereq in script order (call_proposal_accepted)', () => {
    const points = {
      deepWhy: 'family freedom',
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true'
      // callInterestConfirmed missing
    };
    const missing = checkCapitalQuestionPrereqs(points);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].id, 'call_proposal_accepted');
    assert.equal(missing[0].stepNumber, 17);
  });
});

describe('detectCapitalQuestionPremature', () => {
  it('@tegaumukoro_ scenario — capital question after deep-why answer is BLOCKED', () => {
    // Lead just answered the deep-why question. capturedDataPoints
    // has incomeGoal but NOT yet deepWhy/obstacle/beliefBreak/etc.
    const captured = { incomeGoal: '4000' };
    const reply =
      "real quick, what's your capital situation like for the markets right now?";
    assert.equal(detectCapitalQuestionPremature(reply, captured), true);
  });

  it('capital question after just income goal is BLOCKED (Step 9 → Step 18 jump)', () => {
    const captured = {
      workBackground: 'engineer',
      incomeGoal: '15000'
    };
    const reply = 'what budget can you put toward getting started?';
    assert.equal(detectCapitalQuestionPremature(reply, captured), true);
  });

  it('capital question is ALLOWED only after callProposalAccepted = true (and all earlier prereqs)', () => {
    const captured = {
      deepWhy: 'family freedom',
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true',
      callProposalAccepted: 'true'
    };
    const reply =
      "real quick, what's your capital situation like for the markets right now?";
    assert.equal(detectCapitalQuestionPremature(reply, captured), false);
  });

  it('does NOT trigger on non-capital replies even when prereqs missing', () => {
    const captured = { incomeGoal: '4000' };
    assert.equal(
      detectCapitalQuestionPremature(
        'gotchu bro, replace or supplement your job?',
        captured
      ),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// inferStepFromReply / detectStepDistanceViolation (architectural skip guard)
// ---------------------------------------------------------------------------

describe('inferStepFromReply', () => {
  it('returns 18 for capital question phrasing', () => {
    assert.equal(
      inferStepFromReply("real quick, what's your capital situation like?"),
      18
    );
  });

  it('returns 13 for "99% of traders" belief break', () => {
    assert.equal(
      inferStepFromReply(
        "Bro 99% of traders don't know what the real problem is."
      ),
      13
    );
  });

  it('returns 16 for call-proposal phrasing', () => {
    assert.equal(
      inferStepFromReply(
        'set up a time with my right hand guy Anthony to break it down'
      ),
      16
    );
  });

  it('returns the HIGHEST step when reply matches multiple patterns', () => {
    // A reply that contains both belief-break (Step 13) and call-proposal
    // (Step 16) language returns 16 — Step 18 capital question would
    // win over Step 16 if present.
    const reply =
      "99% of traders don't know what the real problem is. Let me set up a time with Anthony for you.";
    assert.equal(inferStepFromReply(reply), 16);
  });

  it('returns null for replies that match no step', () => {
    assert.equal(inferStepFromReply('appreciate that bro.'), null);
    assert.equal(inferStepFromReply('how long you been at it?'), null);
  });

  it('returns step label for the highest match', () => {
    assert.equal(
      inferStepLabelFromReply(
        "real quick, what's your capital situation like?"
      ),
      'Step 18 — Capital / DQ Check'
    );
  });
});

describe('detectStepDistanceViolation', () => {
  it('fires when reply jumps more than 3 steps ahead', () => {
    // AI on Step 9, reply contains Step 18 capital question.
    assert.equal(
      detectStepDistanceViolation(
        "real quick, what's your capital situation like?",
        9
      ),
      18
    );
  });

  it('does NOT fire when reply is at most 3 steps ahead', () => {
    // AI on Step 9, reply contains Step 12 obstacle re-ask (3 ahead).
    assert.equal(
      detectStepDistanceViolation(
        'what do you feel is the main thing holding you back?',
        9
      ),
      null
    );
  });

  it('does NOT fire when reply is at the current step', () => {
    assert.equal(
      detectStepDistanceViolation(
        'But why is making 4k a month so important to you?',
        10
      ),
      null
    );
  });

  it('respects custom maxLookahead', () => {
    // With maxLookahead=2, Step 12 (3 ahead of Step 9) WOULD violate.
    assert.equal(
      detectStepDistanceViolation(
        'what do you feel is the main thing holding you back?',
        9,
        2
      ),
      12
    );
  });

  it('does NOT fire when no step is inferred from reply', () => {
    assert.equal(detectStepDistanceViolation('appreciate that bro.', 5), null);
  });

  it('does NOT fire with null/invalid currentStepNumber', () => {
    assert.equal(detectStepDistanceViolation('capital situation?', null), null);
    assert.equal(detectStepDistanceViolation('capital situation?', 0), null);
  });

  it('catches the @tegaumukoro_ Step 9 → Step 18 jump (architectural test)', () => {
    // The actual production drift: AI was generating from Step 9
    // (income goal context) and emitted capital question (Step 18).
    assert.equal(
      detectStepDistanceViolation(
        "real quick, what's your capital situation like for the markets right now?",
        9
      ),
      18
    );
  });
});

// ---------------------------------------------------------------------------
// bug-28 acceptance: Step 9 → Step 18 architectural skip
// ---------------------------------------------------------------------------

describe('bug-28-capital-question-and-step-distance (acceptance)', () => {
  it('@tegaumukoro_ scenario: capital question after deep-why answer is blocked TWO ways', () => {
    const captured = {
      incomeGoal: '4000',
      deepWhy: 'want to provide for kids'
    };
    const reply =
      "real quick, what's your capital situation like for the markets right now?";
    // (a) capital question premature gate: missing obstacle, beliefBreak, buyIn, callAccepted
    assert.equal(detectCapitalQuestionPremature(reply, captured), true);
    // (b) step-distance violation: AI on Step 11ish, reply infers Step 18
    const inferred = inferStepFromReply(reply);
    assert.equal(inferred, 18);
    assert.equal(detectStepDistanceViolation(reply, 11), 18);
  });

  it('after callProposalAccepted is captured, capital question is allowed', () => {
    const captured = {
      deepWhy: 'family freedom',
      obstacle: 'no system',
      beliefBreakDelivered: 'complete',
      buyInConfirmed: 'true',
      callProposalAccepted: 'true'
    };
    const reply =
      "real quick, what's your capital situation like for the markets right now?";
    assert.equal(detectCapitalQuestionPremature(reply, captured), false);
    // step-distance check still has a current-step input — at Step 17/18,
    // capital question (Step 18) is at-or-near current and does NOT violate.
    assert.equal(detectStepDistanceViolation(reply, 17), null);
  });

  it('catches future skip categories without enumerating their patterns', () => {
    // Even if a NEW skip class emerges (say belief-break right after
    // opener), the step-distance check fires generically.
    assert.equal(
      detectStepDistanceViolation(
        "Bro 99% of traders don't know what the real problem is.",
        2
      ),
      13
    );
  });
});

// ---------------------------------------------------------------------------
// Mandatory-ask enforcement (volunteered-data skip guard, bug-29)
// ---------------------------------------------------------------------------

describe('detectAskFiredInHistory', () => {
  it('detects "how long you been doing that" in history', () => {
    const history = [
      { content: 'damn bro respect for that.' },
      { content: 'how long you been doing that?' }
    ];
    const fragments = ['how long you been', 'how long have you been'];
    assert.equal(detectAskFiredInHistory(history, fragments), true);
  });

  it('handles fragments that include regex syntax (.{0,N})', () => {
    const history = [{ content: 'how much you make in a month right now?' }];
    const fragments = ['how much\\b.{0,20}\\bmonth(ly)?\\b'];
    assert.equal(detectAskFiredInHistory(history, fragments), true);
  });

  it('falls back to substring when regex parse fails', () => {
    const history = [{ content: 'replace your job completely with trading' }];
    // Even if the fragment isn\'t valid regex, substring match wins.
    assert.equal(detectAskFiredInHistory(history, ['replace your job']), true);
  });

  it('returns false when no AI message contains any fragment', () => {
    const history = [
      { content: 'yo bro' },
      { content: 'what brought you to trading?' }
    ];
    assert.equal(
      detectAskFiredInHistory(history, ['how much capital', 'set aside']),
      false
    );
  });

  it('handles plain string entries (not just {content:...} objects)', () => {
    const history = ['how long you been doing that?'];
    assert.equal(detectAskFiredInHistory(history, ['how long you been']), true);
  });
});

describe('checkMandatoryAsksFired', () => {
  it('returns ALL three when no asks have fired and no skip flags', () => {
    const missing = checkMandatoryAsksFired([], {});
    assert.equal(missing.length, MANDATORY_ASK_STEPS.length);
    assert.deepEqual(
      missing.map((m) => m.stepNumber),
      [6, 7, 8]
    );
  });

  it('returns empty when all three asks have fired', () => {
    const history = [
      { content: 'how long you been doing that?' },
      { content: 'how much is your job bringing in on a monthly basis?' },
      {
        content:
          'are you thinking of replacing your job completely with trading?'
      }
    ];
    assert.deepEqual(checkMandatoryAsksFired(history, {}), []);
  });

  it('honors monthlyIncomeSkipped judgeSkipKey for Step 7', () => {
    // Step 7 ASK didn't fire BUT operator script's judge condition
    // explicitly skipped it for an "obvious high earner" (engineer/doctor).
    const history = [
      { content: 'how long you been doing that?' },
      {
        content:
          'are you thinking of replacing your job completely with trading?'
      }
    ];
    const captured = { monthlyIncomeSkipped: 'true' };
    assert.deepEqual(checkMandatoryAsksFired(history, captured), []);
  });

  it('honors durable volunteered-data step completions', () => {
    const history = [
      { content: 'how much is your job bringing in on a monthly basis?' },
      {
        content:
          'are you thinking of replacing your job completely with trading?'
      }
    ];
    const captured = {
      branchHistory: [
        {
          eventType: 'step_completed',
          stepNumber: 6,
          stepTitle: 'Job Acknowledgment',
          selectedBranchLabel: null,
          completedAt: '2026-05-11T00:01:00.000Z'
        }
      ]
    };

    assert.deepEqual(checkMandatoryAsksFired(history, captured), []);
  });

  it('detects partial-firing and returns only missing steps', () => {
    const history = [
      { content: 'how long you been doing that?' }
      // Step 7, 8 asks not fired
    ];
    const missing = checkMandatoryAsksFired(history, {});
    assert.deepEqual(
      missing.map((m) => m.stepNumber),
      [7, 8]
    );
  });
});

describe('bug-30-msg-verbatim-violation', () => {
  it('detects when required [MSG] text is skipped', () => {
    const violation = detectMsgVerbatimViolation(
      'if nothing changes and you keep grinding another year, how would that hit you mentally?',
      ['I respect that bro, I truly do.']
    );
    assert.ok(violation);
    assert.equal(violation!.expected, 'I respect that bro, I truly do.');
  });

  it('allows punctuation/case variation when the full literal message is present', () => {
    assert.equal(
      detectMsgVerbatimViolation('i respect that bro i truly do', [
        'I respect that bro, I truly do.'
      ]),
      null
    );
  });

  it('bug-52-allows-required-message-with-variable-slot-when-fixed-words-match', () => {
    const required =
      "Yeah I feel you, I mean I'm not an expert in {{their field}} haha but I do know it's quite different than trading man.";
    const generated =
      "Yeah I feel you, I mean I'm not an expert in their field haha but I do know it's quite different than trading man.";

    assert.equal(detectMsgVerbatimViolation(generated, [required]), null);
  });

  it('bug-013-allows-runtime-variable-slot-with-specific-generated-value', () => {
    const required =
      "I mean bro, based off what it seems, the main struggle you're facing is {{obstacle}}, but like I said your commitment is truly there I can tell.";
    const generated =
      "I mean bro, based off what it seems, the main struggle you're facing is emotional control, but like I said your commitment is truly there I can tell.";

    assert.equal(detectMsgVerbatimViolation(generated, [required]), null);
  });

  it('bug-52-still-hard-fails-variable-slot-message-when-fixed-words-are-missing', () => {
    const required =
      "Yeah I feel you, I mean I'm not an expert in {{their field}} haha but I do know it's quite different than trading man.";

    assert.ok(
      detectMsgVerbatimViolation('retail management sounds intense bro', [
        required
      ])
    );
  });

  it('bug-49-literal-info-collection-msg: hard-fails when required list items are omitted', () => {
    const required =
      'Perfect. Send me your full name, email, phone number, city, and the best time to call you.';

    const quality = scoreVoiceQualityGroup(
      ['Perfect. Send me your full name, email, and phone number.'],
      {
        currentStepRequiredMessages: [required]
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      )
    );
  });

  it('bug-49-literal-link-msg: hard-fails when a required URL is omitted', () => {
    const required =
      'Here is the booking link: https://cal.com/example/strategy-call';

    assert.ok(
      detectMsgVerbatimViolation('Here is the booking link.', [required])
    );

    assert.equal(
      detectMsgVerbatimViolation(
        'Here is the booking link: https://cal.com/example/strategy-call',
        [required]
      ),
      null
    );
  });

  it('bug-49-literal-resource-msg: hard-fails when the wrong URL is sent', () => {
    const required =
      'Watch this before the call: https://youtube.com/watch?v=operator-script';

    const quality = scoreVoiceQualityGroup(
      ['Watch this before the call: https://youtube.com/watch?v=wrong-video'],
      {
        currentStepRequiredMessages: [required]
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      )
    );
  });

  it('bug-49-verbatim-speech-msg: hard-fails on paraphrased operator speech', () => {
    const required =
      'When people come into the markets, they believe they need more discipline.';

    const quality = scoreVoiceQualityGroup(
      [
        'Most traders think the answer is just becoming more disciplined in the markets.'
      ],
      {
        currentStepRequiredMessages: [required]
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      )
    );
  });

  it('hard-fails the group gate for missing required [MSG]', () => {
    const quality = scoreVoiceQualityGroup(
      ['what would getting 50k a month do for you and your sons?'],
      {
        currentStepRequiredMessages: [
          'I respect that bro, I truly do. I hear so many people talk about cars and materialistic stuff so it is refreshing to hear this haha.'
        ]
      }
    );
    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      )
    );
  });

  it('bug-002-falls-back-to-direct-step-msg-when-selected-branch-has-no-msg', () => {
    const quality = scoreVoiceQualityGroup(
      [
        'that goal makes sense bro',
        'but why is $1k so important to you though?'
      ],
      {
        activeBranchRequiredMessages: [],
        currentStepRequiredMessages: [
          'I respect that bro, I truly do. I hear so many people talk about cars and materialistic stuff so it is refreshing to hear this haha.'
        ],
        currentStepScriptedQuestions: [
          "But why is $1k so important to you though? Asking since the more I know the better I'll be able to help."
        ]
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      )
    );
  });

  it('bug-002-hard-fails-when-resolved-income-goal-is-dropped-from-ask', () => {
    const quality = scoreVoiceQualityGroup(
      [
        'I respect that bro, I truly do. I hear so many people talk about cars and materialistic stuff so it is refreshing to hear this haha.',
        'But why is their stated goal so important to you though?'
      ],
      {
        currentStepRequiredMessages: [
          'I respect that bro, I truly do. I hear so many people talk about cars and materialistic stuff so it is refreshing to hear this haha.'
        ],
        currentStepScriptedQuestions: [
          "But why is $1k so important to you though? Asking since the more I know the better I'll be able to help."
        ]
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('required_question_value_missing:')
      )
    );
  });

  it('bug-002-allows-step-10-verbatim-msg-and-resolved-income-goal-ask', () => {
    const quality = scoreVoiceQualityGroup(
      [
        'I respect that bro, I truly do. I hear so many people talk about cars and materialistic stuff so it is refreshing to hear this haha.',
        "But why is $1k so important to you though? Asking since the more I know the better I'll be able to help."
      ],
      {
        currentStepRequiredMessages: [
          'I respect that bro, I truly do. I hear so many people talk about cars and materialistic stuff so it is refreshing to hear this haha.'
        ],
        currentStepScriptedQuestions: [
          "But why is $1k so important to you though? Asking since the more I know the better I'll be able to help."
        ]
      }
    );

    assert.equal(
      quality.hardFails.some(
        (failure) =>
          failure.includes('msg_verbatim_violation:') ||
          failure.includes('required_question_value_missing:')
      ),
      false
    );
  });

  it('hard-fails when multiple required [MSG] actions are merged into one bubble', () => {
    const requiredMessages = [
      'Bro what if I told you 99% of traders that say that actually do not know what the real problem is?',
      'When people come into the markets, they believe they need more discipline.',
      'So what is really the bottleneck? It is the systems you have in place.'
    ];
    const merged = requiredMessages.join(' ');

    const directViolation = detectMsgBubbleSequenceViolation(
      [merged],
      requiredMessages
    );
    assert.ok(directViolation);

    const quality = scoreVoiceQualityGroup([merged], {
      currentStepRequiredMessages: requiredMessages
    });
    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('required_message_not_in_separate_bubble')
      )
    );
  });

  it('allows multiple required [MSG] actions when each appears in order as its own bubble', () => {
    const requiredMessages = [
      'Bro what if I told you 99% of traders that say that actually do not know what the real problem is?',
      'When people come into the markets, they believe they need more discipline.',
      'So what is really the bottleneck? It is the systems you have in place.'
    ];

    assert.equal(
      detectMsgBubbleSequenceViolation(requiredMessages, requiredMessages),
      null
    );
  });

  it('bug-003-required-verbatim-phrase-wins-over-banned-phrase', () => {
    const requiredMessages = [
      'Bro what if I told you 99% of traders that say that actually do not know what the real problem is? Let me explain.',
      'When people come into the markets, they believe they need more discipline.',
      'So what is really the bottleneck? It is the systems you have in place. That is what gets you from point A to point B.'
    ];

    const quality = scoreVoiceQualityGroup(requiredMessages, {
      currentStepRequiredMessages: requiredMessages
    });

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('banned_phrase: "let me explain"')
      ),
      false
    );
    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      ),
      false
    );
  });

  it('bug-003-still-blocks-banned-phrase-when-not-required-by-script', () => {
    const quality = scoreVoiceQualityGroup(
      ['let me explain how this works bro'],
      {
        currentStepRequiredMessages: ['here is the exact message']
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('banned_phrase: "let me explain"')
      )
    );
  });

  it('bug-003-extended-required-ask-word-wins-over-banned-word', () => {
    const requiredAsk =
      'What specifically would that extra income change for you and your family?';
    const quality = scoreVoiceQualityGroup([requiredAsk], {
      currentStepScriptedQuestions: [requiredAsk],
      currentStepHasAnyAskAction: true
    });

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('banned_word: "specifically"')
      ),
      false
    );
  });

  it('bug-003-extended-still-blocks-banned-word-when-not-required-by-script', () => {
    const quality = scoreVoiceQualityGroup(
      ['Specifically, you need to tell me your why.'],
      {
        currentStepScriptedQuestions: [
          'What would that income change for you?'
        ],
        currentStepHasAnyAskAction: true
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('banned_word: "specifically"')
      )
    );
  });
});

describe('fabricated URL guard', () => {
  it('catches a fabricated URL in a single-bubble reply', () => {
    const quality = scoreVoiceQualityGroup(
      ['here is the link: https://old.example.com/typeform'],
      {
        allowedUrls: ['https://current.example.com/book']
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('fabricated_url_in_reply:')
      )
    );
  });

  it('catches a fabricated URL in the second bubble', () => {
    const quality = scoreVoiceQualityGroup(
      ['perfect bro', 'grab this: https://old.example.com/typeform'],
      {
        allowedUrls: ['https://current.example.com/book']
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('fabricated_url_in_reply:')
      )
    );
  });

  it('catches a fabricated URL in the third bubble', () => {
    const quality = scoreVoiceQualityGroup(
      [
        'perfect bro',
        'one more thing',
        'grab this: https://old.example.com/typeform'
      ],
      {
        allowedUrls: ['https://current.example.com/book']
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('fabricated_url_in_reply:')
      )
    );
  });

  it('allows a URL from the current script allowlist', () => {
    const violation = detectFabricatedUrlInReply(
      ['grab this: https://current.example.com/book#conversationid=abc123'],
      ['https://current.example.com/book']
    );

    assert.equal(violation, null);
  });

  it('allows a URL from persona fallback allowlist', () => {
    const quality = scoreVoiceQualityGroup(
      ['this free training will help: https://youtube.com/watch?v=abc123'],
      {
        allowedUrls: ['https://youtube.com/watch?v=abc123']
      }
    );

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('fabricated_url_in_reply:')
      ),
      false
    );
  });

  it('sanitizes URLs across all multi-bubble messages before shipping', () => {
    const result = {
      reply: 'perfect bro',
      messages: [
        'perfect bro',
        'grab this: https://old.example.com/typeform',
        'use this instead: https://current.example.com/book'
      ]
    };

    const removed = sanitizeMessageGroupUrls(result, [
      'https://current.example.com/book'
    ]);

    assert.deepEqual(removed, ['https://old.example.com/typeform']);
    assert.equal(result.messages[1], 'grab this: [link removed]');
    assert.equal(
      result.messages[2],
      'use this instead: https://current.example.com/book'
    );
  });

  it('does not expose stale persona booking URLs when current script step does not reference them', () => {
    const script = {
      steps: [
        {
          stepNumber: 19,
          actions: [
            {
              content: 'confirm the lead has enough capital',
              linkUrl: null
            }
          ],
          branches: []
        },
        {
          stepNumber: 21,
          actions: [
            {
              content: 'booking handoff',
              linkUrl: 'https://current.example.com/book'
            }
          ],
          branches: []
        }
      ]
    };
    const relevant = getCurrentlyRelevantUrlsFromScript(script, 19);

    assert.equal(
      shouldExposePersonaAssetUrl('https://old.example.com/typeform', relevant),
      false
    );
    assert.equal(
      shouldExposePersonaAssetUrl('https://current.example.com/book', relevant),
      true
    );
  });

  it("enforces each client's own URL allowlist without cross-client leakage", () => {
    const clientTwoAllowed = ['https://legal.example.com/intake'];

    const violation = detectFabricatedUrlInReply(
      ['fill this out: https://fitness.example.com/apply'],
      clientTwoAllowed
    );

    assert.equal(violation?.url, 'https://fitness.example.com/apply');
  });
});

describe('detectMandatoryAskSkipped', () => {
  it('@tegaumukoro_ scenario — lead volunteers nurse + AI jumps to income goal: BLOCKED', () => {
    // Lead said "I trade futures and work as a nurse"
    // AI's only history: opener + ack of nurse
    const aiHistory = [
      {
        content:
          'yo bro, you new in the markets or have you been trading for a while?'
      },
      {
        content: 'damn bro, respect for that. nurses be carrying a lot.'
      }
    ];
    const captured = { job: 'nurse' };
    // AI jumps to Step 9 income-goal-from-trading
    const reply =
      'so how much money are you trying to make from trading on a monthly basis?';
    const skipped = detectMandatoryAskSkipped(reply, aiHistory, captured);
    assert.ok(skipped, 'expected mandatory-ask skip detected');
    // All three asks (6, 7, 8) missing
    assert.equal(skipped!.length, 3);
    assert.equal(skipped![0].stepNumber, 6);
  });

  it('does NOT fire when reply is on Steps 6/7/8 themselves', () => {
    // AI is correctly asking the missing step right now — that's the
    // right behavior, gate must not fire.
    const aiHistory = [{ content: 'opener' }];
    assert.equal(
      detectMandatoryAskSkipped('how long you been doing that?', aiHistory, {}),
      null
    );
    assert.equal(
      detectMandatoryAskSkipped(
        'how much is your job bringing in on a monthly basis?',
        aiHistory,
        {}
      ),
      null
    );
    assert.equal(
      detectMandatoryAskSkipped(
        'are you trying to replace your job with trading or just supplement income on the side?',
        aiHistory,
        {}
      ),
      null
    );
  });

  it('does NOT fire on early discovery / opener', () => {
    const aiHistory: Array<{ content: string }> = [];
    assert.equal(
      detectMandatoryAskSkipped(
        'yo bro, you new in the markets or trading for a while?',
        aiHistory,
        {}
      ),
      null
    );
  });

  it('fires when reply contains capital question without any discovery asks', () => {
    const aiHistory = [{ content: 'opener' }];
    const captured = { job: 'engineer' };
    const reply = "what's your capital situation like?";
    const skipped = detectMandatoryAskSkipped(reply, aiHistory, captured);
    assert.ok(skipped);
    assert.equal(skipped!.length, 3); // all 3 asks missing
  });

  it('fires when reply contains Step 12 obstacle re-ask without discovery asks', () => {
    const aiHistory = [{ content: 'opener' }];
    const reply = 'what do you feel is the main thing holding you back?';
    const skipped = detectMandatoryAskSkipped(reply, aiHistory, {});
    assert.ok(skipped);
  });

  it('does NOT fire when 6/7/8 asks have all fired', () => {
    const aiHistory = [
      { content: 'how long you been doing that?' },
      { content: 'how much is your job bringing in on a monthly basis?' },
      { content: 'replace your job completely with trading or supplement?' }
    ];
    const reply =
      'how much would you need to be making from trading to replace it?';
    assert.equal(detectMandatoryAskSkipped(reply, aiHistory, {}), null);
  });

  it('bug-32-step8-mandatory-ask blocks Step 9 when replace/supplement ask never fired', () => {
    const aiHistory = [
      { content: 'how long you been doing that?' },
      { content: 'how much is your job bringing in on a monthly basis?' }
    ];
    const reply =
      'how much would you need to be making from trading on a monthly basis?';
    const skipped = detectMandatoryAskSkipped(reply, aiHistory, {
      workBackground: 'nurse',
      monthlyIncome: '4000',
      replaceOrSupplement: 'replace'
    });
    assert.ok(skipped);
    assert.deepEqual(
      skipped!.map((req) => req.stepNumber),
      [8]
    );
  });
});

// ---------------------------------------------------------------------------
// bug-29 acceptance: nurse-volunteered-job scenario
// ---------------------------------------------------------------------------

describe('bug-29-mandatory-ask-enforcement (acceptance)', () => {
  it('volunteered job title + AI jumps to income goal → BLOCKED', () => {
    // Reproduces the exact production drift.
    const history = [
      {
        content:
          'yo bro, you new in the markets or have you been trading for a while?'
      },
      { content: 'gotchu, respect that bro. nurses do real work.' }
    ];
    const captured = { workBackground: 'nurse', job: 'nurse' };
    const reply =
      'And how much would you need to be making from trading to replace it?';
    assert.ok(detectMandatoryAskSkipped(reply, history, captured));
  });

  it('after Step 6/7/8 asks fire normally, Step 9 advance is allowed', () => {
    const history = [
      { content: 'opener' },
      { content: 'gotchu, what do you do for work?' },
      { content: 'respect that bro. how long you been doing that?' },
      {
        content: 'and on a monthly basis, how much is your job bringing in?'
      },
      {
        content:
          'gotchu — are you thinking of replacing your job completely with trading?'
      }
    ];
    const captured = {
      workBackground: 'nurse',
      monthlyIncome: '4000',
      replaceOrSupplement: 'replace'
    };
    const reply = 'how much would you need to be making from trading?';
    assert.equal(detectMandatoryAskSkipped(reply, history, captured), null);
  });

  it('monthlyIncomeSkipped judge-condition still works (high earner exception)', () => {
    // Operator script's Step 7 judge condition: "If their job makes it
    // obvious they earn well (engineer, doctor) → skip to STEP 8".
    // monthlyIncomeSkipped flag in capturedDataPoints honors that.
    const history = [
      { content: 'how long you been doing that?' },
      {
        content:
          'are you thinking of replacing your job completely with trading?'
      }
    ];
    const captured = { monthlyIncomeSkipped: 'true' };
    const reply =
      'how much would you need to be making from trading to replace it?';
    assert.equal(detectMandatoryAskSkipped(reply, history, captured), null);
  });
});
