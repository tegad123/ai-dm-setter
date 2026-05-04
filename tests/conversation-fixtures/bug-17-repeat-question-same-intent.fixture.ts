// BUG 17 — repeat-question-same-intent
// What: AI asked "how soon are you trying to turn that eval into a
//       payout?", lead answered with a timeline, then AI asked
//       another urgency-intent question instead of advancing.
// Found: 2026-05-04 production audit.
// Fixed: intent-fingerprint dedup in the script-state-recovery
//        prompt directives.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-17-repeat-question-same-intent',
  bug: 17,
  slug: 'repeat-question-same-intent',
  description:
    'When a prior AI message already asked an urgency intent, the next AI message must not re-ask the same intent.',
  bugFoundDate: '2026-05-04',
  fixReference: 'intent-dedup directive in prompt-side guidance',
  conversationHistory: [
    {
      sender: 'AI',
      content: 'how soon are you trying to turn that eval into a payout?'
    },
    { sender: 'LEAD', content: 'Like asap, if im optimistic' }
  ],
  lastLeadMessage: 'i will try to make it happen till june',
  recordedAssistantReply:
    'june is realistic with the right setup. you sitting on at least $1000 to start with right now?',
  expectedBehavior:
    'Advance to next script step (capital question). No urgency re-ask.',
  forbiddenBehavior:
    'Any urgency-intent re-phrasing: "how soon", "what\'s your timeline", "when are you trying to", "make this happen".',
  assertion: {
    type: 'INTENT_DEDUP_ENFORCED',
    intentMatchPatterns: [
      /\bhow soon\b/i,
      /\bwhat'?s your timeline\b/i,
      /\bwhen are you (trying|looking) to\b/i,
      /\bmake (this|it) happen\b/i,
      /\bturn (that|the|your) eval into a payout\b/i
    ]
  }
};
