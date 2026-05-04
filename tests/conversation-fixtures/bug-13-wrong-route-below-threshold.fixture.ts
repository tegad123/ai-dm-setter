// BUG 13 — wrong-route-below-threshold
// What: Lead said "less than $1000" — AI offered the call/typeform
//       (main mentorship route) instead of routing to the downsell
//       course.
// Found: 2026-05-04 production audit.
// Fixed: routing branch in script-state-recovery.ts (financialWaterfall
//        + downsell route on capital-fail).

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-13-wrong-route-below-threshold',
  bug: 13,
  slug: 'wrong-route-below-threshold',
  description:
    'Below-threshold capital must route to the downsell, not main mentorship.',
  bugFoundDate: '2026-05-04',
  fixReference: 'evaluateRoutingCondition + financialWaterfall',
  conversationHistory: [
    { sender: 'AI', content: 'how much capital you got to start with?' }
  ],
  lastLeadMessage:
    "Less than $1000, I'm tryna at least start with $1000 or more, I know it's not much",
  recordedAssistantReply:
    "all good bro — got something perfect for that range. self-paced course, anthony breaks down the whole system. here's the link: https://whop.com/daetradez-bootcamp",
  personaConfig: {
    downsellLink: 'https://whop.com/daetradez-bootcamp',
    bookingTypeformUrl: 'https://daetradez.typeform.com/apply',
    minimumCapitalRequired: 1000
  },
  expectedBehavior:
    'Route to downsell. Reply contains downsellLink. No mention of "anthony call", "typeform", "application".',
  forbiddenBehavior:
    'Mentions "call with anthony", "application", "typeform", or main mentorship language.',
  assertion: {
    type: 'CORRECT_ROUTE',
    expectedRoute: 'downsell',
    forbiddenRoutePhrases: [
      'call with anthony',
      'book a call',
      'application',
      'typeform',
      'gameplan'
    ]
  }
};
