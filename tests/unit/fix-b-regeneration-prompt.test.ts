// Run: npx tsx --test tests/unit/fix-b-regeneration-prompt.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync('src/lib/ai-engine.ts', 'utf8');

describe('Fix B regeneration prompt', () => {
  it('forbids urgency/timeline/motivation/goal pivots after an unclear capital answer', () => {
    assert.match(source, /CRITICAL: Lead has not given a capital number yet\./);
    assert.match(
      source,
      /Ask one varied clarifier that pins a dollar figure\./
    );
    assert.match(
      source,
      /Do NOT ask the urgency\/timeline\/motivation\/goal question\./
    );
    assert.match(source, /Stay at CAPITAL_QUALIFICATION\./);
  });
});
