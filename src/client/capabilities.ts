/** DeepSeek model/provider capability matrix and request dialect helpers. */

export type ApiProvider =
  | "deepseek"
  | "deepseek-cn"
  | "nvidia-nim"
  | "openrouter"
  | "novita"
  | "fireworks"
  | "sglang";

export type RequestPayloadMode = "chat_completions" | "responses_api";

export interface ModelDeprecation {
  alias: string;
  replacement: string;
  notice: string;
}

export interface ProviderCapability {
  provider: ApiProvider;
  resolved_model: string;
  context_window: number;
  max_output: number;
  thinking_supported: boolean;
  cache_telemetry_supported: boolean;
  request_payload_mode: RequestPayloadMode;
  deprecation?: ModelDeprecation;
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEEPSEEK_V4_MAX_OUTPUT_TOKENS = 262_144;

export function defaultBaseUrlForProvider(provider: ApiProvider): string {
  switch (provider) {
    case "nvidia-nim":
      return "https://integrate.api.nvidia.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "novita":
      return "https://api.novita.ai/v1";
    case "fireworks":
      return "https://api.fireworks.ai/inference/v1";
    case "sglang":
      return "http://localhost:30000/v1";
    case "deepseek-cn":
      return "https://api.deepseeki.com";
    case "deepseek":
    default:
      return "https://api.deepseek.com";
  }
}

const LEGACY_ALIASES: ModelDeprecation[] = [
  legacy("deepseek-chat"),
  legacy("deepseek-reasoner"),
  legacy("deepseek-r1"),
  legacy("deepseek-v3"),
  legacy("deepseek-v3.2"),
];

function legacy(alias: string): ModelDeprecation {
  return {
    alias,
    replacement: "deepseek-v4-flash",
    notice: "Deprecated DeepSeek alias; use deepseek-v4-flash instead.",
  };
}

export function resolveProviderAlias(value: string | undefined | null): ApiProvider | null {
  const normalized = (value || "deepseek").trim().toLowerCase().replace(/_/g, "-");
  switch (normalized) {
    case "deepseek":
    case "deep-seek":
      return "deepseek";
    case "deepseek-cn":
    case "deepseekcn":
    case "deepseek-china":
      return "deepseek-cn";
    case "nvidia":
    case "nvidia-nim":
    case "nim":
      return "nvidia-nim";
    case "openrouter":
    case "open-router":
      return "openrouter";
    case "novita":
      return "novita";
    case "fireworks":
    case "fireworks-ai":
      return "fireworks";
    case "sglang":
    case "sg-lang":
      return "sglang";
    default:
      return null;
  }
}

export function parseProvider(value: string | undefined | null): ApiProvider {
  return resolveProviderAlias(value) || "deepseek";
}

export function canonicalModelName(model: string): string | null {
  const normalized = model.trim().toLowerCase();
  switch (normalized) {
    case "deepseek-v4-pro":
    case "deepseek-v4pro":
      return "deepseek-v4-pro";
    case "deepseek-v4-flash":
    case "deepseek-v4flash":
    case "deepseek-v4":
      return "deepseek-v4-flash";
    case "deepseek-chat":
    case "deepseek-reasoner":
    case "deepseek-r1":
    case "deepseek-v3":
    case "deepseek-v3.2":
      return "deepseek-v4-flash";
    default:
      return null;
  }
}

export function normalizeModelName(model: string): string {
  const canonical = canonicalModelName(model);
  if (canonical) return canonical;
  const trimmed = model.trim();
  if (!trimmed) return "deepseek-v4-pro";
  return trimmed;
}

export function deprecationForModel(model: string): ModelDeprecation | undefined {
  const normalized = model.trim().toLowerCase();
  return LEGACY_ALIASES.find(alias => alias.alias === normalized);
}

export function resolveProviderModel(provider: ApiProvider, model: string): string {
  const normalized = normalizeModelName(model);
  const isPro = isV4ProModel(normalized);
  const isFlash = isV4FlashModel(normalized);
  if (!isPro && !isFlash) return normalized;

  if (provider === "nvidia-nim") return `deepseek-ai/${isPro ? "deepseek-v4-pro" : "deepseek-v4-flash"}`;
  if (provider === "openrouter" || provider === "novita") return `deepseek/${isPro ? "deepseek-v4-pro" : "deepseek-v4-flash"}`;
  if (provider === "fireworks") return `accounts/fireworks/models/${isPro ? "deepseek-v4-pro" : "deepseek-v4-flash"}`;
  if (provider === "sglang") return `deepseek-ai/${isPro ? "DeepSeek-V4-Pro" : "DeepSeek-V4-Flash"}`;
  return normalized;
}

export function providerCapability(provider: ApiProvider, model: string): ProviderCapability {
  const resolvedModel = resolveProviderModel(provider, model);
  const v4 = isV4ProModel(resolvedModel) || isV4FlashModel(resolvedModel);
  const deprecation = deprecationForModel(model);
  return {
    provider,
    resolved_model: resolvedModel,
    context_window: v4 ? DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS : DEFAULT_CONTEXT_WINDOW_TOKENS,
    max_output: v4 ? DEEPSEEK_V4_MAX_OUTPUT_TOKENS : 4096,
    thinking_supported: v4,
    cache_telemetry_supported: provider === "deepseek" || provider === "deepseek-cn" || provider === "nvidia-nim",
    request_payload_mode: "chat_completions",
    ...(deprecation ? { deprecation } : {}),
  };
}

export function isV4ProModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("v4-pro") || normalized.includes("v4pro");
}

