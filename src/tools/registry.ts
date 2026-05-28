/** Global tool registry singleton. */

import {
  PermissionLevel,
  isToolConcurrencySafe,
  isToolDestructive,
  isToolReadOnly,
  isToolStaticallyConcurrencySafe,
  isToolStaticallyDestructive,
  isToolStaticallyReadOnly,
  getToolRenderMetadata,
  type ToolCapability,
  type ToolDef,
  type ToolInterruptBehavior,
  type ToolRenderMetadata,
  type ToolResultKind,
} from "./base.js";
import { toolToOpenAISchema } from "./base.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REGISTERED_TOOLS = 1_000;
const MAX_TOOL_TEXT_CHARS = 2_000;
const MAX_TOOL_ALIASES = 32;
const MAX_SEARCH_TEXT_CHARS = 20_000;
const MAX_SCHEMA_CACHE_CHARS = 2_000_000;
const MAX_TOOL_FAILURE_THRESHOLD = 100_000;
const MAX_TOOL_STAT_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_REGISTRY_SAFE_ARRAY_ITEMS = 10_000;
const MAX_REGISTRY_SAFE_OBJECT_KEYS = 2_000;
const MAX_REGISTRY_SAFE_DEPTH = 32;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const TOOL_RESULT_KIND_VALUES = new Set<ToolResultKind>(["text", "json", "diff", "artifact", "diagnostic", "task"]);

const ALWAYS_ACTIVE_TOOLS = new Set([
  "read",
  "ls",
  "search",
  "glob",
  "diagnostics",
  "tool_search",
  "tool_stats",
  "tool_enable",
  "custom_tools",
  "web_stats",
  "rlm_query",
  "think",
  "get_goal",
  "plan_status",
  "checklist_write",
  "update_plan",
  "note",
  "task_create",
  "task_list",
  "task_read",
  "task_cancel",
  "task_complete",
  "task_fail",
  "task_shell_start",
  "task_shell_wait",
  "exec_shell_wait",
  "exec_shell_cancel",
  "artifact_create",
  "artifact_list",
  "artifact_read",
  "mcp_manager",
  "lsp_diagnostics",
]);

export class ToolRegistry {
  private static instance: ToolRegistry;
  private tools: Map<string, ToolDef> = new Map();
  private aliases: Map<string, string> = new Map();
  private schemaCache: Record<string, unknown>[] | null = null;
  private activeToolNames: Set<string> = new Set();
  private stats: Map<string, ToolStats> = new Map();
  private disabledReasons: Map<string, string> = new Map();

  static get(): ToolRegistry {
    if (!ToolRegistry.instance) ToolRegistry.instance = new ToolRegistry();
    return ToolRegistry.instance;
  }

  register(tool: ToolDef): void {
    if (!tool || typeof tool !== "object") return;
    let normalized: ToolDef;
    try {
      normalized = normalizeToolDef(tool);
    } catch {
      return;
    }
    if (!isValidToolName(normalized.name)) return;
    if (!this.tools.has(normalized.name) && this.tools.size >= MAX_REGISTERED_TOOLS) return;
    this.aliases.delete(normalized.name);
    this.deleteAliasesFor(normalized.name);
    this.tools.set(normalized.name, normalized);
    this.activeToolNames.delete(normalized.name);
    this.disabledReasons.delete(normalized.name);
    const existingStats = this.stats.get(normalized.name);
    if (existingStats) existingStats.consecutive_failures = 0;
    for (const alias of normalized.aliases || []) {
      if (!alias || alias === normalized.name) continue;
      if (this.tools.has(alias) && alias !== normalized.name) continue;
      const existing = this.aliases.get(alias);
      if (existing && existing !== normalized.name) continue;
      this.aliases.set(alias, normalized.name);
    }
    if (normalized.alwaysLoad || (!normalized.deferLoading && !normalized.shouldDefer) || ALWAYS_ACTIVE_TOOLS.has(normalized.name)) {
      this.activeToolNames.add(normalized.name);
    }
    this.schemaCache = null;
  }

