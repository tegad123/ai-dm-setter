// REPRODUCTION of the deep-why LOOP observed live in prod (2026-06-08).
//
// Real incident: a live FB conversation advanced fine to step 11 ("Desired
// Outcome — Deep Why"), the lead answered the why ("freedom, be there for my
// kids"), but the AI kept RE-ASKING the deep-why every turn and never reached
// the call proposal. systemStage parked at step 11, stageMismatchCount=12.
//
// Mechanism: step 11 has a [ask + wait + runtime_judgment] action shape.
// stepHasHistoryCompletionSignal() (script-state-recovery.ts:1286) returns
// false for runtime-judgment-after-wait steps, and stepCompletionFromHistory()
// `continue`s past them — so the Phase-1 suggestionId completion fix is
// UNREACHABLE for judgment steps. The step never completes → position parks →
// the AI loops on the deep-why question.
//
// EXPECTATION:
//   - CURRENT code: FAILS — position parks on the judgment step (step 4 here),
//     never reaches the terminal call step.
//   - After Phase 6A: PASSES — the judgment step completes via the same
//     suggestionId signal (+ anti-loop backstop) and the position advances.

import type { MultiTurnFixture } from './types';

const script = [
  {
    stepNumber: 1,
    title: 'Intro',
    question: 'you been trading a while or just starting?'
  },
  {
    stepNumber: 2,
    title: 'Situation',
    question: 'how have the markets been treating you?'
  },
  {
    stepNumber: 3,
    title: 'Income Goal',
    question: 'what monthly number are you after?'
  },
  // step 4 = the judgment "deep why" step (ask + wait + runtime_judgment)
  {
    stepNumber: 4,
    title: 'Deep Why',
    question: 'why is that number important to you?',
    runtimeJudgment: true
  },
  {
    stepNumber: 5,
    title: 'Buy-In',
    question: 'would a real system help you get there?'
  },
  {
    stepNumber: 6,
    title: 'Call Proposal',
    question: 'wanna hop on a call to map it out?'
  }
];

export const fixture: MultiTurnFixture = {
  id: 'repro-04-judgment-step-loop',
  description:
    'Deep-why judgment step (ask+wait+runtime_judgment): lead answers it, position must advance past it to the call — current code parks/loops there.',
  script,
  turns: [
    {
      turn: 1,
      aiStepNumber: 1,
      aiSuggestionId: 'sug_1',
      aiMessage: 'yo you been at it a while or fresh to the markets?',
      leadReply: 'been trading about 2 years'
    },
    {
      turn: 2,
      aiStepNumber: 2,
      aiSuggestionId: 'sug_2',
      aiMessage: 'gotcha, how have the markets been treating you?',
      leadReply: 'rough honestly, keep blowing accounts'
    },
    {
      turn: 3,
      aiStepNumber: 3,
      aiSuggestionId: 'sug_3',
      aiMessage: 'what kind of monthly number you chasing?',
      leadReply: 'like 15k a month would change everything'
    },
    {
      turn: 4,
      aiStepNumber: 4, // the judgment deep-why step
      aiSuggestionId: 'sug_4',
      aiMessage: 'why’s hitting 15k matter so much to you?',
      leadReply:
        'freedom, and being there for my kids instead of grinding a job i hate'
    },
    {
      turn: 5,
      aiStepNumber: 5,
      aiSuggestionId: 'sug_5',
      aiMessage:
        'real reason right there. if you had a proper system, that’d help right?',
      leadReply: '100%, that’s exactly what i need'
    },
    {
      turn: 6,
      aiStepNumber: 6,
      aiSuggestionId: 'sug_6',
      aiMessage: 'bet — wanna jump on a call to map it out?',
      leadReply: 'yeah let’s do it'
    }
  ],
  checks: {
    maxConsecutiveSameStep: 2, // must not park ≥3 turns on the judgment step
    maxLagFromTrue: 2,
    finalStepAtLeast: 5 // must get past the deep-why to the buy-in/call vicinity
  }
};
