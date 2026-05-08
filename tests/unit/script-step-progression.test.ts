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
  buildCurrentStepBlock,
  checkCallProposalPrereqs,
  detectBeliefBreakDelivered,
  detectBeliefBreakInMessage,
  detectCallProposalAttempt,
  hasCapturedDataPoint,
  inferCurrentStepNumber,
  type CompactScriptStep
} from '../../src/lib/script-step-progression';

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
      beliefBreakDelivered: 'true',
      buyInConfirmed: 'true'
    };
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
      beliefBreakDelivered: 'true',
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
      beliefBreakDelivered: 'true',
      buyInConfirmed: 'true'
    };
    assert.deepEqual(checkCallProposalPrereqs(points), []);
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
      beliefBreakDelivered: { value: true, confidence: 'HIGH' },
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
      beliefBreakDelivered: 'true',
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
      beliefBreakDelivered: 'true',
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
