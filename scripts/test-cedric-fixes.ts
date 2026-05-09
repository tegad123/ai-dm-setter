/* eslint-disable no-console */
// Regression coverage for Cedric Chaar 2026-04-29:
//   1. Goal/Why stalls after 8 AI messages hard-fail to urgency
//   2. Capital missing after 12 AI messages hard-fails to capital
//   3. Three validation-only AI messages in a row trigger regen
//   4. "facts bro" and "yeah bro" are capped at 2 uses

import {
  isValidationOnlyMessage,
  scoreVoiceQualityGroup
} from '../src/lib/voice-quality-gate';

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

function hasHardFail(failures: string[], reason: string): boolean {
  return failures.some((f) => f.includes(`${reason}:`));
}

function main() {
  console.log('\n[TEST 1] Goal/Why stall hard-fails to urgency');
  const stalled = scoreVoiceQualityGroup(
    ["facts bro, that's why i like keeping it simple"],
    {
      aiMessageCount: 9,
      currentStage: 'GOAL_EMOTIONAL_WHY',
      incomeGoalAsked: true,
      capitalQuestionAsked: false
    }
  );
  expect(
    'qualification_stalled hard fail fires',
    hasHardFail(stalled.hardFails, 'qualification_stalled'),
    true
  );

  console.log('\n[TEST 2] Capital missing after 12 AI messages hard-fails');
  const capitalOverdue = scoreVoiceQualityGroup(
    ["gotchu bro, gold moves clean when you're patient"],
    {
      aiMessageCount: 13,
      currentStage: 'URGENCY',
      incomeGoalAsked: true,
      capitalQuestionAsked: false
    }
  );
  expect(
    'capital_question_overdue hard fail fires',
    hasHardFail(capitalOverdue.hardFails, 'capital_question_overdue'),
    true
  );

  const parsedScriptPacing = scoreVoiceQualityGroup(
    ["gotchu bro, gold moves clean when you're patient"],
    {
      aiMessageCount: 13,
      currentStage: 'URGENCY',
      incomeGoalAsked: true,
      capitalQuestionAsked: false,
      skipLegacyPacingGates: true
    }
  );
  expect(
    'capital_question_overdue is suppressed for parsed-script pacing',
    hasHardFail(parsedScriptPacing.hardFails, 'capital_question_overdue'),
    false
  );

  const capitalAsked = scoreVoiceQualityGroup(
    [
      "real quick, what's your capital situation like for the markets right now?"
    ],
    {
      aiMessageCount: 13,
      currentStage: 'FINANCIAL_SCREENING',
      incomeGoalAsked: true,
      capitalQuestionAsked: false
    }
  );
  expect(
    'capital overdue does not fire when current reply asks capital',
    hasHardFail(capitalAsked.hardFails, 'capital_question_overdue'),
    false
  );

  const parsedScriptPrematureCapital = scoreVoiceQualityGroup(
    [
      "real quick, what's your capital situation like for the markets right now?"
    ],
    {
      aiMessageCount: 13,
      currentStage: 'FINANCIAL_SCREENING',
      incomeGoalAsked: true,
      capitalQuestionAsked: false,
      skipLegacyPacingGates: true,
      capturedDataPoints: {
        incomeGoal: 6000,
        early_obstacle: 'emotions'
      }
    }
  );
  expect(
    'parsed-script capital ask after income goal hard-fails Step 18 prereqs',
    hasHardFail(
      parsedScriptPrematureCapital.hardFails,
      'capital_question_premature'
    ),
    true
  );

  console.log('\n[TEST 3] Validation loop detected');
  expect(
    'validation-only helper catches facts bro without a question',
    isValidationOnlyMessage("facts bro, that's why i like keeping it simple"),
    true
  );
  expect(
    'validation-only helper ignores validation plus a question',
    isValidationOnlyMessage(
      'facts bro, how soon are you trying to make this happen?'
    ),
    false
  );
  const validationLoop = scoreVoiceQualityGroup(
    ["yeah bro, that's the part people miss"],
    {
      priorValidationOnlyCount: 2,
      incomeGoalAsked: true,
      capitalQuestionAsked: false
    }
  );
  expect(
    'validation_loop soft signal fires on third validation-only reply',
    validationLoop.softSignals.validation_loop,
    -0.5
  );

  const advanced = scoreVoiceQualityGroup(
    ['facts bro, how soon are you trying to make this happen?'],
    {
      priorValidationOnlyCount: 2,
      incomeGoalAsked: true,
      capitalQuestionAsked: false
    }
  );
  expect(
    'validation_loop does not fire when the reply advances with a question',
    advanced.softSignals.validation_loop,
    undefined
  );

  console.log('\n[TEST 4] Validation phrase overuse capped');
  const factsOverused = scoreVoiceQualityGroup(
    ["facts bro, that's why patience matters"],
    {
      priorFactsBroCount: 2,
      incomeGoalAsked: true,
      capitalQuestionAsked: false
    }
  );
  expect(
    'facts bro third use fires overused_validation_phrase',
    factsOverused.softSignals.overused_validation_phrase,
    -0.4
  );

  const yeahOverused = scoreVoiceQualityGroup(
    ["yeah bro, that's the clean part"],
    {
      priorYeahBroCount: 2,
      incomeGoalAsked: true,
      capitalQuestionAsked: false
    }
  );
  expect(
    'yeah bro third use fires overused_validation_phrase',
    yeahOverused.softSignals.overused_validation_phrase,
    -0.4
  );

  const factsAllowed = scoreVoiceQualityGroup(
    ["facts bro, that's a clean read"],
    {
      priorFactsBroCount: 1,
      incomeGoalAsked: true,
      capitalQuestionAsked: false
    }
  );
  expect(
    'facts bro second use is still allowed',
    factsAllowed.softSignals.overused_validation_phrase,
    undefined
  );

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
