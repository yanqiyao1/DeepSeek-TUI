/** Think tool — explicit reasoning step. */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

async function think(args: Record<string, unknown>): Promise<string> {
  if (typeof args.thought !== "string") return "Error: thought must be a string.";
  const thought = args.thought;
  const preview = thought.length > 200 ? safeSliceTextBoundary(thought, 200) + "..." : thought;
  return `Thought recorded: ${preview}`;
}

export function registerThinkTool(): void {
  getRegistry().register({
    name: "think", description: "Think through a complex problem step by step.",
    parameters: { type: "object", properties: { thought: { type: "string" } }, required: ["thought"] },
    execute: think, permission: PermissionLevel.ALWAYS_ALLOW, category: "meta", parallelOk: true,
    validateInput: (args) => (
      typeof args.thought === "string"
        ? { ok: true as const, args }
        : { ok: false as const, message: "thought must be a string." }
    ),
    readOnly: true,
    searchHint: "scratch reasoning note",
    resultKind: "text",
  });
}
