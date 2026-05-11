import { getCredentials } from '@/lib/credential-store';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

export interface HaikuTextResult {
  text: string | null;
  error: string | null;
  timedOut: boolean;
  keySource: 'byok' | 'env' | null;
}

export async function resolveAnthropicApiKeyWithSource(
  accountId?: string | null
): Promise<{ apiKey: string | null; keySource: 'byok' | 'env' | null }> {
  try {
    if (accountId) {
      const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
      const byokKey =
        typeof anthropicCreds?.apiKey === 'string'
          ? anthropicCreds.apiKey.trim()
          : '';
      if (byokKey) return { apiKey: byokKey, keySource: 'byok' };
    }
  } catch {
    // Fall through to env key. Missing BYOK must never block generation.
  }

  const envKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  return { apiKey: envKey, keySource: envKey ? 'env' : null };
}

export async function callHaikuText(params: {
  accountId?: string | null;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  logPrefix?: string;
}): Promise<HaikuTextResult> {
  const {
    accountId,
    prompt,
    maxTokens = 80,
    temperature = 0,
    timeoutMs = 3000,
    logPrefix = '[haiku-text]'
  } = params;
  const keyResolution = await resolveAnthropicApiKeyWithSource(accountId);
  if (!keyResolution.apiKey) {
    console.warn(`${logPrefix} SKIPPED — no Anthropic key available`, {
      accountId
    });
    return {
      text: null,
      error: 'missing_anthropic_key',
      timedOut: false,
      keySource: null
    };
  }

  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': keyResolution.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = `anthropic_${response.status}:${body.slice(0, 160)}`;
      console.warn(`${logPrefix} API error`, { error });
      return {
        text: null,
        error,
        timedOut: false,
        keySource: keyResolution.keySource
      };
    }

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text =
      data.content
        ?.map((part) => (part.type === 'text' ? part.text || '' : ''))
        .join('')
        .trim() || null;

    return {
      text,
      error: null,
      timedOut: false,
      keySource: keyResolution.keySource
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`${logPrefix} call failed`, { error, timedOut: didTimeout });
    return {
      text: null,
      error,
      timedOut: didTimeout,
      keySource: keyResolution.keySource
    };
  } finally {
    clearTimeout(timeout);
  }
}
