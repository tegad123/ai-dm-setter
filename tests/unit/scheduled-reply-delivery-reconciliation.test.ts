import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { QualityGateEscalationError } from '../../src/lib/quality-gate-escalation';
import {
  reconcileScheduledReplyAfterError,
  scheduledReplyDeliveryCausalStart,
  type DeliveredAiMessageEvidence,
  type ScheduledReplyDeliveryReconciliationDependencies
} from '../../src/lib/scheduled-reply-delivery-reconciliation';

function qualityError(
  awaitingSince: Date | null,
  escalatedAt: Date | null = new Date('2026-09-18T10:01:02.000Z')
) {
  return new QualityGateEscalationError({
    conversationId: 'conv-1',
    accountId: 'acct-1',
    awaitingSince,
    escalatedAt,
    generatedResult: {
      reply: 'draft that did not pass',
      messages: ['draft that did not pass'],
      qualityGateTerminalFailure: true
    }
  });
}

function dependencies(input: {
  delivered: DeliveredAiMessageEvidence | null;
  clearCount?: number;
  clearError?: Error;
}) {
  const calls = {
    find: [] as Array<{ conversationId: string; since: Date }>,
    sent: [] as Array<{
      scheduledReplyId: string;
      deliveredMessage: DeliveredAiMessageEvidence;
      error: unknown;
    }>,
    clear: [] as Array<{
      conversationId: string;
      awaitingSince: Date;
      escalatedAt: Date;
    }>
  };
  const deps: ScheduledReplyDeliveryReconciliationDependencies = {
    async findDeliveredAiMessage(request) {
      calls.find.push(request);
      return input.delivered;
    },
    async markScheduledReplySent(request) {
      calls.sent.push(request);
    },
    async clearAttemptQualityHold(request) {
      calls.clear.push(request);
      if (input.clearError) throw input.clearError;
      return input.clearCount ?? 1;
    }
  };
  return { deps, calls };
}

