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

import { spawn, type ChildProcess } from "node:child_process";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify } from "../utils/json-safe.js";

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
const MAX_HOOKS = 128;
const MAX_HOOK_COMMAND_CHARS = 4096;
const MAX_HOOK_MATCHER_CHARS = 256;
const MAX_HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_OUTPUT_CHARS = 64_000;
const MAX_HOOK_MESSAGE_CHARS = 2_000;
const MAX_HOOK_PAYLOAD_JSON_CHARS = 256_000;
const MAX_HOOK_PAYLOAD_VALUE_JSON_CHARS = 128_000;
const MAX_HOOK_PAYLOAD_STRING_CHARS = 32_000;
const MAX_HOOK_MODIFIED_INPUT_KEYS = 128;
const MAX_HOOK_MODIFIED_INPUT_JSON_CHARS = 100_000;
const MAX_HOOK_JSON_DEPTH = 8;
const MAX_HOOK_JSON_ARRAY_ITEMS = 128;
const HOOK_CONTROL_GLOBAL_RE = /[\u0000-\u001F\u007F]/g;
const HOOK_MESSAGE_CONTROL_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const VALID_HOOK_EVENTS = new Set<HookEvent>([
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
]);

export function registerHook(config: HookConfig): void {
  if (!config || typeof config !== "object") return;
  if (hooks.length >= MAX_HOOKS) return;
  const event = normalizeHookEvent(config.event);
  if (!event) return;
  const command = normalizeHookText(config.command, MAX_HOOK_COMMAND_CHARS);
  if (!command) return;
  const matcher = normalizeHookText(config.matcher, MAX_HOOK_MATCHER_CHARS);
  hooks.push(omitUndefined({
    event,
    command,
    ...(matcher ? { matcher } : {}),
    ...(() => {
      const timeout = normalizeTimeout(config.timeout);
      return timeout !== undefined ? { timeout } : {};
    })(),
  }));
}

export function clearHooks(): void {
  hooks.length = 0;
}

export function getHooks(): HookConfig[] {
  return hooks.map(hook => ({ ...hook }));
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
  const safeEvent = normalizeHookEvent(event);
  if (!safeEvent) return { decision: "continue", fired: 0 };
  const matching = hooks.filter(h => {
    if (h.event !== safeEvent) return false;
    if (h.matcher) {
      if (typeof context.tool_name !== "string") return false;
      const toolName = normalizeHookText(context.tool_name, MAX_HOOK_MATCHER_CHARS);
      if (!toolName || !matchTool(h.matcher, toolName)) return false;
    }
    return true;
  });

  if (matching.length === 0) return { decision: "continue", fired: 0 };

  const payload: HookPayload = omitUndefined({
    event: safeEvent,
    tool_name: normalizeOptionalHookText(context.tool_name, MAX_HOOK_MATCHER_CHARS),
    tool_input: sanitizeHookRecord(context.tool_input, MAX_HOOK_PAYLOAD_VALUE_JSON_CHARS),
    tool_result: normalizeOptionalHookValueText(context.tool_result, MAX_HOOK_PAYLOAD_STRING_CHARS),
    session_id: normalizeOptionalHookText(context.session_id, MAX_HOOK_MATCHER_CHARS),
    cwd: normalizeOptionalHookText(context.cwd, MAX_HOOK_COMMAND_CHARS) || process.cwd(),
    timestamp: new Date().toISOString(),
  });

  let result: HookResult = { decision: "continue" };
  let fired = 0;

  for (const hook of matching) {
    const hookResult = sanitizeHookResult(await runHook(hook, payload));
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
      result.message = combineHookMessages(result.message, hookResult.message);
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
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: HookResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(sanitizeHookResult(result));
    };
    const child = spawn(hook.command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      detached: process.platform !== "win32",
      env: { ...process.env, SEEKCODE_HOOK_EVENT: payload.event, DEEPSEEK_HOOK_EVENT: payload.event },
    });

    timer = setTimeout(() => {
      terminateHookProcess(child);
      finish({ decision: "continue", message: `Hook timed out after ${timeout}ms` });
    }, timeout);
    timer.unref?.();

    let stdout = "";
    let stderr = "";
    let stdinError = "";

    child.stdout.on("data", (d: Buffer) => {
      stdout = appendBoundedOutput(stdout, d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = appendBoundedOutput(stderr, d);
    });

    // Send payload as JSON on stdin
    const payloadJson = serializeHookPayload(payload);
    child.stdin.on("error", (err) => {
      stdinError = sanitizeHookMessage(err.message, 200);
    });
    try {
      child.stdin.end(payloadJson);
    } catch (error: any) {
      stdinError = sanitizeHookMessage(error?.message, 200);
    }

    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = sanitizeHookMessage(stderr, 200) || stdinError;
        finish({ decision: "continue", message: `Hook exited with code ${code}${detail ? `: ${detail}` : ""}` });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim() || "{}") as HookResult;
        finish(result);
      } catch {
        // If hook outputs plain text, treat as message
        const msg = sanitizeHookMessage(stdout);
        finish(msg ? { decision: "continue", message: msg } : { decision: "continue" });
      }
    });

    child.on("error", (err) => {
      finish({ decision: "continue", message: `Hook error: ${sanitizeHookMessage(err.message)}` });
    });
  });
}

