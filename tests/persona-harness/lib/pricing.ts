// Approximate USD pricing per 1M tokens. Update when provider prices
// change. Keys are model id substrings — looked up via includes() so
// versioned IDs (claude-haiku-4-5-20251001) match the base entry.
//
// Source: Anthropic pricing page and OpenAI pricing page, accessed
// 2026-05-12. Numbers here are best-effort and intended for visibility
// only — they are not used for billing reconciliation.

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING_TABLE: Array<[string, ModelPricing]> = [
  ['claude-opus-4-7', { inputPerMillion: 15, outputPerMillion: 75 }],
  ['claude-opus-4-6', { inputPerMillion: 15, outputPerMillion: 75 }],
  ['claude-opus-4', { inputPerMillion: 15, outputPerMillion: 75 }],
  ['claude-sonnet-4-6', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-sonnet-4-5', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-sonnet-4', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-haiku-4-5', { inputPerMillion: 1, outputPerMillion: 5 }],
  ['claude-haiku-4', { inputPerMillion: 1, outputPerMillion: 5 }],
  ['claude-3-5-haiku', { inputPerMillion: 0.8, outputPerMillion: 4 }],
  ['claude-3-haiku', { inputPerMillion: 0.25, outputPerMillion: 1.25 }],
  ['gpt-5.4', { inputPerMillion: 2.5, outputPerMillion: 10 }],
  ['gpt-5-mini', { inputPerMillion: 0.15, outputPerMillion: 0.6 }],
  ['gpt-5', { inputPerMillion: 5, outputPerMillion: 15 }],
  ['gpt-4o-mini', { inputPerMillion: 0.15, outputPerMillion: 0.6 }],
  ['gpt-4', { inputPerMillion: 5, outputPerMillion: 15 }]
];

const FALLBACK_PRICING: ModelPricing = {
  inputPerMillion: 5,
  outputPerMillion: 15
};

export function pricingForModel(modelId: string): ModelPricing {
  const normalized = modelId.toLowerCase();
  for (const [key, pricing] of PRICING_TABLE) {
    if (normalized.includes(key)) return pricing;
  }
  return FALLBACK_PRICING;
}

export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = pricingForModel(modelId);
  return (
    (inputTokens / 1_000_000) * p.inputPerMillion +
    (outputTokens / 1_000_000) * p.outputPerMillion
  );
}
