// BUG 11 — direct-question-ignored
// What: AI offered the downsell course; lead accepted AND asked
//       "what does it include?" — AI ignored the question and
//       jumped to a different script step.
// Found: 2026-05-04 production audit.
// Fixed: prompt-side directive to acknowledge direct questions
//        before advancing.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-11-direct-question-ignored',
  bug: 11,
  slug: 'direct-question-ignored',
  description:
    'When the lead asks a direct question alongside accepting an offer, the reply must address the question before advancing.',
  bugFoundDate: '2026-05-04',
  fixReference: 'prompt-side direct-question handling',
  conversationHistory: [
    {
      sender: 'AI',
      content:
        'got something for you — self-paced course, anthony breaks down the whole system. want it?'
    }
  ],
  lastLeadMessage: 'Yes of course. What does it include?',
  recordedAssistantReply:
    "say less — anthony covers everything: entries, risk, the playbook. here's the link: https://whop.com/daetradez-bootcamp",
  personaConfig: {
    downsellLink: 'https://whop.com/daetradez-bootcamp'
  },
  expectedBehavior:
    'Reply acknowledges what the course includes (e.g. "anthony breaks down", "covers", "playbook") before/while delivering the link.',
  forbiddenBehavior:
    'Reply ignores the question and pivots to an unrelated script step.',
  assertion: {
    type: 'TOPIC_ACKNOWLEDGED',
    topicKeywords: [
      'anthony',
      'covers',
      'breaks down',
      'playbook',
      'includes',
      'walks',
      'walkthrough'
    ]
  }
};
