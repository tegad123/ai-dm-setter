import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeManyChatAutomationEcho } from '../../src/lib/manychat-echo-classifier';

const firedAt = new Date('2026-09-18T18:00:00.000Z');
const conversation = {
  source: 'MANYCHAT',
  manyChatOpenerMessage: 'are you new to trading?',
  manyChatFiredAt: firedAt
};
const duringFlow = new Date('2026-09-18T18:05:00.000Z');

test('uncorrelated phone echo is not inferred as ManyChat from waiting state', () => {
  assert.equal(
    looksLikeManyChatAutomationEcho(
      conversation,
      'manual note from the phone',
      'meta-mid-phone',
      duringFlow
    ),
    false
  );
});

test('exact configured opener with a Meta mid is recognized inside the automation window', () => {
  assert.equal(
    looksLikeManyChatAutomationEcho(
      conversation,
      'are you new to trading?',
      'meta-mid-opener',
      duringFlow
    ),
    true
  );
});

test('content match without a Meta mid or outside the bounded window is not enough', () => {
  assert.equal(
    looksLikeManyChatAutomationEcho(
      conversation,
      'are you new to trading?',
      undefined,
      duringFlow
    ),
    false
  );
  assert.equal(
    looksLikeManyChatAutomationEcho(
      conversation,
      'are you new to trading?',
      'meta-mid-late',
      new Date('2026-09-18T21:00:00.000Z')
    ),
    false
  );
});
