/** Tool discovery and activation for tools that are present in the stable schema prefix. */

import {
  PermissionLevel,
  isToolStaticallyConcurrencySafe,
  isToolStaticallyDestructive,
  isToolStaticallyReadOnly,
} from "./base.js";
import { getRegistry } from "./registry.js";

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function normalizeQueryArg(args: Record<string, unknown>): string {
  if (typeof args.query === "string") return args.query.trim();
  if (typeof args.q === "string") return args.q.trim();
  return "";
}

async function toolSearch(args: Record<string, unknown>): Promise<string> {
  const query = normalize(normalizeQueryArg(args));
  if (!query.trim()) return "Error: query is required.";
  const registry = getRegistry();
  const matches = registry.search(query, 12);

  if (!matches.length) return `No tools matched '${query}'.`;
  for (const { tool } of matches) registry.activate(tool.name);
  return [
    `Activated ${matches.length} matching tool(s):`,
    ...matches.map(({ tool }) => {
      const tags = [
        isToolStaticallyReadOnly(tool) ? "read-only" : "",
        isToolStaticallyDestructive(tool) ? "destructive" : "",
        isToolStaticallyConcurrencySafe(tool) ? "concurrent" : "",
        tool.searchHint ? `hint: ${tool.searchHint}` : "",
      ].filter(Boolean).join(", ");
      return `- ${tool.name}${tags ? ` [${tags}]` : ""}: ${tool.description}`;
    }),
  ].join("\n");
}

async function toolStats(): Promise<string> {
  return JSON.stringify(getRegistry().toolStats(), null, 2);
}

async function toolEnable(args: Record<string, unknown>): Promise<string> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return "Error: name is required.";
  return getRegistry().enableDegraded(name) ? `Enabled ${name}.` : `Error: tool not found: ${name}`;
}

function validateToolEnableArgs(args: Record<string, unknown>) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  return name
    ? { ok: true as const, args: { ...args, name } }
    : { ok: false as const, message: "name is required." };
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
