import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { anchoredCaptureIsConsistent } from '../../src/lib/script-variable-resolver';

const ask =
  'you trading anything yet, even on demo, or still learning the basics first?';
const anchors = [
  {
    variableName: 'goal',
    stepNumber: 2,
    askContents: [ask]
  }
];

describe('anchored variable answer check', () => {
  it('accepts a stated alternative grounded in the delivered ask', () => {
    assert.equal(
      anchoredCaptureIsConsistent('goal', 'learning the basics', anchors, [
        { sender: 'AI', content: ask },
        { sender: 'LEAD', content: 'not yet, still learning the basics' }
      ]),
      true
    );
  });

  it('rejects a clarification that quotes the alternative', () => {
    assert.equal(
      anchoredCaptureIsConsistent('goal', 'learning the basics', anchors, [
        { sender: 'AI', content: ask },
        {
          sender: 'LEAD',
          content: 'not yet, what do you mean by learning the basics?'
        }
      ]),
      false
    );
  });
});
