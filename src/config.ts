/** Configuration management: TOML file + env vars + CLI overrides -> zod schema. */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS, defaultBaseUrlForProvider, providerCapability, resolveProviderAlias } from "./client/capabilities.js";
import { DEFAULT_SKILL_INSTALL_SIZE_BYTES, DEFAULT_SKILLS_REGISTRY_URL, defaultSkillsDir } from "./engine/skills.js";
import { LEGACY_DEEPSEEK_DIR, SEEKCODE_DIR, homeDir } from "./paths.js";
import { stableJsonStringify } from "./utils/json-safe.js";

const MAX_CONFIG_ENV_VALUE_CHARS = 16_384;
const MAX_CONFIG_STRING_CHARS = 8_192;
const MAX_CONFIG_PATH_CHARS = 4_096;
const MAX_CONFIG_MODEL_CHARS = 256;
const MAX_CONFIG_THEME_CHARS = 128;
const MAX_CONFIG_API_KEY_CHARS = 4_096;
const MAX_CONFIG_URL_CHARS = 8_192;
const MAX_CONFIG_LIST_ITEMS = 200;
const MAX_CONFIG_LIST_ITEM_CHARS = 512;
const MAX_CONFIG_STATUS_ITEMS = 16;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const MAX_CONFIG_PERMISSION_ENTRIES = 512;
const MAX_CONFIG_PERMISSION_KEY_CHARS = 256;
const MAX_CONFIG_MAX_TOKENS = 1_000_000;
const MAX_CONFIG_MAX_TURNS = 10_000;
const MAX_CONFIG_CONTEXT_LIMIT = 10_000_000;
const MAX_CONFIG_TOOL_CALL_BUDGET = 1_000;
const MAX_CONFIG_TOOL_FAILURE_THRESHOLD = 100;
const MAX_CONFIG_SKILL_INSTALL_BYTES = 512 * 1024 * 1024;
const MAX_CONFIG_WEB_TIMEOUT_MS = 60_000;
const MAX_CONFIG_WEB_BYTES = 10 * 1024 * 1024;
const MAX_MCP_SERVERS = 64;
const MAX_MCP_NAME_CHARS = 80;
const MAX_MCP_COMMAND_CHARS = 4_096;
const MAX_MCP_ARGS = 128;
const MAX_MCP_ARG_CHARS = 4_096;
const MAX_MCP_ENV_ENTRIES = 128;
const MAX_MCP_ENV_VALUE_CHARS = 8_192;
const MAX_CONFIG_EXPLAIN_ENTRIES = 2_000;
const MAX_CONFIG_EXPLAIN_DEPTH = 16;
const MAX_CONFIG_WRITE_DEPTH = 16;
const MAX_CONFIG_WRITE_ARRAY_ITEMS = 512;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F]/;

const NumericConfigMax: Record<string, number> = {
  max_tokens: MAX_CONFIG_MAX_TOKENS,
  max_turns: MAX_CONFIG_MAX_TURNS,
  context_limit: MAX_CONFIG_CONTEXT_LIMIT,
  tool_call_budget_per_turn: MAX_CONFIG_TOOL_CALL_BUDGET,
  tool_failure_degrade_threshold: MAX_CONFIG_TOOL_FAILURE_THRESHOLD,
  skills_max_install_size_bytes: MAX_CONFIG_SKILL_INSTALL_BYTES,
  "web.search_timeout_ms": MAX_CONFIG_WEB_TIMEOUT_MS,
  "web.fetch_timeout_ms": MAX_CONFIG_WEB_TIMEOUT_MS,
  "web.max_bytes": MAX_CONFIG_WEB_BYTES,
};

const ConfigStringSchema = (maxChars: number) =>
  z.string()
    .max(maxChars)
    .refine(value => !hasUnsupportedControl(value), "must not contain control characters");

const TrimmedConfigStringSchema = (maxChars: number) =>
  ConfigStringSchema(maxChars).transform(value => value.trim());

const MCPEnvKeySchema = z.string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name");

const MCPEnvRecordSchema = z.record(MCPEnvKeySchema, ConfigStringSchema(MAX_MCP_ENV_VALUE_CHARS))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > MAX_MCP_ENV_ENTRIES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must contain ${MAX_MCP_ENV_ENTRIES} entries or fewer`,
      });
    }
  });

const PermissionActionSchema = z.enum(["allow", "ask", "deny"]);

const PermissionRecordSchema = z.record(PermissionActionSchema)
  .superRefine((value, ctx) => {
    const entries = Object.entries(value);
    if (entries.length > MAX_CONFIG_PERMISSION_ENTRIES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must contain ${MAX_CONFIG_PERMISSION_ENTRIES} entries or fewer`,
      });
    }
    for (const [key] of entries) {
      if (!key || key.length > MAX_CONFIG_PERMISSION_KEY_CHARS || hasUnsupportedControl(key) || !isSafeConfigKey(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "permission key must be non-empty, bounded, and free of control characters",
        });
      }
    }
  });

