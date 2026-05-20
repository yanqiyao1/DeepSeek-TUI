/** Global tool registry singleton. */

import {
  isToolConcurrencySafe,
  isToolDestructive,
  isToolReadOnly,
  isToolStaticallyConcurrencySafe,
  isToolStaticallyDestructive,
  isToolStaticallyReadOnly,
  getToolRenderMetadata,
  type ToolDef,
} from "./base.js";
import { toolToOpenAISchema } from "./base.js";

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
    const normalized = normalizeToolDef(tool);
    this.aliases.delete(normalized.name);
    this.deleteAliasesFor(normalized.name);
    this.tools.set(normalized.name, normalized);
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
    const primary = this.aliases.get(name) || name;
    const tool = this.tools.get(primary);
    this.tools.delete(primary);
    this.activeToolNames.delete(primary);
    this.stats.delete(primary);
    this.disabledReasons.delete(primary);
    for (const alias of tool?.aliases || []) this.aliases.delete(alias);
    this.schemaCache = null;
  }

  lookup(name: string): ToolDef | undefined {
    return this.tools.get(this.aliases.get(name) || name);
  }

  listAll(): ToolDef[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  listActive(): ToolDef[] {
    return this.listAll().filter(tool => this.activeToolNames.has(tool.name));
  }

  activate(name: string): boolean {
    const primary = this.aliases.get(name) || name;
    if (!this.tools.has(primary)) return false;
    if (this.disabledReasons.has(primary)) return false;
    const before = this.activeToolNames.size;
    this.activeToolNames.add(primary);
    if (this.activeToolNames.size !== before) this.schemaCache = null;
    return true;
  }

  deactivate(name: string): boolean {
    const primary = this.aliases.get(name) || name;
    if (!this.activeToolNames.delete(primary)) return false;
    this.schemaCache = null;
    return true;
  }

  activateForContext(text: string): string[] {
    const normalized = text.toLowerCase();
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
    const primary = this.aliases.get(name) || name;
    const safeDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    const current = this.stats.get(primary) || {
      name: primary,
      calls: 0,
      failures: 0,
      consecutive_failures: 0,
      total_ms: 0,
      last_called_at: "",
    };
    current.calls++;
    current.total_ms += safeDurationMs;
    current.last_called_at = new Date().toISOString();
    if (ok) {
      current.consecutive_failures = 0;
    } else {
      current.failures++;
      current.consecutive_failures++;
    }
    this.stats.set(primary, current);
    return current;
  }

  degradeIfUnhealthy(name: string, threshold: number): string | null {
    const primary = this.aliases.get(name) || name;
    const stats = this.stats.get(primary);
    if (!stats || stats.consecutive_failures < Math.max(1, threshold)) return null;
    const reason = `disabled after ${stats.consecutive_failures} consecutive failures`;
    this.disabledReasons.set(primary, reason);
    this.deactivate(primary);
    return reason;
  }

  enableDegraded(name: string): boolean {
    const primary = this.aliases.get(name) || name;
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
      disabled_reason: this.disabledReasons.get(tool.name),
      read_only: isToolStaticallyReadOnly(tool),
      destructive: isToolStaticallyDestructive(tool),
      concurrency_safe: isToolStaticallyConcurrencySafe(tool),
      search_hint: tool.searchHint,
      max_result_size_chars: tool.maxResultSizeChars,
      };
      return stats;
    });
  }

  search(query: string, limit = 12): Array<{ tool: ToolDef; score: number }> {
    const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
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
    if (!options.activeOnly && this.schemaCache) return this.schemaCache;
    const tools = options.activeOnly ? this.listActive() : this.listAll();
    const schemas = tools.map(toolToOpenAISchema);
    if (!options.activeOnly) this.schemaCache = schemas;
    return schemas;
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
  const normalized: ToolDef = {
    ...tool,
    readOnly: tool.readOnly ?? KNOWN_READ_ONLY_TOOLS.has(tool.name),
    destructive: tool.destructive ?? KNOWN_DESTRUCTIVE_TOOLS.has(tool.name),
    concurrencySafe: tool.concurrencySafe ?? tool.parallelOk,
  };
  const deferLoading = tool.deferLoading ?? tool.shouldDefer;
  if (deferLoading !== undefined) normalized.deferLoading = deferLoading;
  return normalized;
}

function normalizeSearchLimit(limit: unknown): number {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return 12;
  return Math.max(1, Math.min(Math.floor(parsed), 50));
}

function toolSearchText(tool: ToolDef): string {
  const render = getToolRenderMetadata(tool);
  return [
    tool.name,
    ...(tool.aliases || []),
    tool.searchHint || "",
    tool.description,
    tool.category,
    tool.resultKind || "",
    render?.userFacingName || "",
    render?.icon || "",
    render?.accent || "",
    isToolStaticallyReadOnly(tool) ? "read-only readonly safe" : "",
    isToolStaticallyDestructive(tool) ? "destructive mutating mutation" : "",
    JSON.stringify(tool.parameters),
  ].join(" ").toLowerCase();
}
