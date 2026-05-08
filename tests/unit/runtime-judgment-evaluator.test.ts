// Unit tests for runtime-judgment-evaluator. Verifies that the
// {{variable}} parsing, prompt-block rendering, captured-data-points
// merging, and prior-signal injection all behave correctly. Run with:
//   npx tsx --test tests/unit/runtime-judgment-evaluator.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildPriorCapturedSignalsBlock,
  buildRuntimeJudgmentBlock,
  extractVariableNames,
  mergeCapturedDataPoints,
  parseCapturedDataPointsFromResponse,
  parseRuntimeJudgments
} from '../../src/lib/runtime-judgment-evaluator';

// ---------------------------------------------------------------------------
// extractVariableNames
// ---------------------------------------------------------------------------

describe('extractVariableNames', () => {
  it('extracts a single {{variable}}', () => {
    assert.deepEqual(
      extractVariableNames('store as {{early_obstacle}} for later'),
      ['early_obstacle']
    );
  });

  it('extracts multiple distinct variables in order', () => {
    assert.deepEqual(
      extractVariableNames(
        'capture {{first_pain}} then {{second_pain}} then {{third_pain}}'
      ),
      ['first_pain', 'second_pain', 'third_pain']
    );
  });

  it('dedupes repeated references', () => {
    assert.deepEqual(
      extractVariableNames(
        '{{early_obstacle}} ... reference {{early_obstacle}} again'
      ),
      ['early_obstacle']
    );
  });

  it('rejects names with whitespace inside braces', () => {
    // Whitespace inside braces is operator-side typo / freeform text;
    // treat as no variable.
    assert.deepEqual(
      extractVariableNames('store as {{ early_obstacle }} (whitespace)'),
      []
    );
  });

  it('returns [] for null/undefined/empty input', () => {
    assert.deepEqual(extractVariableNames(null), []);
    assert.deepEqual(extractVariableNames(undefined), []);
    assert.deepEqual(extractVariableNames(''), []);
  });

  it('does not match malformed braces', () => {
    assert.deepEqual(extractVariableNames('{not_a_var} or {{not closed'), []);
  });
});

// ---------------------------------------------------------------------------
// parseRuntimeJudgments
// ---------------------------------------------------------------------------

describe('parseRuntimeJudgments', () => {
  it('annotates each judgment with its variable names', () => {
    const result = parseRuntimeJudgments([
      {
        stepNumber: 2,
        branchLabel: 'Already in markets',
        content: 'Store struggle as {{early_obstacle}}.'
      },
      {
        stepNumber: 3,
        branchLabel: null,
        content: 'No variables here, just a soft instruction.'
      }
    ]);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0].variableNames, ['early_obstacle']);
    assert.deepEqual(result[1].variableNames, []);
    assert.equal(result[0].branchLabel, 'Already in markets');
  });

  it('drops judgments with empty content', () => {
    const result = parseRuntimeJudgments([
      { stepNumber: 1, content: '' },
      { stepNumber: 2, content: '   ' },
      { stepNumber: 3, content: 'real instruction with {{x}}' }
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].stepNumber, 3);
  });
});

// ---------------------------------------------------------------------------
// buildRuntimeJudgmentBlock
// ---------------------------------------------------------------------------

describe('buildRuntimeJudgmentBlock', () => {
  it('returns null when there are zero variable-bearing judgments', () => {
    const judgments = parseRuntimeJudgments([
      { stepNumber: 1, content: 'no vars here' }
    ]);
    assert.equal(buildRuntimeJudgmentBlock(judgments), null);
  });

  it('returns null when input list is empty', () => {
    assert.equal(buildRuntimeJudgmentBlock([]), null);
  });

  it('renders a block that explicitly tells the LLM to populate captured_data_points', () => {
    const judgments = parseRuntimeJudgments([
      {
        stepNumber: 2,
        branchLabel: 'Already in markets',
        content:
          'If their reply mentions a struggle, frustration, or obstacle unprompted → store as {{early_obstacle}}. Treat them accordingly — open door.'
      }
    ]);
    const block = buildRuntimeJudgmentBlock(judgments);
    assert.ok(block, 'should produce a block');
    // Must direct the LLM to use captured_data_points and pause linear flow
    assert.match(block!, /captured_data_points/);
    assert.match(block!, /DO NOT advance/);
    assert.match(block!, /go DEEPER/i);
    assert.match(block!, /\{\{early_obstacle\}\}/);
    assert.match(block!, /Step 2/);
    assert.match(block!, /branch: Already in markets/);
  });

  it('skips judgments without {{variable}} but still emits block when at least one has variables', () => {
    const judgments = parseRuntimeJudgments([
      {
        stepNumber: 1,
        content:
          'Use your judgment to personalise the opener — no specific variable.'
      },
      {
        stepNumber: 4,
        content: 'Capture buying signal as {{purchase_intent_signal}}.'
      }
    ]);
    const block = buildRuntimeJudgmentBlock(judgments);
    assert.ok(block);
    assert.match(block!, /\{\{purchase_intent_signal\}\}/);
    // The first judgment had no variable — should not appear in the
    // active-judgment list of the block.
    assert.equal(block!.includes('personalise the opener'), false);
  });
});

