// BUG 08 — metadata-leak
// What: AI replies leaked structured metadata (key:value, JSON
//       fragments) into the user-facing message body.
// Found: 2026-05-04 production audit.
// Fixed: voice-quality-gate.ts R34 detector + surgical strip
//        (detectMetadataLeak / surgicalStripMetadataLeak).

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-08-metadata-leak',
  bug: 8,
  slug: 'metadata-leak',
  description:
    'Reply must not contain structured metadata (key:value pairs, JSON fragments) in the user-facing body.',
  bugFoundDate: '2026-05-04',
  fixReference: 'R34 in src/lib/voice-quality-gate.ts',
  conversationHistory: [
    { sender: 'AI', content: 'yo bro, what got you reaching out?' },
    { sender: 'LEAD', content: 'tryna get serious about trading this year' }
  ],
  lastLeadMessage: 'tryna get serious about trading this year',
  recordedAssistantReply:
    'respect bro. stage_confidence: 0.82 what specifically is the goal you trying to hit by EOY?',
  expectedBehavior:
    'Clean conversational reply. No key:value, no JSON fragments, no stage_confidence/quality_score metadata.',
  forbiddenBehavior:
    'Any of: stage_confidence:, quality_score:, intent:, stage:, JSON fragments {"...":"..."}',
  assertion: {
    type: 'FORBIDDEN_PHRASE_ABSENT',
    forbiddenPhrases: [
      'stage_confidence:',
      'quality_score:',
      'intent:',
      'stage:'
    ],
    forbiddenPatterns: [/\{\s*"[a-zA-Z_]+"\s*:/],
    notes:
      'detectMetadataLeak() is also invoked via FORBIDDEN_PHRASE_ABSENT path when expanded; here we use plain regex match.'
  }
};
