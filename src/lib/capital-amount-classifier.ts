import { callHaikuText } from '@/lib/haiku-text';

export interface SemanticCapitalAmountResult {
  amount: number | null;
  error: string | null;
  timedOut: boolean;
}

export function parseSemanticCapitalAmountOutput(
  raw: string | null | undefined
): number | null {
  const text = (raw || '').trim();
  if (!text || /^none$/i.test(text)) return null;
  const normalized = text.replace(/[,$]/g, '').trim();
  const match = normalized.match(/^(\d{1,9})(?:\.\d+)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount);
}

export async function classifyCapitalAmountWithHaiku(params: {
  accountId?: string | null;
  leadMessage: string;
  recentConversation?: string[];
}): Promise<SemanticCapitalAmountResult> {
  const context = (params.recentConversation ?? []).slice(-10).join('\n');
  const result = await callHaikuText({
    accountId: params.accountId,
    maxTokens: 20,
    temperature: 0,
    timeoutMs: 3000,
    logPrefix: '[capital-classifier]',
    prompt:
      `You parse available trading/education capital from a lead's message.\n` +
      `Return ONLY the capital amount in USD as a plain integer, or NONE if unclear.\n` +
      `Interpret common shorthand: 3k = 3000, around 5k = 5000.\n` +
      `Do not use prop-firm account sizes, trade losses, dates, times, payouts, or percentages as capital.\n\n` +
      `Recent context:\n${context || '(none)'}\n\n` +
      `Lead message: ${params.leadMessage}\n\n` +
      `Capital amount in USD:`
  });
  return {
    amount: parseSemanticCapitalAmountOutput(result.text),
    error: result.error,
    timedOut: result.timedOut
  };
}
