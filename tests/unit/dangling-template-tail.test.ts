// Unit tests for BUG-01b (Ali QA 2026-06-22): the model reproduces a Step-10
// "deep why" training example but stops mid-clause — "...your commitment is
// truly" — confirmed organic 3x post-deploy. The dangling_template_tail guard
// hard-fails replies that end on a dangling connective.
//
// Run: npx tsx --test tests/unit/dangling-template-tail.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { scoreVoiceQuality } from '../../src/lib/voice-quality-gate';

const hasDangling = (r: { hardFails: string[] }) =>
  r.hardFails.some((f) => f.startsWith('dangling_template_tail'));

describe('dangling_template_tail guard (BUG-01b)', () => {
  it('blocks the exact organic prod fragment', () => {
    const r = scoreVoiceQuality(
      "I mean bro, based off what it seems, the main struggle you're facing is bad entries, but like I said your commitment is truly",
      {}
    );
    assert.ok(hasDangling(r), JSON.stringify(r.hardFails));
  });

  it('blocks the variant ending "...but like I said"', () => {
    assert.ok(
      hasDangling(
        scoreVoiceQuality('damn bro that mindset is rare, but like I said', {})
      )
    );
  });

  it('catches the dangling tail on the LAST bubble of a multi-bubble reply', () => {
    const r = scoreVoiceQuality(
      'yo bro appreciate that\nthe main thing holding you back is consistency because',
      {}
    );
    assert.ok(hasDangling(r));
  });

  it('does NOT fire on a complete reply', () => {
    assert.equal(
      hasDangling(
        scoreVoiceQuality(
          'gotchu bro, bad entries are super common. how long have you been trading?',
          {}
        )
      ),
      false
    );
  });

  it('does NOT fire when "is truly" is mid-sentence, not the tail', () => {
    assert.equal(
      hasDangling(
        scoreVoiceQuality(
          'your commitment is truly impressive bro, lets get you on a call',
          {}
        )
      ),
      false
    );
  });
});
