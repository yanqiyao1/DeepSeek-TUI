/** Configuration management: TOML file + env vars + CLI overrides -> zod schema. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS, defaultBaseUrlForProvider, parseProvider, providerCapability, resolveProviderAlias } from "./client/capabilities.js";
import { DEFAULT_SKILL_INSTALL_SIZE_BYTES, DEFAULT_SKILLS_REGISTRY_URL, defaultSkillsDir } from "./engine/skills.js";
import { LEGACY_DEEPSEEK_DIR, SEEKCODE_DIR, homeDir } from "./paths.js";

const MCPConfigSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "sse"]).default("stdio"),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});

export type MCPConfig = z.infer<typeof MCPConfigSchema>;

const StatusItemSchema = z.enum([
  "mode",
  "model",
  "workspace",
  "context",
  "cache",
  "tools",
  "elapsed",
  "cost",
  "hints",
]);

const PermissionActionSchema = z.enum(["allow", "ask", "deny"]);

const WebConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(["live", "off"]).default("live"),
  search_engine: z.enum(["auto", "bing", "duckduckgo", "brave", "tavily", "serper", "searxng", "google", "arxiv", "baidu", "exa", "kagi", "semantic_scholar", "pubmed"]).default("auto"),
  allowed_domains: z.array(z.string()).default([]),
  blocked_domains: z.array(z.string()).default([]),
  google_api_key: z.string().default(""),
  google_cx: z.string().default(""),
  exa_api_key: z.string().default(""),
  kagi_api_key: z.string().default(""),
  brave_api_key: z.string().default(""),
  tavily_api_key: z.string().default(""),
  serper_api_key: z.string().default(""),
  semantic_scholar_api_key: z.string().default(""),
  pubmed_api_key: z.string().default(""),
  searxng_url: z.string().default(""),
  proxy: z.string().default(""),
  no_proxy: z.array(z.string()).default([]),
  search_timeout_ms: z.number().int().positive().default(15_000),
  fetch_timeout_ms: z.number().int().positive().default(15_000),
  max_bytes: z.number().int().positive().default(1_000_000),
});

const ConfigSchema = z.object({
  api_key: z.string().default(""),
  provider: z.enum(["deepseek", "deepseek-cn", "nvidia-nim", "openrouter", "novita", "fireworks", "sglang"]).default("deepseek"),
  base_url: z.string().default("https://api.deepseek.com"),
  model: z.string().default("deepseek-v4-pro"),
  flash_model: z.string().default("deepseek-v4-flash"),
  mode: z.enum(["plan", "agent", "yolo"]).default("agent"),
  max_tokens: z.number().int().positive().default(8192),
  max_turns: z.number().int().positive().default(50),
  context_limit: z.number().int().positive().default(DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS),
  reasoning_effort: z.enum(["off", "low", "medium", "high", "max", "xhigh"]).default("high"),
  rollback_enabled: z.boolean().default(true),
  cost_tracking: z.boolean().default(true),
  thinking_visible: z.boolean().default(true),
  tui_alternate_screen: z.enum(["auto", "always", "never"]).default("never"),
  mcp_servers: z.array(MCPConfigSchema).default([]),
  skills_dir: z.string().default(() => defaultSkillsDir()),
  skills_registry_url: z.string().default(DEFAULT_SKILLS_REGISTRY_URL),
  skills_max_install_size_bytes: z.number().int().positive().default(DEFAULT_SKILL_INSTALL_SIZE_BYTES),
  theme: z.string().default("deepseek-dark"),
  context_refresh_enabled: z.boolean().default(true),
  approval_policy: z.enum(["on-request", "on-failure", "never", "untrusted"]).default("on-request"),
  sandbox_mode: z.enum(["workspace-write", "read-only", "danger-full-access"]).default("workspace-write"),
  workspace_boundary: z.boolean().default(true),
  trusted_workspaces: z.array(z.string()).default([]),
  lsp_auto_diagnostics: z.boolean().default(true),
  lsp_diagnostics_severity: z.enum(["error", "warning", "information", "hint", "all"]).default("warning"),
  tool_call_budget_per_turn: z.number().int().positive().default(80),
  tool_failure_degrade_threshold: z.number().int().positive().default(3),
  status_items: z.array(StatusItemSchema).default(["mode", "model", "workspace"]),
  permissions: z.record(PermissionActionSchema).default({}),
  web: WebConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type WebConfig = Config["web"];

export interface ConfigValidationIssue {
  level: "error" | "warning" | "info";
  source: string;
  path?: string;
  key?: string;
  message: string;
}

export interface ConfigValidationReport {
  ok: boolean;
  issues: ConfigValidationIssue[];
  resolved?: Config;
}

export interface ConfigMigrationReport {
  changed: boolean;
  path: string;
  actions: string[];
  warnings: string[];
}

export interface ConfigConflict {
  key: string;
  winner: string;
  winner_value: unknown;
  candidates: Array<{ source: string; value: unknown; path?: string }>;
}

export interface ConfigExplainReport {
  precedence: string[];
  sources: Array<{ source: string; path?: string; exists?: boolean; keys: string[] }>;
  conflicts: ConfigConflict[];
  resolved: Config;
}

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_USER_CONFIG_TEMPLATE = `# Seek Code user configuration
# This file is created automatically on first use.
# Prefer SEEKCODE_* environment variables. DEEPSEEK_* remains supported
# for provider/API/model compatibility and legacy config.

api_key = ""
provider = "deepseek"
base_url = "https://api.deepseek.com"
model = "deepseek-v4-pro"
flash_model = "deepseek-v4-flash"

mode = "agent"
max_tokens = 8192
max_turns = 50
reasoning_effort = "high"

tui_alternate_screen = "never"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
workspace_boundary = true

[web]
enabled = true
mode = "live"
search_engine = "auto"
`;

function loadTomlFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, "utf-8");
    return parseToml(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readTomlFile(path: string): { data: Record<string, unknown>; exists: boolean; error?: string } {
  try {
    const raw = readFileSync(path, "utf-8");
    return { data: parseToml(raw) as Record<string, unknown>, exists: true };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { data: {}, exists: false };
    return { data: {}, exists: existsSync(path), error: e.message };
  }
}

export function userConfigPath(): string {
  return resolve(homeDir(), SEEKCODE_DIR, "config.toml");
}

export function legacyUserConfigPath(): string {
  return resolve(homeDir(), ".config", "deepseek", "config.toml");
}

export function projectConfigPath(): string {
  return resolve(process.cwd(), SEEKCODE_DIR, "config.toml");
}

export function legacyProjectConfigPath(): string {
  return resolve(process.cwd(), LEGACY_DEEPSEEK_DIR, "config.toml");
}

export function loadUserConfigRaw(): Record<string, unknown> {
  ensureUserConfigFile();
  return loadTomlFile(userConfigPath());
}

export function writeUserConfigRaw(config: Record<string, unknown>): void {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyToml(config as any), "utf-8");
}

export function ensureUserConfigFile(): void {
  const path = userConfigPath();
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, DEFAULT_USER_CONFIG_TEMPLATE, "utf-8");
}

export function writeUserApiKey(apiKey: string): void {
  ensureUserConfigFile();
  const path = userConfigPath();
  const loaded = readTomlFile(path);
  if (loaded.error) throw new Error(`Could not read config file ${path}: ${loaded.error}`);
  const config = { ...loaded.data, api_key: apiKey };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyToml(config as any), "utf-8");
}

function loadEnv(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const map: [string, string][] = [
    ["DEEPSEEK_API_KEY", "api_key"],
    ["DEEPSEEK_PROVIDER", "provider"],
    ["DEEPSEEK_BASE_URL", "base_url"],
    ["DEEPSEEK_MODEL", "model"],
    ["DEEPSEEK_FLASH_MODEL", "flash_model"],
    ["DEEPSEEK_MODE", "mode"],
    ["DEEPSEEK_MAX_TOKENS", "max_tokens"],
    ["DEEPSEEK_MAX_TURNS", "max_turns"],
    ["DEEPSEEK_CONTEXT_LIMIT", "context_limit"],
    ["DEEPSEEK_REASONING_EFFORT", "reasoning_effort"],
    ["DEEPSEEK_TUI_ALTERNATE_SCREEN", "tui_alternate_screen"],
    ["DEEPSEEK_SKILLS_DIR", "skills_dir"],
    ["DEEPSEEK_SKILLS_REGISTRY_URL", "skills_registry_url"],
    ["DEEPSEEK_SKILLS_MAX_INSTALL_SIZE_BYTES", "skills_max_install_size_bytes"],
    ["DEEPSEEK_APPROVAL_POLICY", "approval_policy"],
    ["DEEPSEEK_SANDBOX_MODE", "sandbox_mode"],
    ["DEEPSEEK_THEME", "theme"],
    ["DEEPSEEK_LSP_DIAGNOSTICS_SEVERITY", "lsp_diagnostics_severity"],
    ["DEEPSEEK_TOOL_CALL_BUDGET_PER_TURN", "tool_call_budget_per_turn"],
    ["DEEPSEEK_TOOL_FAILURE_DEGRADE_THRESHOLD", "tool_failure_degrade_threshold"],
    ["DEEPSEEK_STATUS_ITEMS", "status_items"],
    ["DEEPSEEK_WEB_MODE", "web.mode"],
    ["DEEPSEEK_WEB_SEARCH_ENGINE", "web.search_engine"],
    ["DEEPSEEK_WEB_ALLOWED_DOMAINS", "web.allowed_domains"],
    ["DEEPSEEK_WEB_BLOCKED_DOMAINS", "web.blocked_domains"],
    ["DEEPSEEK_WEB_GOOGLE_API_KEY", "web.google_api_key"],
    ["DEEPSEEK_WEB_GOOGLE_CX", "web.google_cx"],
    ["DEEPSEEK_WEB_EXA_API_KEY", "web.exa_api_key"],
    ["DEEPSEEK_WEB_KAGI_API_KEY", "web.kagi_api_key"],
    ["DEEPSEEK_WEB_BRAVE_API_KEY", "web.brave_api_key"],
    ["DEEPSEEK_WEB_TAVILY_API_KEY", "web.tavily_api_key"],
    ["DEEPSEEK_WEB_SERPER_API_KEY", "web.serper_api_key"],
    ["DEEPSEEK_WEB_SEMANTIC_SCHOLAR_API_KEY", "web.semantic_scholar_api_key"],
    ["DEEPSEEK_WEB_PUBMED_API_KEY", "web.pubmed_api_key"],
    ["DEEPSEEK_WEB_SEARXNG_URL", "web.searxng_url"],
    ["DEEPSEEK_WEB_PROXY", "web.proxy"],
    ["DEEPSEEK_WEB_NO_PROXY", "web.no_proxy"],
    ["DEEPSEEK_WEB_SEARCH_TIMEOUT_MS", "web.search_timeout_ms"],
    ["DEEPSEEK_WEB_FETCH_TIMEOUT_MS", "web.fetch_timeout_ms"],
    ["DEEPSEEK_WEB_MAX_BYTES", "web.max_bytes"],
  ];
  for (const [legacyEnv, key] of map) {
    const canonicalEnv = legacyEnv.replace(/^DEEPSEEK_/, "SEEKCODE_");
    const val = envValue(canonicalEnv, legacyEnv);
    if (val) {
      if (
        ["max_tokens", "max_turns", "context_limit", "tool_call_budget_per_turn", "tool_failure_degrade_threshold", "skills_max_install_size_bytes"].includes(key)
        || key.startsWith("web.") && /_ms$|max_bytes$/.test(key)
      ) {
        const parsed = parseEnvInteger(val);
        if (parsed !== null) setNested(result, key, parsed);
      } else if (key === "status_items" || key === "web.allowed_domains" || key === "web.blocked_domains" || key === "web.no_proxy") {
        setNested(result, key, val.split(",").map(item => item.trim()).filter(Boolean));
      } else {
        setNested(result, key, val);
      }
    }
  }
  if (envValue("SEEKCODE_CONTEXT_REFRESH_ENABLED", "DEEPSEEK_CONTEXT_REFRESH_ENABLED")) {
    result.context_refresh_enabled = parseEnvBool(envValue("SEEKCODE_CONTEXT_REFRESH_ENABLED", "DEEPSEEK_CONTEXT_REFRESH_ENABLED")!);
  }
  if (envValue("SEEKCODE_WORKSPACE_BOUNDARY", "DEEPSEEK_WORKSPACE_BOUNDARY")) {
    result.workspace_boundary = parseEnvBool(envValue("SEEKCODE_WORKSPACE_BOUNDARY", "DEEPSEEK_WORKSPACE_BOUNDARY")!);
  }
  if (envValue("SEEKCODE_LSP_AUTO_DIAGNOSTICS", "DEEPSEEK_LSP_AUTO_DIAGNOSTICS")) {
    result.lsp_auto_diagnostics = parseEnvBool(envValue("SEEKCODE_LSP_AUTO_DIAGNOSTICS", "DEEPSEEK_LSP_AUTO_DIAGNOSTICS")!);
  }
  if (envValue("SEEKCODE_ROLLBACK_ENABLED", "DEEPSEEK_ROLLBACK_ENABLED")) {
    result.rollback_enabled = parseEnvBool(envValue("SEEKCODE_ROLLBACK_ENABLED", "DEEPSEEK_ROLLBACK_ENABLED")!);
  }
  if (envValue("SEEKCODE_COST_TRACKING", "DEEPSEEK_COST_TRACKING")) {
    result.cost_tracking = parseEnvBool(envValue("SEEKCODE_COST_TRACKING", "DEEPSEEK_COST_TRACKING")!);
  }
  if (envValue("SEEKCODE_THINKING_VISIBLE", "DEEPSEEK_THINKING_VISIBLE")) {
    result.thinking_visible = parseEnvBool(envValue("SEEKCODE_THINKING_VISIBLE", "DEEPSEEK_THINKING_VISIBLE")!);
  }
  if (envValue("SEEKCODE_WEB_ENABLED", "DEEPSEEK_WEB_ENABLED")) {
    setNested(result, "web.enabled", parseEnvBool(envValue("SEEKCODE_WEB_ENABLED", "DEEPSEEK_WEB_ENABLED")!));
  }
  if (!getNested(result, "web.google_api_key") && process.env.GOOGLE_API_KEY) {
    setNested(result, "web.google_api_key", process.env.GOOGLE_API_KEY);
  }
  if (!getNested(result, "web.google_cx") && (process.env.GOOGLE_CSE_ID || process.env.GOOGLE_CX)) {
    setNested(result, "web.google_cx", process.env.GOOGLE_CSE_ID || process.env.GOOGLE_CX);
  }
  if (!getNested(result, "web.exa_api_key") && process.env.EXA_API_KEY) {
    setNested(result, "web.exa_api_key", process.env.EXA_API_KEY);
  }
  if (!getNested(result, "web.kagi_api_key") && process.env.KAGI_API_KEY) {
    setNested(result, "web.kagi_api_key", process.env.KAGI_API_KEY);
  }
  if (!getNested(result, "web.brave_api_key") && process.env.BRAVE_SEARCH_API_KEY) {
    setNested(result, "web.brave_api_key", process.env.BRAVE_SEARCH_API_KEY);
  }
  if (!getNested(result, "web.tavily_api_key") && process.env.TAVILY_API_KEY) {
    setNested(result, "web.tavily_api_key", process.env.TAVILY_API_KEY);
  }
  if (!getNested(result, "web.serper_api_key") && process.env.SERPER_API_KEY) {
    setNested(result, "web.serper_api_key", process.env.SERPER_API_KEY);
  }
  if (!getNested(result, "web.semantic_scholar_api_key") && (process.env.SEMANTIC_SCHOLAR_API_KEY || process.env.S2_API_KEY)) {
    setNested(result, "web.semantic_scholar_api_key", process.env.SEMANTIC_SCHOLAR_API_KEY || process.env.S2_API_KEY);
  }
  if (!getNested(result, "web.pubmed_api_key") && (process.env.PUBMED_API_KEY || process.env.NCBI_API_KEY)) {
    setNested(result, "web.pubmed_api_key", process.env.PUBMED_API_KEY || process.env.NCBI_API_KEY);
  }
  if (!getNested(result, "web.searxng_url") && process.env.SEARXNG_URL) {
    setNested(result, "web.searxng_url", process.env.SEARXNG_URL);
  }
  const trustedWorkspaces = envValue("SEEKCODE_TRUSTED_WORKSPACES", "DEEPSEEK_TRUSTED_WORKSPACES");
  if (trustedWorkspaces) {
    result.trusted_workspaces = trustedWorkspaces
      .split(":")
      .map(item => item.trim())
      .filter(Boolean);
  }
  return result;
}

function envValue(primary: string, fallback: string): string | undefined {
  return process.env[primary] ?? process.env[fallback];
}

function parseEnvBool(value: string): boolean | string {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}

function parseEnvInteger(value: string): number | null {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function setNested(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  if (!isSafeConfigPath(parts)) return;
  if (parts.length === 1) {
    target[key] = value;
    return;
  }
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function getNested(target: Record<string, unknown>, key: string): unknown {
  if (!isSafeConfigPath(key.split("."))) return undefined;
  let current: unknown = target;
  for (const part of key.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function loadConfig(cliOverrides: Record<string, unknown> = {}): Config {
  // Layered loading: defaults < user < project < env < CLI
  ensureUserConfigFile();
  const merged: Record<string, unknown> = {};

  // User config
  mergeConfigLayer(merged, migrateConfigObject(loadTomlFile(userConfigPath())).config);

  // Project-local config
  mergeConfigLayer(merged, migrateConfigObject(loadTomlFile(projectConfigPath())).config);

  // Env vars
  mergeConfigLayer(merged, loadEnv());

  // CLI overrides (skip empty api_key)
  mergeConfigLayer(merged, normalizeCliOverrides(cliOverrides));

  if (typeof merged.provider === "string") {
    const resolvedProvider = resolveProviderAlias(merged.provider);
    if (!resolvedProvider) throw new Error(`provider must be one of: deepseek, deepseek-cn, nvidia-nim, openrouter, novita, fireworks, sglang`);
    merged.provider = resolvedProvider;
  }
  const parsed = ConfigSchema.parse(merged);
  const capability = providerCapability(parsed.provider, parsed.model);
  const cliBaseUrl = (cliOverrides as Record<string, unknown>).base_url ?? (cliOverrides as Record<string, unknown>).baseUrl;
  const baseUrlWasExplicit = typeof cliBaseUrl === "string" && cliBaseUrl.trim() !== ""
    || Object.prototype.hasOwnProperty.call(loadEnv(), "base_url")
    || typeof merged.base_url === "string" && merged.base_url !== DEFAULT_DEEPSEEK_BASE_URL;
  const contextLimitExplicit = Object.prototype.hasOwnProperty.call(merged, "context_limit");
  return {
    ...parsed,
    base_url: baseUrlWasExplicit ? parsed.base_url : defaultBaseUrlForProvider(parsed.provider),
    model: capability.resolved_model,
    context_limit: contextLimitExplicit ? parsed.context_limit : capability.context_window,
    max_tokens: Math.min(parsed.max_tokens, capability.max_output),
  };
}

export function validateConfig(cliOverrides: Record<string, unknown> = {}): ConfigValidationReport {
  const issues: ConfigValidationIssue[] = [];
  for (const source of configSources(cliOverrides)) {
    if (source.error) {
      issues.push(configIssue("error", source.source, source.error, source.path));
      continue;
    }
    const migrated = migrateConfigObject(source.values);
    for (const warning of migrated.warnings) {
      issues.push(configIssue("warning", source.source, warning, source.path));
    }
    const parsed = ConfigSchema.partial().safeParse(migrated.config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push(configIssue("error", source.source, issue.message, source.path, issue.path.join(".")));
      }
    }
    for (const issue of semanticConfigIssues(migrated.config, source.source, source.path)) issues.push(issue);
  }
  try {
    const resolved = loadConfig(cliOverrides);
    return { ok: !issues.some(issue => issue.level === "error"), issues, resolved };
  } catch (e: any) {
    issues.push({ level: "error", source: "resolved", message: e.message });
    return { ok: false, issues };
  }
}

export function migrateUserConfig(options: { dryRun?: boolean } = {}): ConfigMigrationReport {
  if ((!existsSync(userConfigPath()) || isGeneratedDefaultUserConfig()) && existsSync(legacyUserConfigPath())) {
    return migrateConfigFileFrom(legacyUserConfigPath(), userConfigPath(), options);
  }
  return migrateConfigFile(userConfigPath(), options);
}

export function migrateProjectConfig(options: { dryRun?: boolean } = {}): ConfigMigrationReport {
  if (!existsSync(projectConfigPath()) && existsSync(legacyProjectConfigPath())) {
    return migrateConfigFileFrom(legacyProjectConfigPath(), projectConfigPath(), options);
  }
  return migrateConfigFile(projectConfigPath(), options);
}

export function migrateConfigFile(path: string, options: { dryRun?: boolean } = {}): ConfigMigrationReport {
  return migrateConfigFileFrom(path, path, options);
}

function migrateConfigFileFrom(sourcePath: string, outputPath: string, options: { dryRun?: boolean } = {}): ConfigMigrationReport {
  const loaded = readTomlFile(sourcePath);
  if (!loaded.exists && !loaded.error) return { changed: false, path: outputPath, actions: [], warnings: [`Config file does not exist: ${outputPath}`] };
  if (loaded.error) return { changed: false, path: outputPath, actions: [], warnings: [loaded.error] };
  const migrated = migrateConfigObject(loaded.data);
  const copiedFromLegacy = sourcePath !== outputPath;
  const actions = copiedFromLegacy ? [`copied legacy config ${sourcePath} → ${outputPath}`, ...migrated.actions] : migrated.actions;
  const changed = copiedFromLegacy || migrated.changed;
  if (changed && !options.dryRun) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, stringifyToml(migrated.config as any), "utf-8");
  }
  return { changed, path: outputPath, actions, warnings: migrated.warnings };
}

function isGeneratedDefaultUserConfig(): boolean {
  try {
    return readFileSync(userConfigPath(), "utf-8") === DEFAULT_USER_CONFIG_TEMPLATE;
  } catch {
    return false;
  }
}

export function explainConfig(cliOverrides: Record<string, unknown> = {}): ConfigExplainReport {
  const sources = configSources(cliOverrides);
  const conflicts: ConfigConflict[] = [];
  const valuesByKey = new Map<string, Array<{ source: string; value: unknown; path?: string }>>();
  for (const source of sources) {
    const migrated = migrateConfigObject(source.values).config;
    for (const [key, value] of flattenConfigEntries(migrated)) {
      if (value === undefined || value === null || value === "") continue;
      const list = valuesByKey.get(key) || [];
      const candidate: { source: string; value: unknown; path?: string } = { source: source.source, value };
      if (source.path !== undefined) candidate.path = source.path;
      list.push(candidate);
      valuesByKey.set(key, list);
    }
  }
  for (const [key, candidates] of valuesByKey) {
    const unique = new Set(candidates.map(candidate => stableValue(candidate.value)));
    if (candidates.length <= 1 || unique.size <= 1) continue;
    const winner = candidates[candidates.length - 1]!;
    conflicts.push({ key, winner: winner.source, winner_value: winner.value, candidates });
  }
  return {
    precedence: sources.map(source => source.source),
    sources: sources.map(source => {
      const item: { source: string; path?: string; exists?: boolean; keys: string[] } = {
        source: source.source,
        keys: Object.keys(source.values).sort(),
      };
      if (source.path !== undefined) item.path = source.path;
      if (source.exists !== undefined) item.exists = source.exists;
      return item;
    }),
    conflicts,
    resolved: loadConfig(cliOverrides),
  };
}

function configSources(cliOverrides: Record<string, unknown>): Array<{ source: string; path?: string; exists?: boolean; values: Record<string, unknown>; error?: string }> {
  ensureUserConfigFile();
  const user = readTomlFile(userConfigPath());
  const project = readTomlFile(projectConfigPath());
  const userSource: { source: string; path?: string; exists?: boolean; values: Record<string, unknown>; error?: string } = {
    source: "user",
    path: userConfigPath(),
    exists: user.exists,
    values: user.data,
  };
  if (user.error !== undefined) userSource.error = user.error;
  const projectSource: { source: string; path?: string; exists?: boolean; values: Record<string, unknown>; error?: string } = {
    source: "project",
    path: projectConfigPath(),
    exists: project.exists,
    values: project.data,
  };
  if (project.error !== undefined) projectSource.error = project.error;
  return [
    userSource,
    projectSource,
    { source: "env", values: loadEnv() },
    { source: "cli", values: normalizeCliOverrides(cliOverrides) },
  ];
}

function normalizeCliOverrides(cliOverrides: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cliOverrides)) {
    if (value === undefined || value === null) continue;
    if (key === "api_key" && value === "") continue;
    if (typeof value === "string" && value === "") continue;
    setNested(normalized, key, value);
  }
  return migrateConfigObject(normalized).config;
}

function mergeConfigLayer(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (!isSafeConfigKey(key)) continue;
    if (value === undefined || value === null) continue;
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeConfigLayer(target[key] as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    target[key] = value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const UNSAFE_CONFIG_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isSafeConfigKey(key: string): boolean {
  return !!key && !UNSAFE_CONFIG_KEYS.has(key);
}

function isSafeConfigPath(parts: string[]): boolean {
  return parts.length > 0 && parts.every(isSafeConfigKey);
}

function migrateConfigObject(input: Record<string, unknown>): { config: Record<string, unknown>; changed: boolean; actions: string[]; warnings: string[] } {
  const config = { ...input };
  const actions: string[] = [];
  const warnings: string[] = [];
  const rename = (from: string, to: string) => {
    if (!Object.prototype.hasOwnProperty.call(config, from)) return;
    if (!Object.prototype.hasOwnProperty.call(config, to)) {
      config[to] = config[from];
      actions.push(`renamed ${from} → ${to}`);
    } else {
      warnings.push(`both ${from} and ${to} exist; kept ${to}`);
    }
    delete config[from];
  };
  rename("apiKey", "api_key");
  rename("baseUrl", "base_url");
  rename("maxTokens", "max_tokens");
  rename("maxTurns", "max_turns");
  rename("contextLimit", "context_limit");
  rename("reasoningEffort", "reasoning_effort");
  rename("rollbackEnabled", "rollback_enabled");
  rename("costTracking", "cost_tracking");
  rename("thinkingVisible", "thinking_visible");
  rename("mcpServers", "mcp_servers");
  rename("skillsDir", "skills_dir");
  rename("skillsRegistryUrl", "skills_registry_url");
  rename("skillsMaxInstallSizeBytes", "skills_max_install_size_bytes");
  rename("flashModel", "flash_model");
  rename("approvalPolicy", "approval_policy");
  rename("sandboxMode", "sandbox_mode");
  rename("workspaceBoundary", "workspace_boundary");
  rename("trustedWorkspaces", "trusted_workspaces");
  rename("permission", "permissions");
  rename("webSearch", "web");
  rename("web_search", "web");

  if (config.web === false) {
    config.web = { enabled: false, mode: "off" };
    actions.push("converted web = false → web.enabled = false");
  } else if (config.web === true) {
    config.web = { enabled: true, mode: "live" };
    actions.push("converted web = true → web.enabled = true");
  } else if (typeof config.web === "string") {
    const mode = String(config.web).trim().toLowerCase();
    config.web = { enabled: mode !== "off", mode: mode === "off" ? "off" : "live" };
    actions.push("converted legacy web string → web.mode");
  }
  if (config.web && typeof config.web === "object" && !Array.isArray(config.web)) {
    const web = { ...(config.web as Record<string, unknown>) };
    const webRename = (from: string, to: string) => {
      if (!Object.prototype.hasOwnProperty.call(web, from)) return;
      if (!Object.prototype.hasOwnProperty.call(web, to)) web[to] = web[from];
      delete web[from];
      actions.push(`renamed web.${from} → web.${to}`);
    };
    webRename("searchEngine", "search_engine");
    webRename("allowedDomains", "allowed_domains");
    webRename("blockedDomains", "blocked_domains");
    webRename("googleApiKey", "google_api_key");
    webRename("googleCx", "google_cx");
    webRename("exaApiKey", "exa_api_key");
    webRename("kagiApiKey", "kagi_api_key");
    webRename("braveApiKey", "brave_api_key");
    webRename("tavilyApiKey", "tavily_api_key");
    webRename("serperApiKey", "serper_api_key");
    webRename("semanticScholarApiKey", "semantic_scholar_api_key");
    webRename("pubmedApiKey", "pubmed_api_key");
    webRename("searxngUrl", "searxng_url");
    webRename("noProxy", "no_proxy");
    webRename("searchTimeoutMs", "search_timeout_ms");
    webRename("fetchTimeoutMs", "fetch_timeout_ms");
    webRename("maxBytes", "max_bytes");
    if (web.mode === "cached") {
      warnings.push("web.mode = \"cached\" is not supported by local web tools; using live");
      web.mode = "live";
    }
    config.web = web;
  }

  if (config.model === "deepseek-chat" || config.model === "deepseek-reasoner" || config.model === "deepseek-r1") {
    warnings.push(`model ${String(config.model)} is deprecated; provider capability resolution will use deepseek-v4-flash`);
  }
  if (Array.isArray(config.mcp_servers)) {
    config.mcp_servers = config.mcp_servers
      .map(server => normalizeMigratedMCPServerRecord(server, actions))
      .filter((server): server is Record<string, unknown> => !!server);
  }
  if (config.skills && typeof config.skills === "object" && !Array.isArray(config.skills)) {
    const skills = config.skills as Record<string, unknown>;
    if (skills.registry_url && !config.skills_registry_url) {
      config.skills_registry_url = skills.registry_url;
      actions.push("flattened skills.registry_url → skills_registry_url");
    }
    if (skills.max_install_size_bytes && !config.skills_max_install_size_bytes) {
      config.skills_max_install_size_bytes = skills.max_install_size_bytes;
      actions.push("flattened skills.max_install_size_bytes → skills_max_install_size_bytes");
    }
    delete config.skills;
  }
  return { config, changed: actions.length > 0, actions, warnings };
}

function normalizeMCPEnvRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") env[key] = entry;
  }
  return env;
}

function normalizeMigratedMCPServerRecord(
  server: unknown,
  actions: string[],
): Record<string, unknown> | null {
  if (!server || typeof server !== "object" || Array.isArray(server)) return null;
  const record = { ...(server as Record<string, unknown>) };
  const name = typeof record.name === "string" && record.name.trim() ? record.name : null;
  if (!name) return null;

  const url = typeof record.url === "string" && record.url.trim() ? record.url : undefined;
  const transport = typeof record.transport === "string" && (record.transport === "stdio" || record.transport === "sse")
    ? record.transport
    : (url ? "sse" : "stdio");

  if (record.transport !== transport) {
    actions.push(`defaulted MCP server ${name} transport`);
  }

  return {
    ...record,
    name,
    transport,
    command: typeof record.command === "string" && record.command.trim() ? record.command : undefined,
    args: Array.isArray(record.args)
      ? record.args.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [],
    url,
    env: normalizeMCPEnvRecord(record.env),
    enabled: record.enabled !== false,
  };
}

function semanticConfigIssues(config: Record<string, unknown>, source: string, path?: string): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (Array.isArray(config.mcp_servers)) {
    config.mcp_servers.forEach((server, index) => {
      if (!server || typeof server !== "object") return;
      const record = server as Record<string, unknown>;
      const prefix = `mcp_servers.${index}`;
      if (record.transport === "stdio" && !record.command) {
        issues.push(configIssue("error", source, "stdio MCP server requires command", path, `${prefix}.command`));
      }
      if (record.transport === "sse" && !record.url) {
        issues.push(configIssue("error", source, "sse MCP server requires url", path, `${prefix}.url`));
      }
    });
  }
  if (typeof config.context_limit === "number" && config.context_limit < 4096) {
    issues.push(configIssue("warning", source, "context_limit is unusually small", path, "context_limit"));
  }
  if (typeof config.max_tokens === "number" && config.max_tokens < 1) {
    issues.push(configIssue("error", source, "max_tokens must be positive", path, "max_tokens"));
  }
  if (typeof config.skills_max_install_size_bytes === "number" && config.skills_max_install_size_bytes < 1024) {
    issues.push(configIssue("warning", source, "skills_max_install_size_bytes is unusually small", path, "skills_max_install_size_bytes"));
  }
  if (config.web && typeof config.web === "object" && !Array.isArray(config.web)) {
    const web = config.web as Record<string, unknown>;
    for (const key of ["search_timeout_ms", "fetch_timeout_ms"]) {
      if (typeof web[key] === "number" && web[key] < 1000) {
        issues.push(configIssue("warning", source, `${key} is unusually small`, path, `web.${key}`));
      }
    }
    if (typeof web.max_bytes === "number" && web.max_bytes < 1024) {
      issues.push(configIssue("warning", source, "web.max_bytes is unusually small", path, "web.max_bytes"));
    }
    if (typeof web.proxy === "string" && web.proxy && !/^https?:\/\//i.test(web.proxy)) {
      issues.push(configIssue("error", source, "web.proxy must be an http:// or https:// URL", path, "web.proxy"));
    }
    if (typeof web.searxng_url === "string" && web.searxng_url && !/^https?:\/\//i.test(web.searxng_url)) {
      issues.push(configIssue("error", source, "web.searxng_url must be an http:// or https:// URL", path, "web.searxng_url"));
    }
  }
  return issues;
}

function configIssue(
  level: ConfigValidationIssue["level"],
  source: string,
  message: string,
  path?: string,
  key?: string,
): ConfigValidationIssue {
  const issue: ConfigValidationIssue = { level, source, message };
  if (path !== undefined) issue.path = path;
  if (key !== undefined) issue.key = key;
  return issue;
}

function stableValue(value: unknown): string {
  return JSON.stringify(value, Object.keys(value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}).sort());
}

function flattenConfigEntries(
  value: Record<string, unknown>,
  prefix = "",
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      entries.push(...flattenConfigEntries(child, path));
      continue;
    }
    entries.push([path, child]);
  }
  return entries;
}
