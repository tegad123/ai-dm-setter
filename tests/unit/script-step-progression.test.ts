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
  containsQuestion,
  countQuestionMarks,
  detectAcknowledgmentOpener,
  detectBeliefBreakDelivered,
  detectBeliefBreakInMessage,
  detectCallProposalAttempt,
  getStepActionShape,
  hasCapturedDataPoint,
  inferCurrentStepNumber,
  jaccardSimilarity,
  maxQuestionSimilarityToScript,
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
