import crypto from 'crypto';

// HMAC-signed OAuth `state` parameter. Replaces the plain
// `Buffer.from(JSON.stringify(...)).toString('base64url')` encoding that
// was previously used by the Meta and Instagram OAuth routes — that
// pattern lets an attacker forge a state with any accountId/userId,
// causing the OAuth callback to associate the returned token with the
// wrong tenant. HMAC-SHA256 with a server-side secret prevents
// tampering: an attacker without the secret cannot produce a state
// that verifies, so callbacks reject anything they didn't issue.
//
// Wire format: `{base64url(payload)}.{base64url(hmac)}`. Compact,
// URL-safe, and survives round-trips through Meta's `state` query
// param without escaping concerns. Constant-time comparison via
// `crypto.timingSafeEqual` to avoid signature-leak timing attacks.

interface StatePayload {
  accountId: string;
  userId: string;
  // Issued-at timestamp in seconds. Optional but lets us reject very
  // old state params (defense against replay across days). Not yet
  // enforced in verifyState — included so future rotation can rely
  // on it without a wire-format break.
  iat?: number;
}

function getSecret(): string {
  const secret =
    process.env.OAUTH_STATE_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    // Fail closed — never sign with an empty/weak secret.
    throw new Error(
      'OAuth state HMAC misconfigured: set OAUTH_STATE_SECRET (or NEXTAUTH_SECRET / CRON_SECRET) to a strong random value (32+ chars recommended)'
    );
  }
  return secret;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(payload: string, secret: string): string {
  return base64url(
    crypto.createHmac('sha256', secret).update(payload).digest()
  );
}

export function signState(payload: {
  accountId: string;
  userId: string;
}): string {
  const secret = getSecret();
  const body: StatePayload = {
    accountId: payload.accountId,
    userId: payload.userId,
    iat: Math.floor(Date.now() / 1000)
  };
  const encoded = base64url(Buffer.from(JSON.stringify(body)));
  const sig = hmac(encoded, secret);
  return `${encoded}.${sig}`;
}

export function verifyState(
  stateParam: string | null | undefined
): { accountId: string; userId: string; iat?: number } | null {
  if (!stateParam || typeof stateParam !== 'string') return null;
  const dot = stateParam.indexOf('.');
  if (dot < 1 || dot === stateParam.length - 1) return null;
  const encoded = stateParam.slice(0, dot);
  const sigProvided = stateParam.slice(dot + 1);

  let secret: string;
  try {
    secret = getSecret();
  } catch {
    // No usable secret — refuse to verify rather than risk a false
    // accept. Callers redirect with invalid_state.
    return null;
  }
  const sigExpected = hmac(encoded, secret);

  // Timing-safe equality on equal-length buffers. Bail if lengths
  // differ — a length mismatch is itself a signature mismatch and
  // shouldn't take a different code path.
  let provided: Buffer;
  let expected: Buffer;
  try {
    provided = Buffer.from(sigProvided, 'base64url');
    expected = Buffer.from(sigExpected, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  // Signature OK — decode the payload.
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as StatePayload;
    if (
      typeof parsed.accountId !== 'string' ||
      !parsed.accountId ||
      typeof parsed.userId !== 'string' ||
      !parsed.userId
    ) {
      return null;
    }
    return {
      accountId: parsed.accountId,
      userId: parsed.userId,
      iat: typeof parsed.iat === 'number' ? parsed.iat : undefined
    };
  } catch {
    return null;
  }
}

// Test helpers — exported so the integration suite can build a
// signed state without exporting the secret. Production code paths
// always use signState / verifyState directly.
export function isStateSigned(stateParam: string | null | undefined): boolean {
  return verifyState(stateParam) !== null;
}
