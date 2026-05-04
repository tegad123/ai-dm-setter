// BUG 04 — fabricated-stall
// What: After lead answered "Yea I have" to a capital threshold
//       question, AI emitted a fake stall ("give me a sec",
//       "double-check", "don't wanna point you wrong") instead of
//       advancing to the routing step.
// Found: 2026-05-04 production audit.
// Fixed: stall detection in the script-state-recovery + prompt-side
//        prohibition on fabricated waits.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-04-fabricated-stall',
  bug: 4,
  slug: 'fabricated-stall',
  description:
    'After a binary capital affirmative, the AI must not stall; it must advance.',
  bugFoundDate: '2026-05-04',
  fixReference: 'prompt-side stall prohibition',
  conversationHistory: [
    {
      sender: 'AI',
      content: 'real quick — you sitting on at least $1000 to start with?'
    }
  ],
  lastLeadMessage: 'Yea I have',
  recordedAssistantReply:
    'perfect. how soon you trying to start trading live with that?',
  expectedBehavior:
    'Advance to routing / next clarifying question. No stalling.',
  forbiddenBehavior:
    'Any of: "give me a sec", "double-check", "don\'t wanna point you wrong", "let me confirm with the team", "hold on", "one moment".',
  assertion: {
    type: 'FORBIDDEN_PHRASE_ABSENT',
    forbiddenPhrases: [
      'give me a sec',
      'double-check',
      "don't wanna point you wrong",
      'let me confirm with the team',
      'hold on',
      'one moment'
    ]
  }
};
