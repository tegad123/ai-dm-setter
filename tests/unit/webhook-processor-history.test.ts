import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  formatMessagesForGenerateReply,
  mergeMetaHistoryBackfill,
  suggestionIdForDeliveredBubble
} from '../../src/lib/webhook-processor';
import { isManyChatFirstReplyTurn } from '../../src/lib/manychat-first-reply-routing';

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

  it('keeps a queued first reply routable after Meta backfills the confirmed ManyChat opener', async () => {
    const opener = 'are you new to trading?';
    const leadMessage = {
      id: 'queued-lead-reply',
      conversationId: 'conversation-1',
      sender: 'LEAD',
      content: 'starting',
      timestamp: new Date('2026-09-18T18:01:00.000Z'),
      platformMessageId: null,
      deliveryStatus: null
    };
    const messages: Array<Record<string, unknown>> = [leadMessage];

    await mergeMetaHistoryBackfill(
      {
        conversationId: 'conversation-1',
        platform: 'INSTAGRAM',
        platformUserId: 'lead-igsid',
        pageId: null,
        conversation: {
          source: 'MANYCHAT',
          manyChatOpenerMessage: opener,
          manyChatFiredAt: new Date('2026-09-18T18:00:00.000Z')
        },
        resetAtMs: 0,
        // Meta returns newest first. The merge restores chronological order.
        apiMessages: [
          {
            id: 'meta-lead-reply',
            message: 'starting',
            from: { id: 'lead-igsid' },
            createdTime: '2026-09-18T18:01:00.000Z'
          },
          {
            id: 'meta-opener',
            message: opener,
            from: { id: 'instagram-business-id' },
            createdTime: '2026-09-18T18:00:05.000Z'
          }
        ]
      },
      {
        findExistingMessages: async () => [leadMessage],
        createMessage: async (data) => {
          messages.push({ id: `created-${messages.length}`, ...data });
          return messages.at(-1)!;
        },
        persistManyChatEcho: async (data) => {
          const message = {
            id: 'confirmed-opener',
            conversationId: data.conversationId,
            sender: 'MANYCHAT',
            msgSource: 'MANYCHAT_FLOW',
            content: data.messageText,
            timestamp: data.receivedAt!,
            platformMessageId: data.platformMessageId!,
            deliveryStatus: 'META_CONFIRMED',
            deliveryConfirmedAt: data.receivedAt!
          };
          messages.push(message);
          return {
            message: message as never,
            classification: 'MANYCHAT',
            disposition: 'CREATED'
          };
        }
      }
    );

    const history = messages
      .toSorted(
        (left, right) =>
          (left.timestamp as Date).getTime() -
          (right.timestamp as Date).getTime()
      )
      .map((message) => ({
        id: message.id as string,
        sender: message.sender as string,
        content: message.content as string,
        deliveryStatus: (message.deliveryStatus as string | null) ?? null
      }));
    assert.equal(messages.length, 2);
    assert.deepEqual(history[0], {
      id: 'confirmed-opener',
      sender: 'MANYCHAT',
      content: opener,
      deliveryStatus: 'META_CONFIRMED'
    });
    assert.equal(
      isManyChatFirstReplyTurn({
        conversationSource: 'MANYCHAT',
        openerMessage: opener,
        currentLeadMessageId: leadMessage.id,
        conversationHistory: history,
        currentScriptStep: 1,
        handoffReceipt: {
          leadMessageId: leadMessage.id,
          status: 'QUEUED'
        }
      }),
      true
    );
  });

  it('uses Instagram participant identity while merging non-opener Meta history', async () => {
    const created: Array<Record<string, unknown>> = [];
    await mergeMetaHistoryBackfill(
      {
        conversationId: 'conversation-2',
        platform: 'INSTAGRAM',
        platformUserId: 'lead-igsid',
        pageId: null,
        conversation: {
          source: 'MANYCHAT',
          manyChatOpenerMessage: 'are you new to trading?',
          manyChatFiredAt: new Date('2026-09-18T18:00:00.000Z')
        },
        resetAtMs: 0,
        apiMessages: [
          {
            id: 'late-exact-copy',
            message: 'are you new to trading?',
            from: { id: 'instagram-business-id' },
            createdTime: '2026-09-18T21:00:00.000Z'
          },
          {
            id: 'unrelated-outbound',
            message: 'manual account-side follow-up',
            from: { id: 'instagram-business-id' },
            createdTime: '2026-09-18T18:06:00.000Z'
          },
          {
            id: 'lead-message',
            message: 'starting',
            from: { id: 'lead-igsid' },
            createdTime: '2026-09-18T18:05:00.000Z'
          }
        ]
      },
      {
        findExistingMessages: async () => [],
        createMessage: async (data) => {
          created.push(data as unknown as Record<string, unknown>);
          return data as never;
        },
        persistManyChatEcho: async () => {
          assert.fail('no non-opener message should be promoted to ManyChat');
        }
      }
    );

    assert.deepEqual(
      created.map((message) => [message.platformMessageId, message.sender]),
      [
        ['lead-message', 'LEAD'],
        ['unrelated-outbound', 'AI'],
        ['late-exact-copy', 'AI']
      ]
    );
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
