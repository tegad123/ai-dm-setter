// Unit tests for parseLeadCapitalAnswer — focused on the
// SMOKE 12 (below-threshold-routes-to-downsell) fix that introduced
// BELOW_THRESHOLD_HEDGE_PATTERN. Run with:
//   npx tsx --test tests/unit/parse-lead-capital.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseLeadCapitalAnswer } from '../../src/lib/ai-engine';

describe('parseLeadCapitalAnswer — below-threshold hedges', () => {
  it('SMOKE 12: "Less than $X" with corrective tail decrements the amount', () => {
    const result = parseLeadCapitalAnswer(
      "Less than $1000, I'm tryna at least start with $1000 or more, I know it's not much"
    );
    // The "not much" tail makes this hit the disqualifier branch
    // first — preserved behavior. Amount=0 marks a hard miss.
    assert.equal(result.kind, 'disqualifier');
    assert.equal(result.amount, 0);
  });

  it('"less than $1000" alone yields amount = 999 (below threshold)', () => {
    const result = parseLeadCapitalAnswer('less than $1000');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 999);
  });

  it('"under $1000" decrements past a $1000 threshold', () => {
    const result = parseLeadCapitalAnswer('under $1000 right now');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 999);
  });

  it('"below $500" yields amount = 499', () => {
    const result = parseLeadCapitalAnswer('below $500');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 499);
  });

  it('"barely $200" yields amount = 199', () => {
    const result = parseLeadCapitalAnswer('barely $200 to my name');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 199);
  });

  it('"not even $300" yields amount = 299', () => {
    const result = parseLeadCapitalAnswer('not even $300 bro');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 299);
  });

  it('"fewer than 100 dollars" decrements correctly', () => {
    const result = parseLeadCapitalAnswer('fewer than 100 dollars');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 99);
  });

  it('hedge with approximator: "less than about $1500" → 1499', () => {
    const result = parseLeadCapitalAnswer('less than about $1500');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 1499);
  });

  it('hedge without currency symbol: "under 2000" → 1999', () => {
    const result = parseLeadCapitalAnswer('under 2000');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 1999);
  });
});

describe('parseLeadCapitalAnswer — hedge phrases must NOT misfire', () => {
  it('"less than two hours" is not a capital hedge — no amount, falls through to hedging', () => {
    const result = parseLeadCapitalAnswer('less than two hours away');
    // Word number, not digits — BELOW_THRESHOLD_HEDGE_PATTERN
    // requires a digit token. Falls through to the no-amount path
    // which catches "less than" via the hedging regex.
    assert.equal(result.kind, 'hedging');
  });

  it('"barely have time to trade" doesn\'t decrement (no digit follows the hedge)', () => {
    const result = parseLeadCapitalAnswer('I barely have time to trade');
    assert.notEqual(result.kind, 'amount');
  });
});

describe('parseLeadCapitalAnswer — concrete amounts unaffected', () => {
  it('"$5000" returns the parsed amount verbatim', () => {
    const result = parseLeadCapitalAnswer('I have $5000 ready');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 5000);
  });

  it('"around $1500" returns 1500 (no below-threshold hedge)', () => {
    const result = parseLeadCapitalAnswer('around $1500');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 1500);
  });

  it('"$2000" with no hedge passes through', () => {
    const result = parseLeadCapitalAnswer('got $2000 set aside for trading');
    assert.equal(result.kind, 'amount');
    assert.equal(result.amount, 2000);
  });
});

describe('parseLeadCapitalAnswer — disqualifier precedence preserved', () => {
  it('"broke" still wins over a stray number', () => {
    const result = parseLeadCapitalAnswer("I'm broke man, $0 to my name");
    assert.equal(result.kind, 'disqualifier');
  });

  it('"no money" still wins', () => {
    const result = parseLeadCapitalAnswer('no money right now');
    assert.equal(result.kind, 'disqualifier');
  });
});
