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

// ── M5 item 7: verbatim repeat matcher (pure) ─────────────────────────────
import { findVerbatimRepeat } from '../../src/lib/state-machine/copy-match';

describe('findVerbatimRepeat', () => {
  const prior = [
    'No worries bro! I appreciate you being real about it.',
    'Probably the best place for you to start right now would be my YouTube channel, everything is free there',
    'https://daetradingaccelerator.com/landing-page',
    'yo bro, no stress'
  ];
  it('blocks an exact repeat and a punctuation/case drift of delivered copy (conv cmu0zhsp40003lh043d9f0ndt)', () => {
    assert.equal(
      findVerbatimRepeat(
        'No worries bro! I appreciate you being real about it.',
        prior
      ),
      prior[0]
    );
    assert.equal(
      findVerbatimRepeat(
        'no worries bro, i appreciate you being real about it',
        prior
      ),
      prior[0]
    );
    assert.equal(
      findVerbatimRepeat(
        'Probably the best place for you to start right now would be my YouTube channel, everything is free there.',
        prior
      ),
      prior[1]
    );
  });
  it('does not treat a new short question as a repeat just because its words appear in an old long message', () => {
    assert.equal(
      findVerbatimRepeat('what platform are you on right now?', prior),
      null
    );
    assert.equal(
      findVerbatimRepeat(
        'where do you want to start, entries or exits?',
        prior
      ),
      null
    );
  });
  it('ignores short generic lines on both sides', () => {
    assert.equal(findVerbatimRepeat('yo bro, no stress', prior), null);
    assert.equal(
      findVerbatimRepeat('bet bro, here you go', ['bet bro, here you go']),
      null
    );
  });
  it('a bare URL is too short to match by tokens: links are governed by the link guard, not this one', () => {
    assert.equal(
      findVerbatimRepeat(
        'https://daetradingaccelerator.com/landing-page',
        prior
      ),
      null
    );
  });
});

describe('findVerbatimRepeat — containment direction', () => {
  it('a delivered line repeated whole inside a longer new bubble is a repeat (Daniel v2 local run, 2026-09-15)', () => {
    const prior = [
      'yo wassup, respect for reaching out!',
      "let's see if I can help you out here 🙏🏽 where you based out of?"
    ];
    assert.equal(
      findVerbatimRepeat(
        "yo wassup, respect for reaching out! let's see if I can help you out here 🙏🏽",
        prior
      ),
      prior[0]
    );
  });
  it('a short new question that appears inside an old long message is still new', () => {
    assert.equal(
      findVerbatimRepeat('where you based out of?', [
        "let's see if I can help you out here 🙏🏽 where you based out of? and what do you trade"
      ]),
      null
    );
  });
});