function terminateHookProcess(child: ChildProcess): void {
  if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }, 100).unref?.();
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
  return value > 0 ? Math.min(Math.floor(value), MAX_HOOK_TIMEOUT_MS) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appendBoundedOutput(current: string, chunk: Buffer): string {
  if (current.length >= MAX_HOOK_OUTPUT_CHARS) return current;
  const remaining = MAX_HOOK_OUTPUT_CHARS - current.length;
  return (current + chunk.toString("utf-8").slice(0, remaining)).replace(HOOK_CONTROL_GLOBAL_RE, " ");
}

function normalizeHookEvent(value: unknown): HookEvent | null {
  return typeof value === "string" && VALID_HOOK_EVENTS.has(value as HookEvent) ? value as HookEvent : null;
}

function normalizeHookText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(HOOK_CONTROL_GLOBAL_RE, " ").trim();
  return normalized.length <= maxChars ? normalized : "";
}

function normalizeOptionalHookText(value: unknown, maxChars: number): string | undefined {
  return normalizeHookText(value, maxChars) || undefined;
}

function normalizeOptionalHookValueText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(HOOK_CONTROL_GLOBAL_RE, " ");
  return safeSlice(normalized, maxChars);
}

function sanitizeHookMessage(value: unknown, maxChars = MAX_HOOK_MESSAGE_CHARS): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(HOOK_MESSAGE_CONTROL_GLOBAL_RE, " ").trim();
  return safeSlice(normalized, maxChars);
}

function combineHookMessages(current: string | undefined, next: string): string {
  return sanitizeHookMessage(current ? `${current}\n${next}` : next);
}

function sanitizeHookResult(value: unknown): HookResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { decision: "continue" };
  const record = value as Record<string, unknown>;
  const decision: NonNullable<HookResult["decision"]> = record.decision === "approve" || record.decision === "deny" || record.decision === "continue"
    ? record.decision
    : "continue";
  const message = sanitizeHookMessage(record.message);
  const modifiedInput = sanitizeModifiedInput(record.modified_input);
  return omitUndefined({
    decision,
    ...(message ? { message } : {}),
    ...(modifiedInput ? { modified_input: modifiedInput } : {}),
  });
}

function sanitizeModifiedInput(value: unknown): Record<string, unknown> | undefined {
  return sanitizeHookRecord(value, MAX_HOOK_MODIFIED_INPUT_JSON_CHARS, false);
}

function sanitizeHookRecord(value: unknown, maxJsonChars: number, truncateLarge = true): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = sanitizeHookJsonValue(value, new WeakSet<object>(), 0);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  try {
    const serialized = safeJsonStringify(candidate, { dropUndefinedObjectFields: true });
    if (serialized.length > maxJsonChars) return truncateLarge ? { __truncated: true } : undefined;
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return truncateLarge ? { __truncated: true } : undefined;
  }
}

function sanitizeHookJsonValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return safeSlice(value.replace(HOOK_CONTROL_GLOBAL_RE, " "), MAX_HOOK_PAYLOAD_STRING_CHARS);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_HOOK_JSON_DEPTH) return "[MaxDepth]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_HOOK_JSON_ARRAY_ITEMS).map(item => {
        const normalized = sanitizeHookJsonValue(item, seen, depth + 1);
        return normalized === undefined ? null : normalized;
      });
    }

    const result: Record<string, unknown> = {};
    for (const [rawKey, child] of Object.entries(value).slice(0, MAX_HOOK_MODIFIED_INPUT_KEYS)) {
      const key = normalizeHookText(rawKey, MAX_HOOK_MATCHER_CHARS);
      if (!key) continue;
      const normalized = sanitizeHookJsonValue(child, seen, depth + 1);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function serializeHookPayload(payload: HookPayload): string {
  const serialized = safeJsonStringify(payload, { dropUndefinedObjectFields: true });
  if (serialized.length <= MAX_HOOK_PAYLOAD_JSON_CHARS) return serialized;
  return safeJsonStringify({
    event: payload.event,
    tool_name: payload.tool_name,
    tool_input: { __truncated: true },
    tool_result: payload.tool_result ? safeSlice(payload.tool_result, MAX_HOOK_MESSAGE_CHARS) : undefined,
    session_id: payload.session_id,
    cwd: payload.cwd,
    timestamp: payload.timestamp,
  }, { dropUndefinedObjectFields: true });
}

function safeSlice(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = Math.max(0, Math.floor(maxChars));
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return value.slice(0, end);
}
