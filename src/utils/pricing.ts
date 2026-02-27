/**
 * @module utils/pricing
 *
 * Anthropic model pricing for cost calculation from token counts.
 * Prices are per million tokens.
 */

/** Per-million-token pricing for a model. */
interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheCreationPerM: number;
  cacheReadPerM: number;
}

/**
 * Pricing table for known Anthropic models (USD per million tokens).
 * Keys are matched as prefixes against the model ID.
 */
const PRICING: [string, ModelPricing][] = [
  // Claude 4 family — specific models before broader prefixes (first match wins)
  ["claude-opus-4-5", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  ["claude-opus-4-6", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  ["claude-opus-4", { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheReadPerM: 1.5 }],
  ["claude-sonnet-4", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-haiku-4-5", { inputPerM: 1, outputPerM: 5, cacheCreationPerM: 1.25, cacheReadPerM: 0.1 }],
  ["claude-haiku-4", { inputPerM: 0.8, outputPerM: 4, cacheCreationPerM: 1, cacheReadPerM: 0.08 }],
  // Claude 3.7 family
  ["claude-3-7-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  // Claude 3.5 family
  ["claude-3-5-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-3-5-haiku", { inputPerM: 0.8, outputPerM: 4, cacheCreationPerM: 1, cacheReadPerM: 0.08 }],
  // Claude 3 family
  ["claude-3-opus", { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheReadPerM: 1.5 }],
  ["claude-3-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-3-haiku", { inputPerM: 0.25, outputPerM: 1.25, cacheCreationPerM: 0.3, cacheReadPerM: 0.03 }],
];

/** Default pricing when model is unknown (uses Sonnet rates). */
const DEFAULT_PRICING: ModelPricing = {
  inputPerM: 3,
  outputPerM: 15,
  cacheCreationPerM: 3.75,
  cacheReadPerM: 0.3,
};

/**
 * Look up pricing for a model by prefix matching.
 */
export function getPricing(model: string | null | undefined): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  const lower = model.toLowerCase();
  for (const [prefix, pricing] of PRICING) {
    if (lower.startsWith(prefix)) {
      return pricing;
    }
  }
  return DEFAULT_PRICING;
}

/**
 * Calculate cost in USD from token counts and model.
 *
 * @param model - Model identifier (e.g. "claude-sonnet-4-20250514")
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param cacheCreationTokens - Number of cache creation tokens
 * @param cacheReadTokens - Number of cache read tokens
 * @returns Cost in USD
 */
export function calculateCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  const p = getPricing(model);
  return (
    (inputTokens * p.inputPerM) / 1_000_000 +
    (outputTokens * p.outputPerM) / 1_000_000 +
    (cacheCreationTokens * p.cacheCreationPerM) / 1_000_000 +
    (cacheReadTokens * p.cacheReadPerM) / 1_000_000
  );
}
