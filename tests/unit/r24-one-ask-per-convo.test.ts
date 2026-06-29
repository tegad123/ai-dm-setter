// Unit tests for R24 one-ask-per-conversation fix (Tega M3 re-open,
// 2026-06-28). When the capital question has been asked exactly once and
// the lead has not yet answered, checkR24Verification must UNBLOCK (not
// re-ask) so the AI doesn't triple-prompt for capital.
//
// Run: npx tsx --test tests/unit/r24-one-ask-per-convo.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isAcknowledgmentOnlyLeadMessage } from '../../src/lib/voice-quality-gate';

// ─── ACK_ONLY continuation phrase tests ───────────────────────────────────
// These also cover Fix 2A — continuation phrases should be classified as
// acknowledgment-only so the continuation directive fires in ai-engine.

describe('ACK_ONLY_PATTERNS — continuation phrases', () => {
  const shouldMatch = [
    'go on then',
    'go on',
    'go ahead',
    'aight go ahead',
    'aight, go ahead',
    'sure go on',
    'sure go ahead',
    'ok go on',
    'tell me',
    'tell me more',
    "i'm listening",
    'im listening',
    'keep going',
    'continue',
    'explain',
    'explain more',
    'fair enough',
    "i'm all ears",
    'im all ears',
    // original ack-only patterns must still match
    'ok',
    'okay',
    'got it',
    'cool',
    'bet',
    'aight',
    'sounds good',
    'nice',
    'perfect',
    'yeah',
    'yep',
    'yes',
    'alright',
    'sure',
    'word'
  ];

  for (const phrase of shouldMatch) {
    it(`classifies "${phrase}" as acknowledgment-only`, () => {
      assert.equal(
        isAcknowledgmentOnlyLeadMessage(phrase),
        true,
        `Expected "${phrase}" to be ack-only`
      );
    });
  }

  const shouldNotMatch = [
    'is this legit though?',
    'how does this work?',
    "i'm skeptical",
    'that sounds sus',
    'what exactly are you selling',
    'go on then, but i still have doubts'
  ];

  for (const phrase of shouldNotMatch) {
    it(`does NOT classify "${phrase}" as acknowledgment-only`, () => {
      assert.equal(
        isAcknowledgmentOnlyLeadMessage(phrase),
        false,
        `Expected "${phrase}" NOT to be ack-only`
      );
    });
  }
});