const MCPConfigSchema = z.object({
  name: TrimmedConfigStringSchema(MAX_MCP_NAME_CHARS),
  transport: z.enum(["stdio", "sse"]).default("stdio"),
  command: TrimmedConfigStringSchema(MAX_MCP_COMMAND_CHARS).optional(),
  args: z.array(TrimmedConfigStringSchema(MAX_MCP_ARG_CHARS)).max(MAX_MCP_ARGS).default([]),
  url: TrimmedConfigStringSchema(MAX_CONFIG_URL_CHARS).optional(),
  env: MCPEnvRecordSchema.default({}),
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

const BoundedStringArraySchema = (maxItems = MAX_CONFIG_LIST_ITEMS, maxItemChars = MAX_CONFIG_LIST_ITEM_CHARS) =>
  z.array(TrimmedConfigStringSchema(maxItemChars)).max(maxItems)
    .transform(items => dedupeStrings(items.filter(Boolean)));

const WebConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(["live", "off"]).default("live"),
  search_engine: z.enum(["auto", "bing", "duckduckgo", "brave", "tavily", "serper", "searxng", "google", "arxiv", "baidu", "exa", "kagi", "semantic_scholar", "pubmed"]).default("auto"),
  allowed_domains: BoundedStringArraySchema().default([]),
  blocked_domains: BoundedStringArraySchema().default([]),
  google_api_key: TrimmedConfigStringSchema(MAX_CONFIG_API_KEY_CHARS).default(""),
  google_cx: TrimmedConfigStringSchema(MAX_CONFIG_API_KEY_CHARS).default(""),
  exa_api_key: TrimmedConfigStringSchema(MAX_CONFIG_API_KEY_CHARS).default(""),
  kagi_api_key: TrimmedConfigStringSchema(MAX_CONFIG_API_KEY_CHARS).default(""),
  brave_api_key: TrimmedConfigStringSchema(MAX_CONFIG_API_KEY_CHARS).default(""),
  tavily_api_key: TrimmedConfigStringSchema(MAX_CONFIG_API_KEY_CHARS).default(""),
  serper_api_key: TrimmedConfigStringSchema(MAX_CONFIG_API_KEY_CHARS).default(""),
  semantic_scholar_api_key: TrimmedConfigStringSchema(MAX_CONFIG_API_KEY_CHARS).default(""),
  pubmed_api_key: TrimmedConfigStringSchema(MAX_CONFIG_API_KEY_CHARS).default(""),
  searxng_url: TrimmedConfigStringSchema(MAX_CONFIG_URL_CHARS).default(""),
  proxy: TrimmedConfigStringSchema(MAX_CONFIG_URL_CHARS).default(""),
  no_proxy: BoundedStringArraySchema().default([]),
  search_timeout_ms: z.number().int().positive().max(MAX_CONFIG_WEB_TIMEOUT_MS).default(15_000),
  fetch_timeout_ms: z.number().int().positive().max(MAX_CONFIG_WEB_TIMEOUT_MS).default(15_000),
  max_bytes: z.number().int().positive().max(MAX_CONFIG_WEB_BYTES).default(1_000_000),
});

