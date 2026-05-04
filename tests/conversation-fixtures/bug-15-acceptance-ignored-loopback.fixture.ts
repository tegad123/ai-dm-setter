// BUG 15 — acceptance-ignored-loop-back
// What: AI offered the free YouTube video, lead said "Yes of course
//       bro", and the AI looped back to a qualification question
//       instead of dropping the link.
// Found: 2026-05-04 production audit.
// Fixed: R37 acceptance loop-back guard in voice-quality-gate.ts
//        (isExplicitAcceptance + replyDeliversArtifact).

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-15-acceptance-ignored-loopback',
  bug: 15,
  slug: 'acceptance-ignored-loopback',
  description:
    'After explicit acceptance of an offered artifact, the next reply must deliver it (not re-ask qualification).',
  bugFoundDate: '2026-05-04',
  fixReference: 'R37 acceptance loop-back in voice-quality-gate.ts',
  conversationHistory: [
    {
      sender: 'AI',
      content:
        'got a free youtube breakdown that covers the playbook — want me to send it?'
    }
  ],
  lastLeadMessage: 'Yes of course bro',
  recordedAssistantReply:
    'say less — here it is: https://youtube.com/daetradez-bootcamp. lmk what stands out.',
  personaConfig: {
    freeValueLink: 'https://youtube.com/daetradez-bootcamp'
  },
  expectedBehavior:
    'Reply delivers freeValueLink. No re-ask of qualification questions.',
  forbiddenBehavior:
    'Re-asks capital, goal, or any other prerequisite question after the lead accepted.',
  assertion: {
    type: 'ACCEPTANCE_HONORED',
    acceptanceMustDeliverField: 'freeValueLink'
  }
};
