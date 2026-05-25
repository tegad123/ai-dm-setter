// ---------------------------------------------------------------------------
// AI error handling — normalize OpenAI / Anthropic SDK failures into typed,
// operator-friendly errors so the UI never shows raw provider JSON.
//
// Closes the "raw JSON error" bug class (QD-003/024/043/044/045/048): a
// depleted API key, rate limit, or auth failure used to surface the provider's
// raw error body in the dashboard. Now every wrapped call throws an
// `AIServiceError` with a human message + an HTTP status, and API routes can
// return `aiErrorResponse(err)` for a clean payload.
// ---------------------------------------------------------------------------

import { NextResponse } from 'next/server';

export type AIErrorKind =
  | 'quota' // out of credit / insufficient_quota / credit_balance_too_low
  | 'rate_limit' // 429 rate limited (but still has quota)
  | 'auth' // missing / invalid API key
  | 'overloaded' // provider temporarily overloaded (529)
  | 'timeout' // request timed out / aborted
  | 'unknown';

const USER_MESSAGES: Record<AIErrorKind, string> = {
  quota:
    'Your AI provider account is out of credit. Add billing/credit (or update the API key) in Settings → Integrations, then try again.',
  rate_limit:
    'The AI provider is rate-limiting requests right now. Wait a few seconds and try again.',
  auth: 'The AI API key is missing or invalid. Re-enter it in Settings → Integrations.',
  overloaded:
    'The AI provider is temporarily overloaded. Please try again in a moment.',
  timeout: 'The AI request timed out. Please try again.',
  unknown:
    'The AI request failed. Please try again, or check your API key in Settings → Integrations.'
};

const HTTP_STATUS: Record<AIErrorKind, number> = {
  quota: 402, // Payment Required
  rate_limit: 429,
  auth: 401,
  overloaded: 503,
  timeout: 504,
  unknown: 502
};

export class AIServiceError extends Error {
  readonly kind: AIErrorKind;
  readonly userMessage: string;
  readonly httpStatus: number;
  readonly provider?: 'openai' | 'anthropic';
  readonly cause?: unknown;

  constructor(
    kind: AIErrorKind,
    provider?: 'openai' | 'anthropic',
    cause?: unknown
  ) {
    super(USER_MESSAGES[kind]);
    this.name = 'AIServiceError';
    this.kind = kind;
    this.userMessage = USER_MESSAGES[kind];
    this.httpStatus = HTTP_STATUS[kind];
    this.provider = provider;
    this.cause = cause;
  }

  static from(err: unknown, provider?: 'openai' | 'anthropic'): AIServiceError {
    if (err instanceof AIServiceError) return err;
    const kind = classifyAIError(err);
    return new AIServiceError(kind, provider, err);
  }
}

/**
 * Classify a raw OpenAI/Anthropic SDK error (or any thrown value) into a kind.
 * Duck-types on `status` + message/code so we don't have to import either SDK.
 *
 * OpenAI: APIError has `.status` (HTTP) + `.code` (e.g. 'insufficient_quota').
 * Anthropic: APIError has `.status` + `.error.error.type` (e.g. 'rate_limit_error',
 * 'overloaded_error'); credit issues come back as 400 with a "credit balance is
 * too low" message.
 */
export function classifyAIError(err: unknown): AIErrorKind {
  const e = (err ?? {}) as Record<string, unknown>;
  const status = Number(e.status ?? e.statusCode ?? 0);
  const message = String(e.message ?? '').toLowerCase();
  const code = String(
    e.code ??
      (e.error as any)?.error?.type ??
      (e.error as any)?.type ??
      (e.error as any)?.code ??
      ''
  ).toLowerCase();
  const name = String(e.name ?? '').toLowerCase();

  // Quota / billing — check before generic 429 because insufficient_quota is 429
  if (
    code === 'insufficient_quota' ||
    code === 'billing_hard_limit_reached' ||
    message.includes('insufficient_quota') ||
    message.includes('credit balance is too low') ||
    message.includes('credit_balance_too_low') ||
    message.includes('exceeded your current quota') ||
    message.includes('billing')
  ) {
    return 'quota';
  }

  if (status === 401 || status === 403 || code === 'authentication_error') {
    return 'auth';
  }
  if (
    message.includes('invalid api key') ||
    message.includes('incorrect api key') ||
    message.includes('no api key') ||
    message.includes('api key not')
  ) {
    return 'auth';
  }

  if (
    status === 429 ||
    code === 'rate_limit_error' ||
    message.includes('rate limit')
  ) {
    return 'rate_limit';
  }

  if (
    status === 529 ||
    code === 'overloaded_error' ||
    message.includes('overloaded')
  ) {
    return 'overloaded';
  }

  if (
    name === 'aborterror' ||
    code === 'etimedout' ||
    message.includes('timeout') ||
    message.includes('timed out')
  ) {
    return 'timeout';
  }

  return 'unknown';
}

/** Run an OpenAI call, rethrowing any failure as a typed AIServiceError. */
export async function safeOpenAI<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw AIServiceError.from(err, 'openai');
  }
}

/** Run an Anthropic call, rethrowing any failure as a typed AIServiceError. */
export async function safeAnthropic<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw AIServiceError.from(err, 'anthropic');
  }
}

/**
 * Build a clean NextResponse for an AI error in an API route. Use in catch
 * blocks of operator-facing routes so the dashboard gets `{ error, code }`
 * instead of a raw provider error body.
 */
export function aiErrorResponse(err: unknown): NextResponse {
  const e = AIServiceError.from(err);
  return NextResponse.json(
    { error: e.userMessage, code: e.kind },
    { status: e.httpStatus }
  );
}

/** True if the value is (or wraps) an AI service error. */
export function isAIServiceError(err: unknown): err is AIServiceError {
  return err instanceof AIServiceError;
}