const ConfigSchema = z.object({
  api_key: TrimmedConfigStringSchema(MAX_CONFIG_API_KEY_CHARS).default(""),
  provider: z.enum(["deepseek", "deepseek-cn", "nvidia-nim", "openrouter", "novita", "fireworks", "sglang"]).default("deepseek"),
  base_url: TrimmedConfigStringSchema(MAX_CONFIG_URL_CHARS).default("https://api.deepseek.com"),
  model: TrimmedConfigStringSchema(MAX_CONFIG_MODEL_CHARS).default("deepseek-v4-pro"),
  flash_model: TrimmedConfigStringSchema(MAX_CONFIG_MODEL_CHARS).default("deepseek-v4-flash"),
  mode: z.enum(["plan", "agent", "yolo"]).default("agent"),
  max_tokens: z.number().int().positive().max(MAX_CONFIG_MAX_TOKENS).default(8192),
  max_turns: z.number().int().positive().max(MAX_CONFIG_MAX_TURNS).default(50),
  context_limit: z.number().int().positive().max(MAX_CONFIG_CONTEXT_LIMIT).default(DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS),
  reasoning_effort: z.enum(["off", "low", "medium", "high", "max", "xhigh"]).default("high"),
  rollback_enabled: z.boolean().default(true),
  cost_tracking: z.boolean().default(true),
  thinking_visible: z.boolean().default(true),
  tui_alternate_screen: z.enum(["auto", "always", "never"]).default("never"),
  mcp_servers: z.array(MCPConfigSchema).max(MAX_MCP_SERVERS).default([]),
  skills_dir: TrimmedConfigStringSchema(MAX_CONFIG_PATH_CHARS).default(() => defaultSkillsDir()),
  skills_registry_url: TrimmedConfigStringSchema(MAX_CONFIG_URL_CHARS).default(DEFAULT_SKILLS_REGISTRY_URL),
  skills_max_install_size_bytes: z.number().int().positive().max(MAX_CONFIG_SKILL_INSTALL_BYTES).default(DEFAULT_SKILL_INSTALL_SIZE_BYTES),
  theme: TrimmedConfigStringSchema(MAX_CONFIG_THEME_CHARS).default("deepseek-dark"),
  context_refresh_enabled: z.boolean().default(true),
  approval_policy: z.enum(["on-request", "on-failure", "never", "untrusted"]).default("on-request"),
  sandbox_mode: z.enum(["workspace-write", "read-only", "danger-full-access"]).default("workspace-write"),
  workspace_boundary: z.boolean().default(true),
  trusted_workspaces: BoundedStringArraySchema(MAX_CONFIG_LIST_ITEMS, MAX_CONFIG_PATH_CHARS).default([]),
  lsp_auto_diagnostics: z.boolean().default(true),
  lsp_diagnostics_severity: z.enum(["error", "warning", "information", "hint", "all"]).default("warning"),
  tool_call_budget_per_turn: z.number().int().positive().max(MAX_CONFIG_TOOL_CALL_BUDGET).default(80),
  tool_failure_degrade_threshold: z.number().int().positive().max(MAX_CONFIG_TOOL_FAILURE_THRESHOLD).default(3),
  status_items: z.array(StatusItemSchema).max(MAX_CONFIG_STATUS_ITEMS).transform(dedupeStrings).default(["mode", "model", "workspace"]),
  permissions: PermissionRecordSchema.default({}),
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

function readTomlFile(path: string): { data: Record<string, unknown>; exists: boolean; error?: string } {
  const loaded = readConfigFileText(path);
  if (loaded.error || !loaded.exists || loaded.raw === undefined) {
    const result: { data: Record<string, unknown>; exists: boolean; error?: string } = { data: {}, exists: loaded.exists };
    if (loaded.error !== undefined) result.error = loaded.error;
    return result;
  }
  try {
    return { data: parseToml(loaded.raw) as Record<string, unknown>, exists: true };
  } catch (e: any) {
    return { data: {}, exists: true, error: e.message };
  }
}

function loadTomlFile(path: string): Record<string, unknown> {
  const loaded = readTomlFile(path);
  return loaded.error ? {} : loaded.data;
}

function readConfigFileText(path: string): { raw?: string; exists: boolean; error?: string } {
  if (path.includes("\0")) return { exists: false, error: "Config path must not contain NUL bytes" };
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { exists: true, error: `Config path must not be a symlink: ${path}` };
    if (!stat.isFile()) return { exists: true, error: `Config path is not a file: ${path}` };
    if (stat.size > MAX_CONFIG_FILE_BYTES) {
      return { exists: true, error: `Config file exceeds ${MAX_CONFIG_FILE_BYTES} bytes: ${path}` };
    }
    return { raw: readFileSync(path, "utf-8"), exists: true };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { exists: false };
    return { exists: safeExists(path), error: e?.message || String(e) };
  }
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
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
  if (path.includes("\0")) throw new Error("Invalid config path.");
  const safeConfig = sanitizeTomlConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  assertSafeConfigWriteTarget(path);
  writeFileSync(path, stringifyToml(safeConfig as any), "utf-8");
}

export function ensureUserConfigFile(): void {
  const path = userConfigPath();
  if (path.includes("\0")) throw new Error("Invalid config path.");
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  assertSafeConfigWriteTarget(path);
  writeFileSync(path, DEFAULT_USER_CONFIG_TEMPLATE, "utf-8");
}

export function writeUserApiKey(apiKey: string): void {
  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey || trimmedApiKey.includes("\0")) throw new Error("API key must be a non-empty string.");
  ensureUserConfigFile();
  const path = userConfigPath();
  const loaded = readTomlFile(path);
  if (loaded.error) throw new Error(`Could not read config file ${path}: ${loaded.error}`);
  const config = { ...loaded.data, api_key: trimmedApiKey };
  mkdirSync(dirname(path), { recursive: true });
  assertSafeConfigWriteTarget(path);
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
    if (val !== undefined) {
      if (
        ["max_tokens", "max_turns", "context_limit", "tool_call_budget_per_turn", "tool_failure_degrade_threshold", "skills_max_install_size_bytes"].includes(key)
        || key.startsWith("web.") && /_ms$|max_bytes$/.test(key)
      ) {
        const parsed = parseEnvInteger(val, NumericConfigMax[key]);
        if (parsed !== null) setNested(result, key, parsed);
      } else if (key === "status_items" || key === "web.allowed_domains" || key === "web.blocked_domains" || key === "web.no_proxy") {
        setNested(result, key, parseDelimitedList(val, ","));
      } else {
        setNested(result, key, val);
      }
    }
  }
  assignEnvValue(result, "context_refresh_enabled", "SEEKCODE_CONTEXT_REFRESH_ENABLED", "DEEPSEEK_CONTEXT_REFRESH_ENABLED", parseEnvBool);
  assignEnvValue(result, "workspace_boundary", "SEEKCODE_WORKSPACE_BOUNDARY", "DEEPSEEK_WORKSPACE_BOUNDARY", parseEnvBool);
  assignEnvValue(result, "lsp_auto_diagnostics", "SEEKCODE_LSP_AUTO_DIAGNOSTICS", "DEEPSEEK_LSP_AUTO_DIAGNOSTICS", parseEnvBool);
  assignEnvValue(result, "rollback_enabled", "SEEKCODE_ROLLBACK_ENABLED", "DEEPSEEK_ROLLBACK_ENABLED", parseEnvBool);
  assignEnvValue(result, "cost_tracking", "SEEKCODE_COST_TRACKING", "DEEPSEEK_COST_TRACKING", parseEnvBool);
  assignEnvValue(result, "thinking_visible", "SEEKCODE_THINKING_VISIBLE", "DEEPSEEK_THINKING_VISIBLE", parseEnvBool);
  assignEnvValue(result, "web.enabled", "SEEKCODE_WEB_ENABLED", "DEEPSEEK_WEB_ENABLED", parseEnvBool);
  const googleApiKey = firstEnvValue("GOOGLE_API_KEY");
  if (!getNested(result, "web.google_api_key") && googleApiKey) {
    setNested(result, "web.google_api_key", googleApiKey);
  }
  const googleCx = firstEnvValue("GOOGLE_CSE_ID", "GOOGLE_CX");
  if (!getNested(result, "web.google_cx") && googleCx) {
    setNested(result, "web.google_cx", googleCx);
  }
  const exaApiKey = firstEnvValue("EXA_API_KEY");
  if (!getNested(result, "web.exa_api_key") && exaApiKey) {
    setNested(result, "web.exa_api_key", exaApiKey);
  }
  const kagiApiKey = firstEnvValue("KAGI_API_KEY");
  if (!getNested(result, "web.kagi_api_key") && kagiApiKey) {
    setNested(result, "web.kagi_api_key", kagiApiKey);
  }
  const braveApiKey = firstEnvValue("BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY");
  if (!getNested(result, "web.brave_api_key") && braveApiKey) {
    setNested(result, "web.brave_api_key", braveApiKey);
  }
  const tavilyApiKey = firstEnvValue("TAVILY_API_KEY");
  if (!getNested(result, "web.tavily_api_key") && tavilyApiKey) {
    setNested(result, "web.tavily_api_key", tavilyApiKey);
  }
  const serperApiKey = firstEnvValue("SERPER_API_KEY");
  if (!getNested(result, "web.serper_api_key") && serperApiKey) {
    setNested(result, "web.serper_api_key", serperApiKey);
  }
  const semanticScholarApiKey = firstEnvValue("SEMANTIC_SCHOLAR_API_KEY", "S2_API_KEY");
  if (!getNested(result, "web.semantic_scholar_api_key") && semanticScholarApiKey) {
    setNested(result, "web.semantic_scholar_api_key", semanticScholarApiKey);
  }
  const pubmedApiKey = firstEnvValue("PUBMED_API_KEY", "NCBI_API_KEY");
  if (!getNested(result, "web.pubmed_api_key") && pubmedApiKey) {
    setNested(result, "web.pubmed_api_key", pubmedApiKey);
  }
  const searxngUrl = firstEnvValue("SEARXNG_URL");
  if (!getNested(result, "web.searxng_url") && searxngUrl) {
    setNested(result, "web.searxng_url", searxngUrl);
  }
  const trustedWorkspaces = envValue("SEEKCODE_TRUSTED_WORKSPACES", "DEEPSEEK_TRUSTED_WORKSPACES");
  if (trustedWorkspaces) {
    result.trusted_workspaces = parseDelimitedList(trustedWorkspaces, delimiter, {
      maxItemChars: MAX_CONFIG_PATH_CHARS,
    });
  }
  return result;
}

