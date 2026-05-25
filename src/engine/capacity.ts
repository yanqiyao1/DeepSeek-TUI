/** Capacity-aware context pressure guardrails. */

export type RiskBand = "low" | "medium" | "high";
export type GuardrailAction = "no_intervention" | "targeted_context_refresh" | "verify_with_tool_replay" | "verify_and_replan";

export interface CapacityDecision {
  used_tokens: number;
  context_limit: number;
  used_ratio: number;
  risk: RiskBand;
  action: GuardrailAction;
  reason: string;
}

export interface CapacityConfig {
  lowRiskMax?: number;
  mediumRiskMax?: number;
  severeMinSlack?: number;
}

const DEFAULT_LOW_RISK_MAX = 0.50;
const DEFAULT_MEDIUM_RISK_MAX = 0.72;
const DEFAULT_SEVERE_MIN_SLACK = 0.08;
const MAX_CAPACITY_REASON_CHARS = 300;
const CAPACITY_CONTROL_RE = /[\u0000-\u001F\u007F]/g;

export class CapacityController {
  private lowRiskMax: number;
  private mediumRiskMax: number;
  private severeMinSlack: number;

  constructor(config: CapacityConfig = {}) {
    this.lowRiskMax = safeRatio(config.lowRiskMax, DEFAULT_LOW_RISK_MAX);
    this.mediumRiskMax = safeRatio(config.mediumRiskMax, DEFAULT_MEDIUM_RISK_MAX);
    if (this.mediumRiskMax < this.lowRiskMax) {
      [this.lowRiskMax, this.mediumRiskMax] = [this.mediumRiskMax, this.lowRiskMax];
    }
    this.severeMinSlack = safeRatio(config.severeMinSlack, DEFAULT_SEVERE_MIN_SLACK);
  }

  observe(usedTokens: number, contextLimit: number): CapacityDecision {
    const safeUsed = safeTokenCount(usedTokens);
    const safeLimit = Math.max(1, safeTokenCount(contextLimit, 1));
    const ratio = Math.min(10, safeUsed / safeLimit);
    const slack = 1 - ratio;
    if (slack <= this.severeMinSlack) {
      return {
        used_tokens: safeUsed,
        context_limit: safeLimit,
        used_ratio: ratio,
        risk: "high",
        action: "verify_and_replan",
        reason: "context window is nearly exhausted",
      };
    }
    if (ratio > this.mediumRiskMax) {
      return {
        used_tokens: safeUsed,
        context_limit: safeLimit,
        used_ratio: ratio,
        risk: "high",
        action: "targeted_context_refresh",
        reason: "context pressure is high; compact before continuing",
      };
    }
    if (ratio > this.lowRiskMax) {
      return {
        used_tokens: safeUsed,
        context_limit: safeLimit,
        used_ratio: ratio,
        risk: "medium",
        action: "verify_with_tool_replay",
        reason: "context pressure is moderate",
      };
    }
    return {
      used_tokens: safeUsed,
      context_limit: safeLimit,
      used_ratio: ratio,
      risk: "low",
      action: "no_intervention",
      reason: "context pressure is low",
    };
  }
}

export function formatCapacityDecision(decision: CapacityDecision): string {
  const usedTokens = safeTokenCount(decision.used_tokens);
  const contextLimit = Math.max(1, safeTokenCount(decision.context_limit, 1));
  const usedRatio = Number.isFinite(decision.used_ratio) && decision.used_ratio >= 0
    ? Math.min(10, decision.used_ratio)
    : usedTokens / contextLimit;
  const risk = normalizeRisk(decision.risk);
  const action = normalizeAction(decision.action);
  const reason = safeReason(decision.reason, "capacity telemetry unavailable");
  return [
    `risk: ${risk}`,
    `action: ${action}`,
    `context: ${usedTokens.toLocaleString()} / ${contextLimit.toLocaleString()} (${(usedRatio * 100).toFixed(1)}%)`,
    `reason: ${reason}`,
  ].join("\n");
}

function safeTokenCount(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function safeRatio(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function normalizeRisk(value: unknown): RiskBand {
  return value === "low" || value === "medium" || value === "high" ? value : "low";
}

function normalizeAction(value: unknown): GuardrailAction {
  return value === "no_intervention"
    || value === "targeted_context_refresh"
    || value === "verify_with_tool_replay"
    || value === "verify_and_replan"
    ? value
    : "no_intervention";
}

function safeReason(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(CAPACITY_CONTROL_RE, " ").trim();
  return normalized ? normalized.slice(0, MAX_CAPACITY_REASON_CHARS) : fallback;
}
