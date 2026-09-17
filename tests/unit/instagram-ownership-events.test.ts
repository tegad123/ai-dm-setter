import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractInstagramOwnershipEvents } from '../../src/lib/instagram-ownership-events';

describe('Instagram ownership event extraction', () => {
  it('extracts previous and new owners from a pass event', () => {
    const events = extractInstagramOwnershipEvents({
      messaging: [
        {
          sender: { id: 'lead' },
          recipient: { id: 'ig-business' },
          timestamp: 1789600000000,
          pass_thread_control: {
            previous_owner_app_id: '532160876956612',
            new_owner_app_id: '2027287141168190'
          }
        }
      ]
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'pass_thread_control');
    assert.equal(events[0].previousOwnerAppId, '532160876956612');
    assert.equal(events[0].newOwnerAppId, '2027287141168190');
    assert.equal(events[0].recipientId, 'ig-business');
    assert.equal(events[0].eventTimestamp?.getTime(), 1789600000000);
  });

  it('classifies standby messages for audit-only handling', () => {
    const events = extractInstagramOwnershipEvents({
      standby: [
        {
          sender: { id: 'lead' },
          recipient: { id: 'ig-business' },
          message: { mid: 'mid-1', text: 'hello' }
        }
      ]
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'standby_message');
    assert.equal(events[0].channel, 'standby');
  });

  it('extracts change-field ownership notifications', () => {
    const events = extractInstagramOwnershipEvents({
      time: 1789600000,
      changes: [
        {
          field: 'messaging_handover',
          value: {
            recipient_id: 'ig-business',
            previous_owner_app_id: 532160876956612,
            new_owner_app_id: 2027287141168190
          }
        }
      ]
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, 'changes');
    assert.equal(events[0].previousOwnerAppId, '532160876956612');
    assert.equal(events[0].newOwnerAppId, '2027287141168190');
    assert.equal(events[0].eventTimestamp?.getTime(), 1789600000000);
  });

  it('ignores ordinary messaging events', () => {
    assert.deepEqual(
      extractInstagramOwnershipEvents({
        messaging: [
          {
            sender: { id: 'lead' },
            recipient: { id: 'ig-business' },
            message: { mid: 'mid-1', text: 'hello' }
          }
        ]
      }),
      []
    );
  });
});

for (const channel of ['messaging', 'standby', 'changes'] as const) {
  it(`does not turn an ownership request into a new owner on ${channel}`, () => {
    const request = { requested_owner_app_id: 'requester' };
    const entry =
      channel === 'changes'
        ? { changes: [{ field: 'messaging_handover', value: request }] }
        : { [channel]: [{ request_thread_control: request }] };
    const [event] = extractInstagramOwnershipEvents(entry);
    assert.equal(event.newOwnerAppId, null);
    assert.ok(JSON.stringify(event.payload).includes('requester'));
  });
}
