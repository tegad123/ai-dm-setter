import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  appendAutoClearedStaleReviewEvent,
  AUTO_CLEARED_STALE_REVIEW_EVENT,
  shouldAutoClearAwaitingHumanReview
} from '../../src/lib/stale-human-review';

describe('stale human review auto-clear', () => {
  it('clears review holds when a new lead message arrives and AI is active', () => {
    assert.equal(
      shouldAutoClearAwaitingHumanReview({
        awaitingHumanReview: true,
        aiActive: true,
        distressDetected: false
      }),
      true
    );
  });

  it('does not clear when AI is paused for a protected hold', () => {
    assert.equal(
      shouldAutoClearAwaitingHumanReview({
        awaitingHumanReview: true,
        aiActive: false,
        distressDetected: false
      }),
      false
    );
    assert.equal(
      shouldAutoClearAwaitingHumanReview({
        awaitingHumanReview: true,
        aiActive: true,
        distressDetected: true
      }),
      false
    );
  });

  it('does not clear when the conversation is not awaiting review', () => {
    assert.equal(
      shouldAutoClearAwaitingHumanReview({
        awaitingHumanReview: false,
        aiActive: true,
        distressDetected: false
      }),
      false
    );
  });

  it('appends a durable auto-cleared review event without dropping captured data', () => {
    const captured = appendAutoClearedStaleReviewEvent(
      { obstacle: { value: 'revenge trading' }, reviewEvents: [] },
      {
        eventType: AUTO_CLEARED_STALE_REVIEW_EVENT,
        conversationId: 'conv_123',
        leadMessageId: 'msg_123',
        leadMessagePreview: 'hey bro',
        clearedAt: '2026-05-11T22:15:58.587Z',
        reason: 'Lead sent a new message.'
      }
    ) as Record<string, unknown>;

    assert.deepEqual(captured.obstacle, { value: 'revenge trading' });
    const events = captured.reviewEvents as Array<Record<string, unknown>>;
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, AUTO_CLEARED_STALE_REVIEW_EVENT);
    assert.equal(events[0].leadMessagePreview, 'hey bro');
  });
});
