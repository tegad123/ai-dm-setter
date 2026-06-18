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

// BUG-03 (Paris Mokoena 2026-06-17): the booking-info prompt's example slot
// list reached the lead verbatim — "just missing your specific missing info
// e.g. "email" / "timezone" / "phone number"." None of the field:value /
// bracket / JSON patterns matched it. Added quoted-field-list + scaffolding
// phrase patterns.
describe('detectMetadataLeak — prompt-scaffolding field lists (BUG-03)', () => {
  const leaks = [
    'Appreciate that bro, just missing your specific missing info e.g. "email" / "timezone" / "phone number".',
    'just need your "email" / "phone number" to lock it in',
    'missing your specific missing info bro',
    'e.g. "full name" / "email" so i can set it up'
  ];
  for (const reply of leaks) {
    it(`flags scaffolding leak: "${reply.slice(0, 45)}…"`, () => {
      assert.equal(detectMetadataLeak(reply).leak, true);
    });
  }

  const clean = [
    'whats the best email to send the details to?',
    'what timezone are you in bro?',
    'drop me your email and i got you',
    'he literally said "no way" haha'
  ];
  for (const reply of clean) {
    it(`allows natural slot asks: "${reply.slice(0, 40)}…"`, () => {
      assert.equal(detectMetadataLeak(reply).leak, false);
    });
  }
});
