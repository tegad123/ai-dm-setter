// Unit tests for BUG-06 (Paris Mokoena 2026-06-17): the AI dodges concrete
// pricing/logistics questions, looping back to qualification. Tests both the
// detector and the gate's ignored_direct_question soft signal.
//
// Run: npx tsx --test tests/unit/direct-question-dodge.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { detectDirectQuestion } from '../../src/lib/conversation-detail-extractor';
import { scoreVoiceQuality } from '../../src/lib/voice-quality-gate';

describe('detectDirectQuestion (BUG-06)', () => {
  const positives = [
    'how much does it cost?',
    'firstly I have to know how much do you selling it',
    'are you selling it or not',
    'do you have a whatsapp group where you teach strategies',
    'do you teach courses',
    'so how does the system work',
    "what's the agenda for the call"
  ];
  for (const q of positives) {
    it(`detects: "${q.slice(0, 40)}"`, () => {
      assert.equal(detectDirectQuestion(q).detected, true);
    });
  }

  const negatives = [
    'yeah man been trading 2 years',
    'im based in south africa',
    'i really wanna replace my income'
  ];
  for (const q of negatives) {
    it(`ignores non-question: "${q.slice(0, 30)}"`, () => {
      assert.equal(detectDirectQuestion(q).detected, false);
    });
  }
});

const hasDodgeSignal = (r: { softSignals: Record<string, number> }) =>
  typeof r.softSignals.ignored_direct_question === 'number';

describe('ignored_direct_question gate signal (BUG-06)', () => {
  it('penalizes dodging "how much does it cost" with another question', () => {
    const result = scoreVoiceQuality(
      'gotchu bro, what timezone are you in so i can line up the call?',
      { previousLeadMessage: 'how much does it cost?' }
    );
    assert.ok(
      hasDodgeSignal(result),
      `expected ignored_direct_question, got: ${JSON.stringify(result.softSignals)}`
    );
  });

  it('does NOT penalize when the reply answers / defers to the call', () => {
    const result = scoreVoiceQuality(
      'good q bro, anthony goes over the exact pricing on the call so it fits your situation',
      { previousLeadMessage: 'how much does it cost?' }
    );
    assert.equal(hasDodgeSignal(result), false);
  });

  it('does NOT fire when the lead did not ask a direct question', () => {
    const result = scoreVoiceQuality('what timezone are you in bro?', {
      previousLeadMessage: 'yeah man been trading 2 years'
    });
    assert.equal(hasDodgeSignal(result), false);
  });
});
