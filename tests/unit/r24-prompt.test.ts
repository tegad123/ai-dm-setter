// Run: npx tsx --test tests/unit/r24-prompt.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync('src/lib/ai-prompts.ts', 'utf8');

function r24CapitalRuleSource(): string {
  const start = source.indexOf(
    'const capitalRule = `Before sending ANY booking'
  );
  const end = source.indexOf('This rule is flow-agnostic:', start);
  assert.notEqual(start, -1, 'R24 capitalRule block should exist');
  assert.notEqual(end, -1, 'R24 capitalRule ending should exist');
  return source.slice(start, end);
}

describe('R24 prompt — unclear capital answer', () => {
  it('forbids pivoting to urgency/timeline/motivation after a non-numeric capital answer', () => {
    const r24 = r24CapitalRuleSource();

    assert.match(r24, /Do NOT pivot to urgency, timeline, motivation/i);
    assert.match(r24, /pins a dollar figure/i);
    assert.match(r24, /stay at CAPITAL_QUALIFICATION/i);
    assert.doesNotMatch(r24, /Instead pivot/i);
    assert.doesNotMatch(
      r24.replace(/\n/g, ' '),
      /ask a different clarifying question.*urgency.*timeline.*motivation/i
    );
  });
});
