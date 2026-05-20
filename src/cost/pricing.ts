/** Model pricing table (USD per 1M tokens). */

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export const PRICING: Record<string, ModelPricing> = {
  "deepseek-v4-pro": { inputPer1M: 0.27, outputPer1M: 1.10 },
  "deepseek-v4-flash": { inputPer1M: 0.07, outputPer1M: 0.28 },
  // Legacy aliases
  "deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.10 },
  "deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },
};

export function getPricing(model: string): ModelPricing {
  return PRICING[model] ?? { inputPer1M: 0.27, outputPer1M: 1.10 };
}

export function calculateCost(model: string, tokensIn: number, tokensOut: number, cachedTokensIn = 0): number {
  const p = getPricing(model);
  const safeTokensIn = Math.max(0, tokensIn);
  const safeTokensOut = Math.max(0, tokensOut);
  const safeCachedTokensIn = Math.min(Math.max(0, cachedTokensIn), safeTokensIn);
  const regularIn = safeTokensIn - safeCachedTokensIn;
  return (regularIn / 1_000_000) * p.inputPer1M + (safeCachedTokensIn / 1_000_000) * p.inputPer1M * 0.1 + (safeTokensOut / 1_000_000) * p.outputPer1M;
}