// ---------------------------------------------------------------------------
// parseCapturedDataPointsFromResponse
// ---------------------------------------------------------------------------

describe('parseCapturedDataPointsFromResponse', () => {
  it('extracts a flat object of trimmed string values', () => {
    const raw = {
      early_obstacle: '  blowing accounts back to back  ',
      willingness: 'open to chat'
    };
    assert.deepEqual(parseCapturedDataPointsFromResponse(raw), {
      early_obstacle: 'blowing accounts back to back',
      willingness: 'open to chat'
    });
  });

  it('coerces non-string scalar values via String()', () => {
    const raw = { capital_amount: 1500, ready_now: true };
    assert.deepEqual(parseCapturedDataPointsFromResponse(raw), {
      capital_amount: '1500',
      ready_now: 'true'
    });
  });

  it('drops empty / null / undefined values', () => {
    const raw = {
      kept: 'real value',
      blank: '',
      whitespace: '   ',
      explicitNull: null,
      undef: undefined
    };
    assert.deepEqual(parseCapturedDataPointsFromResponse(raw), {
      kept: 'real value'
    });
  });

  it('returns null for non-object inputs', () => {
    assert.equal(parseCapturedDataPointsFromResponse(null), null);
    assert.equal(parseCapturedDataPointsFromResponse(undefined), null);
    assert.equal(parseCapturedDataPointsFromResponse('not an object'), null);
    assert.equal(parseCapturedDataPointsFromResponse(['array']), null);
    assert.equal(parseCapturedDataPointsFromResponse(42), null);
  });

  it('returns null when all keys are dropped', () => {
    assert.equal(
      parseCapturedDataPointsFromResponse({ a: '', b: null, c: '   ' }),
      null
    );
  });
});

// ---------------------------------------------------------------------------
// mergeCapturedDataPoints
// ---------------------------------------------------------------------------

describe('mergeCapturedDataPoints', () => {
  it('merges incoming over existing — newer wins', () => {
    const existing = { early_obstacle: 'old phrase', other: 'kept' };
    const incoming = { early_obstacle: 'new fresher phrase' };
    assert.deepEqual(mergeCapturedDataPoints(existing, incoming), {
      early_obstacle: 'new fresher phrase',
      other: 'kept'
    });
  });

  it('preserves existing keys not present in incoming', () => {
    const existing = { kept: 'A', also_kept: 'B' };
    const incoming = { added: 'C' };
    assert.deepEqual(mergeCapturedDataPoints(existing, incoming), {
      kept: 'A',
      also_kept: 'B',
      added: 'C'
    });
  });

  it('treats null / non-object existing as empty', () => {
    assert.deepEqual(mergeCapturedDataPoints(null, { x: '1' }), { x: '1' });
    assert.deepEqual(
      mergeCapturedDataPoints(undefined as unknown as null, { x: '1' }),
      { x: '1' }
    );
  });

  it('drops empty / non-string incoming values', () => {
    const existing = { kept: 'A' };
    const incoming = { added: 'B', blank: '', ws: '  ' } as Record<
      string,
      string
    >;
    assert.deepEqual(mergeCapturedDataPoints(existing, incoming), {
      kept: 'A',
      added: 'B'
    });
  });

  it('returns a new object — does not mutate inputs', () => {
    const existing = { a: '1' };
    const incoming = { b: '2' };
    const result = mergeCapturedDataPoints(existing, incoming);
    assert.notEqual(result, existing);
    assert.notEqual(result, incoming);
    // Inputs unchanged
    assert.deepEqual(existing, { a: '1' });
    assert.deepEqual(incoming, { b: '2' });
  });
});

// ---------------------------------------------------------------------------
// buildPriorCapturedSignalsBlock
// ---------------------------------------------------------------------------

describe('buildPriorCapturedSignalsBlock', () => {
  it('renders a block when known variables have captured values', () => {
    const captured = {
      early_obstacle: "can't stop blowing accounts",
      verifiedCapitalUsd: 5000 // structured field, NOT a runtime variable
    };
    const block = buildPriorCapturedSignalsBlock(captured, [
      'early_obstacle',
      'willingness_to_invest'
    ]);
    assert.ok(block);
    assert.match(block!, /PRIOR CAPTURED SIGNALS/);
    assert.match(block!, /\{\{early_obstacle\}\}: can't stop blowing accounts/);
    // verifiedCapitalUsd is NOT a runtime variable name — must be filtered out
    assert.equal(block!.includes('verifiedCapitalUsd'), false);
    // willingness_to_invest is a known var but has no captured value — also filtered
    assert.equal(block!.includes('willingness_to_invest'), false);
  });

  it('returns null when no known variables have captured values', () => {
    const captured = { unrelated: 'foo' };
    assert.equal(
      buildPriorCapturedSignalsBlock(captured, ['early_obstacle']),
      null
    );
  });

  it('returns null when capturedDataPoints is null/empty', () => {
    assert.equal(buildPriorCapturedSignalsBlock(null, ['x']), null);
    assert.equal(buildPriorCapturedSignalsBlock({}, ['x']), null);
  });

  it('returns null when there are no known variable names', () => {
    assert.equal(buildPriorCapturedSignalsBlock({ x: 'value' }, []), null);
  });
});