  unregister(name: string): void {
    const lookup = normalizeLookupName(name);
    if (!lookup) return;
    const primary = this.aliases.get(lookup) || lookup;
    const tool = this.tools.get(primary);
    this.tools.delete(primary);
    this.activeToolNames.delete(primary);
    this.stats.delete(primary);
    this.disabledReasons.delete(primary);
    this.deleteAliasesFor(primary);
    for (const alias of safeArrayItems(safeProperty(tool, "aliases"), MAX_TOOL_ALIASES)) {
      if (typeof alias === "string") this.aliases.delete(alias);
    }
    this.schemaCache = null;
  }

  lookup(name: string): ToolDef | undefined {
    const lookup = normalizeLookupName(name);
    if (!lookup) return undefined;
    const tool = this.tools.get(this.aliases.get(lookup) || lookup);
    return tool ? cloneToolDef(tool) : undefined;
  }

  listAll(): ToolDef[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name)).map(cloneToolDef);
  }

  listActive(): ToolDef[] {
    return this.listAll().filter(tool => this.activeToolNames.has(tool.name));
  }

  activate(name: string): boolean {
    const lookup = normalizeLookupName(name);
    if (!lookup) return false;
    const primary = this.aliases.get(lookup) || lookup;
    if (!this.tools.has(primary)) return false;
    if (this.disabledReasons.has(primary)) return false;
    const before = this.activeToolNames.size;
    this.activeToolNames.add(primary);
    if (this.activeToolNames.size !== before) this.schemaCache = null;
    return true;
  }

  deactivate(name: string): boolean {
    const lookup = normalizeLookupName(name);
    if (!lookup) return false;
    const primary = this.aliases.get(lookup) || lookup;
    if (!this.activeToolNames.delete(primary)) return false;
    this.schemaCache = null;
    return true;
  }

  activateForContext(text: string): string[] {
    const normalized = normalizeText(text, MAX_SEARCH_TEXT_CHARS).toLowerCase();
    if (!normalized) return [];
    const activated: string[] = [];
    for (const tool of this.listAll()) {
      if (activated.length >= 8) break;
      if (this.activeToolNames.has(tool.name) || this.disabledReasons.has(tool.name)) continue;
      const haystack = toolSearchText(tool);
      if (!haystack.split(/[_\s-]+/).some(term => term.length >= 4 && normalized.includes(term))) continue;
      if (this.activate(tool.name)) activated.push(tool.name);
    }
    return activated;
  }

  recordCall(name: string, ok: boolean, durationMs: number): ToolStats {
    const lookup = normalizeLookupName(name);
    const primary = lookup ? this.aliases.get(lookup) || lookup : "unknown";
    const safeDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    const current = this.stats.get(primary) || {
      name: primary,
      calls: 0,
      failures: 0,
      consecutive_failures: 0,
      total_ms: 0,
      last_called_at: "",
    };
    current.calls = incrementStatCounter(current.calls);
    current.total_ms = addStatCounter(current.total_ms, safeDurationMs);
    current.last_called_at = new Date().toISOString();
    if (ok === true) {
      current.consecutive_failures = 0;
    } else {
      current.failures = incrementStatCounter(current.failures);
      current.consecutive_failures = incrementStatCounter(current.consecutive_failures);
    }
    this.stats.set(primary, current);
    return cloneToolStats(current);
  }

  degradeIfUnhealthy(name: string, threshold: number): string | null {
    const lookup = normalizeLookupName(name);
    if (!lookup) return null;
    const primary = this.aliases.get(lookup) || lookup;
    const stats = this.stats.get(primary);
    const boundedThreshold = normalizeFailureThreshold(threshold);
    if (!stats || stats.consecutive_failures < boundedThreshold) return null;
    const reason = `disabled after ${stats.consecutive_failures} consecutive failures`;
    this.disabledReasons.set(primary, reason);
    this.deactivate(primary);
    return reason;
  }

  enableDegraded(name: string): boolean {
    const lookup = normalizeLookupName(name);
    if (!lookup) return false;
    const primary = this.aliases.get(lookup) || lookup;
    if (!this.tools.has(primary)) return false;
    this.disabledReasons.delete(primary);
    return this.activate(primary);
  }

  toolStats(): ToolStatsView[] {
    return this.listAll().map(tool => {
      const stats: ToolStatsView = {
        ...(this.stats.get(tool.name) || {
        name: tool.name,
        calls: 0,
        failures: 0,
        consecutive_failures: 0,
        total_ms: 0,
        last_called_at: "",
      }),
      active: this.activeToolNames.has(tool.name),
      disabled_reason: normalizeOptionalText(this.disabledReasons.get(tool.name), MAX_TOOL_TEXT_CHARS),
      read_only: isToolStaticallyReadOnly(tool),
      destructive: isToolStaticallyDestructive(tool),
      concurrency_safe: isToolStaticallyConcurrencySafe(tool),
      search_hint: normalizeOptionalText(tool.searchHint, MAX_TOOL_TEXT_CHARS),
      max_result_size_chars: tool.maxResultSizeChars,
      };
      return stats;
    });
  }

  search(query: string, limit = 12): Array<{ tool: ToolDef; score: number }> {
    const terms = normalizeText(query, MAX_SEARCH_TEXT_CHARS).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 32);
    if (!terms.length) return [];
    const boundedLimit = normalizeSearchLimit(limit);
    return this.listAll()
      .map(tool => {
        const haystack = toolSearchText(tool);
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { tool, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, boundedLimit);
  }

  toOpenAISchemas(options: { activeOnly?: boolean } = {}): Record<string, unknown>[] {
    const activeOnly = safeProperty(options, "activeOnly") === true;
    if (!activeOnly && this.schemaCache) return cloneSchemas(this.schemaCache);
    const tools = activeOnly ? this.listActive() : this.listAll();
    const schemas = boundedSchemas(tools);
    if (!activeOnly) this.schemaCache = schemas;
    return cloneSchemas(schemas);
  }

  clear(): void {
    this.tools.clear();
    this.aliases.clear();
    this.activeToolNames.clear();
    this.stats.clear();
    this.disabledReasons.clear();
    this.schemaCache = null;
  }

  get size(): number {
    return this.tools.size;
  }

  get activeSize(): number {
    return this.activeToolNames.size;
  }

  private deleteAliasesFor(primary: string): void {
    for (const [alias, target] of this.aliases.entries()) {
      if (target === primary) this.aliases.delete(alias);
    }
  }
}

