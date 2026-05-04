// BUG 05 — binary-yes-capital-not-captured
// What: AI asked "do you have at least $1000?". Lead said "Yea I
//       have". Pipeline failed to capture capitalThresholdMet=true,
//       so the next turn re-asked or escalated to a human.
// Found: 2026-05-04 production audit.
// Fixed: extractCapitalDataPoints recognises binary affirmative
//        when AI's prior question was a capital threshold question.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-05-binary-yes-capital-not-captured',
  bug: 5,
  slug: 'binary-yes-capital-not-captured',
  description:
    'After AI asks a binary capital threshold question, lead’s "Yea I have" must capture capitalThresholdMet=true.',
  bugFoundDate: '2026-05-04',
  fixReference: 'extractCapitalDataPoints in script-state-recovery.ts',
  conversationHistory: [
    {
      sender: 'AI',
      content: 'real quick — you sitting on at least $1000 to start with?'
    }
  ],
  lastLeadMessage: 'Yea I have',
  recordedAssistantReply:
    'perfect. how soon you trying to start trading live with that?',
  capitalAsked: true,
  personaConfig: { minimumCapitalRequired: 1000 },
  expectedBehavior:
    'capturedDataPoints.capitalThresholdMet === true and conversation advances.',
  forbiddenBehavior:
    'Re-ask capital question, escalate to human, or emit a stall.',
  assertion: {
    type: 'STAGE_ADVANCE',
    forbiddenPhrases: [
      'how much capital',
      'at least $1000',
      'sitting on',
      'let me check with the team'
    ]
  }
};
