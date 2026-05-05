// BUG 22 — post-capital non-numeric pivot
// What: AI asked the capital question, lead answered with a broker
//       non-answer, then the regenerated reply pivoted to urgency.
//       That skipped the dollar-figure clarification and drifted the
//       funnel state.
// Found: 2026-05-05 production (@mini_slzz).
// Fixed: R24 prompt wording + Fix B post_capital_non_numeric_pivot
//        detector + Fix B regen directive.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-22-post-capital-non-numeric-pivot',
  bug: 22,
  slug: 'post-capital-non-numeric-pivot',
  description:
    'After a capital question, a non-numeric broker answer must be clarified with a dollar-figure question, not an urgency pivot.',
  bugFoundDate: '2026-05-05',
  fixReference:
    'R24 unclear-answer prompt + post_capital_non_numeric_pivot Fix B detector',
  conversationHistory: [
    {
      sender: 'AI',
      content:
        "real quick, what's your capital situation like for the markets right now?"
    }
  ],
  lastLeadMessage: 'The broker',
  blockedDraftReply: 'how soon are you trying to make this happen?',
  blockedDraftStage: 'URGENCY',
  recordedAssistantReply:
    'my bad bro, I mean cash on hand for trading + education combined, roughly how much you working with?',
  systemStage: 'CAPITAL_QUALIFICATION',
  currentScriptStep: 8,
  personaConfig: {
    minimumCapitalRequired: 1000
  },
  expectedBehavior:
    'AI asks one varied clarifier that pins a dollar figure and remains in CAPITAL_QUALIFICATION.',
  forbiddenBehavior:
    'AI asks urgency/timeline phrasing like "how soon are you trying to make this happen?" after the broker non-answer.',
  assertion: {
    type: 'POST_CAPITAL_CLARIFIER_ENFORCED',
    notes:
      'Asserts blocked urgency draft maps to the Fix B audit reason and the fixed reply is a dollar-figure clarifier, not an urgency pivot.'
  }
};