export interface ToolStats {
  name: string;
  calls: number;
  failures: number;
  consecutive_failures: number;
  total_ms: number;
  last_called_at: string;
}

export interface ToolStatsView extends ToolStats {
  active: boolean;
  disabled_reason: string | undefined;
  read_only: boolean;
  destructive: boolean;
  concurrency_safe: boolean;
  search_hint: string | undefined;
  max_result_size_chars: number | undefined;
}

export function getRegistry(): ToolRegistry {
  return ToolRegistry.get();
}

const KNOWN_READ_ONLY_TOOLS = new Set([
  "read", "ls", "search", "glob",
  "git_status", "git_diff", "git_log", "git_branch",
  "web_search", "web_fetch", "fetch_url",
  "web_stats",
  "diagnostics", "lsp_diagnostics", "lsp_symbols", "lsp_definition", "lsp_hover", "tool_search", "tool_stats",
  "custom_tools",
  "think", "get_goal", "plan_status",
  "task_list", "task_read", "task_shell_wait", "exec_shell_wait",
  "artifact_list", "artifact_read", "artifact_links",
  "agent_profiles",
]);

const KNOWN_DESTRUCTIVE_TOOLS = new Set([
  "write", "edit", "apply_patch", "exec_shell_cancel", "task_cancel",
]);

