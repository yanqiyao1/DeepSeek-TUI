/** Model pricing table (USD per 1M tokens). */

import { normalizeModelName } from "../client/capabilities.js";

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const FALLBACK_PRICING: ModelPricing = Object.freeze({ inputPer1M: 0.27, outputPer1M: 1.10 });

export const PRICING: Readonly<Record<string, Readonly<ModelPricing>>> = Object.freeze({
  "deepseek-v4-pro": Object.freeze({ inputPer1M: 0.27, outputPer1M: 1.10 }),
  "deepseek-v4-flash": Object.freeze({ inputPer1M: 0.07, outputPer1M: 0.28 }),
  // Legacy aliases
  "deepseek-chat": Object.freeze({ inputPer1M: 0.27, outputPer1M: 1.10 }),
  "deepseek-reasoner": Object.freeze({ inputPer1M: 0.55, outputPer1M: 2.19 }),
});

const MAX_PRICING_MODEL_CHARS = 512;
const MAX_PRICING_TOKEN_COUNT = 1_000_000_000;
const MAX_PRICING_RATE_PER_1M = 10_000;
const MAX_CALCULATED_COST = 1_000_000_000;
const PRICING_MODEL_CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const PRICING_KEYS = Object.freeze(Object.keys(PRICING));

export function getPricing(model: string): ModelPricing {
  const normalized = normalizePricingModel(model);
  return sanitizePricingRecord(PRICING[normalized]);
}

export function calculateCost(model: string, tokensIn: number, tokensOut: number, cachedTokensIn = 0): number {
  const p = getPricing(model);
  const safeTokensIn = safeTokenCount(tokensIn);
  const safeTokensOut = safeTokenCount(tokensOut);
  const safeCachedTokensIn = Math.min(safeTokenCount(cachedTokensIn), safeTokensIn);
  const regularIn = safeTokensIn - safeCachedTokensIn;
  const cost = (regularIn / 1_000_000) * p.inputPer1M + (safeCachedTokensIn / 1_000_000) * p.inputPer1M * 0.1 + (safeTokensOut / 1_000_000) * p.outputPer1M;
  return Number.isFinite(cost) && cost >= 0 ? Math.min(cost, MAX_CALCULATED_COST) : 0;
}

function safeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_PRICING_TOKEN_COUNT)
    : 0;
}

function normalizePricingModel(model: unknown): string {
  if (typeof model !== "string") return "deepseek-v4-pro";
  const safeModel = safePricingModelText(model);
  if (!safeModel) return "deepseek-v4-pro";
  let normalized = safeModel;
  try {
    normalized = normalizeModelName(safeModel);
  } catch {
    normalized = safeModel;
  }
  if (PRICING[normalized]) return normalized;
  for (const key of PRICING_KEYS) {
    if (normalized === key || normalized.endsWith(`/${key}`) || normalized.endsWith(`/models/${key}`)) return key;
  }
  return normalized;
}

function safePricingModelText(value: string): string {
  const normalized = value.replace(PRICING_MODEL_CONTROL_RE, " ").trim().split(/\s+/)[0] || "";
  if (!normalized) return "";
  return normalized.length <= MAX_PRICING_MODEL_CHARS
    ? normalized
    : normalized.slice(-MAX_PRICING_MODEL_CHARS).trim();
}

function sanitizePricingRecord(value: unknown): ModelPricing {
  if (!value || typeof value !== "object") return { ...FALLBACK_PRICING };
  return {
    inputPer1M: safePricingRate(safeProperty(value, "inputPer1M"), FALLBACK_PRICING.inputPer1M),
    outputPer1M: safePricingRate(safeProperty(value, "outputPer1M"), FALLBACK_PRICING.outputPer1M),
  };
}

function safePricingRate(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PRICING_RATE_PER_1M
    ? value
    : fallback;
}

function safeProperty(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
