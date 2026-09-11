// M5 item 1 — Wait-boundary guard, pure core.
// Run: npx tsx --test tests/unit/egress-guards.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  collectPostWaitContents,
  matchPostWaitCopy
} from '../../src/lib/state-machine/egress-guards';

// Shape of the daetradez step-1 "Warm Inbound" branch that produced the
// incident: intro, location ask, WAIT, geography react.
const warmInbound = {
  actions: [],
  branches: [
    {
      actions: [
        {
          actionType: 'send_message',
          content:
            "yo wassup, respect for reaching out! Let's see if I can help you out here",
          sortOrder: 0
        },
        {
          actionType: 'ask_question',
          content: 'Where are you currently based out of?',
          sortOrder: 1
        },
        { actionType: 'wait_for_response', content: '', sortOrder: 2 },
        {
          actionType: 'send_message',
          content: "That's awesome, I'm over in here in Texas.",
          sortOrder: 3
        },
        {
          actionType: 'ask_question',
          content: 'Are you totally new to trading or have you dabbled before?',
          sortOrder: 4
        }
      ]
    },
    {
      actions: [
        { actionType: 'runtime_judgment', content: 'classify', sortOrder: 0 },
        { actionType: 'wait_for_response', content: '', sortOrder: 1 }
      ]
    }
  ]
};

describe('collectPostWaitContents', () => {
  it('returns only deliverables AFTER the first Wait, per sequence', () => {
    const post = collectPostWaitContents(warmInbound);
    assert.deepEqual(post, [
      "That's awesome, I'm over in here in Texas.",
      'Are you totally new to trading or have you dabbled before?'
    ]);
  });
  it('is empty for a step with no Wait', () => {
    assert.deepEqual(
      collectPostWaitContents({
        actions: [
          {
            actionType: 'send_message',
            content: 'For sure bro, it is $200 USD',
            sortOrder: 0
          },
          {
            actionType: 'ask_question',
            content: 'Would that be realistic for you?',
            sortOrder: 1
          }
        ]
      }),
      []
    );
  });
  it('respects sortOrder, not array order', () => {
    const post = collectPostWaitContents({
      actions: [
        {
          actionType: 'send_message',
          content: 'this is the react after the wait block',
          sortOrder: 2
        },
        { actionType: 'wait_for_response', content: '', sortOrder: 1 },
        {
          actionType: 'ask_question',
          content: 'this is the ask before the wait block?',
          sortOrder: 0
        }
      ]
    });
    assert.deepEqual(post, ['this is the react after the wait block']);
  });
});

describe('matchPostWaitCopy', () => {
  const post = collectPostWaitContents(warmInbound);
  it('matches the incident bubble even with small model drift', () => {
    // model emitted "over here" where the script says "over in here"
    assert.equal(
      matchPostWaitCopy("That's awesome, I'm over here in Texas.", post),
      "That's awesome, I'm over in here in Texas."
    );
  });
  it('matches verbatim and containment', () => {
    assert.ok(
      matchPostWaitCopy("That's awesome, I'm over in here in Texas.", post)
    );
    assert.ok(
      matchPostWaitCopy(
        "bet. That's awesome, I'm over in here in Texas. anyway",
        post
      )
    );
  });
  it('does NOT match pre-wait copy or unrelated text', () => {
    assert.equal(
      matchPostWaitCopy('Where are you currently based out of?', post),
      null
    );
    assert.equal(
      matchPostWaitCopy(
        'gotchu bro, 6 months in is solid. what has been holding you back?',
        post
      ),
      null
    );
  });
  it('never matches short or generic bubbles', () => {
    assert.equal(matchPostWaitCopy("that's awesome", post), null);
    assert.equal(matchPostWaitCopy('bet bro, i got you', post), null);
  });
});