function normalizeToolDef(tool: ToolDef): ToolDef {
  const name = normalizeToolName(safeProperty(tool, "name")) || "";
  const execute = safeProperty(tool, "execute");
  if (typeof execute !== "function") throw new Error("missing tool executor");
  const parallelOk = safeProperty(tool, "parallelOk") === true;
  const searchHint = normalizeOptionalText(safeProperty(tool, "searchHint"), MAX_TOOL_TEXT_CHARS);
  const readOnly = normalizeToolCapability(safeProperty(tool, "readOnly"));
  const destructive = normalizeToolCapability(safeProperty(tool, "destructive"));
  const concurrencySafe = normalizeToolCapability(safeProperty(tool, "concurrencySafe"));
  const normalized: ToolDef = {
    name,
    description: normalizeOptionalText(safeProperty(tool, "description"), MAX_TOOL_TEXT_CHARS) || "Tool",
    parameters: normalizeToolParameters(safeProperty(tool, "parameters")),
    execute: execute as ToolDef["execute"],
    permission: normalizePermissionLevel(safeProperty(tool, "permission")),
    category: normalizeOptionalText(safeProperty(tool, "category"), 100) || "tool",
    parallelOk,
    readOnly: readOnly ?? KNOWN_READ_ONLY_TOOLS.has(name),
    destructive: destructive ?? KNOWN_DESTRUCTIVE_TOOLS.has(name),
    concurrencySafe: concurrencySafe ?? parallelOk,
  };
  assignFunctionProperty(normalized, tool, "checkPermissions");
  assignFunctionProperty(normalized, tool, "validateInput");
  assignFunctionProperty(normalized, tool, "renderProgress");
  assignFunctionProperty(normalized, tool, "renderResult");
  assignFunctionProperty(normalized, tool, "renderGroup");
  assignFunctionProperty(normalized, tool, "isSearchOrReadCommand");
  assignFunctionProperty(normalized, tool, "getPermissionPatterns");
  assignFunctionProperty(normalized, tool, "preparePermissionMatcher");
  assignFunctionProperty(normalized, tool, "toAutoClassifierInput");
  assignFunctionProperty(normalized, tool, "getTranscriptSearchText");
  assignFunctionProperty(normalized, tool, "getToolUseSummary");
  assignFunctionProperty(normalized, tool, "getActivityDescription");

  const aliases = normalizeToolAliases(safeProperty(tool, "aliases"));
  if (aliases) normalized.aliases = aliases;
  if (searchHint) normalized.searchHint = searchHint;
  const maxResultSizeChars = normalizePositiveInteger(safeProperty(tool, "maxResultSizeChars"));
  if (maxResultSizeChars !== undefined) normalized.maxResultSizeChars = maxResultSizeChars;
  const resultKind = normalizeToolResultKind(safeProperty(tool, "resultKind"));
  if (resultKind) normalized.resultKind = resultKind;
  const renderMetadata = normalizeRegistryRenderMetadata(safeProperty(tool, "renderMetadata"));
  if (renderMetadata) normalized.renderMetadata = renderMetadata;
  const interruptBehavior = normalizeInterruptBehavior(safeProperty(tool, "interruptBehavior"));
  if (interruptBehavior) normalized.interruptBehavior = interruptBehavior;
  const deferLoading = normalizeBoolean(safeProperty(tool, "deferLoading"))
    ?? normalizeBoolean(safeProperty(tool, "shouldDefer"));
  if (deferLoading !== undefined) normalized.deferLoading = deferLoading;
  const alwaysLoad = normalizeBoolean(safeProperty(tool, "alwaysLoad"));
  if (alwaysLoad !== undefined) normalized.alwaysLoad = alwaysLoad;
  return normalized;
}

