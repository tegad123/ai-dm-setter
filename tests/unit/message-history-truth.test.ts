import assert from 'node:assert/strict';
import test from 'node:test';

import { MessageDeliveryStatus } from '@prisma/client';

import {
  AI_HISTORY_DELIVERY_WHERE,
  filterAiEligibleMessageHistory,
  isMessageEligibleForAiHistory
} from '../../src/lib/message-history-truth';

test('AI history excludes unproven ManyChat rows without guessing from a legacy id', () => {
  const rows = [
    { id: 'lead', sender: 'LEAD', deliveryStatus: null },
    {
      id: 'provisional-human-echo',
      sender: 'HUMAN',
      deliveryStatus: 'META_CONFIRMED',
      echoAttributionPendingUntil: new Date('2026-09-18T18:02:00Z')
    },
    {
      id: 'legacy-provider-id-in-meta-column',
      sender: 'MANYCHAT',
      deliveryStatus: null,
      platformMessageId: 'manychat-id-that-is-not-a-meta-mid'
    },
    {
      id: 'planned',
      sender: 'MANYCHAT',
      deliveryStatus: MessageDeliveryStatus.PLANNED
    },
    {
      id: 'failed',
      sender: 'MANYCHAT',
      deliveryStatus: MessageDeliveryStatus.FAILED
    },
    {
      id: 'provider',
      sender: 'MANYCHAT',
      deliveryStatus: MessageDeliveryStatus.PROVIDER_REPORTED
    },
    {
      id: 'meta',
      sender: 'MANYCHAT',
      deliveryStatus: MessageDeliveryStatus.META_CONFIRMED
    }
  ];

  assert.deepEqual(
    filterAiEligibleMessageHistory(rows).map((row) => row.id),
    ['lead', 'provider', 'meta']
  );
  assert.equal(isMessageEligibleForAiHistory(rows[1]), false);
});

test('database history filter requires explicit ManyChat delivery evidence', () => {
  assert.deepEqual(AI_HISTORY_DELIVERY_WHERE, {
    echoAttributionPendingUntil: null,
    OR: [
      { sender: { not: 'MANYCHAT' } },
      {
        sender: 'MANYCHAT',
        deliveryStatus: {
          in: [
            MessageDeliveryStatus.PROVIDER_REPORTED,
            MessageDeliveryStatus.META_CONFIRMED
          ]
        }
      }
    ]
  });
});
