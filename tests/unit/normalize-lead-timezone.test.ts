// Unit tests for normalizeLeadTimezone (BUG-09 tz, Paris/Shazim 2026-06).
// The AI emitted Europe/London for a South-Africa / GMT+2 lead because the
// prompt only showed US/UK examples — mislabelling every booking slot.
//
// Run: npx tsx --test tests/unit/normalize-lead-timezone.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { normalizeLeadTimezone } from '../../src/lib/ai-engine';

describe('normalizeLeadTimezone (BUG-09 tz)', () => {
  it('maps the wrong Europe/London for a South-Africa lead → Africa/Johannesburg', () => {
    // The model often emits Europe/London; but if it (or the lead) names SA we fix it.
    assert.equal(normalizeLeadTimezone('South Africa'), 'Africa/Johannesburg');
    assert.equal(normalizeLeadTimezone('SAST'), 'Africa/Johannesburg');
    assert.equal(normalizeLeadTimezone('Johannesburg'), 'Africa/Johannesburg');
  });

  it('maps bare GMT+2 (no region) to the populous default', () => {
    assert.equal(normalizeLeadTimezone('GMT+2'), 'Africa/Johannesburg');
    assert.equal(normalizeLeadTimezone('UTC+2'), 'Africa/Johannesburg');
  });

  it('maps other common regions correctly', () => {
    assert.equal(normalizeLeadTimezone('Nigeria'), 'Africa/Lagos');
    assert.equal(normalizeLeadTimezone('Dubai'), 'Asia/Dubai');
    assert.equal(normalizeLeadTimezone('India'), 'Asia/Kolkata');
  });

  it('leaves an already-correct IANA zone untouched', () => {
    assert.equal(normalizeLeadTimezone('America/New_York'), 'America/New_York');
    assert.equal(
      normalizeLeadTimezone('Africa/Johannesburg'),
      'Africa/Johannesburg'
    );
  });

  it('handles null / empty', () => {
    assert.equal(normalizeLeadTimezone(null), null);
    assert.equal(normalizeLeadTimezone(''), null);
  });
});
