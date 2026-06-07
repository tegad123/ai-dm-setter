// REPRODUCTION of Tega's stuck conversation (2026-06-05).
//
// Real incident: systemStage froze at step 7 ("Job Acknowledgment") while the
// conversation content reached BOOKING; stageMismatchCount climbed to 19; the
// AI eventually escalated to human and went silent.
//
// Mechanism reproduced here: the AI PARAPHRASES its scripted [ASK] each turn
// (real LLM behavior). The current `stepCompletionFromHistory` only completes a
// step when the AI's message textually matches the scripted question, so a
// paraphrased ask is never recognized as "asked + answered" → the step never
// completes → computeSystemStage parks the position → it lags further every turn.
//
// EXPECTATION:
//   - On CURRENT code: this fixture FAILS (position parks, lag grows, never
//     reaches the terminal step). That red is the proof the test catches the bug.
//   - After the fix (1a suggestionId/paraphrase completion + 1b conditional
//     cap): this fixture PASSES (position tracks within tolerance, reaches
//     terminal step).

import type { MultiTurnFixture } from './types';

// A generic 8-step funnel (NOT assuming DAE), each step asks one question.
const script = [
  {
    stepNumber: 1,
    title: 'Intro',
    question: 'are you new to the markets or been trading a while?'
  },
  {
    stepNumber: 2,
    title: 'Experience',
    question: 'how long have you been trading?'
  },
  {
    stepNumber: 3,
    title: 'Current Situation',
    question: 'how have the markets been treating you?'
  },
  {
    stepNumber: 4,
    title: 'Obstacle',
    question: 'what is the main thing holding you back?'
  },
  {
    stepNumber: 5,
    title: 'Goal',
    question: 'what are you trying to make each month?'
  },
  {
    stepNumber: 6,
    title: 'Deep Why',
    question: 'why is that important to you?'
  },
  {
    stepNumber: 7,
    title: 'Buy-In',
    question: 'would a structured system help you get there?'
  },
  {
    stepNumber: 8,
    title: 'Call Proposal',
    question: 'wanna hop on a call to map it out?'
  }
];

export const fixture: MultiTurnFixture = {
  id: 'repro-01-step-parking',
  description:
    "Tega's stuck-conversation reproduction: AI paraphrases each scripted ask; current code parks the position; fix must let it track + reach the call proposal.",
  script,
  turns: [
    {
      turn: 1,
      aiStepNumber: 1,
      aiSuggestionId: 'sug_step1',
      aiMessage: 'yo so are you fresh to the markets or you been at it a bit?', // paraphrase of step 1
      leadReply: "i'm pretty new to it"
    },
    {
      turn: 2,
      aiStepNumber: 2,
      aiSuggestionId: 'sug_step2',
      aiMessage: 'gotchu — so how long you been messing with it?', // paraphrase of step 2
      leadReply: 'like a few months'
    },
    {
      turn: 3,
      aiStepNumber: 3,
      aiSuggestionId: 'sug_step3',
      aiMessage: 'and how’s it been going for you so far?', // paraphrase of step 3
      leadReply: 'honestly not great, keep losing'
    },
    {
      turn: 4,
      aiStepNumber: 4,
      aiSuggestionId: 'sug_step4',
      aiMessage:
        'damn — what do you reckon’s the biggest thing tripping you up?', // paraphrase of step 4
      leadReply: 'no real plan, i just wing it'
    },
    {
      turn: 5,
      aiStepNumber: 5,
      aiSuggestionId: 'sug_step5',
      aiMessage: 'makes sense. what kind of monthly number you chasing?', // paraphrase of step 5
      leadReply: 'like 10k a month would change my life'
    },
    {
      turn: 6,
      aiStepNumber: 6,
      aiSuggestionId: 'sug_step6',
      aiMessage: 'love that — why’s hitting 10k matter so much to you?', // paraphrase of step 6
      leadReply: 'i want to take care of my mom and stop stressing'
    },
    {
      turn: 7,
      aiStepNumber: 7,
      aiSuggestionId: 'sug_step7',
      aiMessage:
        'real reason right there. if you had a proper system, that’d help right?', // paraphrase of step 7
      leadReply: '100%, that’s exactly what i need'
    },
    {
      turn: 8,
      aiStepNumber: 8,
      aiSuggestionId: 'sug_step8',
      aiMessage: 'bet — wanna jump on a quick call so we can lay it out?', // paraphrase of step 8
      leadReply: "yes i'm down"
    }
  ],
  checks: {
    maxConsecutiveSameStep: 2, // must not freeze on a step for 3+ turns
    maxLagFromTrue: 2, // tracked step must stay within 2 of the true step
    finalStepAtLeast: 7 // by the end, must have reached the call-proposal vicinity
  }
};
