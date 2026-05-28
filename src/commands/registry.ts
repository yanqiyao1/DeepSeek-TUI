import { p } from "../ui/palette.js";
import { agentCommand, clearCommand, costCommand, helpCommand, permissionsCommand, planCommand, reasoningCommand, tokensCommand, versionCommand, yoloCommand } from "./core.js";
import { capabilitiesCommand, modelCommand, providerCommand } from "./model.js";
import { configCommand } from "./config.js";
import { deleteCommand, exitCommand, loadCommand, saveCommand, sessionsCommand } from "./sessions.js";
import { jobsCommand, tasksCommand } from "./tasks.js";
import { mcpCommand } from "./mcp.js";
import { restoreCommand } from "./workspace.js";
import { skillCommand, skillsCommand } from "./skills.js";
import { expandClaudeCommand, findClaudeCommand } from "./compat.js";
import type { Config } from "../config.js";
import type { CostTracker } from "../cost/tracker.js";
import type { ConversationHistory } from "../session/history.js";
import type { Session } from "../session/types.js";
import type { SlashCommandHandler, SlashCommandRuntime, SlashCommandResult } from "./types.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

export type { SlashCommandRuntime, PickerRenderer } from "./types.js";

const MAX_SLASH_INPUT_CHARS = 4_096;
const CONTROL_SLASH_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_SLASH_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MAX_SLASH_DISPLAY_CHARS = 120;

export const LIVE_READONLY_COMMANDS = new Set([
  "/tasks",
  "/jobs",
  "/tokens",
  "/cost",
  "/permissions",
  "/sessions",
  "/version",
  "/help",
]);

export function normalizedSlashInput(input: string): string | null {
  if (typeof input !== "string" || input.length > MAX_SLASH_INPUT_CHARS || CONTROL_SLASH_RE.test(input)) return null;
  const trimmed = input.trim();
  return trimmed.startsWith("/") ? trimmed : null;
}

const COMMAND_HANDLERS = new Map<string, SlashCommandHandler>([
  ["/help", helpCommand],
  ["/plan", planCommand],
  ["/agent", agentCommand],
  ["/yolo", yoloCommand],
  ["/provider", providerCommand],
  ["/model", modelCommand],
  ["/capabilities", capabilitiesCommand],
  ["/reasoning", reasoningCommand],
  ["/clear", clearCommand],
  ["/save", saveCommand],
  ["/load", loadCommand],
  ["/delete", deleteCommand],
  ["/sessions", sessionsCommand],
  ["/restore", restoreCommand],
  ["/tokens", tokensCommand],
  ["/tasks", tasksCommand],
  ["/jobs", jobsCommand],
  ["/skills", skillsCommand],
  ["/skill", skillCommand],
  ["/permissions", permissionsCommand],
  ["/mcp", mcpCommand],
  ["/config", configCommand],
  ["/cost", costCommand],
  ["/exit", exitCommand],
  ["/version", versionCommand],
]);

export function isLiveReadonlyCommand(input: string): boolean {
  const slashInput = normalizedSlashInput(input);
  if (!slashInput) return false;
  const cmd = slashInput.split(/\s+/)[0];
  return !!cmd && LIVE_READONLY_COMMANDS.has(cmd.toLowerCase());
}

export async function handleSlashCommand(
  input: string,
  cfg: Config,
  session: Session,
  history: ConversationHistory,
  costTracker: CostTracker,
  runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
  const trimmedInput = typeof input === "string" ? input.trim() : "";
  const slashInput = normalizedSlashInput(input);
  if (trimmedInput.startsWith("/") && !slashInput) {
    const writeInvalid = runtime.write ?? ((message: unknown) => {
      console.log(typeof message === "string" ? message : safeJsonStringify(message, { space: 2 }));
    });
    writeInvalid(p.error("Invalid slash command input."));
    return false;
  }
  const normalizedInput = slashInput ?? trimmedInput;
  const parts = normalizedInput.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const write = runtime.write ?? ((message: unknown) => {
    console.log(typeof message === "string" ? message : safeJsonStringify(message, { space: 2 }));
  });
  if (!cmd) return false;

  if (runtime.liveReadonly && !LIVE_READONLY_COMMANDS.has(cmd)) {
    write(p.warning(`Command ${sanitizeSlashDisplayText(cmd)} is not available while the agent is running. Use Esc to interrupt, or wait for the turn to finish.`));
    return false;
  }

  const handler = COMMAND_HANDLERS.get(cmd);
  if (!handler) {
    const compat = findClaudeCommand(normalizedInput, session.workspace_path || process.cwd());
    if (compat) {
      return {
        type: "prompt",
        input: expandClaudeCommand(compat.command, compat.args),
        label: `/${compat.command.name}`,
      };
    }
    write(p.error(`Unknown command: ${sanitizeSlashDisplayText(cmd)}`));
    return false;
  }

  return (await handler({ input, parts, cmd, cfg, session, history, costTracker, runtime, write })) ?? false;
}

function sanitizeSlashDisplayText(value: unknown): string {
  return safeSliceTextBoundary(String(value ?? "").replace(CONTROL_SLASH_GLOBAL_RE, " ").replace(/\s+/g, " ").trim(), MAX_SLASH_DISPLAY_CHARS);
}
