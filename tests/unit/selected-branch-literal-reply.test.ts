import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildSelectedBranchLiteralReply } from '../../src/lib/selected-branch-literal-reply';

const action = (actionType: string, content = '') => ({ actionType, content });
const assemble = (
  branchActions: Array<{ actionType: string; content: string }>,
  directActions: Array<{ actionType: string; content: string }> = []
) =>
  buildSelectedBranchLiteralReply({
    directActions,
    branchActions,
    resolve: (content) => content,
    alreadyDelivered: () => false
  });

describe('selected branch literal reply', () => {
  it('ships the Real goal MSG, not a model draft from Vague', () => {
    const realGoal = [
      action('runtime_judgment', 'Lead named a concrete goal.'),
      action('send_message', 'That is a solid goal.'),
      action('ask_question', 'What got you started?'),
      action('wait_for_response')
    ];
    const vague = [
      action('send_message', 'Most people need to find a goal first.'),
      action('wait_for_response')
    ];
    assert.deepEqual(assemble(realGoal), [
      'That is a solid goal.',
      'What got you started?'
    ]);
    assert.deepEqual(assemble(vague), [
      'Most people need to find a goal first.'
    ]);
  });

  it('preserves shared actions and stops at WAIT', () => {
    assert.deepEqual(
      assemble(
        [
          action('send_message', 'Branch reply.'),
          action('wait_for_response'),
          action('send_message', 'Next turn.')
        ],
        [action('send_message', 'Shared opening.')]
      ),
      ['Shared opening.', 'Branch reply.']
    );
  });

  it('does not inherit shared copy for a pure routing branch', () => {
    assert.equal(
      assemble(
        [action('runtime_judgment', 'The opener was already sent.')],
        [action('send_message', 'New opener.')]
      ),
      null
    );
  });

  it('does not cross a step-level WAIT into branch copy', () => {
    assert.equal(
      assemble(
        [action('send_message', 'Branch reply.')],
        [
          action('send_message', 'Prior-turn opener.'),
          action('wait_for_response')
        ]
      ),
      null
    );
  });

  it('leaves runtime placeholders and link actions to their own paths', () => {
    assert.equal(
      assemble([
        action('send_message', 'Fixed intro.'),
        action('send_message', '{{acknowledge their goal}}')
      ]),
      null
    );
    assert.equal(
      assemble([
        action('send_message', 'Here it is.'),
        action('send_link', 'https://example.com')
      ]),
      null
    );
  });

  it('does not send unresolved variables or repeat delivered fixed copy', () => {
    assert.equal(
      buildSelectedBranchLiteralReply({
        directActions: [],
        branchActions: [action('send_message', 'Hi {{name}}')],
        resolve: (content) => content,
        alreadyDelivered: () => false
      }),
      null
    );
    assert.equal(
      buildSelectedBranchLiteralReply({
        directActions: [],
        branchActions: [action('send_message', 'Already sent.')],
        resolve: (content) => content,
        alreadyDelivered: () => true
      }),
      null
    );
  });
});
