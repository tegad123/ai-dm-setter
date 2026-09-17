import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldPreserveDirectInstagramCredential } from '../../src/lib/meta-instagram-credential-policy';

describe('Facebook reconnect Instagram credential policy', () => {
  it('preserves a direct Instagram Login credential', () => {
    assert.equal(
      shouldPreserveDirectInstagramCredential({
        igProfessionalAccountId: '17841403104278070',
        webhookSubscribed: true
      }),
      true
    );
  });

  it('allows an existing META_OAUTH credential to refresh', () => {
    assert.equal(
      shouldPreserveDirectInstagramCredential({
        connectedVia: 'META_OAUTH',
        instagramAccountId: '17841403104278070'
      }),
      false
    );
  });

  it('allows creation when no Instagram credential exists', () => {
    assert.equal(shouldPreserveDirectInstagramCredential(null), false);
  });
});
