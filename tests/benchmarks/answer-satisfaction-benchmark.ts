import { performance } from 'node:perf_hooks';

import { replyAnswersAsk } from '../../src/lib/answer-satisfaction';

interface Case {
  name: string;
  ask: string;
  reply: string;
  expected: boolean;
}

// Scenarios vary the script subject and include answers, deferrals, and
// question-backs. This is a behavior benchmark, not a speed target.
const cases: Case[] = [
  {
    name: 'live trading answer plus product question',
    ask: 'you trading anything yet, even on demo, or still learning the basics first?',
    reply:
      "nah not yet, still in learning mode. i'm based in texas. do you have a free discord?",
    expected: true
  },
  {
    name: 'trading answer without extra text',
    ask: 'you trading anything yet, even on demo, or still learning the basics first?',
    reply: 'not yet, still learning',
    expected: true
  },
  {
    name: 'trading answer with alternative phrasing',
    ask: 'you trading anything yet, even on demo, or still learning the basics first?',
    reply: 'not yet, just studying the basics',
    expected: true
  },
  {
    name: 'trading answer followed by pricing question',
    ask: 'you trading anything yet, even on demo, or still learning the basics first?',
    reply:
      'not yet, still learning the basics. How much does the program cost?',
    expected: true
  },
  {
    name: 'trading bare deferral',
    ask: 'you trading anything yet, even on demo, or still learning the basics first?',
    reply: 'not yet',
    expected: false
  },
  {
    name: 'trading reciprocal question only',
    ask: 'you trading anything yet, even on demo, or still learning the basics first?',
    reply: 'not yet, you?',
    expected: false
  },
  {
    name: 'trading clarification about offered option',
    ask: 'you trading anything yet, even on demo, or still learning the basics first?',
    reply: 'not yet, what do you mean by learning the basics?',
    expected: false
  },
  {
    name: 'trading request to explain offered option',
    ask: 'you trading anything yet, even on demo, or still learning the basics first?',
    reply: 'not yet, can you explain the basics?',
    expected: false
  },
  {
    name: 'trading unrelated deferral',
    ask: 'you trading anything yet, even on demo, or still learning the basics first?',
    reply: 'not yet, I need to ask my friend',
    expected: false
  },
  {
    name: 'trading quoted alternative in a question',
    ask: 'you trading anything yet, even on demo, or still learning the basics first?',
    reply: 'not yet, is learning the basics free?',
    expected: false
  },
  {
    name: 'capital ask with learning non-answer',
    ask: 'do you have enough capital to get started?',
    reply: 'not yet, still learning',
    expected: false
  },
  {
    name: 'capital ask with concrete amount',
    ask: 'how much capital do you have to start?',
    reply: 'I have $500 ready',
    expected: true
  },
  {
    name: 'capital price question',
    ask: 'how much capital do you have to start?',
    reply: 'What does the $200 include before paying?',
    expected: false
  },
  {
    name: 'call deciding alternative',
    ask: 'have you booked a call yet, or still deciding?',
    reply: 'not yet, still deciding',
    expected: true
  },
  {
    name: 'call deciding synonym',
    ask: 'have you booked a call yet, or still deciding?',
    reply: 'not yet, still thinking about it',
    expected: true
  },
  {
    name: 'call ask with explanation request',
    ask: 'have you booked a call yet, or still deciding?',
    reply: 'not yet, can you explain what I would be deciding?',
    expected: false
  },
  {
    name: 'call deferral without choice',
    ask: 'have you booked a call yet, or still deciding?',
    reply: 'not yet, maybe later',
    expected: false
  },
  {
    name: 'timing alternative selected',
    ask: 'would you start today or next week?',
    reply: 'not yet, next week',
    expected: true
  },
  {
    name: 'timing option mentioned in question',
    ask: 'would you start today or next week?',
    reply: 'not yet, what happens next week?',
    expected: false
  },
  {
    name: 'timing unrelated question',
    ask: 'would you start today or next week?',
    reply: 'not yet, how much does it cost?',
    expected: false
  },
  {
    name: 'location answer with question back',
    ask: 'where are you based?',
    reply: "I'm based in Nairobi, you?",
    expected: true
  },
  {
    name: 'location bare question back',
    ask: 'where are you based?',
    reply: 'What about you?',
    expected: false
  },
  {
    name: 'goal answer with question',
    ask: 'what income are you aiming for?',
    reply: 'I want 5k a month, is that realistic?',
    expected: true
  },
  {
    name: 'goal number in question only',
    ask: 'what income are you aiming for?',
    reply: 'How much do I need to make 6k though?',
    expected: false
  },
  {
    name: 'product question before answer',
    ask: 'what is your main trading goal?',
    reply: 'How much does the Discord cost?',
    expected: false
  },
  {
    name: 'answer before product question',
    ask: 'what is your main trading goal?',
    reply: 'I want to become consistent. Is the Discord free?',
    expected: true
  }
];

const start = performance.now();
const failures: Array<{ name: string; actual: boolean; expected: boolean }> =
  [];
for (const scenario of cases) {
  const actual = replyAnswersAsk(scenario.reply, scenario.ask);
  if (actual !== scenario.expected) {
    failures.push({ name: scenario.name, actual, expected: scenario.expected });
  }
}
const elapsedMs = performance.now() - start;
console.log(
  `Answer-satisfaction benchmark: ${cases.length - failures.length}/${cases.length} passed in ${elapsedMs.toFixed(1)} ms`
);
for (const failure of failures) {
  console.log(
    `FAIL ${failure.name}: expected ${failure.expected}, received ${failure.actual}`
  );
}
process.exitCode = failures.length === 0 ? 0 : 1;
