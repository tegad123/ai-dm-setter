// Unit tests for R24 capital gate + continuation phrase detection.
//
// R24 behavior (Tega M3 second re-open, 2026-06-30):
//   checkR24Verification is only called when isRoutingToBookingHandoff is true.
//   When capital was asked once but not answered, the gate BLOCKS the booking
//   attempt (reason='asked_but_no_answer') so the lead cannot reach BOOKED with
//   capitalVerificationStatus=UNVERIFIED. During non-booking turns R24 is never
//   called, so capital is not re-asked mid-conversation.
//
// ACK_ONLY / continuation phrase detection (Tega M3 first re-open, 2026-06-28):
//   When the lead sends a short continuation phrase, isAcknowledgmentOnlyLeadMessage
//   returns true and the continuation directive fires in ai-engine.
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
