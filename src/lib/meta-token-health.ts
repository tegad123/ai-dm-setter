// ---------------------------------------------------------------------------
// Meta token health classification + retry-with-backoff.
// ---------------------------------------------------------------------------
// QD-005 fix (2026-05-18): the meta-health cron used to flag the token as
// invalidated on the first non-`is_valid:true` response, including
// transient `OAuthException (#2) Service temporarily unavailable` errors
// that resolve themselves within seconds. Operators saw a flood of
// "credential invalidated — reconnect required" alerts that turned out
// to be Meta hiccups.
//
// This module:
//   1. Classifies the debug_token response into `valid | revoked |
//      transient | unknown` using Meta's documented error codes.
//   2. Retries up to 3 times with exponential backoff (1s, 2s, 4s)
//      when the response is `transient` or fetch itself throws.
//   3. Returns a single typed result so the cron route only needs to
//      decide: alert (revoked), retry (transient_exhausted = next cron
//      tick will catch it), or do nothing (valid).
//
// Reference: Meta Graph API error codes
//   https://developers.facebook.com/docs/graph-api/guides/error-handling
// ---------------------------------------------------------------------------

/**
 * Meta error codes that indicate a transient / retryable condition.
 * The cron should NOT flag the operator on these — Meta will recover.
 */
const TRANSIENT_META_CODES: ReadonlySet<number> = new Set([
  1, // Unknown error (Meta-internal)
  2, // Service temporarily unavailable
  4, // Application request limit reached
  17, // User request limit reached
  32, // Page request limit reached
  341, // Application request limit reached
  368, // Temporarily blocked for policy violation
  613 // Rate limit
]);

/**
 * Meta error codes that indicate a permanent revocation / re-auth needed.
 * The cron SHOULD flag the operator on these — only a reconnect will fix.
 *
 * Code 190 is the main one; its subcodes distinguish:
 *   - 458: User not authorized
 *   - 459: User checkpoint
 *   - 460: Password changed
 *   - 463: Long-lived token expired
 *   - 464: User logged out
 *   - 467: Invalid access token
 *
 * Code 102 / 104 are older session-invalidation codes still seen
 * occasionally on legacy Page tokens.
 */
const REVOKED_META_CODES: ReadonlySet<number> = new Set([102, 104, 190, 463]);

export type DebugTokenClassification =
  | { kind: 'valid' }
  | { kind: 'revoked'; code: number; subcode?: number; details: string }
  | { kind: 'transient'; code?: number; httpStatus: number; details: string }
  | { kind: 'unknown'; httpStatus: number; details: string };

/**
 * Classify a /debug_token HTTP response. Pure function — no I/O.
 *
 * Exported so the cron + tests can call it against captured responses.
 */
export function classifyDebugTokenResponse(
  httpStatus: number,
  body: string
): DebugTokenClassification {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    // Body not JSON — fall through. HTTP 5xx with HTML/text body is
    // a common transient case (Meta's CDN returning an error page).
  }
  const root = (parsed ?? {}) as Record<string, unknown>;

  // Happy path: { data: { is_valid: true, ... } }
  const data = root.data as Record<string, unknown> | undefined;
  if (data?.is_valid === true) {
    return { kind: 'valid' };
  }

  // Inner error: { data: { is_valid: false, error: { code, ... } } }
  const inner = (data?.error as Record<string, unknown>) ?? null;
  if (inner && typeof inner === 'object') {
    const code = Number(inner.code);
    const subcode = inner.error_subcode
      ? Number(inner.error_subcode)
      : undefined;
    const details = `code=${code}${subcode ? ` subcode=${subcode}` : ''} message="${String(inner.message ?? '').slice(0, 160)}"`;
    if (REVOKED_META_CODES.has(code)) {
      return { kind: 'revoked', code, subcode, details };
    }
    if (TRANSIENT_META_CODES.has(code) || inner.is_transient === true) {
      return { kind: 'transient', code, httpStatus, details };
    }
    return { kind: 'unknown', httpStatus, details };
  }

  // Outer error envelope: { error: { code, is_transient, ... } }
  const outer = root.error as Record<string, unknown> | undefined;
  if (outer && typeof outer === 'object') {
    const code = Number(outer.code);
    const subcode = outer.error_subcode
      ? Number(outer.error_subcode)
      : undefined;
    const details = `code=${code}${subcode ? ` subcode=${subcode}` : ''} message="${String(outer.message ?? '').slice(0, 160)}"`;
    if (outer.is_transient === true || TRANSIENT_META_CODES.has(code)) {
      return { kind: 'transient', code, httpStatus, details };
    }
    if (REVOKED_META_CODES.has(code)) {
      return { kind: 'revoked', code, subcode, details };
    }
    return { kind: 'unknown', httpStatus, details };
  }

  // No error object — bare is_valid:false (rare) means revoked.
  if (data?.is_valid === false) {
    return {
      kind: 'revoked',
      code: 0,
      details: 'data.is_valid=false with no error code'
    };
  }

  // HTTP 5xx with no parseable error info: Meta server-side hiccup.
  if (httpStatus >= 500) {
    return {
      kind: 'transient',
      httpStatus,
      details: `HTTP ${httpStatus} ${body.slice(0, 160)}`
    };
  }

  return {
    kind: 'unknown',
    httpStatus,
    details: `HTTP ${httpStatus} ${body.slice(0, 160)}`
  };
}

export type TokenHealthResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'revoked';
      metaCode: number;
      metaSubcode?: number;
      details: string;
    }
  | { ok: false; reason: 'transient_exhausted'; lastError: string };

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];

/**
 * Probe Meta /debug_token with retry-on-transient. Returns a single
 * typed result the caller can act on.
 *
 * - 'valid' → no action.
 * - 'revoked' (code 190 etc.) → caller should fire the credential-
 *   invalidated alert.
 * - 'transient_exhausted' → 3 retries all came back transient or
 *   threw. Caller should NOT alert the operator — log a warning and
 *   let the next 15-min cron tick try again.
 */
export async function checkTokenHealth(opts: {
  accessToken: string;
  appAccessToken: string;
  graphApiBase: string;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  /**
   * Override for testing. Receives the constructed URL, returns the
   * raw fetch Response. Defaults to the global fetch.
   */
  fetchImpl?: (url: string) => Promise<Response>;
}): Promise<TokenHealthResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  let lastTransientDetails = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delayMs = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 0;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    let httpStatus = 0;
    let body = '';
    try {
      const res = await doFetch(
        `${opts.graphApiBase}/debug_token?input_token=${opts.accessToken}&access_token=${opts.appAccessToken}`
      );
      httpStatus = res.status;
      body = await res.text();
    } catch (err) {
      // Network error / fetch threw — treat as transient.
      lastTransientDetails =
        err instanceof Error ? err.message : String(err).slice(0, 200);
      continue;
    }

    const classification = classifyDebugTokenResponse(httpStatus, body);

    if (classification.kind === 'valid') {
      return { ok: true };
    }
    if (classification.kind === 'revoked') {
      return {
        ok: false,
        reason: 'revoked',
        metaCode: classification.code,
        metaSubcode: classification.subcode,
        details: classification.details
      };
    }
    // transient | unknown — record and retry. Unknown is treated as
    // transient because we'd rather under-alert (next cron catches it)
    // than over-alert on an unfamiliar response shape.
    lastTransientDetails = classification.details;
  }

  return {
    ok: false,
    reason: 'transient_exhausted',
    lastError: lastTransientDetails
  };
}
