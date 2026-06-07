// Non-DAE account funnel (F5.1 3a/3b — de-hardcoded funnel).
//
// A completely different account's script: a fitness-coaching setter, NOT the
// DAE trading funnel. Different step ordering, different domain, income-goal
// equivalent ("revenue target") at step 4 instead of 9. Proves the position
// engine tracks an ARBITRARY account's authored script start→terminal without
// parking — the core enabler for onboarding new clients.

import type { MultiTurnFixture } from './types';

const script = [
  {
    stepNumber: 1,
    title: 'Opener',
    question: 'you currently coaching clients or just getting started?',
    stateKey: 'opener'
  },
  {
    stepNumber: 2,
    title: 'Niche',
    question: 'what kind of clients do you work with?',
    stateKey: 'niche'
  },
  {
    stepNumber: 3,
    title: 'Struggle',
    question: 'whats the hardest part of growing it right now?',
    stateKey: 'struggle'
  },
  {
    stepNumber: 4,
    title: 'Revenue Target',
    question: 'what monthly revenue are you aiming for?',
    stateKey: 'income_goal'
  },
  {
    stepNumber: 5,
    title: 'Commitment',
    question: 'how serious are you about scaling this year?',
    stateKey: 'commitment'
  },
  {
    stepNumber: 6,
    title: 'Call',
    question: 'wanna hop on a call to build your plan?',
    stateKey: 'call_proposal'
  }
];

export const fixture: MultiTurnFixture = {
  id: 'repro-03-non-dae-script',
  description:
    'A non-DAE (fitness-coaching) account script with income-goal at step 4: position must track start→call with no parking on an arbitrary authored funnel.',
  script,
  turns: [
    {
      turn: 1,
      aiStepNumber: 1,
      aiSuggestionId: 'sug_1',
      aiMessage: 'yo you already coaching people or just kicking it off?', // paraphrase
      leadReply: 'been coaching about 6 months'
    },
    {
      turn: 2,
      aiStepNumber: 2,
      aiSuggestionId: 'sug_2',
      aiMessage: 'nice, what type of clients you focus on?',
      leadReply: 'busy professionals who want to lose weight'
    },
    {
      turn: 3,
      aiStepNumber: 3,
      aiSuggestionId: 'sug_3',
      aiMessage: 'gotcha — whats been the toughest part of growing it?',
      leadReply: 'getting consistent leads honestly'
    },
    {
      turn: 4,
      aiStepNumber: 4,
      aiSuggestionId: 'sug_4',
      aiMessage: 'makes sense. whats the monthly revenue youre going for?', // income-goal equivalent, step 4 not 9
      leadReply: 'id love to hit 15k a month'
    },
    {
      turn: 5,
      aiStepNumber: 5,
      aiSuggestionId: 'sug_5',
      aiMessage:
        'love it — how serious are you about making that happen this year?',
      leadReply: 'dead serious, im all in'
    },
    {
      turn: 6,
      aiStepNumber: 6,
      aiSuggestionId: 'sug_6',
      aiMessage: 'lets jump on a call and map out your plan then?',
      leadReply: 'yes lets do it'
    }
  ],
  checks: {
    maxConsecutiveSameStep: 2,
    maxLagFromTrue: 2,
    finalStepAtLeast: 5
  }
};
