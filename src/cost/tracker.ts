/** Per-turn and cumulative cost tracking. */

import { calculateCost } from "./pricing.js";
import type { Session } from "../session/types.js";
import { safeTailTextBoundary } from "../utils/text-boundary.js";

const MAX_COST_TURNS = 5_000;
const MAX_TOTAL_TOKEN_SUM = Number.MAX_SAFE_INTEGER;
const MAX_METRIC_SUM = 1_000_000_000;
const MAX_COST_MODEL_CHARS = 512;
const COST_MODEL_CONTROL_RE = /[\u0000-\u001F\u007F]/g;

export interface TurnCost {
  tokensIn: number;
  tokensOut: number;
  cachedTokensIn: number;
  cost: number;
  durationS: number;
}

export class CostTracker {
  model: string;
  private turnHistory: TurnCost[] = [];
  private cumulativeTokensIn = 0;
  private cumulativeTokensOut = 0;
  private cumulativeCost = 0;
  private cumulativeTurnCount = 0;

  constructor(model = "deepseek-v4-pro") { this.model = normalizeModel(model); }

  get turns(): TurnCost[] {
    return this.turnHistory.map(turn => ({ ...turn }));
  }

  set turns(value: TurnCost[]) {
    this.turnHistory = sanitizeTurnArray(value);
    this.trimTurns();
    this.resetTotalsFromHistory();
  }

  setModel(model: string): void {
    this.model = normalizeModel(model, this.model);
  }

  reset(model = this.model): void {
    this.model = normalizeModel(model);
    this.turnHistory = [];
    this.cumulativeTokensIn = 0;
    this.cumulativeTokensOut = 0;
    this.cumulativeCost = 0;
    this.cumulativeTurnCount = 0;
  }

  hydrateFromSession(session: Session): void {
    this.model = normalizeModel(safeProperty(session, "model"), this.model);
    const sessionTurns = safeProperty(session, "turns");
    if (Array.isArray(sessionTurns) && sessionTurns.length) {
      this.turnHistory = safeTailArrayItems(sessionTurns, MAX_COST_TURNS).map(turn => this.sanitizeTurn({
        tokensIn: safeProperty(turn, "tokens_in"),
        tokensOut: safeProperty(turn, "tokens_out"),
        cachedTokensIn: 0,
        cost: safeProperty(turn, "cost"),
        durationS: safeProperty(turn, "duration_s"),
      }));
      this.resetTotalsFromHistory();
      this.cumulativeTokensIn = Math.max(this.cumulativeTokensIn, safeTokenCount(safeProperty(session, "cumulative_tokens_in")));
      this.cumulativeTokensOut = Math.max(this.cumulativeTokensOut, safeTokenCount(safeProperty(session, "cumulative_tokens_out")));
      this.cumulativeCost = Math.max(this.cumulativeCost, safeMetricNumber(safeProperty(session, "cumulative_cost")));
      this.cumulativeTurnCount = Math.max(this.cumulativeTurnCount, safeArrayLength(sessionTurns));
      return;
    }
    const tokensIn = safeTokenCount(safeProperty(session, "cumulative_tokens_in"));
    const tokensOut = safeTokenCount(safeProperty(session, "cumulative_tokens_out"));
    const cost = safeMetricNumber(safeProperty(session, "cumulative_cost"));
    if (tokensIn || tokensOut || cost) {
      this.turnHistory = [{
        tokensIn,
        tokensOut,
        cachedTokensIn: 0,
        cost,
        durationS: 0,
      }];
      this.cumulativeTokensIn = tokensIn;
      this.cumulativeTokensOut = tokensOut;
      this.cumulativeCost = cost;
      this.cumulativeTurnCount = 1;
      return;
    }
    this.reset();
  }

  recordTurn(tokensIn: number, tokensOut: number, cachedTokensIn = 0, durationS = 0): TurnCost {
    const safeTokensIn = safeTokenCount(tokensIn);
    const safeTokensOut = safeTokenCount(tokensOut);
    const safeCachedTokensIn = Math.min(safeTokenCount(cachedTokensIn), safeTokensIn);
    const safeDurationS = safeMetricNumber(durationS);
    const cost = calculateCost(this.model, safeTokensIn, safeTokensOut, safeCachedTokensIn);
    const tc = this.sanitizeTurn({
      tokensIn: safeTokensIn,
      tokensOut: safeTokensOut,
      cachedTokensIn: safeCachedTokensIn,
      cost: safeMetricNumber(cost),
      durationS: safeDurationS,
    });
    this.turnHistory.push(tc);
    this.cumulativeTokensIn = addTokenCount(this.cumulativeTokensIn, tc.tokensIn);
    this.cumulativeTokensOut = addTokenCount(this.cumulativeTokensOut, tc.tokensOut);
    this.cumulativeCost = addMetric(this.cumulativeCost, tc.cost);
    this.cumulativeTurnCount = addTokenCount(this.cumulativeTurnCount, 1);
    this.trimTurns();
    return tc;
  }

