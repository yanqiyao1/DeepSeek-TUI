import { CapacityController, formatCapacityDecision } from "../engine/capacity.js";
import { clearTaskManager } from "../engine/task-lifecycle.js";
import { estimateMessagesTokens, projectMessagesForRequest } from "../engine/compact.js";
import { clearApprovalCache } from "../tools/approval-cache.js";
import { clearAgentState } from "../tools/sub-agent.js";
import { clearGoalState } from "../tools/goal.js";
import { clearPlanState } from "../tools/plan.js";
import { clearAll as clearPermissions, getAllRules, getSessionMemory } from "../tools/permission-ruleset.js";
import { p } from "../ui/palette.js";
import { VERSION } from "../version.js";
import type { SlashCommandHandler } from "./types.js";

const TOKEN_BAR_WIDTH = 20;

function usage(write: (message: unknown, isError?: boolean) => void, message: string): void {
  write(p.dim(message));
}

function rejectArgs(parts: string[], write: (message: unknown, isError?: boolean) => void, message: string): boolean {
  if (parts.length === 1) return false;
  usage(write, message);
  return true;
}

export const helpCommand: SlashCommandHandler = ({ parts, write }) => {
  if (rejectArgs(parts, write, "Usage: /help")) return;
  write(`
${p.blueBold("Commands")}
  /help          Show this help
  Shift+Tab      Cycle mode when idle (plan → agent → yolo)
  /plan          Switch to Plan mode (read-only)
  /agent         Switch to Agent mode (interactive approval)
  /yolo          Switch to YOLO mode (auto-approved)
  /provider [p]  Show or switch provider
  /model [name]  Show or switch model (pro/flash)
  /capabilities  Show current provider/model capability matrix
  /reasoning     Cycle reasoning effort (off → high → max)
  /clear         Clear conversation history
  /save          Save current session
  /load <id>     Load a saved session
  /delete [id]   Delete a saved session
  /sessions      List saved sessions
  /exit          Save session and exit (resume next time)
  /restore       List/revert workspace snapshots
  /cost          Show detailed cost breakdown
  /tokens        Show token usage
  /tasks         Show task status
  /jobs          Show background shell jobs
  /mcp           Manage MCP servers
  /skills        List skills (--remote browses registry)
  /skill <name>  Apply/install/update/uninstall/trust skills
  /permissions   Show permission rules
  /version       Show version
  Ctrl+C         Clear current input
  Alt+R          Search prompt history
`);
};

export const planCommand: SlashCommandHandler = ({ parts, cfg, session, runtime, write }) => {
  if (rejectArgs(parts, write, "Usage: /plan")) return;
  cfg.mode = "plan";
  session.mode = "plan";
  runtime.rebuildSystemPrompt();
  runtime.rebuildRuntime();
  write(p.modePlan("Switched to Plan mode (read-only)."));
  return true;
};

export const agentCommand: SlashCommandHandler = ({ parts, cfg, session, runtime, write }) => {
  if (rejectArgs(parts, write, "Usage: /agent")) return;
  cfg.mode = "agent";
  session.mode = "agent";
  runtime.rebuildSystemPrompt();
  runtime.rebuildRuntime();
  write(p.success("Switched to Agent mode (interactive approval)."));
  return true;
};

export const yoloCommand: SlashCommandHandler = ({ parts, cfg, session, runtime, write }) => {
  if (rejectArgs(parts, write, "Usage: /yolo")) return;
  cfg.mode = "yolo";
  session.mode = "yolo";
  runtime.rebuildSystemPrompt();
  runtime.rebuildRuntime();
  write(p.warning("Switched to YOLO mode (auto-approved)."));
  return true;
};

export const reasoningCommand: SlashCommandHandler = ({ parts, cfg, write }) => {
  if (rejectArgs(parts, write, "Usage: /reasoning")) return;
  const cycle: Record<string, typeof cfg.reasoning_effort> = {
    off: "high",
    low: "max",
    medium: "max",
    high: "max",
    max: "off",
    xhigh: "off",
  };
  cfg.reasoning_effort = cycle[cfg.reasoning_effort] || "high";
  write(p.success(`Reasoning effort: ${cfg.reasoning_effort}`));
};

export const clearCommand: SlashCommandHandler = ({ parts, cfg, session, history, costTracker, runtime, write }) => {
  if (rejectArgs(parts, write, "Usage: /clear")) return;
  session.messages = [];
  history.clear();
  runtime.clearActiveSkill?.();
  clearPlanState();
  clearGoalState();
  clearAgentState();
  clearApprovalCache();
  clearTaskManager();
  clearPermissions();
  session.turns = [];
  session.cumulative_tokens_in = 0;
  session.cumulative_tokens_out = 0;
  session.cumulative_cost = 0;
  session.title = "Untitled session";
  costTracker.reset(cfg.model);
  runtime.rebuildSystemPrompt();
  write(p.success("Conversation cleared."));
};

export const tokensCommand: SlashCommandHandler = ({ parts, cfg, session, history, runtime, write }) => {
  if (rejectArgs(parts, write, "Usage: /tokens")) return;
  const tokens = safeTokenCount(runtime.getRequestTokenCount?.() ?? history.approximateTokenCount());
  const limit = Math.max(1, safeTokenCount(cfg.context_limit, 1));
  const pct = Math.min(1_000, (tokens / limit) * 100);
  const filled = Math.max(0, Math.min(TOKEN_BAR_WIDTH, Math.floor((Math.min(100, pct) / 100) * TOKEN_BAR_WIDTH)));
  const bar = "█".repeat(filled) + "░".repeat(TOKEN_BAR_WIDTH - filled);
  write(`Context: [${bar}] ${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct.toFixed(0)}%)`);
  write(formatCapacityDecision(new CapacityController().observe(tokens, limit)));
  const rawTokens = estimateMessagesTokens(session.messages);
  const projectedMessages = projectMessagesForRequest(session.messages);
  if (projectedMessages.length !== session.messages.length || rawTokens !== tokens) {
    write(p.dim(`Raw event log: ${rawTokens.toLocaleString()} tokens across ${session.messages.length} messages; request projection is compacted before API calls.`));
  }
};

export const permissionsCommand: SlashCommandHandler = ({ parts, write }) => {
  if (rejectArgs(parts, write, "Usage: /permissions")) return;
  const rules = getAllRules();
  const mem = getSessionMemory();
  write(p.blueBold(`Permissions: ${rules.length} rules`));
  write(`  Always allowed: ${mem.allow.join(", ") || "none"}`);
  write(`  Always denied: ${mem.deny.join(", ") || "none"}`);
  write("  Default rules:");
  for (const r of rules.slice(0, 20)) {
    write(`    ${r.permission}:${r.pattern} → ${r.action}`);
  }
};

export const costCommand: SlashCommandHandler = ({ parts, costTracker, write }) => {
  if (rejectArgs(parts, write, "Usage: /cost")) return;
  write(costTracker.formatDetailed());
};

export const versionCommand: SlashCommandHandler = ({ parts, write }) => {
  if (rejectArgs(parts, write, "Usage: /version")) return;
  write(`seek-code v${VERSION}`);
};

function safeTokenCount(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}
