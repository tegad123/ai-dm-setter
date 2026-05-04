// BUG 02 — false-unqualified-qualified-lead
// What: A lead who confirmed $7k capital and accepted a Monday
//       booking was misclassified as UNQUALIFIED.
// Found: 2026-05-04 production audit.
// Fixed: stage classifier honors capitalThresholdMet + booking
//        confirmation signals.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-02-false-unqualified-qualified-lead',
  bug: 2,
  slug: 'false-unqualified-qualified-lead',
  description:
    'When capital is verified above threshold and a booking time is confirmed, stage must be QUALIFIED or BOOKED — never UNQUALIFIED.',
  bugFoundDate: '2026-05-04',
  fixReference: 'computeSystemStage + capital verification durable state',
  conversationHistory: [
    {
      sender: 'AI',
      content: 'how much capital you working with right now?'
    },
    { sender: 'LEAD', content: 'around 7k bro' },
    {
      sender: 'AI',
      content:
        'cool. anthony does a free breakdown call — got availability monday at 3pm cst. that work?'
    }
  ],
  lastLeadMessage: 'Yes that works for Monday',
  systemStage: 'BOOKED',
  capturedDataPoints: {
    capitalThresholdMet: {
      value: true,
      confidence: 'HIGH',
      extractedFromMessageId: null,
      extractionMethod: 'fixture',
      extractedAt: new Date().toISOString()
    }
  },
  personaConfig: { minimumCapitalRequired: 1000 },
  expectedBehavior: 'systemStage is QUALIFIED or BOOKED.',
  forbiddenBehavior: 'systemStage = UNQUALIFIED.',
  assertion: {
    type: 'STAGE_CHECK',
    forbiddenStages: ['UNQUALIFIED', 'UNQUALIFIED_REDIRECT']
  }
};