function envValue(primary: string, fallback: string): string | undefined {
  return firstEnvValue(primary, fallback);
}

function firstEnvValue(...names: string[]): string | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    if (raw.includes("\0")) continue;
    const trimmed = raw.trim();
    if (trimmed.length > MAX_CONFIG_ENV_VALUE_CHARS || hasUnsupportedControl(trimmed)) continue;
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseDelimitedList(
  value: string,
  separator: string,
  options: { maxItems?: number; maxItemChars?: number } = {},
): string[] {
  const maxItems = options.maxItems ?? MAX_CONFIG_LIST_ITEMS;
  const maxItemChars = options.maxItemChars ?? MAX_CONFIG_LIST_ITEM_CHARS;
  const seen = new Set<string>();
  for (const item of value.split(separator)) {
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > maxItemChars || hasUnsupportedControl(trimmed)) continue;
    seen.add(trimmed);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
}

function assignEnvValue(
  target: Record<string, unknown>,
  key: string,
  primary: string,
  fallback: string,
  transform: (value: string) => unknown,
): void {
  const value = envValue(primary, fallback);
  if (value !== undefined) setNested(target, key, transform(value));
}

function parseEnvBool(value: string): boolean | string {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}

function parseEnvInteger(value: string, max = Number.MAX_SAFE_INTEGER): number | null {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
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
    let next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      next = {};
      current[part] = next;
    }
    current = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (leaf !== undefined) current[leaf] = value;
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
  const envOverrides = loadEnv();
  mergeConfigLayer(merged, envOverrides);

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
    || Object.prototype.hasOwnProperty.call(envOverrides, "base_url")
    || typeof merged.base_url === "string" && merged.base_url !== DEFAULT_DEEPSEEK_BASE_URL;
  const contextLimitExplicit = Object.prototype.hasOwnProperty.call(merged, "context_limit");
  const resolved = {
    ...parsed,
    base_url: baseUrlWasExplicit ? parsed.base_url : defaultBaseUrlForProvider(parsed.provider),
    model: capability.resolved_model,
    context_limit: contextLimitExplicit ? parsed.context_limit : capability.context_window,
    max_tokens: Math.min(parsed.max_tokens, capability.max_output),
  };
  assertSemanticallyValidResolvedConfig(resolved);
  return resolved;
}

