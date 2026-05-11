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
