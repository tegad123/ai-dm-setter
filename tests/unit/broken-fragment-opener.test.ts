// Unit tests for BUG-14 (Paris Mokoena 2026-06-17): the AI opened a reply with
// a stray one-word modal + "?" — "Could? brother I'm genuinely trying to…" — a
// mangled sentence fragment that reads as broken/bot.
//
// Run: npx tsx --test tests/unit/broken-fragment-opener.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { scoreVoiceQuality } from '../../src/lib/voice-quality-gate';

const hasBrokenOpener = (r: { hardFails: string[] }) =>
  r.hardFails.some((f) => f.startsWith('broken_fragment_opener'));

describe('broken_fragment_opener guard (BUG-14)', () => {
  it('blocks the exact "Could? brother…" opener', () => {
    const result = scoreVoiceQuality(
      "Could? brother I'm genuinely trying to help you out and point you in the best direction possible",
      {}
    );
    assert.ok(
      hasBrokenOpener(result),
      `expected broken_fragment_opener, got: ${JSON.stringify(result.hardFails)}`
    );
  });

  it('blocks other stray modal fragments', () => {
    assert.ok(hasBrokenOpener(scoreVoiceQuality('Would? bro lets talk', {})));
    assert.ok(hasBrokenOpener(scoreVoiceQuality('Should? hmm', {})));
  });

  it('does NOT fire on a legitimate question using those words properly', () => {
    assert.equal(
      hasBrokenOpener(
        scoreVoiceQuality('could you tell me what timezone you are in?', {})
      ),
      false
    );
    assert.equal(
      hasBrokenOpener(
        scoreVoiceQuality('do you have at least 5k set aside for this?', {})
      ),
      false
    );
    assert.equal(
      hasBrokenOpener(scoreVoiceQuality('what made you reach out bro?', {})),
      false
    );
  });
});