export function validateConfig(cliOverrides: Record<string, unknown> = {}): ConfigValidationReport {
  const issues: ConfigValidationIssue[] = [];
  for (const issue of rawConfigShapeIssues(cliOverrides, "cli")) issues.push(issue);
  for (const source of configSources(cliOverrides)) {
    if (source.error) {
      issues.push(configIssue("error", source.source, source.error, source.path));
      continue;
    }
    for (const issue of rawConfigShapeIssues(source.values, source.source, source.path)) issues.push(issue);
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
    return { ok: !issues.some(issue => issue.level === "error"), issues, resolved: redactConfigSecrets(resolved) as Config };
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
  if (sourcePath.includes("\0") || outputPath.includes("\0")) {
    return { changed: false, path: outputPath, actions: [], warnings: ["Config path must not contain NUL bytes"] };
  }
  const loaded = readTomlFile(sourcePath);
  if (!loaded.exists && !loaded.error) return { changed: false, path: outputPath, actions: [], warnings: [`Config file does not exist: ${outputPath}`] };
  if (loaded.error) return { changed: false, path: outputPath, actions: [], warnings: [loaded.error] };
  const migrated = migrateConfigObject(loaded.data);
  const copiedFromLegacy = sourcePath !== outputPath;
  const actions = copiedFromLegacy ? [`copied legacy config ${sourcePath} → ${outputPath}`, ...migrated.actions] : migrated.actions;
  const changed = copiedFromLegacy || migrated.changed;
  if (changed && !options.dryRun) {
    mkdirSync(dirname(outputPath), { recursive: true });
    assertSafeConfigWriteTarget(outputPath);
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
  const conflicts = conflictsWithRedactedValues(cliOverrides, sources);
  return {
    precedence: sources.map(source => source.source),
    sources: sources.map(source => {
      const item: { source: string; path?: string; exists?: boolean; keys: string[] } = {
        source: source.source,
        keys: flattenConfigEntries(migrateConfigObject(source.values).config).map(([key]) => key).sort(),
      };
      if (source.path !== undefined) item.path = source.path;
      if (source.exists !== undefined) item.exists = source.exists;
      return item;
    }),
    conflicts,
    resolved: redactConfigSecrets(loadConfig(cliOverrides)) as Config,
  };
}

function conflictsWithRedactedValues(
  cliOverrides: Record<string, unknown>,
  sources = configSources(cliOverrides),
): ConfigConflict[] {
  const conflicts: ConfigConflict[] = [];
  const valuesByKey = new Map<string, Array<{ source: string; value: unknown; path?: string }>>();
  for (const source of sources) {
    if (source.error) continue;
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
    conflicts.push({
      key,
      winner: winner.source,
      winner_value: redactConfigValue(key, winner.value),
      candidates: candidates.map(candidate => {
        const item: { source: string; value: unknown; path?: string } = {
          source: candidate.source,
          value: redactConfigValue(key, candidate.value),
        };
        if (candidate.path !== undefined) item.path = candidate.path;
        return item;
      }),
    });
  }
  return conflicts;
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
  for (const [key, value] of safeObjectEntries(cliOverrides)) {
    if (value === undefined || value === null) continue;
    const normalizedValue = typeof value === "string" ? value.trim() : value;
    if (key === "api_key" && normalizedValue === "") continue;
    if (typeof normalizedValue === "string" && normalizedValue === "") continue;
    setNested(normalized, key, normalizedValue);
  }
  return migrateConfigObject(normalized).config;
}

function mergeConfigLayer(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of safeObjectEntries(source)) {
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

function hasUnsupportedControl(value: string): boolean {
  return CONTROL_TEXT_RE.test(value);
}

function dedupeStrings<T extends string>(items: T[]): T[] {
  const seen = new Set<T>();
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
  }
  return [...seen];
}

function sanitizeTomlConfig(value: unknown, depth = 0): unknown {
  if (depth > MAX_CONFIG_WRITE_DEPTH) return undefined;
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > MAX_CONFIG_STRING_CHARS || hasUnsupportedControl(trimmed)) return undefined;
    return trimmed;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_CONFIG_WRITE_ARRAY_ITEMS)
      .map(item => sanitizeTomlConfig(item, depth + 1))
      .filter(item => item !== undefined);
  }
  if (!isPlainObject(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of safeObjectEntries(value)) {
    if (!isSafeConfigKey(key) || hasUnsupportedControl(key) || key.length > MAX_CONFIG_LIST_ITEM_CHARS) continue;
    const sanitized = sanitizeTomlConfig(child, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function normalizeKnownString(record: Record<string, unknown>, key: string, maxChars: number): void {
  const value = record[key];
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars || hasUnsupportedControl(trimmed)) {
    delete record[key];
    return;
  }
  record[key] = trimmed;
}

function normalizeStringArray(record: Record<string, unknown>, key: string, maxItems: number, maxItemChars: number): void {
  const value = record[key];
  if (!Array.isArray(value)) return;
  record[key] = dedupeStrings(
    value
      .slice(0, maxItems)
      .map(item => typeof item === "string" && item.trim().length <= maxItemChars && !hasUnsupportedControl(item) ? item.trim() : "")
      .filter(Boolean),
  );
}

function isSafeConfigKey(key: string): boolean {
  return !!key && !UNSAFE_CONFIG_KEYS.has(key);
}

function isSafeConfigPath(parts: string[]): boolean {
  return parts.length > 0 && parts.every(isSafeConfigKey);
}

function migrateConfigObject(input: Record<string, unknown>): { config: Record<string, unknown>; changed: boolean; actions: string[]; warnings: string[] } {
  const config = Object.fromEntries(safeObjectEntries(input));
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

  normalizeKnownString(config, "api_key", MAX_CONFIG_API_KEY_CHARS);
  normalizeKnownString(config, "base_url", MAX_CONFIG_URL_CHARS);
  normalizeKnownString(config, "model", MAX_CONFIG_MODEL_CHARS);
  normalizeKnownString(config, "flash_model", MAX_CONFIG_MODEL_CHARS);
  normalizeKnownString(config, "skills_dir", MAX_CONFIG_PATH_CHARS);
  normalizeKnownString(config, "skills_registry_url", MAX_CONFIG_URL_CHARS);
  normalizeKnownString(config, "theme", MAX_CONFIG_THEME_CHARS);
  normalizeStringArray(config, "trusted_workspaces", MAX_CONFIG_LIST_ITEMS, MAX_CONFIG_PATH_CHARS);
  normalizeStringArray(config, "status_items", MAX_CONFIG_STATUS_ITEMS, MAX_CONFIG_LIST_ITEM_CHARS);

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
    const web = Object.fromEntries(safeObjectEntries(config.web as Record<string, unknown>));
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
    for (const key of [
      "google_api_key",
      "google_cx",
      "exa_api_key",
      "kagi_api_key",
      "brave_api_key",
      "tavily_api_key",
      "serper_api_key",
      "semantic_scholar_api_key",
      "pubmed_api_key",
    ]) {
      normalizeKnownString(web, key, MAX_CONFIG_API_KEY_CHARS);
    }
    normalizeKnownString(web, "searxng_url", MAX_CONFIG_URL_CHARS);
    normalizeKnownString(web, "proxy", MAX_CONFIG_URL_CHARS);
    normalizeStringArray(web, "allowed_domains", MAX_CONFIG_LIST_ITEMS, MAX_CONFIG_LIST_ITEM_CHARS);
    normalizeStringArray(web, "blocked_domains", MAX_CONFIG_LIST_ITEMS, MAX_CONFIG_LIST_ITEM_CHARS);
    normalizeStringArray(web, "no_proxy", MAX_CONFIG_LIST_ITEMS, MAX_CONFIG_LIST_ITEM_CHARS);
    config.web = web;
  }

  if (config.model === "deepseek-chat" || config.model === "deepseek-reasoner" || config.model === "deepseek-r1") {
    warnings.push(`model ${String(config.model)} is deprecated; provider capability resolution will use deepseek-v4-flash`);
  }
  if (Array.isArray(config.mcp_servers)) {
    const servers = config.mcp_servers
      .map(server => normalizeMigratedMCPServerRecord(server, actions))
      .filter((server): server is Record<string, unknown> => !!server);
    config.mcp_servers = servers.slice(0, MAX_MCP_SERVERS);
  }
  if (config.permissions && typeof config.permissions === "object" && !Array.isArray(config.permissions)) {
    const permissions: Record<string, unknown> = {};
    for (const [pattern, action] of safeObjectEntries(config.permissions as Record<string, unknown>).slice(0, MAX_CONFIG_PERMISSION_ENTRIES)) {
      const key = pattern.trim();
      if (!key || key.length > MAX_CONFIG_PERMISSION_KEY_CHARS || hasUnsupportedControl(key) || !isSafeConfigKey(key)) continue;
      if (action === "allow" || action === "ask" || action === "deny") permissions[key] = action;
    }
    config.permissions = permissions;
  }
  if (config.skills && typeof config.skills === "object" && !Array.isArray(config.skills)) {
    const skills = Object.fromEntries(safeObjectEntries(config.skills as Record<string, unknown>));
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
  for (const [key, entry] of safeObjectEntries(value as Record<string, unknown>)) {
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      && key.length <= 128
      && typeof entry === "string"
      && entry.length <= MAX_MCP_ENV_VALUE_CHARS
      && !hasUnsupportedControl(entry)
    ) {
      env[key] = entry;
      if (safeObjectKeys(env).length >= MAX_MCP_ENV_ENTRIES) break;
    }
  }
  return env;
}

function normalizeMigratedMCPServerRecord(
  server: unknown,
  actions: string[],
): Record<string, unknown> | null {
  if (!server || typeof server !== "object" || Array.isArray(server)) return null;
  const record = Object.fromEntries(safeObjectEntries(server as Record<string, unknown>));
  const name = typeof record.name === "string" && record.name.trim() && record.name.trim().length <= MAX_MCP_NAME_CHARS && !hasUnsupportedControl(record.name) ? record.name.trim() : null;
  if (!name) return null;

  const url = typeof record.url === "string" && record.url.trim() && record.url.trim().length <= MAX_CONFIG_URL_CHARS && !hasUnsupportedControl(record.url) ? record.url.trim() : undefined;
  const rawTransport = typeof record.transport === "string" ? record.transport.trim().toLowerCase() : "";
  const transport = rawTransport === "stdio" || rawTransport === "sse"
    ? rawTransport
    : (url ? "sse" : "stdio");

  if (record.transport !== transport) {
    actions.push(`defaulted MCP server ${name} transport`);
  }
  const command = typeof record.command === "string" && record.command.trim() && record.command.trim().length <= MAX_MCP_COMMAND_CHARS && !hasUnsupportedControl(record.command) ? record.command.trim() : undefined;

  return {
    ...record,
    name,
    transport,
    command,
    args: Array.isArray(record.args)
      ? boundedMigratedMCPArgs(record.args)
      : [],
    url,
    env: normalizeMCPEnvRecord(record.env),
    enabled: record.enabled !== false,
  };
}

function boundedMigratedMCPArgs(args: unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of args) {
    if (typeof value !== "string" || value.trim().length > MAX_MCP_ARG_CHARS || hasUnsupportedControl(value)) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    normalized.push(trimmed);
    seen.add(trimmed);
    if (normalized.length >= MAX_MCP_ARGS) break;
  }
  return normalized;
}

