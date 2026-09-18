import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildNearDuplicateSuppressionMutation,
  isScheduledReplyNoSendForLeadTurn,
  NEAR_DUPLICATE_ANSWERED_MARKER,
  parseScheduledReplyNoSendOutcome,
  recordNearDuplicateAnsweredSuppression,
  SUGGESTION_ONLY_MARKER,
  type NearDuplicateSuppressionPersistence
} from '../../src/lib/scheduled-reply-no-send';

describe('scheduled reply intentional no-send outcomes', () => {
  it('recognizes both durable successful no-send reasons', () => {
    assert.deepEqual(
      parseScheduledReplyNoSendOutcome({
        status: 'CANCELLED',
        lastError: SUGGESTION_ONLY_MARKER
      }),
      { reason: 'suggestion_only', marker: SUGGESTION_ONLY_MARKER }
    );
    assert.deepEqual(
      parseScheduledReplyNoSendOutcome({
        status: 'CANCELLED',
        lastError: NEAR_DUPLICATE_ANSWERED_MARKER
      }),
      {
        reason: 'near_duplicate_answered',
        marker: NEAR_DUPLICATE_ANSWERED_MARKER
      }
    );
  });

  it('does not excuse a failed or still-processing job with marker-like text', () => {
    for (const status of ['FAILED', 'PROCESSING', 'PENDING', 'SENT']) {
      assert.equal(
        parseScheduledReplyNoSendOutcome({
          status,
          lastError: NEAR_DUPLICATE_ANSWERED_MARKER
        }),
        null
      );
    }
    assert.equal(
      parseScheduledReplyNoSendOutcome({
        status: 'CANCELLED',
        lastError: 'some other cancellation'
      }),
      null
    );
  });

  it('blocks ManyChat fallback only for the lead turn that was intentionally closed', () => {
    const closedAt = new Date('2026-09-18T15:30:00.000Z');
    const row = {
      status: 'CANCELLED',
      lastError: NEAR_DUPLICATE_ANSWERED_MARKER,
      createdAt: closedAt
    };

    assert.equal(
      isScheduledReplyNoSendForLeadTurn(
        row,
        new Date('2026-09-18T15:29:59.000Z')
      ),
      true
    );
    assert.equal(
      isScheduledReplyNoSendForLeadTurn(
        row,
        new Date('2026-09-18T15:31:00.000Z')
      ),
      false,
      'an older cancellation must not hide a later unanswered lead turn'
    );
  });

  it('cancels active queue rows and clears the pending-response flags', () => {
    const processedAt = new Date('2026-09-18T15:30:00.000Z');

    assert.deepEqual(
      buildNearDuplicateSuppressionMutation(
        'conv-lifeofjacklin',
        processedAt,
        'reply-lifeofjacklin',
        NEAR_DUPLICATE_ANSWERED_MARKER
      ),
      {
        scheduledReply: {
          where: {
            conversationId: 'conv-lifeofjacklin',
            id: 'reply-lifeofjacklin',
            status: { in: ['PENDING', 'PROCESSING'] }
          },
          data: {
            status: 'CANCELLED',
            processedAt,
            lastError: NEAR_DUPLICATE_ANSWERED_MARKER
          }
        },
        conversation: {
          where: { id: 'conv-lifeofjacklin' },
          data: {
            awaitingAiResponse: false,
            awaitingSince: null
          }
        }
      }
    );
  });

  it('records the near-duplicate outcome once without returning a retryable failure', async () => {
    const calls: Array<{
      conversationId: string;
      scheduledReplyId?: string;
      processedAt: Date;
      marker: string;
    }> = [];
    const persistence: NearDuplicateSuppressionPersistence = {
      async persist(input) {
        calls.push(input);
      }
    };

    await recordNearDuplicateAnsweredSuppression(
      'conv-aloysx7',
      'reply-aloysx7',
      persistence
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.conversationId, 'conv-aloysx7');
    assert.equal(calls[0]?.scheduledReplyId, 'reply-aloysx7');
    assert.equal(calls[0]?.marker, NEAR_DUPLICATE_ANSWERED_MARKER);
    assert.ok(calls[0]?.processedAt instanceof Date);
  });
});
