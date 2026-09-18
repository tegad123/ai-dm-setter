import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyInstagramMetaHistoryMessage,
  looksLikeManyChatAutomationEcho
} from '../../src/lib/manychat-echo-classifier';
import { isManyChatFirstReplyTurn } from '../../src/lib/manychat-first-reply-routing';

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

test('Instagram history identifies the lead by platform user id', () => {
  assert.equal(
    classifyInstagramMetaHistoryMessage({
      conversation,
      messageText: 'starting',
      platformMessageId: 'meta-mid-lead',
      fromId: 'lead-igsid',
      platformUserId: 'lead-igsid',
      timestamp: duringFlow
    }),
    'LEAD'
  );
});

test('Instagram history attributes an exact confirmed opener to ManyChat inside the bounded window', () => {
  const sender = classifyInstagramMetaHistoryMessage({
    conversation,
    messageText: conversation.manyChatOpenerMessage,
    platformMessageId: 'meta-mid-opener',
    fromId: 'instagram-business-id',
    platformUserId: 'lead-igsid',
    timestamp: duringFlow
  });
  assert.equal(sender, 'MANYCHAT');

  const leadMessage = { id: 'queued-first-reply', sender: 'LEAD' };
  assert.equal(
    isManyChatFirstReplyTurn({
      conversationSource: conversation.source,
      openerMessage: conversation.manyChatOpenerMessage,
      currentLeadMessageId: leadMessage.id,
      currentScriptStep: 1,
      conversationHistory: [
        {
          id: 'meta-mid-opener',
          sender,
          content: conversation.manyChatOpenerMessage,
          deliveryStatus: 'META_CONFIRMED'
        },
        leadMessage
      ],
      handoffReceipt: {
        leadMessageId: leadMessage.id,
        status: 'QUEUED'
      }
    }),
    true,
    'a Meta-backfilled opener must not hide the queued first-reply receipt'
  );
});

test('Instagram history keeps unrelated account-side messages attributed to AI', () => {
  assert.equal(
    classifyInstagramMetaHistoryMessage({
      conversation,
      messageText: 'manual or Convlo account-side message',
      platformMessageId: 'meta-mid-account-side',
      fromId: 'instagram-business-id',
      platformUserId: 'lead-igsid',
      timestamp: duringFlow
    }),
    'AI'
  );
});

test('Instagram history does not invent a lead-side message when Meta omits from.id', () => {
  assert.equal(
    classifyInstagramMetaHistoryMessage({
      conversation,
      messageText: 'account-side message with incomplete sender metadata',
      platformMessageId: 'meta-mid-missing-from',
      fromId: undefined,
      platformUserId: 'lead-igsid',
      timestamp: duringFlow
    }),
    'AI'
  );
});

test('Instagram history does not promote an exact opener outside the correlation window', () => {
  assert.equal(
    classifyInstagramMetaHistoryMessage({
      conversation,
      messageText: conversation.manyChatOpenerMessage,
      platformMessageId: 'meta-mid-late-opener',
      fromId: 'instagram-business-id',
      platformUserId: 'lead-igsid',
      timestamp: new Date('2026-09-18T21:00:00.000Z')
    }),
    'AI'
  );
});
