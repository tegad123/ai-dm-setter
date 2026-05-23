import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { detectMetadataLeak } from '../../src/lib/voice-quality-gate';

// 2026-05-23: lead received a literal "[your offer]" template placeholder.
// The bracket guard was ALL-CAPS only; broadened to catch lowercase/mixed
// placeholders too. A lead must never receive an unfilled [bracket] token.

describe('detectMetadataLeak — bracket placeholders', () => {
  const leaks = [
    'Hey! Thanks for reaching out 🙌 What made you interested in [your offer]?',
    'What is your [name] and goal?',
    'tell me about [their goal] bro',
    '[BOOKING LINK] here', // ALL-CAPS still caught
    'check [your dashboard] later'
  ];
  for (const reply of leaks) {
    it(`flags placeholder: "${reply.slice(0, 40)}…"`, () => {
      assert.equal(detectMetadataLeak(reply).leak, true);
    });
  }

  const clean = [
    'so you trade futures? whats your edge',
    'lets hop on a call tomorrow at 9:30',
    'ok bet, lets do it',
    'been trading 2 years, blew 3 accounts fr'
  ];
  for (const reply of clean) {
    it(`allows clean copy: "${reply.slice(0, 40)}…"`, () => {
      assert.equal(detectMetadataLeak(reply).leak, false);
    });
  }
});
