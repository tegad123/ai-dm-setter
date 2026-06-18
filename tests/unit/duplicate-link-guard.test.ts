// Unit tests for BUG-13 (Paris Mokoena 2026-06-17): the AI re-sent the same
// youtube.com/@DAETRADEZ link ~97 min apart. The duplicate_link gate blocks a
// reply containing a URL already sent earlier in the conversation.
//
// Run: npx tsx --test tests/unit/duplicate-link-guard.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { scoreVoiceQuality } from '../../src/lib/voice-quality-gate';

const hasDuplicateLink = (r: { hardFails: string[] }) =>
  r.hardFails.some((f) => f.startsWith('duplicate_link'));

describe('duplicate_link guard (BUG-13)', () => {
  it('blocks re-sending a link already sent earlier', () => {
    const result = scoreVoiceQuality(
      'yeah bro check out my youtube https://www.youtube.com/@daetradez',
      { alreadySentUrls: ['https://www.youtube.com/@daetradez'] }
    );
    assert.ok(
      hasDuplicateLink(result),
      `expected duplicate_link, got: ${JSON.stringify(result.hardFails)}`
    );
  });

  it('is case-insensitive and tolerant of trailing punctuation', () => {
    const result = scoreVoiceQuality(
      'here it is again: https://www.YouTube.com/@DAETRADEZ.',
      { alreadySentUrls: ['https://www.youtube.com/@daetradez'] }
    );
    assert.ok(hasDuplicateLink(result));
  });

  it('does NOT fire for a different link', () => {
    const result = scoreVoiceQuality(
      'check this one https://calendly.com/daetradez/call',
      { alreadySentUrls: ['https://www.youtube.com/@daetradez'] }
    );
    assert.equal(hasDuplicateLink(result), false);
  });

  it('does NOT fire when no links were sent before', () => {
    const result = scoreVoiceQuality(
      'check out my youtube https://www.youtube.com/@daetradez',
      { alreadySentUrls: [] }
    );
    assert.equal(hasDuplicateLink(result), false);
  });
});
