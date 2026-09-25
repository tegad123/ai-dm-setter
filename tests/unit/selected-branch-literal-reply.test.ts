import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  assembleMixedSelectedBranchReply,
  buildSelectedBranchLiteralReply
} from '../../src/lib/selected-branch-literal-reply';

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

describe('selected branch with a generated placeholder', () => {
  const realGoal = [
    action('runtime_judgment', 'A concrete goal was named.'),
    action('send_message', '{{acknowledge their goal in their own words}}'),
    action(
      'send_message',
      "that's the exact thing my free discord is built around. I trade gold live every asia session in there"
    ),
    action('ask_question', 'want me to send you the link?'),
    action('wait_for_response')
  ];
  const vague = [
    action(
      'send_message',
      "that's all good, most people don't have it fully mapped out yet"
    ),
    action('send_message', 'I run a free discord where I trade gold live'),
    action('ask_question', 'want me to send you the link?')
  ];
  const assemble = (generatedMessages: string[]) =>
    assembleMixedSelectedBranchReply({
      branchActions: realGoal,
      allBranchActions: [realGoal, vague],
      generatedMessages,
      alreadyDelivered: () => false
    });

  it('rejects the actual v3 failure: Real goal selected, Vague fixed copy drafted', () => {
    assert.deepEqual(
      assemble([
        vague[0].content,
        vague[1].content,
        'want me to send you the link?'
      ]),
      { kind: 'missing_placeholder', expected: 1, found: 0 }
    );
  });

  it('keeps only the generated acknowledgment and inserts fixed copy in order', () => {
    assert.deepEqual(
      assemble([
        'looking after your girlfriend is a real reason to get serious about trading',
        'I run a free discord where I trade gold live',
        'want me to send you the link?'
      ]),
      {
        kind: 'assembled',
        bubbles: [
          'looking after your girlfriend is a real reason to get serious about trading',
          realGoal[2].content,
          'want me to send you the link?'
        ],
        fixedMessages: [realGoal[2].content, realGoal[3].content]
      }
    );
  });

  it('rejects ambiguous extra free text instead of guessing the placeholder slot', () => {
    assert.deepEqual(
      assemble(['contextual acknowledgment', 'unscripted extra claim']),
      { kind: 'missing_placeholder', expected: 1, found: 2 }
    );
  });

  it('leaves an unresolved link with the existing link guard', () => {
    assert.deepEqual(
      assembleMixedSelectedBranchReply({
        branchActions: [
          action('send_message', 'bet, here you go'),
          action('send_link', 'Discord'),
          action('send_message', '{{tell them which role to grab}}')
        ],
        allBranchActions: [],
        generatedMessages: ['Grab the Futures role'],
        alreadyDelivered: () => false
      }),
      { kind: 'not_applicable' }
    );
  });

  it('keeps fixed messages and a real link in script order around a generated slot', () => {
    const link = 'https://daetradingaccelerator.com/freediscord';
    const branchActions = [
      action('send_message', 'bet, here you go 💯'),
      { actionType: 'send_link', content: 'Discord', linkUrl: link },
      action('send_message', '{{tell them which role to grab}}'),
      action('send_message', 'say hello in general-chat'),
      action('ask_question', "lmk once you're in?"),
      action('wait_for_response')
    ];
    assert.deepEqual(
      assembleMixedSelectedBranchReply({
        branchActions,
        allBranchActions: [branchActions],
        generatedMessages: ['grab the Futures role'],
        alreadyDelivered: () => false
      }),
      {
        kind: 'assembled',
        bubbles: [
          'bet, here you go 💯',
          link,
          'grab the Futures role',
          'say hello in general-chat',
          "lmk once you're in?"
        ],
        fixedMessages: [
          'bet, here you go 💯',
          'say hello in general-chat',
          "lmk once you're in?",
          link
        ]
      }
    );
  });

  it('rejects a Forex role instruction for a lead classified as Futures', () => {
    const branchActions = [
      action('send_message', 'here is the link'),
      action('send_message', '{{tell them which role to grab}}'),
      action('ask_question', "lmk once you're in?")
    ];
    assert.deepEqual(
      assembleMixedSelectedBranchReply({
        branchActions,
        allBranchActions: [branchActions],
        generatedMessages: ['grab the Forex role when you get in'],
        requiredRole: 'Futures',
        alreadyDelivered: () => false
      }),
      { kind: 'missing_placeholder', expected: 1, found: 0 }
    );
    assert.equal(
      assembleMixedSelectedBranchReply({
        branchActions,
        allBranchActions: [branchActions],
        generatedMessages: ['grab the Futures role for prop firm deals'],
        requiredRole: 'Futures',
        alreadyDelivered: () => false
      }).kind,
      'assembled'
    );
  });

  it('discards a model draft on a fixed-message and link branch', () => {
    const link = 'https://form.typeform.com/to/JczMfKyp';
    const branchActions = [
      action('send_message', 'first fixed line'),
      { actionType: 'send_link', content: 'Waitlist', linkUrl: link },
      action('send_message', 'second fixed line')
    ];
    assert.deepEqual(
      assembleMixedSelectedBranchReply({
        branchActions,
        allBranchActions: [branchActions],
        generatedMessages: ['wrong branch text'],
        alreadyDelivered: () => false
      }),
      {
        kind: 'assembled',
        bubbles: ['first fixed line', link, 'second fixed line'],
        fixedMessages: ['first fixed line', 'second fixed line', link]
      }
    );
  });

  it('assembles a placeholder followed by a fixed ASK even without a fixed MSG', () => {
    const branchActions = [
      action('send_message', '{{acknowledge they have not joined}}'),
      action('ask_question', 'want me to send the link again?'),
      action('wait_for_response')
    ];
    assert.deepEqual(
      assembleMixedSelectedBranchReply({
        branchActions,
        allBranchActions: [branchActions],
        generatedMessages: ['no rush, that makes sense'],
        alreadyDelivered: () => false
      }),
      {
        kind: 'assembled',
        bubbles: [
          'no rush, that makes sense',
          'want me to send the link again?'
        ],
        fixedMessages: ['want me to send the link again?']
      }
    );
  });

  it('does not assemble past a direct action or a direct WAIT', () => {
    for (const directAction of [
      action('send_message', 'shared opener'),
      action('wait_for_response')
    ]) {
      assert.deepEqual(
        assembleMixedSelectedBranchReply({
          directActions: [directAction],
          branchActions: realGoal,
          allBranchActions: [realGoal],
          generatedMessages: ['a personal acknowledgment'],
          alreadyDelivered: () => false
        }),
        { kind: 'not_applicable' }
      );
    }
  });
});
