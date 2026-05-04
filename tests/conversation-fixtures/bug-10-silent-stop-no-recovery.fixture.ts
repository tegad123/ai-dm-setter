// BUG 10 — silent-stop-no-recovery
// What: After the lead gave a hedging answer, no AI response was
//       generated and the conversation went dark. Heartbeat
//       recovery did not fire.
// Found: 2026-05-04 production audit.
// Fixed: silent-stop heartbeat recovery loop on awaitingAiResponse.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-10-silent-stop-no-recovery',
  bug: 10,
  slug: 'silent-stop-no-recovery',
  description:
    'Hedging lead replies must still produce a generated response within the heartbeat window.',
  bugFoundDate: '2026-05-04',
  fixReference: 'silent-stop heartbeat recovery in webhook-processor.ts',
  conversationHistory: [
    {
      sender: 'AI',
      content: 'you sitting on at least $1000 to start with right now?'
    }
  ],
  lastLeadMessage: 'It could be',
  recordedAssistantReply:
    "no rush bro — when you say could be, you mean you got it but you're rationing, or you don't have it yet?",
  expectedBehavior: 'AI generates a clarifying response. No silence.',
  forbiddenBehavior: 'No response generated; conversation stays dark.',
  assertion: { type: 'RESPONSE_GENERATED' }
};
