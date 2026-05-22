import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  resolveEmittedPlaceholders,
  normalizeTemplateKey,
  type ScriptVariableResolutionMap,
  type ScriptVariableResolution
} from '../../src/lib/script-variable-resolver';

// ---------------------------------------------------------------------------
// resolveEmittedPlaceholders — Day 4 resolve-before-strip helper.
// A generated "{{name}}" we CAN resolve should ship personalized; one we
// can't resolve must stay literal so it falls through to strip/escalate.
// ---------------------------------------------------------------------------

function makeMap(entries: Record<string, string>): ScriptVariableResolutionMap {
  const byNormalizedName = new Map<string, ScriptVariableResolution>();
  const resolvedVariables: ScriptVariableResolution[] = [];
  for (const [name, value] of Object.entries(entries)) {
    const res: ScriptVariableResolution = {
      variableName: name,
      value,
      source: 'leadContext',
      confidence: 'HIGH',
      shouldPersist: false
    };
    byNormalizedName.set(normalizeTemplateKey(name), res);
    resolvedVariables.push(res);
  }
  return { byNormalizedName, resolvedVariables };
}

describe('resolveEmittedPlaceholders', () => {
  it('resolves a known placeholder and reports changed=true', () => {
    const map = makeMap({ name: 'Shazim' });
    const out = resolveEmittedPlaceholders(["hey {{name}}, what's good"], map);
    assert.equal(out.changed, true);
    assert.equal(out.messages[0], "hey Shazim, what's good");
  });

  it('leaves an unresolvable placeholder literal and reports changed=false', () => {
    const map = makeMap({ name: 'Shazim' });
    const out = resolveEmittedPlaceholders(['see you {{day_and_time}}'], map);
    assert.equal(out.changed, false);
    assert.equal(out.messages[0], 'see you {{day_and_time}}');
  });

  it('mixed: resolves known, keeps unknown literal, changed=true', () => {
    const map = makeMap({ name: 'Shazim' });
    const out = resolveEmittedPlaceholders(
      ['hi {{name}}', 'see you {{unknown_var}}'],
      map
    );
    assert.equal(out.changed, true);
    assert.equal(out.messages[0], 'hi Shazim');
    assert.equal(out.messages[1], 'see you {{unknown_var}}');
  });

  it('no placeholders → unchanged, changed=false', () => {
    const map = makeMap({ name: 'Shazim' });
    const out = resolveEmittedPlaceholders(['just a normal message'], map);
    assert.equal(out.changed, false);
    assert.equal(out.messages[0], 'just a normal message');
  });

  it('no resolution map → unchanged, changed=false', () => {
    const out = resolveEmittedPlaceholders(['hi {{name}}'], null);
    assert.equal(out.changed, false);
    assert.equal(out.messages[0], 'hi {{name}}');
  });

  it('resolves the same placeholder across multiple bubbles', () => {
    const map = makeMap({ name: 'Shazim' });
    const out = resolveEmittedPlaceholders(
      ['yo {{name}}', '{{name}}, you still there?'],
      map
    );
    assert.equal(out.changed, true);
    assert.deepEqual(out.messages, ['yo Shazim', 'Shazim, you still there?']);
  });
});