  get totalTokensIn(): number { return safeTokenCount(this.cumulativeTokensIn); }
  get totalTokensOut(): number { return safeTokenCount(this.cumulativeTokensOut); }
  get totalCost(): number { return safeMetricNumber(this.cumulativeCost); }
  get turnCount(): number { return safeTokenCount(this.cumulativeTurnCount); }

  formatSummary(): string {
    return `Tokens: ${this.totalTokensIn.toLocaleString()} in / ${this.totalTokensOut.toLocaleString()} out | Cost: $${this.totalCost.toFixed(4)} | Turns: ${this.turnCount}`;
  }

  formatDetailed(): string {
    const lines = ["Turn | Tokens In | Tokens Out | Cost", "-".repeat(50)];
    const visibleTurns = this.turnHistory.slice(-MAX_COST_TURNS);
    const skipped = Math.max(0, this.turnCount - visibleTurns.length);
    if (skipped > 0) lines.push(`... ${skipped.toLocaleString()} older turns omitted ...`);
    visibleTurns.forEach((t, i) => {
      const turnNumber = skipped + i + 1;
      lines.push(`${turnNumber.toString().padStart(4)} | ${t.tokensIn.toLocaleString().padStart(9)} | ${t.tokensOut.toLocaleString().padStart(10)} | $${t.cost.toFixed(4)}`);
    });
    lines.push("-".repeat(50));
    lines.push(`Total | ${this.totalTokensIn.toLocaleString().padStart(9)} | ${this.totalTokensOut.toLocaleString().padStart(10)} | $${this.totalCost.toFixed(4)}`);
    return lines.join("\n");
  }

  private sanitizeTurn(turn: Partial<Record<keyof TurnCost, unknown>>): TurnCost {
    const tokensIn = safeTokenCount(turn.tokensIn);
    return {
      tokensIn,
      tokensOut: safeTokenCount(turn.tokensOut),
      cachedTokensIn: Math.min(safeTokenCount(turn.cachedTokensIn), tokensIn),
      cost: safeMetricNumber(turn.cost),
      durationS: safeMetricNumber(turn.durationS),
    };
  }

  private trimTurns(): void {
    if (this.turnHistory.length > MAX_COST_TURNS) this.turnHistory = this.turnHistory.slice(-MAX_COST_TURNS);
  }

  private resetTotalsFromHistory(): void {
    this.cumulativeTokensIn = safeSum(this.turnHistory.map(turn => safeTokenCount(turn.tokensIn)), MAX_TOTAL_TOKEN_SUM);
    this.cumulativeTokensOut = safeSum(this.turnHistory.map(turn => safeTokenCount(turn.tokensOut)), MAX_TOTAL_TOKEN_SUM);
    this.cumulativeCost = safeMetricSum(this.turnHistory.map(turn => safeMetricNumber(turn.cost)));
    this.cumulativeTurnCount = this.turnHistory.length;
  }
}

function normalizeModel(value: unknown, fallback = "deepseek-v4-pro"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(COST_MODEL_CONTROL_RE, " ").trim();
  if (!normalized) return fallback;
  return normalized.length <= MAX_COST_MODEL_CHARS ? normalized : safeTailTextBoundary(normalized, MAX_COST_MODEL_CHARS).trim() || fallback;
}

function safeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeMetricNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_METRIC_SUM) : 0;
}

function safeSum(values: number[], max: number): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) continue;
    total = Math.min(max, total + value);
  }
  return total;
}

function safeMetricSum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) continue;
    total = Math.min(MAX_METRIC_SUM, total + value);
  }
  return total;
}

function addTokenCount(current: number, increment: number): number {
  return Math.min(MAX_TOTAL_TOKEN_SUM, safeTokenCount(current) + safeTokenCount(increment));
}

function addMetric(current: number, increment: number): number {
  return Math.min(MAX_METRIC_SUM, safeMetricNumber(current) + safeMetricNumber(increment));
}

function sanitizeTurnArray(value: unknown): TurnCost[] {
  if (!Array.isArray(value)) return [];
  return safeTailArrayItems(value, MAX_COST_TURNS).map(turn => sanitizeTurnRecord(turn));
}

function sanitizeTurnRecord(turn: unknown): TurnCost {
  const tokensIn = safeTokenCount(safeProperty(turn, "tokensIn"));
  return {
    tokensIn,
    tokensOut: safeTokenCount(safeProperty(turn, "tokensOut")),
    cachedTokensIn: Math.min(safeTokenCount(safeProperty(turn, "cachedTokensIn")), tokensIn),
    cost: safeMetricNumber(safeProperty(turn, "cost")),
    durationS: safeMetricNumber(safeProperty(turn, "durationS")),
  };
}

function safeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeArrayLength(value: unknown[]): number {
  try {
    return Number.isSafeInteger(value.length) && value.length >= 0 ? value.length : 0;
  } catch {
    return 0;
  }
}

function safeTailArrayItems(value: unknown[], maxItems: number): unknown[] {
  const length = safeArrayLength(value);
  const start = Math.max(0, length - Math.max(0, Math.floor(maxItems)));
  const items: unknown[] = [];
  for (let index = start; index < length; index++) {
    try {
      items.push(value[index]);
    } catch {
      // Skip hostile entries while preserving readable neighbors.
    }
  }
  return items;
}
