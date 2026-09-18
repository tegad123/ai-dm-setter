import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  formatMessagesForGenerateReply,
  suggestionIdForDeliveredBubble
} from '../../src/lib/webhook-processor';

describe('webhook processor generation history metadata', () => {
  it('passes suggestionId through to generateReply history', () => {
    const [aiMessage, leadMessage] = formatMessagesForGenerateReply([
      {
        id: 'msg_ai_1',
        sender: 'AI',
        content: 'give me a bit more context',
        timestamp: new Date('2026-05-11T09:20:00.000Z'),
        suggestionId: 'sug_step_4',
        messageGroupId: 'group_1',
        bubbleIndex: 0,
        bubbleTotalCount: 2
      },
      {
        id: 'msg_lead_1',
        sender: 'LEAD',
        content: 'I keep revenge trading after losses',
        timestamp: new Date('2026-05-11T09:21:00.000Z'),
        suggestionId: null
      }
    ]);

    assert.equal(aiMessage.suggestionId, 'sug_step_4');
    assert.equal(leadMessage.suggestionId, null);
  });

  it('keeps unverified ManyChat rows out of the actual generation history', () => {
    const formatted = formatMessagesForGenerateReply([
      {
        id: 'lead-1',
        sender: 'LEAD',
        content: 'starting',
        timestamp: new Date('2026-09-18T18:00:00.000Z')
      },
      {
        id: 'legacy-phantom',
        sender: 'MANYCHAT',
        content: 'planned opener',
        timestamp: new Date('2026-09-18T18:00:01.000Z'),
        deliveryStatus: null
      },
      {
        id: 'provisional-human-echo',
        sender: 'HUMAN',
        content: 'source attribution is still pending',
        timestamp: new Date('2026-09-18T18:00:01.500Z'),
        deliveryStatus: 'META_CONFIRMED',
        echoAttributionPendingUntil: new Date('2026-09-18T18:02:00.000Z')
      },
      {
        id: 'provider-reported',
        sender: 'MANYCHAT',
        content: 'provider says this was sent',
        timestamp: new Date('2026-09-18T18:00:02.000Z'),
        deliveryStatus: 'PROVIDER_REPORTED'
      },
      {
        id: 'meta-confirmed',
        sender: 'MANYCHAT',
        content: 'Meta echoed this send',
        timestamp: new Date('2026-09-18T18:00:03.000Z'),
        deliveryStatus: 'META_CONFIRMED'
      }
    ]);

    assert.deepEqual(
      formatted.map((message) => message.id),
      ['lead-1', 'provider-reported', 'meta-confirmed']
    );
    assert.deepEqual(
      formatted.map((message) => message.deliveryStatus ?? null),
      [null, 'PROVIDER_REPORTED', 'META_CONFIRMED']
    );
  });

  it('tags every delivered bubble with the AISuggestion id', () => {
    const bubbleSuggestionIds = ['bubble 0', 'bubble 1', 'bubble 2'].map(() =>
      suggestionIdForDeliveredBubble('sug_multi_bubble')
    );

    assert.deepEqual(bubbleSuggestionIds, [
      'sug_multi_bubble',
      'sug_multi_bubble',
      'sug_multi_bubble'
    ]);
  });
});
