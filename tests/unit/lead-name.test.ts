// Unit tests for the message-body-as-name guard. The priority is ZERO false
// positives on real names/bios (never hide or rename a legitimate lead); it is
// acceptable to miss some corrupted names (e.g. capitalized sentences) rather
// than risk renaming a real one. Run with:
//   npx tsx --test tests/unit/lead-name.test.ts
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { looksLikeMessageBody, leadDisplayName } from '../../src/lib/lead-name';

describe('looksLikeMessageBody — flags chat messages', () => {
  for (const s of [
    'let me check first my schedule',
    'ion wanna talk',
    "honestly whatever's open works for me",
    'the lock in guy'
  ]) {
    it(`flags: ${JSON.stringify(s)}`, () => {
      assert.equal(looksLikeMessageBody(s), true);
    });
  }
});

describe('looksLikeMessageBody — never flags real names / bios (zero false positives)', () => {
  for (const s of [
    'Eric Blair Jr.',
    'Dr. Chuks',
    'Keivan Afsharieh | Forex | Price Action | Live Trading',
    'NICK S.',
    's a m i 🥷🏻 CR4',
    'Shazim Khan',
    'Jean-Pierre van der Berg',
    'Flicker Mist',
    'Témi (Tay-Me) FKA Intro of Def Jam',
    ''
  ]) {
    it(`does NOT flag: ${JSON.stringify(s)}`, () => {
      assert.equal(looksLikeMessageBody(s), false);
    });
  }
});

describe('leadDisplayName — falls back to handle for corrupted names', () => {
  it('corrupted name → handle', () => {
    assert.equal(
      leadDisplayName({
        name: 'let me check first my schedule',
        handle: 'Flicker Mist',
        platformUserId: 'x'
      }),
      'Flicker Mist'
    );
  });
  it('legit name → name', () => {
    assert.equal(
      leadDisplayName({
        name: 'Eric Blair Jr.',
        handle: 'priehst',
        platformUserId: 'x'
      }),
      'Eric Blair Jr.'
    );
  });
});
