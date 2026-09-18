import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessMetaWebhookSubscription,
  buildMetaInstagramSubscriptionPayload,
  buildMetaPageSubscriptionPayload,
  META_SUBSCRIPTION_ALERT_THROTTLE_MS
} from '../../src/lib/meta-webhook-subscription';

const requiredFields = ['messages', 'message_echoes', 'messaging_postbacks'];

describe('Meta webhook subscription health', () => {
  it('reports a complete subscription as healthy', () => {
    assert.deepEqual(
      assessMetaWebhookSubscription({
        pageId: 'page-1',
        appSubscribed: true,
        subscribedFields: requiredFields
      }),
      { healthy: true, missingFields: [] }
    );
  });

  it('describes missing message_echoes without claiming inbound DMs are lost', () => {
    const result = assessMetaWebhookSubscription({
      pageId: 'page-1',
      appSubscribed: true,
      subscribedFields: ['messages', 'messaging_postbacks']
    });

    assert.equal(result.healthy, false);
    assert.deepEqual(result.missingFields, ['message_echoes']);
    assert.equal(
      result.alertTitle,
      'Meta webhook subscription issue: missing message_echoes'
    );
    assert.match(result.alertBody ?? '', /Inbound lead DMs still reach Convlo/);
    assert.match(result.alertBody ?? '', /will not be mirrored into Convlo/);
    assert.doesNotMatch(
      result.alertBody ?? '',
      /New inbound lead DMs will not reach Convlo/
    );
  });

  it('identifies a real inbound outage when messages is missing', () => {
    const result = assessMetaWebhookSubscription({
      pageId: 'page-2',
      appSubscribed: true,
      subscribedFields: ['message_echoes', 'messaging_postbacks']
    });

    assert.deepEqual(result.missingFields, ['messages']);
    assert.match(
      result.alertBody ?? '',
      /New inbound lead DMs will not reach Convlo/
    );
  });

  it('distinguishes postback loss from text DM delivery', () => {
    const result = assessMetaWebhookSubscription({
      pageId: 'page-3',
      appSubscribed: true,
      subscribedFields: ['messages', 'message_echoes']
    });

    assert.deepEqual(result.missingFields, ['messaging_postbacks']);
    assert.match(result.alertBody ?? '', /Text DMs still reach Convlo/);
    assert.match(result.alertBody ?? '', /button and postback interactions/);
  });

  it('reports complete event loss when the app is not subscribed', () => {
    const result = assessMetaWebhookSubscription({
      pageId: 'page-4',
      appSubscribed: false
    });

    assert.equal(
      result.alertTitle,
      'Meta webhook subscription issue: app not subscribed'
    );
    assert.deepEqual(result.missingFields, requiredFields);
    assert.match(result.alertBody ?? '', /Inbound lead DMs/);
    assert.match(result.alertBody ?? '', /messages sent outside Convlo/);
  });

  it('builds every Page subscription with message echoes', () => {
    const payload = buildMetaPageSubscriptionPayload('page-token');
    const fields = payload.subscribed_fields.split(',');

    assert.equal(payload.access_token, 'page-token');
    assert.ok(fields.includes('messages'));
    assert.ok(fields.includes('message_echoes'));
    assert.ok(fields.includes('messaging_postbacks'));
    assert.ok(fields.includes('message_deliveries'));
    assert.ok(fields.includes('message_reads'));
  });

  it('keeps the Instagram account subscription field set platform-specific', () => {
    const payload = buildMetaInstagramSubscriptionPayload('ig-token');
    const fields = payload.subscribed_fields.split(',');

    assert.equal(payload.access_token, 'ig-token');
    assert.ok(fields.includes('messages'));
    assert.ok(fields.includes('message_echoes'));
    assert.ok(fields.includes('messaging_postbacks'));
    assert.equal(fields.includes('message_deliveries'), false);
  });

  it('throttles an unchanged subscription incident for 24 hours', () => {
    assert.equal(META_SUBSCRIPTION_ALERT_THROTTLE_MS, 24 * 60 * 60 * 1000);
  });
});
