import {
  defaultBaseUrlForProvider,
  providerCapability,
  resolveProviderAlias,
  type ApiProvider,
} from "../client/capabilities.js";
import { p } from "../ui/palette.js";
import { pickModel, pickProvider } from "./picker.js";
import type { SlashCommandHandler } from "./types.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_COMMAND_MODEL_CHARS = 512;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u001F\u007F]/g;
const MAX_PROVIDER_DISPLAY_CHARS = 120;
const PROVIDER_USAGE = "Usage: /provider [deepseek|deepseek-cn|nvidia-nim|openrouter|novita|fireworks|sglang] [model]";

export const providerCommand: SlashCommandHandler = async ({ cfg, session, parts, runtime, costTracker, write }) => {
  if (parts.length > 3) {
    write(p.dim(PROVIDER_USAGE));
    return;
  }
  let rawProvider: string | undefined = parts[1];
  if (!rawProvider) {
    rawProvider = await pickProvider(cfg.provider, runtime.renderPicker, runtime.clearModal) || undefined;
  }
  if (!rawProvider) {
    write(safeJsonStringify({
      provider: cfg.provider,
      base_url: cfg.base_url,
      model: cfg.model,
      capability: providerCapability(cfg.provider as ApiProvider, cfg.model),
    }, { space: 2 }));
    return;
  }
  const provider = resolveProviderAlias(rawProvider);
  if (!provider) {
    write(p.warning(`Unknown provider: ${sanitizeCommandDisplayText(rawProvider)}`));
    write(p.dim(PROVIDER_USAGE));
    return;
  }
  const modelArg = normalizeCommandModel(parts[2] || cfg.model);
  if (!modelArg) {
    write(p.warning("Model must be a non-empty string without control characters."));
    return;
  }
  const capability = providerCapability(provider, modelArg);
  applyCapabilitySelection({ cfg, session, costTracker, runtime }, provider, defaultBaseUrlForProvider(provider), capability);
  write(p.success(`Provider: ${provider}`));
  write(p.success(`Model: ${capability.resolved_model}`));
  write(p.dim(`Base URL: ${cfg.base_url}`));
};

export const modelCommand: SlashCommandHandler = async ({ cfg, session, parts, runtime, costTracker, write }) => {
  if (parts.length > 2) {
    write(p.dim("Usage: /model [name]"));
    return;
  }
  const model = parts[1];
  if (model) {
    const normalizedModel = normalizeCommandModel(model);
    if (!normalizedModel) {
      write(p.warning("Model must be a non-empty string without control characters."));
      return;
    }
    const capability = providerCapability(cfg.provider as ApiProvider, normalizedModel);
    applyCapabilitySelection({ cfg, session, costTracker, runtime }, capability.provider, cfg.base_url, capability);
    write(p.success(`Model: ${capability.resolved_model}`));
    if (capability.deprecation) {
      write(p.warning(`${capability.deprecation.alias} is deprecated; use ${capability.deprecation.replacement}`));
    }
    return;
  }

  const selected = await pickModel(cfg.model, runtime.renderPicker, runtime.clearModal);
  const normalizedSelected = normalizeCommandModel(selected);
  if (!normalizedSelected) return;
  const capability = providerCapability(cfg.provider as ApiProvider, normalizedSelected);
  applyCapabilitySelection({ cfg, session, costTracker, runtime }, capability.provider, cfg.base_url, capability);
  write(p.success(`Model: ${capability.resolved_model}`));
  if (capability.deprecation) {
    write(p.warning(`${capability.deprecation.alias} is deprecated; use ${capability.deprecation.replacement}`));
  }
};

export const capabilitiesCommand: SlashCommandHandler = ({ parts, cfg, write }) => {
  if (parts.length !== 1) {
    write(p.dim("Usage: /capabilities"));
    return;
  }
  const provider = resolveProviderAlias(cfg.provider) || "deepseek";
  const capability = providerCapability(provider, cfg.model);
  write(safeJsonStringify(capability, { space: 2 }));
};

function normalizeCommandModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_COMMAND_MODEL_CHARS || CONTROL_TEXT_RE.test(trimmed)) return null;
  return trimmed;
}

function sanitizeCommandDisplayText(value: unknown): string {
  return safeSliceTextBoundary(String(value ?? "").replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim(), MAX_PROVIDER_DISPLAY_CHARS);
}

function applyCapabilitySelection(
  state: Pick<Parameters<SlashCommandHandler>[0], "cfg" | "session" | "costTracker" | "runtime">,
  provider: ApiProvider,
  baseUrl: string,
  capability: ReturnType<typeof providerCapability>,
): void {
  state.cfg.provider = provider;
  state.cfg.base_url = baseUrl;
  state.cfg.model = capability.resolved_model;
  state.cfg.context_limit = capability.context_window;
  state.cfg.max_tokens = Math.min(state.cfg.max_tokens, capability.max_output);
  state.session.model = capability.resolved_model;
  state.costTracker.setModel(capability.resolved_model);
  state.runtime.rebuildRuntime();
  state.runtime.rebuildSystemPrompt();
}
