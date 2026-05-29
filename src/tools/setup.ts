/** Shared built-in tool registration for CLI, TUI, and server runtimes. */

import type { Config } from "../config.js";
import { registerArtifactTools } from "./artifacts.js";
import { registerCustomTools } from "./custom.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerFileTools } from "./file-ops.js";
import { registerGitTools } from "./git.js";
import { registerGoalTools } from "./goal.js";
import { registerPatchTool } from "./patch.js";
import { addRule } from "./permission-ruleset.js";
import { registerPlanTools } from "./plan.js";
import { getRegistry, type ToolRegistry } from "./registry.js";
import { registerRLMTool } from "./rlm-query.js";
import { registerShellTool } from "./shell.js";
import { registerSubAgentTool } from "./sub-agent.js";
import { registerTaskTools } from "./tasks.js";
import { registerThinkTool } from "./think.js";
import { registerToolSearchTool } from "./tool-search.js";
import { registerWebTools } from "./web.js";

export function registerBuiltInTools(config?: Config, options: { clear?: boolean; workspacePath?: string } = {}): ToolRegistry {
  const registry = getRegistry();
  if (safeSetupProperty(options, "clear") === true) registry.clear();
  registerFileTools();
  registerShellTool();
  registerGitTools();
  registerWebTools(config?.web);
  registerPatchTool();
  registerThinkTool();
  registerRLMTool();
  registerSubAgentTool(config);
  registerPlanTools();
  registerGoalTools();
  registerToolSearchTool();
  registerTaskTools();
  registerArtifactTools();
  registerDiagnosticsTools();
  const workspacePath = safeSetupProperty(options, "workspacePath");
  registerCustomTools(typeof workspacePath === "string" && workspacePath.trim() ? workspacePath : process.cwd());
  applyConfiguredPermissions(config);
  return registry;
}

export function refreshWebTools(config?: Config): ToolRegistry {
  const registry = getRegistry();
  registerWebTools(config?.web);
  applyConfiguredPermissions(config);
  return registry;
}

function applyConfiguredPermissions(config?: Config): void {
  const permissions = safeSetupProperty(config, "permissions");
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return;
  for (const [permission, action] of Object.entries(permissions)) {
    addRule({ permission, pattern: "*", action });
  }
}

function safeSetupProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
