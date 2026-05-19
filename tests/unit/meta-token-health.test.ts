import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  classifyDebugTokenResponse,
  checkTokenHealth
} from '../../src/lib/meta-token-health';

// ---------------------------------------------------------------------------
// classifyDebugTokenResponse — pure function, table of responses
// ---------------------------------------------------------------------------

describe('classifyDebugTokenResponse', () => {
  it('valid: { data: { is_valid: true } }', () => {
    const body = JSON.stringify({
      data: {
        app_id: '123',
        type: 'PAGE',
        application: 'Some App',
        is_valid: true,
        scopes: ['pages_messaging']
      }
    });
    const result = classifyDebugTokenResponse(200, body);
    assert.equal(result.kind, 'valid');
  });

  it('revoked: inner error code 190 (token revoked) — must alert', () => {
    const body = JSON.stringify({
      data: {
        error: {
          code: 190,
          error_subcode: 460,
          message:
            'Error validating access token: The session has been invalidated because the user changed their password'
        },
        is_valid: false
      }
    });
    const result = classifyDebugTokenResponse(200, body);
    assert.equal(result.kind, 'revoked');
    if (result.kind === 'revoked') {
      assert.equal(result.code, 190);
      assert.equal(result.subcode, 460);
    }
  });

  it('revoked: code 463 (long-lived token expired) — must alert', () => {
    const body = JSON.stringify({
      data: {
        error: { code: 463, message: 'Token expired' },
        is_valid: false
      }
    });
    const result = classifyDebugTokenResponse(200, body);
    assert.equal(result.kind, 'revoked');
    if (result.kind === 'revoked') assert.equal(result.code, 463);
  });

  it('transient: outer error code 2 (Service temporarily unavailable) — must NOT alert', () => {
    const body = JSON.stringify({
      error: {
        code: 2,
        type: 'OAuthException',
        is_transient: true,
        message:
          'An unexpected error has occurred. Please retry your request later.'
      }
    });
    const result = classifyDebugTokenResponse(500, body);
    assert.equal(result.kind, 'transient');
  });

  it('transient: outer error with is_transient=true even on unfamiliar code — must NOT alert', () => {
    const body = JSON.stringify({
      error: {
        code: 9999, // unfamiliar code
        is_transient: true,
        message: 'Something temporary'
      }
    });
    const result = classifyDebugTokenResponse(500, body);
    assert.equal(result.kind, 'transient');
  });

  it('transient: rate limit code 613 — must NOT alert', () => {
    const body = JSON.stringify({
      error: { code: 613, message: 'Rate limit reached' }
    });
    const result = classifyDebugTokenResponse(400, body);
    assert.equal(result.kind, 'transient');
  });

  it('transient: HTTP 503 with unparseable body — must NOT alert', () => {
    const result = classifyDebugTokenResponse(
      503,
      '<html>Service Unavailable</html>'
    );
    assert.equal(result.kind, 'transient');
  });

  it('revoked: bare is_valid:false with no error block — treat as revoked', () => {
    const body = JSON.stringify({ data: { is_valid: false } });
    const result = classifyDebugTokenResponse(200, body);
    assert.equal(result.kind, 'revoked');
  });

  it('unknown: 400 with an unrecognized error shape', () => {
    const body = JSON.stringify({ error: { code: 999, message: 'Strange' } });
    const result = classifyDebugTokenResponse(400, body);
    assert.equal(result.kind, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// checkTokenHealth — retry + classification end-to-end
// ---------------------------------------------------------------------------

function makeResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('checkTokenHealth', () => {
  it('returns ok immediately on a valid token (no retries)', async () => {
    let calls = 0;
    const result = await checkTokenHealth({
      accessToken: 't',
      appAccessToken: 'a',
      graphApiBase: 'https://example.test/v22.0',
      backoffMs: [0, 0, 0],
      fetchImpl: async () => {
        calls++;
        return makeResponse(200, JSON.stringify({ data: { is_valid: true } }));
      }
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
  });

  it('returns revoked immediately on code 190 (no retries on revoke)', async () => {
    let calls = 0;
    const result = await checkTokenHealth({
      accessToken: 't',
      appAccessToken: 'a',
      graphApiBase: 'https://example.test/v22.0',
      backoffMs: [0, 0, 0],
      fetchImpl: async () => {
        calls++;
        return makeResponse(
          200,
          JSON.stringify({
            data: {
              error: { code: 190, error_subcode: 460, message: 'Revoked' },
              is_valid: false
            }
          })
        );
      }
    });
    assert.equal(result.ok, false);
    if (!result.ok && result.reason === 'revoked') {
      assert.equal(result.metaCode, 190);
      assert.equal(result.metaSubcode, 460);
    }
    assert.equal(calls, 1, 'revoked must not retry');
  });

  it('retries on transient, succeeds on attempt 3', async () => {
    let calls = 0;
    const result = await checkTokenHealth({
      accessToken: 't',
      appAccessToken: 'a',
      graphApiBase: 'https://example.test/v22.0',
      backoffMs: [0, 0, 0],
      fetchImpl: async () => {
        calls++;
        if (calls < 3) {
          return makeResponse(
            500,
            JSON.stringify({
              error: { code: 2, is_transient: true, message: 'Transient' }
            })
          );
        }
        return makeResponse(200, JSON.stringify({ data: { is_valid: true } }));
      }
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 3);
  });

  it('returns transient_exhausted after 3 transient failures (NO alert path)', async () => {
    let calls = 0;
    const result = await checkTokenHealth({
      accessToken: 't',
      appAccessToken: 'a',
      graphApiBase: 'https://example.test/v22.0',
      backoffMs: [0, 0, 0],
      fetchImpl: async () => {
        calls++;
        return makeResponse(
          500,
          JSON.stringify({
            error: {
              code: 2,
              is_transient: true,
              message: 'Service temporarily unavailable'
            }
          })
        );
      }
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'transient_exhausted');
    assert.equal(calls, 3);
  });

  it('retries on fetch throw (network error treated as transient)', async () => {
    let calls = 0;
    const result = await checkTokenHealth({
      accessToken: 't',
      appAccessToken: 'a',
      graphApiBase: 'https://example.test/v22.0',
      backoffMs: [0, 0, 0],
      fetchImpl: async () => {
        calls++;
        if (calls < 3) throw new Error('ECONNREFUSED');
        return makeResponse(200, JSON.stringify({ data: { is_valid: true } }));
      }
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 3);
  });
});
