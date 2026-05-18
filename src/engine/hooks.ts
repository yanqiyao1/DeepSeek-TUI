/** Lifecycle hooks system — PreToolUse, PostToolUse, Stop, UserPromptSubmit, etc.
 *
 * Adopted from OpenAI Codex: script-based hooks that fire at lifecycle events.
 * Hooks are shell commands that receive JSON on stdin and can approve/deny/modify.
 *
 * Config format (~/.seekcode/hooks.toml or .seekcode/hooks.toml):
 *   [[hooks]]
 *   event = "PreToolUse"
 *   command = "node ~/hooks/audit-tool.js"
 *   matcher = "bash"  # optional, only fire for this tool
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// ── Types ────────────────────────────────────────────────────

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PermissionRequest"
  | "SessionStart"
  | "UserPromptSubmit"
  | "Stop";

export interface HookConfig {
  event: HookEvent;
  command: string;    // shell command or script path
  matcher?: string;   // tool name pattern (for PreToolUse/PostToolUse)
  timeout?: number;   // ms, default 10_000
}

export interface HookPayload {
  event: HookEvent;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: string;
  session_id?: string;
  cwd?: string;
  timestamp: string;
}

export interface HookResult {
  decision?: "approve" | "deny" | "continue";
  message?: string;
  modified_input?: Record<string, unknown>;
}

// ── Hook Registry ────────────────────────────────────────────

const hooks: HookConfig[] = [];

export function registerHook(config: HookConfig): void {
  if (typeof config.command !== "string" || !config.command.trim()) return;
  hooks.push({
    ...config,
    command: config.command,
    ...(typeof config.matcher === "string" ? { matcher: config.matcher } : {}),
    ...(normalizeTimeout(config.timeout) !== undefined ? { timeout: normalizeTimeout(config.timeout) } : {}),
  });
}

export function clearHooks(): void {
  hooks.length = 0;
}

export function getHooks(): HookConfig[] {
  return [...hooks];
}

/**
 * Fire all hooks matching an event and optional tool name.
 * Returns the aggregated decision (first deny wins, then first approve,
 * defaults to continue).
 */
export async function fireHooks(
  event: HookEvent,
  context: Partial<HookPayload> = {},
): Promise<HookResult & { fired: number }> {
  const matching = hooks.filter(h => {
    if (h.event !== event) return false;
    if (h.matcher && context.tool_name && !matchTool(h.matcher, context.tool_name)) return false;
    return true;
  });

  if (matching.length === 0) return { decision: "continue", fired: 0 };

  const payload: HookPayload = {
    event,
    tool_name: context.tool_name,
    tool_input: context.tool_input,
    tool_result: context.tool_result,
    session_id: context.session_id,
    cwd: context.cwd || process.cwd(),
    timestamp: new Date().toISOString(),
  };

  let result: HookResult = { decision: "continue" };
  let fired = 0;

  for (const hook of matching) {
    const hookResult = await runHook(hook, payload);
    fired++;
    // First deny wins
    if (hookResult.decision === "deny") {
      return { ...hookResult, fired };
    }
    // First approve wins (overrides continue)
    if (hookResult.decision === "approve" && result.decision === "continue") {
      result = hookResult;
    }
    if (hookResult.message) {
      result.message = result.message
        ? `${result.message}\n${hookResult.message}`
        : hookResult.message;
    }
    // Merge modified_input
    if (hookResult.modified_input) {
      result.modified_input = { ...result.modified_input, ...hookResult.modified_input };
    }
  }

  return { ...result, fired };
}

async function runHook(hook: HookConfig, payload: HookPayload): Promise<HookResult> {
  return new Promise((resolve) => {
    const timeout = normalizeTimeout(hook.timeout) ?? 10_000;
    const child = spawn(hook.command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env: { ...process.env, SEEKCODE_HOOK_EVENT: payload.event, DEEPSEEK_HOOK_EVENT: payload.event },
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ decision: "continue", message: `Hook timed out after ${timeout}ms` });
    }, timeout);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

    // Send payload as JSON on stdin
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ decision: "continue", message: `Hook exited with code ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim() || "{}") as HookResult;
        resolve(result);
      } catch {
        // If hook outputs plain text, treat as message
        const msg = stdout.trim();
        resolve({ decision: "continue", message: msg || undefined });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ decision: "continue", message: `Hook error: ${err.message}` });
    });
  });
}

function matchTool(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  // Simple glob: supports * and exact match
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + escapeRegExp(pattern).replace(/\\\*/g, ".*") + "$");
    return regex.test(toolName);
  }
  return pattern === toolName;
}

function normalizeTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value > 0 ? Math.floor(value) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
