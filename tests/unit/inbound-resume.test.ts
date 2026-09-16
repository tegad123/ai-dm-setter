import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { shouldResumeInterruptedInbound } from '../../src/lib/webhook-processor';

describe('interrupted inbound resume', () => {
  const now = new Date('2026-09-16T04:00:00.000Z');
  const oldMessage = new Date('2026-09-16T03:58:00.000Z');

  it('resumes a saved inbound with no reply work and no outbound', () => {
    assert.equal(
      shouldResumeInterruptedInbound({
        messageTimestamp: oldMessage,
        now,
        hasReplyWork: false,
        hasOutboundAfter: false
      }),
      true
    );
  });

  it('does not race an invocation that may still be processing', () => {
    assert.equal(
      shouldResumeInterruptedInbound({
        messageTimestamp: new Date('2026-09-16T03:59:30.000Z'),
        now,
        hasReplyWork: false,
        hasOutboundAfter: false
      }),
      false
    );
  });

  it('does not regenerate when reply work or an outbound already exists', () => {
    for (const state of [
      { hasReplyWork: true, hasOutboundAfter: false },
      { hasReplyWork: false, hasOutboundAfter: true }
    ]) {
      assert.equal(
        shouldResumeInterruptedInbound({
          messageTimestamp: oldMessage,
          now,
          ...state
        }),
        false
      );
    }
  });
});
