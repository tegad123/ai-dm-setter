// Unit tests for the BUG-08 image performance-claim guard in scoreVoiceQuality
// (Paris Mokoena 2026-06-17). The lead sent a trading screenshot and the AI
// replied "damn bro that's a solid result fr" — asserting a win it can't verify
// from a vague auto-description. The guard blocks unqualified result-judgments
// after a lead image.
//
// Run: npx tsx --test tests/unit/image-result-fabrication.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { scoreVoiceQuality } from '../../src/lib/voice-quality-gate';

const hasFabricatedResult = (r: { hardFails: string[] }) =>
  r.hardFails.some((f) => f.startsWith('fabricated_image_result'));

describe('fabricated_image_result guard (BUG-08)', () => {
  it('blocks "damn bro that\'s a solid result fr" after a lead image', () => {
    const result = scoreVoiceQuality("damn bro that's a solid result fr", {
      previousLeadHadImage: true
    });
    assert.ok(
      hasFabricatedResult(result),
      `expected fabricated_image_result, got: ${JSON.stringify(result.hardFails)}`
    );
  });

  it('blocks "nice win bro, what was the setup"', () => {
    const result = scoreVoiceQuality('nice win bro, what was the setup', {
      previousLeadHadImage: true
    });
    assert.ok(hasFabricatedResult(result));
  });

  it('does NOT fire when there was no preceding image', () => {
    const result = scoreVoiceQuality("damn bro that's a solid result fr", {
      previousLeadHadImage: false
    });
    assert.equal(hasFabricatedResult(result), false);
  });

  it('allows a neutral acknowledgment + question after an image', () => {
    const result = scoreVoiceQuality(
      "appreciate you sharing bro, what's that showing on your end?",
      { previousLeadHadImage: true }
    );
    assert.equal(hasFabricatedResult(result), false);
  });
});
