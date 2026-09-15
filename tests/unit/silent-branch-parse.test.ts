// A deliberately silent branch must ship NOTHING — never the model's own
// JSON scaffolding. Daniel v2 step 1 "Solicitation / non-lead" is
// runtime_judgment-only ("Send nothing. Do not greet…"), the model answers
// {"message": ""}, and on 2026-09-15 (local flow 3) the engine fell back to
// the raw payload and delivered four bubbles to the lead:
//   ```json / "format": "text", / "message": "", / "stage": "OPENING",
// Run: npx tsx --test tests/unit/silent-branch-parse.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseAIResponse as parse } from '../../src/lib/ai-engine';

describe('parseAIResponse — intentionally empty message (silent branch)', () => {
  it('an empty message field ships no bubbles, not the raw JSON', () => {
    const raw = JSON.stringify(
      { format: 'text', message: '', stage: 'OPENING', stage_confidence: 0.9 },
      null,
      2
    );
    const parsed = parse(raw);
    assert.deepEqual(parsed.messages, []);
    assert.equal(parsed.message, '');
    for (const bubble of [parsed.message, ...parsed.messages]) {
      assert.ok(
        !bubble.includes('"format"'),
        'no JSON key leaked into a bubble'
      );
      assert.ok(!bubble.includes('```'), 'no code fence leaked into a bubble');
      assert.ok(
        !bubble.includes('"stage"'),
        'no stage key leaked into a bubble'
      );
    }
  });

  it('the same inside a markdown code fence', () => {
    const raw =
      '```json\n{"format":"text","message":"","stage":"OPENING"}\n```';
    const parsed = parse(raw);
    assert.deepEqual(parsed.messages, []);
    assert.equal(parsed.message, '');
  });

  it('whitespace-only message counts as silent', () => {
    const parsed = parse('{"message":"   ","stage":"OPENING"}');
    assert.deepEqual(parsed.messages, []);
  });

  it('a real message is unaffected', () => {
    const parsed = parse('{"message":"yo wassup bro","stage":"OPENING"}');
    assert.deepEqual(parsed.messages, ['yo wassup bro']);
    assert.equal(parsed.message, 'yo wassup bro');
  });

  it('messages[] still wins when present', () => {
    const parsed = parse(
      '{"message":"","messages":["line one","line two"],"stage":"OPENING"}'
    );
    assert.deepEqual(parsed.messages, ['line one', 'line two']);
  });

  it('unparseable output still falls back to the raw text (unchanged behaviour)', () => {
    const parsed = parse('yo wassup bro, not json at all');
    assert.deepEqual(parsed.messages, ['yo wassup bro, not json at all']);
  });
});
