// BUG 14 — soft-pitch-before-capital
// What: With urgency answered but capital NOT yet asked, the AI
//       jumped to the soft pitch ("call with anthony", "gameplan")
//       before capturing capital.
// Found: 2026-05-04 production audit.
// Fixed: validateSoftPitchPrerequisites in script-state-recovery.ts.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-14-soft-pitch-before-capital',
  bug: 14,
  slug: 'soft-pitch-before-capital',
  description:
    'The soft pitch (call/gameplan) must not fire before capital has been captured.',
  bugFoundDate: '2026-05-04',
  fixReference: 'validateSoftPitchPrerequisites in script-state-recovery.ts',
  conversationHistory: [
    { sender: 'AI', content: 'whats the goal you trying to hit by EOY?' },
    { sender: 'LEAD', content: 'replace my 9-5, full time trading' },
    {
      sender: 'AI',
      content: 'love that. how soon are you trying to make it happen?'
    }
  ],
  lastLeadMessage: 'As soon as possible',
  recordedAssistantReply:
    'love the urgency. real quick — you got at least $1000 to start with right now?',
  capturedDataPoints: {},
  expectedBehavior:
    'AI asks the capital question before offering the call/gameplan.',
  forbiddenBehavior:
    'AI offers "call with anthony", "gameplan", "book", or any pitch language pre-capital.',
  assertion: {
    type: 'PREREQUISITE_GATE_ENFORCED',
    notes:
      'PREREQUISITE_GATE_ENFORCED uses containsCallPitch / containsCallOrBookingAdvancement to detect a fired pitch.'
  }
};
