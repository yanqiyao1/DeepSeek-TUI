/** Tool discovery and activation for tools that are present in the stable schema prefix. */

import {
  PermissionLevel,
  isToolStaticallyConcurrencySafe,
  isToolStaticallyDestructive,
  isToolStaticallyReadOnly,
} from "./base.js";
import { getRegistry } from "./registry.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_TOOL_SEARCH_QUERY_CHARS = 500;
const MAX_TOOL_NAME_CHARS = 64;
const MAX_TOOL_SEARCH_OUTPUT_CHARS = 20_000;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function normalize(value: unknown): string {
  return stringFromUnknown(value).replace(CONTROL_TEXT_GLOBAL_RE, " ").toLowerCase();
}

function normalizeQueryArg(args: Record<string, unknown>): string {
  const query = safeArgValue(args, "query");
  const q = safeArgValue(args, "q");
  if (typeof query === "string" && query.trim()) return normalizeBoundedText(query, MAX_TOOL_SEARCH_QUERY_CHARS);
  if (typeof q === "string") return normalizeBoundedText(q, MAX_TOOL_SEARCH_QUERY_CHARS);
  if (typeof query === "string") return normalizeBoundedText(query, MAX_TOOL_SEARCH_QUERY_CHARS);
  return "";
}

function validateQueryArg(args: Record<string, unknown>): string | null {
  for (const key of ["query", "q"] as const) {
    const read = readArg(args, key);
    if (!read.ok) return `${key} must be a string.`;
    const value = read.value;
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
      const searchHint = safeArgValue(tool as unknown as Record<string, unknown>, "searchHint");
      const name = boundedInline(safeArgValue(tool as unknown as Record<string, unknown>, "name"), MAX_TOOL_NAME_CHARS) || "tool";
      const tags = [
        isToolStaticallyReadOnly(tool) ? "read-only" : "",
        isToolStaticallyDestructive(tool) ? "destructive" : "",
        isToolStaticallyConcurrencySafe(tool) ? "concurrent" : "",
        typeof searchHint === "string" && searchHint ? `hint: ${boundedInline(searchHint, 500)}` : "",
      ].filter(Boolean).join(", ");
      return `- ${name}${tags ? ` [${tags}]` : ""}: ${boundedInline(safeArgValue(tool as unknown as Record<string, unknown>, "description"), 2_000)}`;
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
  const read = readArg(args, "name");
  if (!read.ok) return { ok: false as const, message: "name must be a string." };
  const nameValue = read.value;
  if (nameValue !== undefined && typeof nameValue !== "string") return { ok: false as const, message: "name must be a string." };
  if (typeof nameValue === "string" && nameValue.trim().length > MAX_TOOL_NAME_CHARS) {
    return { ok: false as const, message: `name must be ${MAX_TOOL_NAME_CHARS} characters or fewer.` };
  }
  if (typeof nameValue === "string" && CONTROL_TEXT_RE.test(nameValue.trim())) {
    return { ok: false as const, message: "name contains unsupported control characters." };
  }
  const name = typeof nameValue === "string" ? normalizeBoundedText(nameValue, MAX_TOOL_NAME_CHARS) : "";
  return name
    ? { ok: true as const, args: { name } }
    : { ok: false as const, message: "name is required." };
}

function normalizeBoundedText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars || CONTROL_TEXT_RE.test(trimmed)) return "";
  return trimmed.replace(CONTROL_TEXT_GLOBAL_RE, " ");
}

function boundedInline(value: unknown, maxChars: number): string {
  return safeSliceTextBoundary(stringFromUnknown(value).replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim(), maxChars);
}

function boundedOutput(value: string): string {
  return value.length > MAX_TOOL_SEARCH_OUTPUT_CHARS ? `${safeSliceTextBoundary(value, MAX_TOOL_SEARCH_OUTPUT_CHARS)}\n[truncated]` : value;
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
      return query ? { ok: true, args: { query } } : { ok: false, message: "query is required." };
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

function readArg(args: Record<string, unknown>, key: string): { ok: true; value: unknown } | { ok: false; value?: undefined } {
  if (!args || (typeof args !== "object" && typeof args !== "function")) return { ok: true, value: undefined };
  try {
    return { ok: true, value: args[key] };
  } catch {
    return { ok: false };
  }
}

function safeArgValue(args: Record<string, unknown>, key: string): unknown {
  const read = readArg(args, key);
  return read.ok ? read.value : undefined;
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