function semanticConfigIssues(config: Record<string, unknown>, source: string, path?: string): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (typeof config.base_url === "string" && config.base_url && !isHttpUrlWithoutCredentials(config.base_url)) {
    issues.push(configIssue("error", source, "base_url must be an http:// or https:// URL without credentials", path, "base_url"));
  }
  if (Array.isArray(config.mcp_servers)) {
    if (config.mcp_servers.length > MAX_MCP_SERVERS) {
      issues.push(configIssue("error", source, `mcp_servers must contain ${MAX_MCP_SERVERS} entries or fewer`, path, "mcp_servers"));
    }
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
      if (record.transport === "sse" && typeof record.url === "string" && !isHttpUrlWithoutCredentials(record.url)) {
        issues.push(configIssue("error", source, "sse MCP server url must be an http:// or https:// URL without credentials", path, `${prefix}.url`));
      }
    });
  }
  if (Array.isArray(config.trusted_workspaces) && config.trusted_workspaces.length > MAX_CONFIG_LIST_ITEMS) {
    issues.push(configIssue("error", source, `trusted_workspaces must contain ${MAX_CONFIG_LIST_ITEMS} entries or fewer`, path, "trusted_workspaces"));
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
    if (typeof web.proxy === "string" && web.proxy && !isHttpUrlWithoutCredentials(web.proxy)) {
      issues.push(configIssue("error", source, "web.proxy must be an http:// or https:// URL without credentials", path, "web.proxy"));
    }
    if (typeof web.searxng_url === "string" && web.searxng_url && !isHttpUrlWithoutCredentials(web.searxng_url)) {
      issues.push(configIssue("error", source, "web.searxng_url must be an http:// or https:// URL without credentials", path, "web.searxng_url"));
    }
  }
  if (typeof config.skills_registry_url === "string" && config.skills_registry_url && !isHttpUrlWithoutCredentials(config.skills_registry_url)) {
    issues.push(configIssue("error", source, "skills_registry_url must be an http:// or https:// URL without credentials", path, "skills_registry_url"));
  }
  return issues;
}

