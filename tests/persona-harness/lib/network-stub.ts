/* eslint-disable no-console */
// fetch() interceptor used by the harness. Three jobs:
//   1. Stub outbound Meta IG/FB Send API calls (don't actually DM
//      anyone). Returns a synthetic-success Response.
//   2. Observe LLM provider calls (api.anthropic.com / api.openai.com)
//      to track call count, token usage, and cost. Passes the real
//      request through.
//   3. Detect 429s from LLM providers, back off with exponential
//      delay (max 60s, max 3 retries), and throw
//      RateLimitExhaustedError after the 4th failed attempt.
//
// Install/restore is idempotent. The pattern mirrors smoke-helpers.ts
// so we don't break existing fetch stubs if they happen to coexist.

import { RateLimitExhaustedError } from './errors';
import { estimateCostUsd } from './pricing';

const META_HOSTS: string[] = [
  'graph.instagram.com',
  'graph.facebook.com',
  'graph.fb.com'
];
const ANTHROPIC_HOST = 'api.anthropic.com';
const OPENAI_HOST = 'api.openai.com';
const TRANSCRIPTION_PATH = '/v1/audio/transcriptions';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostMatches(host: string, target: string): boolean {
  return host === target || host.endsWith('.' + target);
}

interface ProviderUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  models: Set<string>;
}

export interface TelemetrySnapshot {
  totalCalls: number;
  totalUsd: number;
  providers: Record<
    string,
    { calls: number; usd: number; inputTokens: number; outputTokens: number }
  >;
}

let originalFetch: typeof fetch | null = null;
let stubInstalled = false;
let fastPath = true;
let usage = newUsage();

function newUsage(): Record<string, ProviderUsage> {
  return {
    anthropic: {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      models: new Set()
    },
    openai: {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      models: new Set()
    }
  };
}

function urlString(input: Request | string | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isMeta(url: string): boolean {
  const h = hostOf(url);
  return META_HOSTS.some((t) => hostMatches(h, t));
}

function isAnthropic(url: string): boolean {
  return hostMatches(hostOf(url), ANTHROPIC_HOST);
}

function isOpenAI(url: string): boolean {
  return hostMatches(hostOf(url), OPENAI_HOST);
}

function isTranscription(url: string): boolean {
  return url.toLowerCase().includes(TRANSCRIPTION_PATH);
}

function delayMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null && Number.isFinite(retryAfter)) {
    return Math.min(retryAfter * 1000, 60_000);
  }
  const base = 2_000 * Math.pow(2, attempt);
  return Math.min(base, 60_000);
}

function parseRetryAfter(headers: Headers): number | null {
  const ra = headers.get('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return n;
  }
  const reset = headers.get('anthropic-ratelimit-requests-reset');
  if (reset) {
    const t = Date.parse(reset);
    if (Number.isFinite(t)) {
      return Math.max(0, Math.ceil((t - Date.now()) / 1000));
    }
  }
  return null;
}

async function recordLlmCall(
  provider: 'anthropic' | 'openai',
  responseClone: Response
): Promise<void> {
  try {
    const body = await responseClone.json();
    const u = usage[provider];
    u.calls += 1;
    let inputTokens = 0;
    let outputTokens = 0;
    let model = '';
    if (provider === 'anthropic') {
      inputTokens = body?.usage?.input_tokens ?? 0;
      outputTokens = body?.usage?.output_tokens ?? 0;
      model = body?.model ?? '';
    } else {
      inputTokens =
        body?.usage?.prompt_tokens ?? body?.usage?.input_tokens ?? 0;
      outputTokens =
        body?.usage?.completion_tokens ?? body?.usage?.output_tokens ?? 0;
      model = body?.model ?? '';
    }
    u.inputTokens += inputTokens;
    u.outputTokens += outputTokens;
    if (model) u.models.add(model);
    u.usd += estimateCostUsd(model, inputTokens, outputTokens);
  } catch {
    // Non-JSON response (streaming, error body, etc.). Still count the
    // call so the visibility is honest even when we can't price it.
    usage[provider].calls += 1;
  }
}

async function callWithRateLimit(
  provider: 'anthropic' | 'openai',
  doFetch: () => Promise<Response>
): Promise<Response> {
  const MAX_ATTEMPTS = 3;
  let attempt = 0;
  while (true) {
    const res = await doFetch();
    if (res.status !== 429) {
      // Record on a clone so the caller still gets a fresh body.
      const clone = res.clone();
      void recordLlmCall(provider, clone);
      return res;
    }
    if (attempt >= MAX_ATTEMPTS) {
      throw new RateLimitExhaustedError(
        `[harness] ${provider} returned 429 after ${MAX_ATTEMPTS + 1} attempts`,
        provider,
        attempt + 1
      );
    }
    const retryAfter = parseRetryAfter(res.headers);
    const wait = delayMs(attempt, retryAfter);
    console.warn(
      `[harness] ${provider} 429 — retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`
    );
    await new Promise((r) => setTimeout(r, wait));
    attempt += 1;
  }
}

export function installFetchStub(opts: { fastPath?: boolean } = {}): void {
  if (stubInstalled) return;
  fastPath = opts.fastPath ?? true;
  originalFetch = globalThis.fetch;
  stubInstalled = true;
  usage = newUsage();

  const stub = (async (
    input: Request | string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = urlString(input);

    if (fastPath && isMeta(url)) {
      return new Response(
        JSON.stringify({
          recipient_id: 'harness_recipient',
          message_id: `harness_mid_${Date.now()}`
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (fastPath && isTranscription(url)) {
      return new Response(
        JSON.stringify({
          text: '[harness: transcription stubbed — payload should carry no audio]'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (!originalFetch) {
      throw new Error('[harness] originalFetch missing after install');
    }

    if (isAnthropic(url)) {
      return callWithRateLimit('anthropic', () =>
        originalFetch!(input as Request, init)
      );
    }
    if (isOpenAI(url)) {
      return callWithRateLimit('openai', () =>
        originalFetch!(input as Request, init)
      );
    }

    return originalFetch(input as Request, init);
  }) as typeof fetch;

  globalThis.fetch = stub;
}

export function uninstallFetchStub(): void {
  if (!stubInstalled || !originalFetch) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
  stubInstalled = false;
}

export function resetTelemetry(): void {
  usage = newUsage();
}

export function snapshotTelemetry(): TelemetrySnapshot {
  const providers: TelemetrySnapshot['providers'] = {};
  let totalCalls = 0;
  let totalUsd = 0;
  for (const [name, u] of Object.entries(usage)) {
    providers[name] = {
      calls: u.calls,
      usd: u.usd,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens
    };
    totalCalls += u.calls;
    totalUsd += u.usd;
  }
  return { totalCalls, totalUsd, providers };
}
