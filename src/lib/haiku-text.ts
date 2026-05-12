import { getCredentials } from '@/lib/credential-store';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_TEXT_FALLBACK_MODEL = 'gpt-4o-mini';
type TextLLMProvider = 'anthropic' | 'openai';

export interface HaikuTextResult {
  text: string | null;
  error: string | null;
  timedOut: boolean;
  keySource: 'byok' | 'env' | null;
  provider: TextLLMProvider | null;
  model: string | null;
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

async function resolveOpenAIApiKeyWithSource(
  accountId?: string | null
): Promise<{
  apiKey: string | null;
  keySource: 'byok' | 'env' | null;
  model: string | null;
}> {
  try {
    if (accountId) {
      const openaiCreds = await getCredentials(accountId, 'OPENAI');
      const byokKey =
        typeof openaiCreds?.apiKey === 'string'
          ? openaiCreds.apiKey.trim()
          : '';
      if (byokKey) {
        return {
          apiKey: byokKey,
          keySource: 'byok',
          model:
            (openaiCreds?.model as string | undefined)?.trim() ||
            OPENAI_TEXT_FALLBACK_MODEL
        };
      }
    }
  } catch {
    // Fall through to env key. Missing BYOK must never block generation.
  }

  const envKey = process.env.OPENAI_API_KEY?.trim() || null;
  return {
    apiKey: envKey,
    keySource: envKey ? 'env' : null,
    model: envKey
      ? process.env.AI_MODEL?.trim() || OPENAI_TEXT_FALLBACK_MODEL
      : null
  };
}

function preferredTextProvider(): TextLLMProvider {
  return (process.env.AI_PROVIDER || '').toLowerCase() === 'openai'
    ? 'openai'
    : 'anthropic';
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
  const [anthropicKey, openaiKey] = await Promise.all([
    resolveAnthropicApiKeyWithSource(accountId),
    resolveOpenAIApiKeyWithSource(accountId)
  ]);
  const preference = preferredTextProvider();
  const provider =
    preference === 'openai' && openaiKey.apiKey
      ? 'openai'
      : preference === 'anthropic' && anthropicKey.apiKey
        ? 'anthropic'
        : anthropicKey.apiKey
          ? 'anthropic'
          : openaiKey.apiKey
            ? 'openai'
            : null;

  if (!provider) {
    console.warn(`${logPrefix} SKIPPED — no Anthropic/OpenAI key available`, {
      accountId
    });
    return {
      text: null,
      error: 'missing_llm_key',
      timedOut: false,
      keySource: null,
      provider: null,
      model: null
    };
  }

  const keyResolution = provider === 'anthropic' ? anthropicKey : openaiKey;
  const model = provider === 'anthropic' ? HAIKU_MODEL : openaiKey.model;
  console.warn(`${logPrefix} LLM ATTEMPT`, {
    provider,
    model,
    keySource: keyResolution.keySource
  });

  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response =
      provider === 'anthropic'
        ? await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              'x-api-key': keyResolution.apiKey!,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: HAIKU_MODEL,
              max_tokens: maxTokens,
              temperature,
              messages: [{ role: 'user', content: prompt }]
            })
          })
        : await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              Authorization: `Bearer ${keyResolution.apiKey}`
            },
            body: JSON.stringify({
              model,
              max_completion_tokens: maxTokens,
              temperature,
              messages: [{ role: 'user', content: prompt }]
            })
          });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = `${provider}_${response.status}:${body.slice(0, 160)}`;
      console.warn(`${logPrefix} API error`, { error });
      return {
        text: null,
        error,
        timedOut: false,
        keySource: keyResolution.keySource,
        provider,
        model
      };
    }

    const data = (await response.json()) as
      | {
          content?: Array<{ type?: string; text?: string }>;
        }
      | {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
    const text =
      provider === 'anthropic'
        ? (
            data as { content?: Array<{ type?: string; text?: string }> }
          ).content
            ?.map((part) => (part.type === 'text' ? part.text || '' : ''))
            .join('')
            .trim() || null
        : (
            data as {
              choices?: Array<{ message?: { content?: string | null } }>;
            }
          ).choices?.[0]?.message?.content?.trim() || null;

    return {
      text,
      error: null,
      timedOut: false,
      keySource: keyResolution.keySource,
      provider,
      model
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`${logPrefix} call failed`, { error, timedOut: didTimeout });
    return {
      text: null,
      error,
      timedOut: didTimeout,
      keySource: keyResolution.keySource,
      provider,
      model
    };
  } finally {
    clearTimeout(timeout);
  }
}