function assertSemanticallyValidResolvedConfig(config: Config): void {
  const errors = semanticConfigIssues(config as unknown as Record<string, unknown>, "resolved")
    .filter(issue => issue.level === "error" && isFatalResolvedConfigIssue(issue));
  if (errors.length) {
    const first = errors[0]!;
    throw new Error(first.key ? `${first.key}: ${first.message}` : first.message);
  }
}

function isFatalResolvedConfigIssue(issue: ConfigValidationIssue): boolean {
  if (issue.key?.endsWith(".command") && issue.message.includes("requires command")) return false;
  if (issue.key?.endsWith(".url") && issue.message.includes("requires url")) return false;
  return true;
}

function rawConfigShapeIssues(config: Record<string, unknown>, source: string, path?: string): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const rawServers = Array.isArray(config.mcp_servers)
    ? config.mcp_servers
    : Array.isArray(config.mcpServers)
    ? config.mcpServers
    : [];
  if (rawServers.length > MAX_MCP_SERVERS) {
    issues.push(configIssue("error", source, `mcp_servers must contain ${MAX_MCP_SERVERS} entries or fewer`, path, "mcp_servers"));
  }
  rawServers.forEach((server, index) => {
    if (!server || typeof server !== "object" || Array.isArray(server)) return;
    const record = server as Record<string, unknown>;
    const prefix = `mcp_servers.${index}`;
    if (Array.isArray(record.args) && record.args.length > MAX_MCP_ARGS) {
      issues.push(configIssue("error", source, `args must contain ${MAX_MCP_ARGS} entries or fewer`, path, `${prefix}.args`));
    }
    if (record.env && typeof record.env === "object" && !Array.isArray(record.env) && safeObjectKeys(record.env as Record<string, unknown>).length > MAX_MCP_ENV_ENTRIES) {
      issues.push(configIssue("error", source, `env must contain ${MAX_MCP_ENV_ENTRIES} entries or fewer`, path, `${prefix}.env`));
    }
  });
  return issues;
}

