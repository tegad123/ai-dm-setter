// BUG 23 — unsend-correction-ai-continues
// What: After an operator unsends an AI message and replaces it with a
//       manual correction within 2 minutes, the AI must:
//         1. Treat the unsent message as if it never existed.
//         2. Continue from the operator's correction as the canonical
//            prior turn.
//         3. NOT reference, apologise for, or recap the unsent content.
//         4. NOT auto-pause aiActive — the toggle stays whatever the
//            operator set it to.
//
//       The conversationHistory below shows ONLY the messages the AI
//       sees (post-deletedAt filter). The unsent message is intentionally
//       absent — the AI prompt builder never receives it.
//
//       Scenario: AI ran with a stale frame and asked the lead "you
//       still in school?" after the lead had already said they
//       graduated. Operator unsent and replaced with a forward-looking
//       capital question. Lead replied. The AI must continue the
//       capital qualification, NOT walk back to school.
// Found: 2026-05-06 (UX spec for unsend + correction flow)
// Fixed: deletedAt filter in webhook-processor scheduleAIReply +
//        operatorCorrectionDirective in ai-engine.ts when the most
//        recent setter message has isHumanCorrection=true.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-23-unsend-correction-ai-continues',
  bug: 23,
  slug: 'unsend-correction-ai-continues',
  description:
    'After operator unsends an AI message and sends a correction, the AI must build on the correction and never reference the unsent content.',
  bugFoundDate: '2026-05-06',
  fixReference:
    'deletedAt filter in webhook-processor scheduleAIReply + operatorCorrectionDirective in ai-engine.ts',
  conversationHistory: [
    {
      sender: 'AI',
      content: 'how long you been trading bro?'
    },
    {
      sender: 'LEAD',
      content: '2 years on and off, finished college last summer'
    },
    // The AI's "you still in school?" message was UNSENT here. It does
    // NOT appear in the history because the prod system filters
    // deletedAt at the DB layer. The next message is the operator's
    // correction (sender=AI in fixture, but in prod sender='HUMAN' with
    // isHumanCorrection=true — same prompt-side effect either way for
    // this fixture's purpose: the AI sees this as the most recent
    // setter turn).
    {
      sender: 'AI',
      content:
        'love that bro, college done means you got time to lock in. how much capital you got set aside for the markets right now?'
    }
  ],
  lastLeadMessage: 'about 2k saved up, ready to deploy',
  capitalAsked: true,
  // Post-fix expected reply: continues from the operator's correction,
  // acknowledges $2k as above-threshold, moves toward soft-pitch /
  // booking. No school references, no apology, no echo of the unsent
  // turn. The fixture asserts the absence of the forbidden patterns
  // against this recorded reply.
  recordedAssistantReply:
    'bet bro, 2k is solid for the strategies we run. when you say ready to deploy — you mean tomorrow ready, or want a few weeks to get the system tight first?',
  personaConfig: {
    minimumCapitalRequired: 1000
  },
  expectedBehavior:
    "Acknowledge the lead's $2k as above-threshold capital and progress qualification (toward soft pitch / booking). Do NOT regress to school questions or apologise for the prior message.",
  forbiddenBehavior:
    'AI references school/college/student status, asks "are you still in school", apologises for a prior message, or otherwise re-opens the slot the operator already corrected past.',
  assertion: {
    type: 'FORBIDDEN_PHRASE_ABSENT',
    forbiddenPatterns: [
      /still in school/i,
      /you in school/i,
      /are you a student/i,
      /(my|the) (last|previous|earlier) message/i,
      /(sorry|apolog).*(message|earlier|before)/i,
      /ignore (my|that)( last| previous)? message/i
    ],
    notes:
      'These patterns would indicate the AI is echoing or apologising for the unsent message, or has reverted to the slot the operator corrected past.'
  }
};