function normalizeToolAliases(values: unknown): string[] | undefined {
  const aliases: string[] = [];
  for (const value of safeArrayItems(values, MAX_TOOL_ALIASES)) {
    if (aliases.length >= MAX_TOOL_ALIASES) break;
    if (typeof value !== "string") continue;
    const alias = normalizeToolName(value);
    if (alias && !aliases.includes(alias)) aliases.push(alias);
  }
  return aliases.length ? aliases : undefined;
}

function normalizeToolParameters(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object", properties: {} };
  }
  const safe = safeJsonValue(value, { dropUndefinedObjectFields: true });
  return safe && typeof safe === "object" && !Array.isArray(safe)
    ? safe as Record<string, unknown>
    : { type: "object", properties: {} };
}

function normalizeSearchLimit(limit: unknown): number {
  const parsed = safeNumber(limit);
  if (!Number.isFinite(parsed)) return 12;
  return Math.max(1, Math.min(Math.floor(parsed), 50));
}

function toolSearchText(tool: ToolDef): string {
  const render = getToolRenderMetadata(tool);
  const parts = [
    safeProperty(tool, "name"),
    ...safeArrayItems(safeProperty(tool, "aliases"), MAX_TOOL_ALIASES),
    safeProperty(tool, "searchHint"),
    safeProperty(tool, "description"),
    safeProperty(tool, "category"),
    safeProperty(tool, "resultKind"),
    safeProperty(render, "userFacingName"),
    safeProperty(render, "icon"),
    safeProperty(render, "accent"),
    isToolStaticallyReadOnly(tool) ? "read-only readonly safe" : "",
    isToolStaticallyDestructive(tool) ? "destructive mutating mutation" : "",
    safeJsonStringify(safeProperty(tool, "parameters")),
  ].map(part => normalizeText(part, MAX_TOOL_TEXT_CHARS)).join(" ");
  return safeSliceTextBoundary(parts, MAX_SEARCH_TEXT_CHARS).toLowerCase();
}

function isValidToolName(name: string): boolean {
  return TOOL_NAME_RE.test(name);
}

function normalizeToolName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (CONTROL_TEXT_RE.test(normalized)) return null;
  return TOOL_NAME_RE.test(normalized) ? normalized : null;
}

function normalizeLookupName(value: unknown): string | null {
  return normalizeToolName(value);
}

function normalizeText(value: unknown, maxChars: number): string {
  return safeSliceTextBoundary(stringFromUnknown(value).replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim(), maxChars);
}

function normalizeOptionalText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeText(value, maxChars);
  return normalized || undefined;
}

function cloneToolDef(tool: ToolDef): ToolDef {
  return normalizeToolDef(tool);
}

function cloneToolStats(stats: ToolStats): ToolStats {
  return { ...stats };
}

function cloneSchemas(schemas: Record<string, unknown>[]): Record<string, unknown>[] {
  return safeArrayItems(schemas, MAX_REGISTERED_TOOLS)
    .map(schema => safeJsonValue(schema, { dropUndefinedObjectFields: true }))
    .filter((schema): schema is Record<string, unknown> => !!schema && typeof schema === "object" && !Array.isArray(schema));
}

function boundedSchemas(tools: ToolDef[]): Record<string, unknown>[] {
  const schemas: Record<string, unknown>[] = [];
  let totalChars = 0;
  for (const tool of tools) {
    const schema = toolToOpenAISchema(tool);
    totalChars += safeJsonStringify(schema).length;
    if (totalChars > MAX_SCHEMA_CACHE_CHARS) break;
    schemas.push(schema);
  }
  return schemas;
}

function incrementStatCounter(value: number): number {
  return addStatCounter(value, 1);
}

function addStatCounter(value: number, delta: number): number {
  const current = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const safeDelta = Number.isFinite(delta) && delta > 0 ? Math.floor(delta) : 0;
  return Math.min(MAX_TOOL_STAT_COUNTER, current + safeDelta);
}

