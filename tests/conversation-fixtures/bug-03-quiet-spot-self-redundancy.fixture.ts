// BUG 03 — quiet-spot-self-redundancy
// What: AI repeated "make sure you're in a quiet spot" / "be prepared"
//       in a follow-up message after already delivering call logistics.
// Found: 2026-05-04 production audit.
// Fixed: redundancy gate (callLogisticsAlreadyDeliveredInRecentHistory)
//        suppresses re-emit of logistics when prior AI msg already
//        delivered them.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-03-quiet-spot-self-redundancy',
  bug: 3,
  slug: 'quiet-spot-self-redundancy',
  description:
    'After AI already delivered call logistics in the prior turn, follow-ups must NOT re-emit "quiet spot" / "be prepared".',
  bugFoundDate: '2026-05-04',
  fixReference:
    'callLogisticsAlreadyDeliveredInRecentHistory in voice-quality-gate.ts',
  conversationHistory: [
    {
      sender: 'AI',
      content:
        "you're locked in for monday at 3pm cst. make sure you're in a quiet spot, headphones if you got em, and bring questions about your current setup."
    },
    { sender: 'LEAD', content: 'cool will do' }
  ],
  lastLeadMessage: 'Sounds good bro',
  recordedAssistantReply: 'appreciate it bro. talk monday.',
  expectedBehavior:
    'Brief acknowledgment only, max ~12 words. No re-emit of logistics.',
  forbiddenBehavior:
    'Any message containing "quiet spot", "quiet area", "be prepared", or restating call logistics already delivered.',
  assertion: {
    type: 'FORBIDDEN_PHRASE_ABSENT',
    forbiddenPhrases: [
      'quiet spot',
      'quiet area',
      'be prepared',
      'headphones',
      'bring questions'
    ]
  }
};
