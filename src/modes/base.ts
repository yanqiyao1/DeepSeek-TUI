/** Interaction modes: Plan (read-only), Agent (approval), YOLO (auto-approved). */

import type { EngineRuntimeEvent } from "../engine/events.js";
import { PermissionLevel, isToolStaticallyReadOnly, resolveToolPermission, type ApprovalContext, type ToolDef } from "../tools/base.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

export const MODE_NAMES = ["plan", "agent", "yolo"] as const;
export type ModeName = typeof MODE_NAMES[number];

export interface BaseMode {
  name: string;
  filterTools(tools: ToolDef[]): ToolDef[];
  checkPermission(ctx: ApprovalContext, callbacks?: UICallbacks): Promise<boolean>;
}

export interface UICallbacks {
  onRuntimeEvent?(event: EngineRuntimeEvent): void | Promise<void>;
  onThinking?(text: string): void | Promise<void>;
  onContent?(text: string): void | Promise<void>;
  onToolCallStart?(name: string): void | Promise<void>;
  onToolExecuted?(name: string, preview: string): void | Promise<void>;
  onApiCallStart?(): void | Promise<void>;
  onContextIntervention?(intervention: unknown): void | Promise<void>;
  onRuntimeItem?(item: EngineRuntimeEvent): void | Promise<void>;
  requestApproval?(toolName: string, args: Record<string, unknown>, description: string): Promise<boolean>;
}

const PLAN_ALLOWED_TOOLS = new Set([
  "read",
  "ls",
  "search",
  "glob",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "web_search",
  "web_fetch",
  "think",
  "get_goal",
  "plan_status",
  "checklist_write",
  "update_plan",
  "note",
]);
const MAX_MODE_TEXT_CHARS = 2_000;
const MAX_MODE_ARG_KEYS = 2_000;
const MAX_MODE_ARG_ARRAY_ITEMS = 10_000;
const MAX_MODE_ARG_DEPTH = 32;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function isPlanAllowedTool(tool: ToolDef): boolean {
  const category = safeProperty(tool, "category");
  const permission = safeProperty(tool, "permission");
  const name = safeProperty(tool, "name");
  if (typeof category !== "string") return false;
  if (typeof name !== "string") return false;
  if (category === "shell") return false;
  if (permission !== PermissionLevel.ALWAYS_ALLOW) return false;
  return PLAN_ALLOWED_TOOLS.has(name) || (
    isToolStaticallyReadOnly(tool)
    && category !== "meta"
    && category !== "artifact"
    && category !== "task"
  );
}

export class PlanMode implements BaseMode {
  name = "plan";

  filterTools(tools: ToolDef[]): ToolDef[] {
    return tools.filter(isPlanAllowedTool);
  }

  async checkPermission(ctx: ApprovalContext, _callbacks?: UICallbacks): Promise<boolean> {
    const toolDef = safeProperty(ctx, "tool_def") as ToolDef | undefined;
    if (!toolDef) return false;
    if (safeProperty(ctx, "tool_name") !== safeProperty(toolDef, "name")) return false;
    return isPlanAllowedTool(toolDef);
  }
}

export class AgentMode implements BaseMode {
  name = "agent";

  filterTools(tools: ToolDef[]): ToolDef[] { return tools; }

  async checkPermission(ctx: ApprovalContext, callbacks?: UICallbacks): Promise<boolean> {
    const toolDecision = await resolveToolPermission(ctx, callbacks);
    if (toolDecision.decision === "allow") return true;
    if (toolDecision.decision === "deny") return false;
    const requestApproval = safeRequestApproval(callbacks);
    if (requestApproval) {
      const toolArgs = safeToolArgs(safeProperty(ctx, "tool_args"));
      return requestApproval(
        safeToolName(safeProperty(ctx, "tool_name")), toolArgs,
        `${approvalDescription(toolDecision.description, safeProperty(safeProperty(ctx, "tool_def"), "description"))}\n\nArguments: ${safeJsonStringify(toolArgs, { sortKeys: true })}`,
      );
    }
    return false;
  }
}

export class YoloMode implements BaseMode {
  name = "yolo";

  filterTools(tools: ToolDef[]): ToolDef[] { return tools; }

  async checkPermission(ctx: ApprovalContext, callbacks?: UICallbacks): Promise<boolean> {
    const toolDecision = await resolveToolPermission(ctx, callbacks);
    if (toolDecision.decision === "deny") return false;
    if (safeProperty(safeProperty(ctx, "tool_def"), "permission") === PermissionLevel.DANGEROUS) {
      const requestApproval = safeRequestApproval(callbacks);
      if (requestApproval) {
        return requestApproval(
          safeToolName(safeProperty(ctx, "tool_name")),
          safeToolArgs(safeProperty(ctx, "tool_args")),
          `DANGEROUS: ${approvalDescription(toolDecision.description || toolDecision.reason, safeProperty(safeProperty(ctx, "tool_def"), "description"))}`,
        );
      }
      return false;
    }
    return true;
  }
}

export function getMode(name: string): BaseMode {
  const modes: Record<string, BaseMode> = {
    plan: new PlanMode(),
    agent: new AgentMode(),
    yolo: new YoloMode(),
  };
  return modes[name] || new AgentMode();
}

export function nextModeName(name: string): ModeName {
  const current = MODE_NAMES.indexOf(name as ModeName);
  if (current === -1) return "agent";
  return MODE_NAMES[(current + 1) % MODE_NAMES.length] ?? "agent";
}

function safeRequestApproval(callbacks: UICallbacks | undefined): UICallbacks["requestApproval"] | undefined {
  const callback = safeProperty(callbacks, "requestApproval");
  return typeof callback === "function" ? callback as UICallbacks["requestApproval"] : undefined;
}

function safeToolName(value: unknown): string {
  return normalizeModeText(typeof value === "string" && value.trim() ? value : "tool", 64) || "tool";
}

function approvalDescription(primary: unknown, fallback: unknown): string {
  return normalizeModeText(primary, MAX_MODE_TEXT_CHARS)
    || normalizeModeText(fallback, MAX_MODE_TEXT_CHARS)
    || "Tool approval requested.";
}

function normalizeModeText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return safeSliceTextBoundary(value.replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim(), maxChars);
}

function safeToolArgs(value: unknown): Record<string, unknown> {
  const safe = safeJsonValue(value, { dropUndefinedObjectFields: true });
  return safe && typeof safe === "object" && !Array.isArray(safe) ? safe as Record<string, unknown> : {};
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
  if (depth >= MAX_MODE_ARG_DEPTH) return options.dropUndefinedObjectFields && insideObject ? undefined : null;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return safeArrayItems(value, MAX_MODE_ARG_ARRAY_ITEMS).map(item => {
        const normalized = normalizeJsonValue(item, options, seen, false, depth + 1);
        return normalized === undefined ? null : normalized;
      });
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of safeObjectEntries(value, MAX_MODE_ARG_KEYS)) {
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
