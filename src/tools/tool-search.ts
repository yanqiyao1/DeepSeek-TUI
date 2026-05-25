/** Tool discovery and activation for tools that are present in the stable schema prefix. */

import {
  PermissionLevel,
  isToolStaticallyConcurrencySafe,
  isToolStaticallyDestructive,
  isToolStaticallyReadOnly,
} from "./base.js";
import { getRegistry } from "./registry.js";
import { safeJsonStringify } from "../utils/json-safe.js";

const MAX_TOOL_SEARCH_QUERY_CHARS = 500;
const MAX_TOOL_NAME_CHARS = 64;
const MAX_TOOL_SEARCH_OUTPUT_CHARS = 20_000;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function normalize(value: unknown): string {
  return String(value ?? "").replace(CONTROL_TEXT_GLOBAL_RE, " ").toLowerCase();
}

function normalizeQueryArg(args: Record<string, unknown>): string {
  if (typeof args.query === "string" && args.query.trim()) return normalizeBoundedText(args.query, MAX_TOOL_SEARCH_QUERY_CHARS);
  if (typeof args.q === "string") return normalizeBoundedText(args.q, MAX_TOOL_SEARCH_QUERY_CHARS);
  if (typeof args.query === "string") return normalizeBoundedText(args.query, MAX_TOOL_SEARCH_QUERY_CHARS);
  return "";
}

function validateQueryArg(args: Record<string, unknown>): string | null {
  for (const key of ["query", "q"] as const) {
    const value = args[key];
    if (value !== undefined && typeof value !== "string") return `${key} must be a string.`;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > MAX_TOOL_SEARCH_QUERY_CHARS) return `${key} must be ${MAX_TOOL_SEARCH_QUERY_CHARS} characters or fewer.`;
      if (CONTROL_TEXT_RE.test(trimmed)) return `${key} contains unsupported control characters.`;
    }
  }
  return null;
}

async function toolSearch(args: Record<string, unknown>): Promise<string> {
  const error = validateQueryArg(args);
  if (error) return `Error: ${error}`;
  const query = normalize(normalizeQueryArg(args));
  if (!query.trim()) return "Error: query is required.";
  const registry = getRegistry();
  const matches = registry.search(query, 12);

  if (!matches.length) return `No tools matched '${query}'.`;
  const activeNames = new Set(registry.listActive().map(tool => tool.name));
  const activated = matches.filter(({ tool }) => {
    const wasActive = activeNames.has(tool.name);
    const ok = registry.activate(tool.name);
    if (ok) activeNames.add(tool.name);
    return ok && !wasActive;
  });
  if (!activated.length) return `No inactive tools matched '${query}'.`;
  return boundedOutput([
    `Activated ${activated.length} matching tool(s):`,
    ...activated.map(({ tool }) => {
      const tags = [
        isToolStaticallyReadOnly(tool) ? "read-only" : "",
        isToolStaticallyDestructive(tool) ? "destructive" : "",
        isToolStaticallyConcurrencySafe(tool) ? "concurrent" : "",
        tool.searchHint ? `hint: ${boundedInline(tool.searchHint, 500)}` : "",
      ].filter(Boolean).join(", ");
      return `- ${tool.name}${tags ? ` [${tags}]` : ""}: ${boundedInline(tool.description, 2_000)}`;
    }),
  ].join("\n"));
}

async function toolStats(): Promise<string> {
  return boundedOutput(safeJsonStringify(getRegistry().toolStats(), { space: 2 }));
}

async function toolEnable(args: Record<string, unknown>): Promise<string> {
  const validation = validateToolEnableArgs(args);
  if (!validation.ok) return `Error: ${validation.message}`;
  const name = validation.args.name;
  if (!name) return "Error: name is required.";
  return getRegistry().enableDegraded(name) ? `Enabled ${name}.` : `Error: tool not found: ${name}`;
}

function validateToolEnableArgs(args: Record<string, unknown>) {
  if (args.name !== undefined && typeof args.name !== "string") return { ok: false as const, message: "name must be a string." };
  if (typeof args.name === "string" && args.name.trim().length > MAX_TOOL_NAME_CHARS) {
    return { ok: false as const, message: `name must be ${MAX_TOOL_NAME_CHARS} characters or fewer.` };
  }
  if (typeof args.name === "string" && CONTROL_TEXT_RE.test(args.name.trim())) {
    return { ok: false as const, message: "name contains unsupported control characters." };
  }
  const name = typeof args.name === "string" ? normalizeBoundedText(args.name, MAX_TOOL_NAME_CHARS) : "";
  return name
    ? { ok: true as const, args: { ...args, name } }
    : { ok: false as const, message: "name is required." };
}

function normalizeBoundedText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars || CONTROL_TEXT_RE.test(trimmed)) return "";
  return trimmed.replace(CONTROL_TEXT_GLOBAL_RE, " ");
}

function boundedInline(value: unknown, maxChars: number): string {
  return String(value ?? "").replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function boundedOutput(value: string): string {
  return value.length > MAX_TOOL_SEARCH_OUTPUT_CHARS ? `${value.slice(0, MAX_TOOL_SEARCH_OUTPUT_CHARS)}\n[truncated]` : value;
}

export function registerToolSearchTool(): void {
  getRegistry().register({
    name: "tool_search",
    description: "Search and activate tool definitions by name, description, category, or schema.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Tool capability to search for." },
        q: { type: "string", description: "Alias for query." },
      },
    },
    execute: toolSearch,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    readOnly: true,
    validateInput: (args) => {
      const error = validateQueryArg(args);
      if (error) return { ok: false, message: error };
      const query = normalizeQueryArg(args);
      return query ? { ok: true, args: { ...args, query } } : { ok: false, message: "query is required." };
    },
    searchHint: "discover deferred tools",
    resultKind: "text",
  });
  getRegistry().register({
    name: "tool_stats",
    description: "Show tool call counts, failures, active state, and degradation reasons.",
    parameters: { type: "object", properties: {} },
    execute: toolStats,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    readOnly: true,
    searchHint: "inspect tool health",
    resultKind: "json",
  });
  getRegistry().register({
    name: "tool_enable",
    description: "Re-enable a degraded or deferred tool by name.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    execute: toolEnable,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: false,
    readOnly: false,
    concurrencySafe: false,
    validateInput: validateToolEnableArgs,
    searchHint: "reenable tool",
    resultKind: "text",
  });
}