export function isV4FlashModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("v4-flash") || normalized.includes("v4flash") || normalized.endsWith("deepseek-v4");
}

export function shouldReplayReasoningContent(model: string, effort?: string | null): boolean {
  const normalizedEffort = (effort || "").trim().toLowerCase();
  if (["off", "disabled", "none", "false"].includes(normalizedEffort)) return false;
  return isV4ProModel(model) || isV4FlashModel(model) || canonicalModelName(model) !== null;
}

export function applyReasoningEffort(
  request: Record<string, unknown>,
  effort: string | undefined | null,
  provider: ApiProvider,
  thinkingSupported: boolean,
): void {
  if (!thinkingSupported) return;
  const normalized = (effort || "").trim().toLowerCase();
  if (["off", "disabled", "none", "false"].includes(normalized)) {
    if (provider === "nvidia-nim") request.chat_template_kwargs = { thinking: false };
    else request.thinking = { type: "disabled" };
    return;
  }
  if (["xhigh", "max", "highest"].includes(normalized)) {
    if (provider === "nvidia-nim") request.chat_template_kwargs = { thinking: true, reasoning_effort: "max" };
    else {
      request.reasoning_effort = "max";
      request.thinking = { type: "enabled" };
    }
    return;
  }
  if (["low", "minimal", "medium", "mid", "high", ""].includes(normalized)) {
    if (provider === "nvidia-nim") request.chat_template_kwargs = { thinking: true, reasoning_effort: "high" };
    else {
      request.reasoning_effort = "high";
      request.thinking = { type: "enabled" };
    }
  }
}

export function extractCachedInputTokens(usage: Record<string, unknown> | null | undefined): number {
  if (!usage) return 0;
  const directKeys = [
    "prompt_cache_hit_tokens",
    "prompt_cache_hit",
    "cache_hit_tokens",
    "cached_tokens",
  ];
  for (const key of directKeys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  }
  const details = usage.prompt_tokens_details;
  if (details && typeof details === "object") {
    const cached = (details as Record<string, unknown>).cached_tokens;
    if (typeof cached === "number" && Number.isFinite(cached)) return Math.max(0, cached);
  }
  return 0;
}
