/** Think tool — explicit reasoning step. */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

async function think(args: Record<string, unknown>): Promise<string> {
  const thought = safeThinkProperty(args, "thought");
  if (typeof thought !== "string") return "Error: thought must be a string.";
  const preview = thought.length > 200 ? safeSliceTextBoundary(thought, 200) + "..." : thought;
  return `Thought recorded: ${preview}`;
}

export function registerThinkTool(): void {
  getRegistry().register({
    name: "think", description: "Think through a complex problem step by step.",
    parameters: { type: "object", properties: { thought: { type: "string" } }, required: ["thought"] },
    execute: think, permission: PermissionLevel.ALWAYS_ALLOW, category: "meta", parallelOk: true,
    validateInput: (args) => (
      typeof safeThinkProperty(args, "thought") === "string"
        ? { ok: true as const, args: safeThinkCloneArgs(args) }
        : { ok: false as const, message: "thought must be a string." }
    ),
    readOnly: true,
    searchHint: "scratch reasoning note",
    resultKind: "text",
  });
}

function safeThinkProperty(source: unknown, key: string): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeThinkCloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(args);
  } catch {
    return clone;
  }
  for (const key of keys) {
    const value = safeThinkProperty(args, key);
    if (value !== undefined) clone[key] = value;
  }
  return clone;
}
