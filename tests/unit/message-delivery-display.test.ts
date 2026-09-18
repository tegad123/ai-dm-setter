import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countsAsConversationMessage,
  effectiveManyChatDeliveryStatus,
  manyChatDeliveryLabel
} from '../../src/lib/message-delivery-display';

describe('ManyChat delivery presentation', () => {
  it('treats a legacy ManyChat row without a Meta id as planned context', () => {
    const message = {
      sender: 'MANYCHAT',
      msgSource: 'MANYCHAT_FLOW',
      platformMessageId: null,
      deliveryStatus: null
    } as const;

    assert.equal(effectiveManyChatDeliveryStatus(message), 'PLANNED');
    assert.equal(countsAsConversationMessage(message), false);
    assert.equal(manyChatDeliveryLabel(message), 'Planned context · not sent');
  });

  it('keeps a legacy ManyChat id unverified because old rows mixed provider and Meta ids', () => {
    const message = {
      sender: 'MANYCHAT',
      platformMessageId: 'mid.123',
      deliveryStatus: null
    } as const;

    assert.equal(effectiveManyChatDeliveryStatus(message), 'PROVIDER_REPORTED');
    assert.equal(countsAsConversationMessage(message), true);
    assert.equal(
      manyChatDeliveryLabel(message),
      'Reported by ManyChat · awaiting Meta confirmation'
    );
  });

  it('labels provider acknowledgement without claiming Meta delivery', () => {
    const message = {
      sender: 'MANYCHAT',
      providerMessageId: 'manychat-operation-1',
      platformMessageId: null,
      deliveryStatus: 'PROVIDER_REPORTED'
    } as const;

    assert.equal(effectiveManyChatDeliveryStatus(message), 'PROVIDER_REPORTED');
    assert.equal(
      manyChatDeliveryLabel(message),
      'Reported by ManyChat · awaiting Meta confirmation'
    );
    assert.equal(countsAsConversationMessage(message), true);
  });

  it('keeps failed delivery visible as an audit event but out of counts', () => {
    const message = {
      sender: 'MANYCHAT',
      deliveryStatus: 'FAILED'
    } as const;

    assert.equal(manyChatDeliveryLabel(message), 'Delivery failed');
    assert.equal(countsAsConversationMessage(message), false);
  });

  it('does not reinterpret ordinary AI and lead messages', () => {
    assert.equal(effectiveManyChatDeliveryStatus({ sender: 'AI' }), null);
    assert.equal(countsAsConversationMessage({ sender: 'LEAD' }), true);
  });
});
