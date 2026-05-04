// BUG 09 — premature-unqualified-religious-framing
// What: A "trusting the lord's timing" reply during qualification
//       caused the stage classifier to flip the lead to UNQUALIFIED
//       and the AI stopped responding. Religious framing is not a
//       disqualifier on its own.
// Found: 2026-05-04 production audit.
// Fixed: PREMATURE_UNQUALIFIED_BLOCKED guard in
//        script-state-recovery.ts (capital must be asked + answered
//        before flipping to UNQUALIFIED).

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-09-premature-unqualified-religious-framing',
  bug: 9,
  slug: 'premature-unqualified-religious-framing',
  description:
    'Religious framing pre-capital must not flip stage to UNQUALIFIED. Stage stays in qualifying flow; AI continues.',
  bugFoundDate: '2026-05-04',
  fixReference: 'PREMATURE_UNQUALIFIED_BLOCKED in script-state-recovery.ts',
  conversationHistory: [
    { sender: 'AI', content: 'whats the goal you trying to hit by EOY bro?' },
    {
      sender: 'LEAD',
      content: 'replace my 9-5, do this full time, take care of my mom'
    },
    {
      sender: 'AI',
      content: 'love that. how soon you trying to make it happen?'
    }
  ],
  lastLeadMessage: "But I'm also trusting the lords timing",
  recordedAssistantReply:
    "respect that bro. lord's timing is real. real quick — you got at least $1000 to start with right now?",
  systemStage: 'QUALIFYING',
  expectedBehavior:
    'Stage remains QUALIFYING. AI continues — advances to capital question.',
  forbiddenBehavior:
    'stage = UNQUALIFIED, outcome = UNQUALIFIED_REDIRECT, AI stops responding.',
  assertion: {
    type: 'STAGE_CHECK',
    forbiddenStages: ['UNQUALIFIED', 'UNQUALIFIED_REDIRECT']
  }
};
