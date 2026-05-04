// BUG 18 - manychat-stage-skip
// What: ManyChat-sourced leads accepted outbound content, but the AI
//       treated that as soft-pitch acceptance and jumped to capital
//       before discovery/work background or income goal happened.
// Found: 2026-05-04 production audit.
// Fixed: ManyChat outbound-continuation prompt directive plus
//        manychat_early_capital_question hardfail in voice-quality-gate.ts.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-18-manychat-stage-skip',
  bug: 18,
  slug: 'manychat-stage-skip',
  description:
    'ManyChat opener acceptance is opening engagement, not permission to ask capital before discovery.',
  bugFoundDate: '2026-05-04',
  fixReference:
    'ManyChat outbound continuation directive + early-capital hardfail',
  source: 'MANYCHAT',
  aiMessageCount: 1,
  capturedDataPoints: {},
  conversationHistory: [
    {
      sender: 'AI',
      content: 'perfect this gonna make you dangerous'
    }
  ],
  lastLeadMessage: 'Yes send it over!',
  blockedDraftReply: 'you got at least $1000 in capital ready to start?',
  recordedAssistantReply:
    "sick, since you wanted the Session Liquidity Model, what's your trading background right now, been at it for a while or pretty new?",
  personaConfig: {
    downsellLink: 'https://whop.com/session-liquidity-model',
    minimumCapitalRequired: 1000
  },
  expectedBehavior:
    'Block early capital on ManyChat handoff and continue with a discovery question about trading background or experience.',
  forbiddenBehavior:
    'Ask any capital/budget question as the first or second AI message on a ManyChat-sourced conversation.',
  assertion: {
    type: 'MANYCHAT_STAGE_SKIP_BLOCKED'
  }
};
