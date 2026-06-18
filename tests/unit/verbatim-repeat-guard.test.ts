// Unit tests for the generic verbatim_repeat hard-fail guard in
// scoreVoiceQuality (BUG-01, Paris Mokoena 2026-06-17). The looping line
// "I mean bro... the main struggle you're facing is greediness and lack of
// patience..." was generated VERBATIM 4 times across one conversation at the
// Call-Proposal stage and slipped past every specific repeat detector.
//
// Run: npx tsx --test tests/unit/verbatim-repeat-guard.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { scoreVoiceQuality } from '../../src/lib/voice-quality-gate';

const PARIS_LOOP_LINE =
  "I mean bro, based off what it seems, the main struggle you're facing is greediness and lack of patience, but like I said your commitment is truly something else, you tryna lock in a call to fix that?";

const hasVerbatimRepeat = (r: { hardFails: string[] }) =>
  r.hardFails.some((f) => f.startsWith('verbatim_repeat'));

describe('verbatim_repeat guard (BUG-01)', () => {
  it('hard-fails when the reply is identical to a recent AI message', () => {
    const result = scoreVoiceQuality(PARIS_LOOP_LINE, {
      recentAIMessages: ['some earlier unrelated turn', PARIS_LOOP_LINE]
    });
    assert.ok(
      hasVerbatimRepeat(result),
      `expected verbatim_repeat hard-fail, got: ${JSON.stringify(result.hardFails)}`
    );
  });

  it('catches a near-verbatim repeat several turns back (window > 3)', () => {
    const result = scoreVoiceQuality(PARIS_LOOP_LINE, {
      recentAIMessages: [
        PARIS_LOOP_LINE, // 5 turns ago
        'turn b',
        'turn c',
        'turn d',
        'turn e'
      ]
    });
    assert.ok(hasVerbatimRepeat(result));
  });

  it('does NOT fire for a genuinely different reply', () => {
    const result = scoreVoiceQuality(
      'yeah for sure bro, what pair you strongest on out of the usd ones?',
      {
        recentAIMessages: [
          PARIS_LOOP_LINE,
          'another different message entirely'
        ]
      }
    );
    assert.equal(hasVerbatimRepeat(result), false);
  });

  it('does NOT false-positive on short acks (handled by repeated_opener instead)', () => {
    const result = scoreVoiceQuality('gotchu bro', {
      recentAIMessages: ['gotchu bro']
    });
    // Short messages (< 8 content tokens) are excluded from the verbatim guard.
    assert.equal(hasVerbatimRepeat(result), false);
  });
});
