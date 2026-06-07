// Multi-turn fixture for the CATCH-UP case (F5.1 1b).
//
// Scenario: an early turn's AI message is NOT recognized for a turn (e.g. a
// bubble lands without its suggestionId attached, or a transient miss), so the
// tracked position falls behind. On the next turns the steps ARE provably
// completed. Pre-1b, the +1/turn cap kept the position one behind forever
// (re-feeding the gate a stale step). Post-1b, once the intervening steps are
// provably complete, the position catches up to the true step in a single turn.
//
// Asserts: position recovers (no permanent lag), reaches the terminal step.

import type { MultiTurnFixture } from './types';

const script = [
  {
    stepNumber: 1,
    title: 'Intro',
    question: 'new to the markets or been trading a while?'
  },
  {
    stepNumber: 2,
    title: 'Experience',
    question: 'how long have you been at it?'
  },
  {
    stepNumber: 3,
    title: 'Situation',
    question: 'how have the markets been treating you?'
  },
  {
    stepNumber: 4,
    title: 'Goal',
    question: 'what monthly number are you after?'
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
  id: 'repro-02-catchup-after-gap',
  description:
    'Tracker falls behind for a turn (untagged bubble), then catches up once intervening steps are provably complete (1b conditional cap).',
  script,
  turns: [
    {
      turn: 1,
      aiStepNumber: 1,
      aiSuggestionId: 'sug_1',
      aiMessage: 'yo you fresh to the markets or been at it?',
      leadReply: 'been trading about a year'
    },
    {
      turn: 2,
      aiStepNumber: 2,
      // NOTE: no suggestionId on this turn AND a paraphrase → the gap. Pre-1a/1b
      // this step wouldn't complete; the position would start to lag here.
      aiMessage: 'nice, how long exactly you been in it?',
      leadReply: 'like 12 months give or take'
    },
    {
      turn: 3,
      aiStepNumber: 3,
      aiSuggestionId: 'sug_3',
      aiMessage: 'gotcha — how’s it been going lately?',
      leadReply: 'rough, keep giving back profits'
    },
    {
      turn: 4,
      aiStepNumber: 4,
      aiSuggestionId: 'sug_4',
      aiMessage: 'what kind of monthly number would change things for you?',
      leadReply: '5k a month'
    },
    {
      turn: 5,
      aiStepNumber: 5,
      aiSuggestionId: 'sug_5',
      aiMessage: 'if you had a structured system, that’d help right?',
      leadReply: 'for sure, that’s what i’m missing'
    },
    {
      turn: 6,
      aiStepNumber: 6,
      aiSuggestionId: 'sug_6',
      aiMessage: 'bet — wanna jump on a quick call to lay it out?',
      leadReply: 'yeah let’s do it'
    }
  ],
  checks: {
    maxConsecutiveSameStep: 2,
    maxLagFromTrue: 2,
    finalStepAtLeast: 5
  }
};