function isHttpUrlWithoutCredentials(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
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
  try {
    return stableJsonStringify(value);
  } catch {
    return "[unserializable]";
  }
}

function isSensitiveConfigKey(key: string): boolean {
  return /(^|\.)([^.]*api[_-]?key|apiKey|token|password|secret|authorization|auth_header)$/i.test(key);
}

function redactConfigValue(key: string, value: unknown): unknown {
  if (!isSensitiveConfigKey(key)) return value;
  if (value === undefined || value === null || value === "") return value;
  return "[redacted]";
}

function redactConfigSecrets<T>(value: T, prefix = ""): unknown {
  if (Array.isArray(value)) return value.map((item, index) => redactConfigSecrets(item, `${prefix}.${index}`));
  if (!value || typeof value !== "object") return redactConfigValue(prefix.replace(/^\./, ""), value);
  const result: Record<string, unknown> = {};
  for (const [key, child] of safeObjectEntries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    result[key] = isSensitiveConfigKey(path) ? redactConfigValue(path, child) : redactConfigSecrets(child, path);
  }
  return result;
}

function flattenConfigEntries(
  value: Record<string, unknown>,
  prefix = "",
  depth = 0,
): Array<[string, unknown]> {
  if (depth > MAX_CONFIG_EXPLAIN_DEPTH) return [];
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of safeObjectEntries(value)) {
    if (entries.length >= MAX_CONFIG_EXPLAIN_ENTRIES) break;
    if (!isSafeConfigKey(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      entries.push(...flattenConfigEntries(child, path, depth + 1));
      continue;
    }
    entries.push([path, child]);
  }
  return entries.slice(0, MAX_CONFIG_EXPLAIN_ENTRIES);
}

function assertSafeConfigWriteTarget(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Config path must not be a symlink: ${path}`);
    if (!stat.isFile()) throw new Error(`Config path is not a file: ${path}`);
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    throw e;
  }
}

function safeObjectEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if ("value" in descriptor) {
        entries.push([key, descriptor.value]);
        continue;
      }
      if (typeof descriptor.get !== "function") continue;
      try {
        entries.push([key, descriptor.get.call(value)]);
      } catch {
        // Ignore hostile or broken accessors while preserving other config fields.
      }
    }
    return entries;
  } catch {
    try {
      return Object.entries(value);
    } catch {
      return [];
    }
  }
}

function safeObjectKeys(value: Record<string, unknown>): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}
