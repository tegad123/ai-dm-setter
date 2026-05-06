// Run: pnpm exec tsx --test tests/unit/meta-delivery-errors.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  classifyMetaDeliveryError,
  getScheduledReplyRetryDelayMs
} from '../../src/lib/meta-delivery-errors';

describe('classifyMetaDeliveryError', () => {
  it('treats OAuthException code 2 / HTTP 500 as retryable transient', () => {
    const info = classifyMetaDeliveryError(
      new Error(
        'Instagram send DM failed: 500 {"error":{"message":"An unexpected error has occurred. Please retry your request later.","type":"OAuthException","is_transient":true,"code":2}}'
      )
    );

    assert.equal(info.httpStatus, 500);
    assert.equal(info.metaCode, 2);
    assert.equal(info.retryable, true);
    assert.equal(info.permanent, false);
  });

  it('treats token and permission codes as permanent', () => {
    for (const code of [10, 190, 200]) {
      const info = classifyMetaDeliveryError(
        new Error(
          `Instagram send DM failed: 400 {"error":{"type":"OAuthException","code":${code}}}`
        )
      );

      assert.equal(info.metaCode, code);
      assert.equal(info.retryable, false);
      assert.equal(info.permanent, true);
    }
  });
});

describe('getScheduledReplyRetryDelayMs', () => {
  it('matches the scheduled reply retry ladder', () => {
    assert.equal(getScheduledReplyRetryDelayMs(2), 30_000);
    assert.equal(getScheduledReplyRetryDelayMs(3), 120_000);
    assert.equal(getScheduledReplyRetryDelayMs(4), 600_000);
    assert.equal(getScheduledReplyRetryDelayMs(5), 1_800_000);
    assert.equal(getScheduledReplyRetryDelayMs(6), null);
  });
});
