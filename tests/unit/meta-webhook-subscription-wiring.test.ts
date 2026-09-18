import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Meta Page webhook subscription wiring', () => {
  it('uses the field-specific assessment and 24-hour exact-incident throttle', () => {
    const route = source('src/app/api/cron/meta-health/route.ts');
    assert.match(route, /assessMetaWebhookSubscription\(\{/);
    assert.match(
      route,
      /assessment\.alertBody,\s*META_SUBSCRIPTION_ALERT_THROTTLE_MS,\s*true/
    );
  });

  it('uses the shared complete Page payload in the manual repair route', () => {
    const route = source('src/app/api/webhooks/subscribe/route.ts');
    assert.match(route, /buildMetaPageSubscriptionPayload\(accessToken\)/);
    assert.match(route, /buildMetaInstagramSubscriptionPayload\(accessToken\)/);
  });

  it('uses the shared complete Page payload in every Meta reconnect path', () => {
    const route = source('src/app/api/auth/meta/callback/route.ts');
    assert.equal(route.match(/buildMetaPageSubscriptionPayload\(/g)?.length, 3);
  });

  it('does not let a direct Instagram reconnect drop message_echoes from the linked Page', () => {
    const route = source('src/app/api/auth/instagram/callback/route.ts');
    assert.match(route, /buildMetaPageSubscriptionPayload\(accessToken\)/);
    assert.doesNotMatch(
      route,
      /async function subscribePageToWebhooks[\s\S]*?subscribed_fields\s*:/
    );
  });
});
