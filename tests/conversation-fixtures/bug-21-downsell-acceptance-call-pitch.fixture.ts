// BUG 21 — downsell-acceptance-call-pitch
// What: Lead is below threshold ($5 vs $1000 minimum). AI correctly
//       pitched the $497 self-paced downsell. Lead said "Yes yes" to
//       confirm interest. AI's NEXT bubble pitched a call with
//       Anthony — looping the unqualified lead back into the
//       qualified-lead pipeline (call → coach → main mentorship)
//       they've already been disqualified from.
//
//       Distinct from bug-13 (initial routing) and bug-15 (acceptance
//       loopback): bug-21 is the specific shape of "downsell pitched +
//       lead accepted + AI's reply pitches a call instead of
//       delivering the course URL".
// Found: 2026-05-05 production (@shepherdgushe.zw, $5 capital).
// Fixed: R40 in ai-prompts.ts + r40_call_pitch_to_unqualified_after_
//        downsell_accept hardfail in voice-quality-gate.ts + R40
//        regen directive in ai-engine.ts.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-21-downsell-acceptance-call-pitch',
  bug: 21,
  slug: 'downsell-acceptance-call-pitch',
  description:
    'After lead affirms downsell interest, AI must deliver the course URL — never pitch a call. Calls are reserved for QUALIFIED leads only.',
  bugFoundDate: '2026-05-05',
  fixReference:
    'R40 in ai-prompts.ts + r40_call_pitch_to_unqualified_after_downsell_accept gate in voice-quality-gate.ts',
  conversationHistory: [
    {
      sender: 'AI',
      content: 'how much capital you got to start with right now bro?'
    },
    { sender: 'LEAD', content: '$5' },
    {
      sender: 'AI',
      content:
        "damn bro, $5 is way too low for the main mentorship. i got a self-paced course that breaks the whole session liquidity model down step by step for $497 one time. you can learn it on your own while you build up. does that sound like something you'd be down for?"
    }
  ],
  lastLeadMessage: 'Yes yes',
  capturedDataPoints: {
    capitalThresholdMet: { value: false },
    downsellInterestConfirmed: { value: true }
  },
  // The recorded reply is the FIXED behavior post-R40: brief
  // acknowledgment + the downsell URL inline. No call CTA.
  recordedAssistantReply:
    "bet bro, that's the move. here's the link: https://whop.com/daetradez-bootcamp\ntake your time with it, hit me up when you've worked through it",
  personaConfig: {
    downsellLink: 'https://whop.com/daetradez-bootcamp',
    bookingTypeformUrl: 'https://daetradez.typeform.com/apply',
    minimumCapitalRequired: 1000
  },
  expectedBehavior:
    'Acknowledge acceptance + deliver downsell URL inline. No call CTA, no closer name.',
  forbiddenBehavior:
    'Pitches a call with the closer / "right hand man" / "hop on a quick call" / mentions Anthony / proposes a chat or break-down session.',
  assertion: {
    type: 'FORBIDDEN_PHRASE_ABSENT',
    forbiddenPatterns: [
      /hop on (a )?(quick )?(call|chat)/i,
      /jump on (a )?(quick )?(call|chat)/i,
      /get on (a )?(quick )?(call|chat)/i,
      /\bquick (call|chat)\b/i,
      /right hand man/i,
      /\banthony so he can\b/i,
      /\bbreak (it|that|everything) down\b/i,
      /\bwanna jump on\b/i,
      /\bwould you be (down|open) for a call\b/i
    ],
    notes:
      'Mirrors the regex shape used by the r40_call_pitch_to_unqualified_after_downsell_accept gate. Drift between this assertion and the gate regex would let a regression slip through both.'
  },
  additionalAssertions: [
    {
      type: 'ACCEPTANCE_HONORED',
      acceptanceMustDeliverField: 'downsellLink',
      notes:
        'R40 second arm: acceptance + no URL triggers r40_downsell_accepted_missing_url hardfail. Reply must contain the downsell URL.'
    }
  ]
};
