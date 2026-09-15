// A lead reply that carries no answerable content must NOT credit our ask.
//
// Local run 2026-09-15 (Tega): the step-1 "No signal" branch asked "what you
// tryna figure out?", the lead sent an unreadable image, the FSM credited it
// as an answer and advanced to step 2 — so step 2's "love to see it, most
// people don't even take the first step" shipped onto an image the AI had
// just said it could not read. Another branch's copy in the wrong branch,
// same family as the decline bug.
//
// Run: npx tsx --test tests/unit/no-signal-credit.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  compileScript,
  type CompilableStep
} from '../../src/lib/script-fsm/compiler';
import {
  fsmTransition,
  isAnswerableReply,
  nodeForStep
} from '../../src/lib/script-fsm/runtime';
import type { FsmCursor } from '../../src/lib/script-fsm/types';

const A = (actionType: string, content = '') => ({ actionType, content });

const script: CompilableStep[] = [
  {
    stepNumber: 1,
    title: 'Open and Classify',
    branches: [
      {
        branchLabel: 'No signal',
        conditionDescription: 'the message carries no answerable content',
        actions: [
          A('ask_question', "yo what's good bro, what you tryna figure out?"),
          A('wait_for_response')
        ]
      }
    ]
  },
  {
    stepNumber: 2,
    title: 'Experience',
    branches: [
      {
        branchLabel: 'New to markets',
        conditionDescription: 'the lead is new',
        actions: [
          A(
            'send_message',
            "love to see it, most people don't even take the first step."
          ),
          A(
            'ask_question',
            'what got you looking into trading in the first place?'
          ),
          A('wait_for_response')
        ]
      }
    ]
  }
];

const fsm = compileScript(script);

describe('isAnswerableReply', () => {
  it('media placeholders do not answer an ask', () => {
    for (const t of [
      '[Image]',
      '[image]',
      '[Voice note]',
      '[video]',
      '[Sticker]',
      '[GIF]'
    ])
      assert.equal(isAnswerableReply(t), false, t);
  });

  it('bare emoji, punctuation and empty text do not answer an ask', () => {
    for (const t of ['🔥', '👍🏽', '?', '!!', '...', '   ', ''])
      assert.equal(isAnswerableReply(t), false, JSON.stringify(t));
  });

  it('terse but real answers DO credit the ask', () => {
    for (const t of ['NY', 'no', '2y', 'Houston', '5k', 'yes send it'])
      assert.equal(isAnswerableReply(t), true, t);
  });

  it('non-latin answers credit the ask (a lead answering in Arabic is not "no signal")', () => {
    for (const t of ['لاغوس', 'Москва', '東京'])
      assert.equal(isAnswerableReply(t), true, t);
  });

  it('emoji plus real text still counts', () => {
    assert.equal(isAnswerableReply('🔥 Houston'), true);
  });
});

describe('the No-signal step does not advance on an unreadable reply', () => {
  // We asked, so spokeInStep is true and a real answer would advance.
  const asked: FsmCursor = {
    stepNumber: 1,
    selectedBranchLabel: 'No signal',
    completedSteps: [],
    compilerVersion: fsm.compilerVersion,
    repliesInStep: 0,
    spokeInStep: true
  };

  it('an image reply holds the cursor at step 1', () => {
    const r = fsmTransition(fsm, asked, {
      type: 'LEAD_REPLIED',
      text: '[Image]'
    });
    assert.equal(r.advanced, false);
    assert.equal(r.reason, 'reply_carries_no_signal');
    assert.equal(r.cursor.stepNumber, 1);
  });

  it('a bare emoji reply holds the cursor at step 1', () => {
    const r = fsmTransition(fsm, asked, { type: 'LEAD_REPLIED', text: '🔥' });
    assert.equal(r.advanced, false);
    assert.equal(r.cursor.stepNumber, 1);
  });

  it('a real answer still advances to step 2 (no regression)', () => {
    const r = fsmTransition(fsm, asked, {
      type: 'LEAD_REPLIED',
      text: 'trying to figure out entries'
    });
    assert.equal(r.advanced, true);
    assert.equal(r.cursor.stepNumber, 2);
  });

  it("step 2's copy is therefore never in scope while the lead has not answered", () => {
    const held = fsmTransition(fsm, asked, {
      type: 'LEAD_REPLIED',
      text: '[Image]'
    }).cursor;
    const node = nodeForStep(fsm, held.stepNumber)!;
    const texts = node.edges.flatMap((e) =>
      e.deliverables
        .filter((d) => d.kind === 'send_message' || d.kind === 'ask')
        .map((d) => (d as { text: string }).text)
    );
    assert.ok(
      !texts.some((t) => t.includes('love to see it')),
      "step 2's new-to-markets copy is not reachable from the held cursor"
    );
  });
});
