// BUG 07 — hallucinated-url
// What: At downsell-delivery time the AI emitted a URL that was NOT
//       on the persona's configured URL list (e.g. anthonyworld.com/course).
// Found: 2026-05-04 production audit.
// Fixed: prompt-side persona URL allowlist + post-LLM URL allowlist gate.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-07-hallucinated-url',
  bug: 7,
  slug: 'hallucinated-url',
  description:
    'When delivering the downsell, the only URL allowed is the persona-configured downsellLink. No hallucinated *.com/course links.',
  bugFoundDate: '2026-05-04',
  fixReference: 'persona URL allowlist enforcement',
  conversationHistory: [
    { sender: 'AI', content: 'how much capital you working with right now?' },
    { sender: 'LEAD', content: 'just a few hundred bro, like maybe $400' },
    {
      sender: 'AI',
      content:
        'all good — got something perfect for that range. self-paced course, breaks down the whole system. want it?'
    }
  ],
  lastLeadMessage: 'Yes I want that',
  recordedAssistantReply:
    "say less. here's the link: https://whop.com/daetradez-bootcamp — go through it, hit me when you finish module 1.",
  personaConfig: {
    downsellLink: 'https://whop.com/daetradez-bootcamp',
    freeValueLink: 'https://youtube.com/daetradez-bootcamp',
    bookingTypeformUrl: 'https://daetradez.typeform.com/apply'
  },
  expectedBehavior:
    'Reply contains only the persona-configured downsellLink. No other URL.',
  forbiddenBehavior:
    'Any URL not in the persona allowlist (e.g. *.com/course made up by the LLM).',
  assertion: {
    type: 'URL_ALLOWLIST_CHECK',
    allowedUrlFields: ['downsellLink', 'freeValueLink', 'bookingTypeformUrl']
  }
};
