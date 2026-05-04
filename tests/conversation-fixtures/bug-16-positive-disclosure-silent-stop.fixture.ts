// BUG 16 — positive-disclosure-silent-stop
// What: Lead made a positive disclosure ("paper trade account, part
//       1 of the plan in progress") and the AI went silent —
//       failed to acknowledge + advance.
// Found: 2026-05-04 production audit.
// Fixed: positive-acknowledgment recovery in script-state-recovery.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-16-positive-disclosure-silent-stop',
  bug: 16,
  slug: 'positive-disclosure-silent-stop',
  description:
    'Positive disclosures (existing paper trade, prior progress) must produce an acknowledgment + advance.',
  bugFoundDate: '2026-05-04',
  fixReference: 'positive-disclosure handling + silent-stop heartbeat recovery',
  conversationHistory: [
    {
      sender: 'AI',
      content: 'where you at right now with your trading? paper or live?'
    }
  ],
  lastLeadMessage:
    'Im already on a paper trade account so part 1 of the plan in progress',
  recordedAssistantReply:
    "respect bro — paper trading is the right move. how's it going so far? you sitting on at least $1000 ready to go live when the numbers say so?",
  expectedBehavior:
    'AI acknowledges the positive disclosure and advances (e.g. capital bridge or next step).',
  forbiddenBehavior: 'No response generated.',
  assertion: {
    type: 'POSITIVE_ACKNOWLEDGED',
    topicKeywords: [
      'respect',
      'love',
      'right move',
      'good move',
      "that's solid",
      'paper'
    ]
  }
};
