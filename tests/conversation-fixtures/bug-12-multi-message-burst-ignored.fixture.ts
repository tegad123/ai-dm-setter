// BUG 12 — multi-message-burst-ignored
// What: Lead sent three consecutive messages — emotional + a direct
//       question — and the AI replied with zero acknowledgment of
//       any topic from the burst.
// Found: 2026-05-04 production audit.
// Fixed: getUnacknowledgedLeadBurst + acknowledgesEmotionally pair
//        in voice-quality-gate.ts.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-12-multi-message-burst-ignored',
  bug: 12,
  slug: 'multi-message-burst-ignored',
  description:
    'A burst of LEAD messages with emotional content + a question must produce a reply that acknowledges at least one topic before advancing.',
  bugFoundDate: '2026-05-04',
  fixReference:
    'getUnacknowledgedLeadBurst + acknowledgesEmotionally in voice-quality-gate.ts',
  conversationHistory: [
    {
      sender: 'AI',
      content: "what's the biggest thing you keep wrestling with on your end?"
    },
    { sender: 'LEAD', content: 'sick of the self flagellation haha' },
    { sender: 'LEAD', content: 'Rebuilding confidence man' }
  ],
  lastLeadMessage:
    'Hows your relationship with these behavioural lapses in this stage of your trading?',
  recordedAssistantReply:
    "respect bro, rebuilding confidence is the whole game. i had a stretch where i was punishing myself for every red day — what helped me was building a hard rule sheet so the next bad trade wasn't a referendum on me. what's your current rule for stop-loss?",
  expectedBehavior:
    'Reply acknowledges at least one topic from the burst (confidence, lapses, rebuild) or contains emotional acknowledgment.',
  forbiddenBehavior:
    'Zero reference to confidence, lapses, rebuild, or any topic from the burst messages.',
  assertion: {
    type: 'BURST_ACKNOWLEDGED',
    topicKeywords: [
      'confidence',
      'rebuild',
      'lapse',
      'flagellation',
      'punishing'
    ]
  }
};
