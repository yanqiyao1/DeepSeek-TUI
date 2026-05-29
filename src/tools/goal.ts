/** Goal tracking tools — create_goal, get_goal, update_goal.
 *
 * Adopted from OpenAI Codex: persistent thread-level goals with token budgets
 * and usage accounting. Goals provide a north-star objective that persists
 * across turns and sessions.
 */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

// ── Goal state ───────────────────────────────────────────────

interface ActiveGoal {
  objective: string;
  token_budget: number | null;
  created_at: number;
  started_at: number;
  // Usage tracking
  tokens_used: number;
  turns_used: number;
  elapsed_ms: number;
  status: "active" | "complete" | "abandoned";
  result?: string;
}

let activeGoal: ActiveGoal | null = null;
// Track per-session usage for the goal
let goalTokensUsed = 0;
let goalTurnsUsed = 0;
let goalStartTime = 0;
const MAX_GOAL_OBJECTIVE_CHARS = 2000;
const MAX_GOAL_RESULT_CHARS = 10_000;

export function getGoalState() { return activeGoal; }
export function clearGoalState() { activeGoal = null; goalTokensUsed = 0; goalTurnsUsed = 0; goalStartTime = 0; }

export function trackGoalTokenUsage(tokens: number): void {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return;
  goalTokensUsed = Math.min(Number.MAX_SAFE_INTEGER, goalTokensUsed + tokens);
  if (activeGoal) activeGoal.tokens_used = goalTokensUsed;
}
export function trackGoalTurn(): void {
  goalTurnsUsed = Math.min(Number.MAX_SAFE_INTEGER, goalTurnsUsed + 1);
  if (activeGoal) activeGoal.turns_used = goalTurnsUsed;
}
export function trackGoalElapsed(): void {
  if (activeGoal && goalStartTime) {
    activeGoal.elapsed_ms = Date.now() - goalStartTime;
  }
}

// ── get_goal ─────────────────────────────────────────────────

async function getGoal(): Promise<string> {
  if (!activeGoal) {
    return "No active goal. Use create_goal to set an objective with an optional token budget.";
  }

  const elapsed = Date.now() - goalStartTime;
  const elapsedStr = formatDuration(elapsed);
  const budgetStr = activeGoal.token_budget
    ? `${activeGoal.tokens_used.toLocaleString()} / ${activeGoal.token_budget.toLocaleString()} tokens`
    : `${activeGoal.tokens_used.toLocaleString()} tokens used (unlimited budget)`;

  return [
    `## Goal: ${activeGoal.objective}`,
    `Status: ${activeGoal.status} | Created: ${new Date(activeGoal.created_at).toISOString().slice(0, 16)}`,
    `Budget: ${budgetStr}`,
    `Turns: ${goalTurnsUsed} | Elapsed: ${elapsedStr}`,
    activeGoal.status === "complete" ? `Result: ${activeGoal.result || "Completed"}` : "",
  ].filter(Boolean).join("\n");
}

// ── create_goal ──────────────────────────────────────────────

async function createGoal(args: Record<string, unknown>): Promise<string> {
  const objective = normalizeGoalText(safeGoalProperty(args, "objective"), "objective", MAX_GOAL_OBJECTIVE_CHARS, true);
  const rawTokenBudget = safeGoalProperty(args, "token_budget");
  const tokenBudget = rawTokenBudget === undefined || rawTokenBudget === null
    ? null
    : typeof rawTokenBudget === "number"
    ? rawTokenBudget
    : Number.NaN;
  const objectiveText = "value" in objective ? objective.value : "";

  if (activeGoal && activeGoal.status === "active") {
    return `Error: A goal is already active: "${activeGoal.objective}". Use update_goal to change status, or complete/abandon the current goal first.`;
  }

  if ("error" in objective) {
    if (objective.error !== "objective must be a string." && objective.error !== "objective is required.") return `Error: ${objective.error}`;
    return "Error: objective is required. Provide a concrete, verifiable goal description.";
  }

  if (tokenBudget !== null && (!Number.isFinite(tokenBudget) || tokenBudget <= 0 || !Number.isInteger(tokenBudget))) {
    return "Error: token_budget must be a positive integer or omitted for unlimited.";
  }

  const now = Date.now();
  activeGoal = {
    objective: objectiveText,
    token_budget: tokenBudget === null ? null : Math.floor(tokenBudget),
    created_at: now,
    started_at: now,
    tokens_used: 0,
    turns_used: 0,
    elapsed_ms: 0,
    status: "active",
  };
  goalTokensUsed = 0;
  goalTurnsUsed = 0;
  goalStartTime = now;

  const budgetNote = tokenBudget
    ? ` with a ${tokenBudget.toLocaleString()} token budget`
    : " (unlimited budget)";

  return `Goal created${budgetNote}: "${objectiveText}"\n\nTrack progress with get_goal. Mark complete with update_goal status=complete when the objective is achieved.`;
}

// ── update_goal ──────────────────────────────────────────────

