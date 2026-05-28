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

  constructor(model = "deepseek-v4-pro") { this.model = normalizeModel(model); }

  get turns(): TurnCost[] {
    return this.turnHistory.map(turn => ({ ...turn }));
  }

  set turns(value: TurnCost[]) {
    this.turnHistory = sanitizeTurnArray(value);
    this.trimTurns();
  }

  setModel(model: string): void {
    this.model = normalizeModel(model, this.model);
  }

  reset(model = this.model): void {
    this.model = normalizeModel(model);
    this.turnHistory = [];
  }

  hydrateFromSession(session: Session): void {
    this.model = normalizeModel(safeProperty(session, "model"), this.model);
    const sessionTurns = safeProperty(session, "turns");
    if (Array.isArray(sessionTurns) && sessionTurns.length) {
      this.turnHistory = sessionTurns.slice(-MAX_COST_TURNS).map(turn => this.sanitizeTurn({
        tokensIn: safeProperty(turn, "tokens_in"),
        tokensOut: safeProperty(turn, "tokens_out"),
        cachedTokensIn: 0,
        cost: safeProperty(turn, "cost"),
        durationS: safeProperty(turn, "duration_s"),
      }));
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
      return;
    }
    this.turnHistory = [];
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
    this.trimTurns();
    return tc;
  }

  get totalTokensIn(): number { return safeSum(this.turnHistory.map(t => safeTokenCount(t.tokensIn)), MAX_TOTAL_TOKEN_SUM); }
  get totalTokensOut(): number { return safeSum(this.turnHistory.map(t => safeTokenCount(t.tokensOut)), MAX_TOTAL_TOKEN_SUM); }
  get totalCost(): number { return safeMetricSum(this.turnHistory.map(t => safeMetricNumber(t.cost))); }
  get turnCount(): number { return this.turnHistory.length; }

  formatSummary(): string {
    return `Tokens: ${this.totalTokensIn.toLocaleString()} in / ${this.totalTokensOut.toLocaleString()} out | Cost: $${this.totalCost.toFixed(4)} | Turns: ${this.turnCount}`;
  }

  formatDetailed(): string {
    const lines = ["Turn | Tokens In | Tokens Out | Cost", "-".repeat(50)];
    const visibleTurns = this.turnHistory.slice(-MAX_COST_TURNS);
    const skipped = this.turnHistory.length - visibleTurns.length;
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

function sanitizeTurnArray(value: unknown): TurnCost[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_COST_TURNS).map(turn => sanitizeTurnRecord(turn));
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
