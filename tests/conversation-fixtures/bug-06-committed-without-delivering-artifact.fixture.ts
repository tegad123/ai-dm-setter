// BUG 06 — committed-without-delivering-artifact
// What: Lead accepted the downsell. AI replied with "once you're in,
//       go through it" but never included the actual link.
// Found: 2026-05-04 production audit.
// Fixed: aiPromisedArtifact / replyDeliversArtifact pairing in
//        voice-quality-gate.ts.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-06-committed-without-delivering-artifact',
  bug: 6,
  slug: 'committed-without-delivering-artifact',
  description:
    'When the AI commits to a delivery ("once you’re in", "go through it"), the same message must also contain the artifact URL.',
  bugFoundDate: '2026-05-04',
  fixReference: 'replyDeliversArtifact gate in voice-quality-gate.ts',
  conversationHistory: [
    {
      sender: 'AI',
      content:
        'got the bootcamp pitch ready — self-paced, anthony walks the playbook. want me to send it?'
    }
  ],
  lastLeadMessage: 'Yes bro',
  recordedAssistantReply:
    "say less — here's the link: https://whop.com/daetradez-bootcamp. once you're in, go through module 1 and hit me with what stands out.",
  personaConfig: {
    downsellLink: 'https://whop.com/daetradez-bootcamp'
  },
  expectedBehavior:
    'Reply contains the persona-configured downsellLink in the same message as the commit language.',
  forbiddenBehavior:
    'Commit language ("once you\'re in", "go through it") without the URL on the same turn.',
  assertion: {
    type: 'REQUIRED_URL_PRESENT',
    requiredUrlField: 'downsellLink'
  }
};