async function updateGoal(args: Record<string, unknown>): Promise<string> {
  if (!activeGoal) {
    return "No active goal. Use create_goal to set an objective first.";
  }
  if (activeGoal.status !== "active") {
    return "No active goal. Use create_goal to set an objective first.";
  }

  const statusInput = safeGoalProperty(args, "status");
  const resultInput = safeGoalProperty(args, "result");
  const status = typeof statusInput === "string" ? statusInput.trim() : undefined;
  if (!status) {
    return "Error: status is required. Use 'complete' to mark the goal achieved.";
  }

  const resultText = resultInput === undefined
    ? { value: "" }
    : normalizeGoalText(resultInput, "result", MAX_GOAL_RESULT_CHARS, false);
  if ("error" in resultText) {
    return `Error: ${resultText.error}`;
  }

  if (status === "complete") {
    const result = resultText.value;
    activeGoal.status = "complete";
    activeGoal.result = result;
    activeGoal.elapsed_ms = Date.now() - goalStartTime;
    const budgetUsed = activeGoal.token_budget
      ? `\nToken budget: ${activeGoal.tokens_used.toLocaleString()} / ${activeGoal.token_budget.toLocaleString()} used`
      : `\nTokens used: ${activeGoal.tokens_used.toLocaleString()}`;

    const objective = activeGoal.objective;
    const elapsedMs = activeGoal.elapsed_ms;
    const response = `Goal marked complete: "${objective}"\nTurns: ${goalTurnsUsed} | Elapsed: ${formatDuration(elapsedMs)}${budgetUsed}${result ? `\nResult: ${result}` : ""}`;
    activeGoal = null;
    goalStartTime = 0;
    return response;
  }

  if (status === "abandon") {
    const objective = activeGoal.objective;
    activeGoal.status = "abandoned";
    activeGoal = null;
    goalStartTime = 0;
    return `Goal abandoned: "${objective}"`;
  }

  return `Unknown status: ${status}. Use 'complete' or 'abandon'.`;
}

// ── Helpers ──────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const secs = Math.floor(safeMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function normalizeGoalText(value: unknown, label: string, maxChars: number, required: boolean): { value: string } | { error: string } {
  if (typeof value !== "string") return { error: `${label} must be a string.` };
  const trimmed = value.trim();
  if (trimmed.includes("\0")) return { error: `${label} must not contain NUL bytes.` };
  if (required && !trimmed) return { error: `${label} is required.` };
  if (trimmed.length > maxChars) return { error: `${label} must be at most ${maxChars} characters.` };
  return { value: trimmed };
}

// ── Registration ─────────────────────────────────────────────

export function registerGoalTools(): void {
  const r = getRegistry();

  r.register({
    name: "get_goal",
    description: "Get the current goal for this session including objective, status, token budget, usage, and elapsed time. Use this before starting work to orient yourself, and periodically to check progress.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: getGoal,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    readOnly: true,
    searchHint: "read session goal",
    resultKind: "text",
  });

  r.register({
    name: "create_goal",
    description: "Create a goal only when explicitly requested by the user. Do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if a goal already exists; use update_goal to manage the current goal.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Required. The concrete, verifiable objective to pursue." },
        token_budget: { type: "integer", description: "Optional positive token budget for the goal." },
      },
      required: ["objective"],
    },
    execute: createGoal,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: false,
    validateInput: (args) => {
      const objective = normalizeGoalText(safeGoalProperty(args, "objective"), "objective", MAX_GOAL_OBJECTIVE_CHARS, true);
      if ("error" in objective) return { ok: false as const, message: objective.error === "objective must be a string." ? "objective is required. Provide a concrete, verifiable goal description." : objective.error };
      const tokenBudget = safeGoalProperty(args, "token_budget");
      if (tokenBudget !== undefined && tokenBudget !== null) {
        if (typeof tokenBudget !== "number" || !Number.isFinite(tokenBudget) || tokenBudget <= 0 || !Number.isInteger(tokenBudget)) {
          return { ok: false as const, message: "token_budget must be a positive integer or omitted for unlimited." };
        }
      }
      return { ok: true as const, args: { ...safeGoalCloneArgs(args), objective: objective.value } };
    },
    searchHint: "create session goal",
    resultKind: "text",
  });

  r.register({
    name: "update_goal",
    description: "Update the existing goal. Use only to mark the goal complete (when objective is achieved) or abandoned. Do not mark complete merely because budget is nearly exhausted or you are stopping work. Report final token usage when completing a budgeted goal.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["complete", "abandon"], description: "Required. Set to 'complete' only when the objective is achieved and no required work remains." },
        result: { type: "string", description: "Optional. Summary of what was accomplished." },
      },
      required: ["status"],
    },
    execute: updateGoal,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: false,
    validateInput: (args) => {
      const statusInput = safeGoalProperty(args, "status");
      const resultInput = safeGoalProperty(args, "result");
      if (typeof statusInput !== "string" || !statusInput.trim()) {
        return { ok: false as const, message: "status is required. Use 'complete' to mark the goal achieved." };
      }
      const status = statusInput.trim();
      if (!["complete", "abandon"].includes(status)) {
        return { ok: false as const, message: "status must be 'complete' or 'abandon'." };
      }
      if (resultInput !== undefined && typeof resultInput !== "string") {
        return { ok: false as const, message: "result must be a string." };
      }
      if (typeof resultInput === "string") {
        const result = normalizeGoalText(resultInput, "result", MAX_GOAL_RESULT_CHARS, false);
        if ("error" in result) return { ok: false as const, message: result.error };
      }
      return { ok: true as const, args: { ...safeGoalCloneArgs(args), status } };
    },
    searchHint: "complete session goal",
    resultKind: "text",
  });
}

function safeGoalProperty(source: unknown, key: string): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeGoalCloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(args);
  } catch {
    return clone;
  }
  for (const key of keys) {
    const value = safeGoalProperty(args, key);
    if (value !== undefined) clone[key] = value;
  }
  return clone;
}