describe('scheduled reply delivery reconciliation', () => {
  it('uses the quality failure lead timestamp as the causal boundary when newer', () => {
    const createdAt = new Date('2026-09-18T10:00:00.000Z');
    const awaitingSince = new Date('2026-09-18T10:03:00.000Z');

    assert.equal(
      scheduledReplyDeliveryCausalStart({
        scheduledReplyCreatedAt: createdAt,
        error: qualityError(awaitingSince)
      }).toISOString(),
      awaitingSince.toISOString()
    );
  });

  it('keeps the scheduled row boundary for ordinary errors and older lead timestamps', () => {
    const createdAt = new Date('2026-09-18T10:00:00.000Z');

    assert.equal(
      scheduledReplyDeliveryCausalStart({
        scheduledReplyCreatedAt: createdAt,
        error: new Error('network failure')
      }).toISOString(),
      createdAt.toISOString()
    );
    assert.equal(
      scheduledReplyDeliveryCausalStart({
        scheduledReplyCreatedAt: createdAt,
        error: qualityError(new Date('2026-09-18T09:59:00.000Z'))
      }).toISOString(),
      createdAt.toISOString()
    );
  });

  it('marks SENT when another path delivered a Meta MID before a terminal quality exception', async () => {
    const createdAt = new Date('2026-09-18T10:00:00.000Z');
    const awaitingSince = new Date('2026-09-18T10:00:30.000Z');
    const delivered = {
      id: 'ai-message-1',
      timestamp: new Date('2026-09-18T10:01:05.000Z'),
      platformMessageId: 'm_meta_confirmed_1'
    };
    const { deps, calls } = dependencies({ delivered });

    const result = await reconcileScheduledReplyAfterError(
      {
        scheduledReplyId: 'reply-1',
        conversationId: 'conv-1',
        scheduledReplyCreatedAt: createdAt,
        reviewHoldExistedBeforeAttempt: false,
        error: qualityError(awaitingSince)
      },
      deps
    );

    assert.equal(result?.deliveredMessage.id, delivered.id);
    assert.equal(result?.clearedAttemptQualityHold, true);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.sent[0]?.scheduledReplyId, 'reply-1');
    assert.equal(calls.clear.length, 1);
    assert.equal(calls.clear[0]?.awaitingSince, awaitingSince);
    assert.equal(
      calls.clear[0]?.escalatedAt.toISOString(),
      '2026-09-18T10:01:02.000Z'
    );
    assert.equal(calls.find[0]?.since, awaitingSince);
  });

  it('marks the delivered row SENT without clearing an older review hold', async () => {
    const delivered = {
      id: 'ai-message-2',
      timestamp: new Date('2026-09-18T10:01:05.000Z'),
      platformMessageId: 'm_meta_confirmed_2'
    };
    const { deps, calls } = dependencies({ delivered });

    const result = await reconcileScheduledReplyAfterError(
      {
        scheduledReplyId: 'reply-2',
        conversationId: 'conv-1',
        scheduledReplyCreatedAt: new Date('2026-09-18T10:00:00.000Z'),
        reviewHoldExistedBeforeAttempt: true,
        error: qualityError(new Date('2026-09-18T10:00:30.000Z'))
      },
      deps
    );

    assert.equal(result?.deliveredMessage.id, delivered.id);
    assert.equal(result?.clearedAttemptQualityHold, false);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.clear.length, 0);
  });

  it('does not clear a review hold when the pre-attempt state was unavailable', async () => {
    const { deps, calls } = dependencies({
      delivered: {
        id: 'ai-message-3',
        timestamp: new Date('2026-09-18T10:01:05.000Z'),
        platformMessageId: 'm_meta_confirmed_3'
      }
    });

    const result = await reconcileScheduledReplyAfterError(
      {
        scheduledReplyId: 'reply-3',
        conversationId: 'conv-1',
        scheduledReplyCreatedAt: new Date('2026-09-18T10:00:00.000Z'),
        reviewHoldExistedBeforeAttempt: null,
        error: qualityError(new Date('2026-09-18T10:00:30.000Z'))
      },
      deps
    );

    assert.equal(result?.clearedAttemptQualityHold, false);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.clear.length, 0);
  });

  it('does not clear a hold when the quality exception lacks an exact escalation timestamp', async () => {
    const { deps, calls } = dependencies({
      delivered: {
        id: 'ai-message-4',
        timestamp: new Date('2026-09-18T10:01:05.000Z'),
        platformMessageId: 'm_meta_confirmed_4'
      }
    });

    const result = await reconcileScheduledReplyAfterError(
      {
        scheduledReplyId: 'reply-4',
        conversationId: 'conv-1',
        scheduledReplyCreatedAt: new Date('2026-09-18T10:00:00.000Z'),
        reviewHoldExistedBeforeAttempt: false,
        error: qualityError(new Date('2026-09-18T10:00:30.000Z'), null)
      },
      deps
    );

    assert.equal(result?.clearedAttemptQualityHold, false);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.clear.length, 0);
  });

  it('keeps the delivered row reconciled when best-effort hold cleanup fails', async () => {
    const { deps, calls } = dependencies({
      delivered: {
        id: 'ai-message-5',
        timestamp: new Date('2026-09-18T10:01:05.000Z'),
        platformMessageId: 'm_meta_confirmed_5'
      },
      clearError: new Error('transient database failure')
    });

    const result = await reconcileScheduledReplyAfterError(
      {
        scheduledReplyId: 'reply-5',
        conversationId: 'conv-1',
        scheduledReplyCreatedAt: new Date('2026-09-18T10:00:00.000Z'),
        reviewHoldExistedBeforeAttempt: false,
        error: qualityError(new Date('2026-09-18T10:00:30.000Z'))
      },
      deps
    );

    assert.equal(result?.deliveredMessage.id, 'ai-message-5');
    assert.equal(result?.clearedAttemptQualityHold, false);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.clear.length, 1);
  });

  it('leaves terminal handling to the caller when no Meta-confirmed delivery exists', async () => {
    const { deps, calls } = dependencies({ delivered: null });

    const result = await reconcileScheduledReplyAfterError(
      {
        scheduledReplyId: 'reply-6',
        conversationId: 'conv-1',
        scheduledReplyCreatedAt: new Date('2026-09-18T10:00:00.000Z'),
        reviewHoldExistedBeforeAttempt: false,
        error: qualityError(new Date('2026-09-18T10:00:30.000Z'))
      },
      deps
    );

    assert.equal(result, null);
    assert.equal(calls.sent.length, 0);
    assert.equal(calls.clear.length, 0);
  });
});