function normalizeFailureThreshold(value: unknown): number {
  const parsed = safeNumber(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(Math.floor(parsed), MAX_TOOL_FAILURE_THRESHOLD));
}

function assignFunctionProperty<K extends keyof ToolDef>(target: ToolDef, source: ToolDef, key: K): void {
  const value = safeProperty(source, key);
  if (typeof value === "function") {
    (target as unknown as Record<string, unknown>)[key as string] = value;
  }
}

function normalizePermissionLevel(value: unknown): PermissionLevel {
  if (
    value === PermissionLevel.ALWAYS_ALLOW
    || value === PermissionLevel.ASK
    || value === PermissionLevel.DENY_IN_PLAN
    || value === PermissionLevel.DANGEROUS
  ) {
    return value;
  }
  return PermissionLevel.ASK;
}

function normalizeToolCapability(value: unknown): ToolCapability | undefined {
  return typeof value === "boolean" || typeof value === "function" ? value as ToolCapability : undefined;
}

function normalizeRegistryRenderMetadata(value: unknown): ToolDef["renderMetadata"] | undefined {
  if (typeof value === "function") return value as (args: Record<string, unknown>) => ToolRenderMetadata | undefined;
  const safe = safeJsonValue(value, { dropUndefinedObjectFields: true });
  return safe && typeof safe === "object" && !Array.isArray(safe) ? safe as ToolRenderMetadata : undefined;
}

function normalizeInterruptBehavior(value: unknown): ToolInterruptBehavior | ((args: Record<string, unknown>) => ToolInterruptBehavior) | undefined {
  if (value === "cancel" || value === "block") return value;
  if (typeof value === "function") return value as (args: Record<string, unknown>) => ToolInterruptBehavior;
  return undefined;
}

function normalizeToolResultKind(value: unknown): ToolResultKind | undefined {
  return typeof value === "string" && TOOL_RESULT_KIND_VALUES.has(value as ToolResultKind)
    ? value as ToolResultKind
    : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

interface SafeJsonOptions {
  dropUndefinedObjectFields?: boolean;
}

function safeJsonValue(value: unknown, options: SafeJsonOptions = {}): unknown {
  return normalizeJsonValue(value, options, new WeakSet<object>(), false, 0);
}

function normalizeJsonValue(
  value: unknown,
  options: SafeJsonOptions,
  seen: WeakSet<object>,
  insideObject: boolean,
  depth: number,
): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return options.dropUndefinedObjectFields && insideObject ? undefined : null;
  }
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_REGISTRY_SAFE_DEPTH) return options.dropUndefinedObjectFields && insideObject ? undefined : null;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return safeArrayItems(value, MAX_REGISTRY_SAFE_ARRAY_ITEMS).map(item => {
        const normalized = normalizeJsonValue(item, options, seen, false, depth + 1);
        return normalized === undefined ? null : normalized;
      });
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of safeObjectEntries(value, MAX_REGISTRY_SAFE_OBJECT_KEYS)) {
      const normalized = normalizeJsonValue(child, options, seen, true, depth + 1);
      if (normalized === undefined && options.dropUndefinedObjectFields) continue;
      out[key] = normalized === undefined ? null : normalized;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function safeObjectEntries(value: unknown, maxEntries: number): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys.slice(0, Math.max(0, Math.floor(maxEntries)))) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    entries.push([key, safeProperty(value, key)]);
  }
  return entries;
}

function safeArrayItems(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return [];
  }
  const limit = Math.min(length, Math.max(0, Math.floor(maxItems)));
  const items: unknown[] = [];
  for (let index = 0; index < limit; index++) {
    items.push(safeProperty(value, index));
  }
  return items;
}

function safeProperty(source: unknown, key: string | number | symbol): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string | number | symbol, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeNumber(value: unknown): number {
  try {
    return Number(value);
  } catch {
    return Number.NaN;
  }
}

function stringFromUnknown(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "";
  }
}
