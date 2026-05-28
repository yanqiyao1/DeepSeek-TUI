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
import { StringDecoder } from "node:string_decoder";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

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
const HOOK_TERMINATE_SIGKILL_MS = 100;
const HOOK_TERMINATE_MAX_WAIT_MS = 1_000;
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
  const event = normalizeHookEvent(safeProperty(config, "event"));
  if (!event) return;
  const command = normalizeHookText(safeProperty(config, "command"), MAX_HOOK_COMMAND_CHARS);
  if (!command) return;
  const matcher = normalizeHookText(safeProperty(config, "matcher"), MAX_HOOK_MATCHER_CHARS);
  hooks.push(omitUndefined({
    event,
    command,
    ...(matcher ? { matcher } : {}),
    ...(() => {
      const timeout = normalizeTimeout(safeProperty(config, "timeout"));
      return timeout !== undefined ? { timeout } : {};
    })(),
  }));
}

export function clearHooks(): void {
  hooks.length = 0;
}

export function getHooks(): HookConfig[] {
  return hooks.map(cloneHookConfig).filter((hook): hook is HookConfig => !!hook);
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
    if (safeProperty(h, "event") !== safeEvent) return false;
    const matcher = normalizeHookText(safeProperty(h, "matcher"), MAX_HOOK_MATCHER_CHARS);
    if (matcher) {
      const toolName = normalizeHookText(safeProperty(context, "tool_name"), MAX_HOOK_MATCHER_CHARS);
      if (!toolName || !matchTool(matcher, toolName)) return false;
    }
    return true;
  });

  if (matching.length === 0) return { decision: "continue", fired: 0 };

  const payload: HookPayload = omitUndefined({
    event: safeEvent,
    tool_name: normalizeOptionalHookText(safeProperty(context, "tool_name"), MAX_HOOK_MATCHER_CHARS),
    tool_input: sanitizeHookRecord(safeProperty(context, "tool_input"), MAX_HOOK_PAYLOAD_VALUE_JSON_CHARS),
    tool_result: normalizeOptionalHookValueText(safeProperty(context, "tool_result"), MAX_HOOK_PAYLOAD_STRING_CHARS),
    session_id: normalizeOptionalHookText(safeProperty(context, "session_id"), MAX_HOOK_MATCHER_CHARS),
    cwd: normalizeOptionalHookText(safeProperty(context, "cwd"), MAX_HOOK_COMMAND_CHARS) || process.cwd(),
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
    if (hookResult.message) {
      result.message = combineHookMessages(result.message, hookResult.message);
    }
    // Merge modified_input
    if (hookResult.modified_input) {
      result.modified_input = { ...result.modified_input, ...hookResult.modified_input };
    }
    // First approve wins (overrides continue) without duplicating message/input fields.
    if (hookResult.decision === "approve" && result.decision === "continue") {
      result.decision = "approve";
    }
  }

  return { ...result, fired };
}

async function runHook(hook: HookConfig, payload: HookPayload): Promise<HookResult> {
  return new Promise((resolve) => {
    const timeout = normalizeTimeout(safeProperty(hook, "timeout")) ?? 10_000;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const finish = (result: HookResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(sanitizeHookResult(result));
    };
    const command = normalizeHookText(safeProperty(hook, "command"), MAX_HOOK_COMMAND_CHARS);
    if (!command) {
      finish({ decision: "continue", message: "Hook command is invalid" });
      return;
    }
    const child = spawn(command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      detached: process.platform !== "win32",
      env: { ...process.env, SEEKCODE_HOOK_EVENT: payload.event, DEEPSEEK_HOOK_EVENT: payload.event },
    });

    timer = setTimeout(() => {
      timedOut = true;
      void terminateHookProcess(child).finally(() => {
        finish({ decision: "continue", message: `Hook timed out after ${timeout}ms` });
      });
    }, timeout);
    timer.unref?.();

    let stdout = "";
    let stderr = "";
    let stdinError = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    child.stdout.on("data", (d: Buffer) => {
      stdout = appendBoundedOutput(stdout, stdoutDecoder.write(d));
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = appendBoundedOutput(stderr, stderrDecoder.write(d));
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
      if (settled || timedOut) return;
      stdout = appendBoundedOutput(stdout, stdoutDecoder.end());
      stderr = appendBoundedOutput(stderr, stderrDecoder.end());
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
      if (timedOut) return;
      finish({ decision: "continue", message: `Hook error: ${sanitizeHookMessage(err.message)}` });
    });
  });
}

function terminateHookProcess(child: ChildProcess): Promise<void> {
  let sigkillTimer: NodeJS.Timeout | undefined;
  let maxWaitTimer: NodeJS.Timeout | undefined;
  const cleanup = () => {
    if (sigkillTimer) clearTimeout(sigkillTimer);
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    try { child.stdout?.destroy(); } catch { /* ignore */ }
    try { child.stderr?.destroy(); } catch { /* ignore */ }
    try { child.stdin?.destroy(); } catch { /* ignore */ }
    child.unref?.();
  };
  if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    cleanup();
    return Promise.resolve();
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      child.off("close", finish);
      cleanup();
      resolve();
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    child.once("close", finish);
    sigkillTimer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, HOOK_TERMINATE_SIGKILL_MS);
    sigkillTimer.unref?.();
    maxWaitTimer = setTimeout(finish, HOOK_TERMINATE_MAX_WAIT_MS);
    maxWaitTimer.unref?.();
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
  return value > 0 ? Math.min(Math.floor(value), MAX_HOOK_TIMEOUT_MS) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appendBoundedOutput(current: string, chunk: string): string {
  if (current.length >= MAX_HOOK_OUTPUT_CHARS) return current;
  const remaining = MAX_HOOK_OUTPUT_CHARS - current.length;
  return (current + safeSlice(chunk, remaining)).replace(HOOK_CONTROL_GLOBAL_RE, " ");
}

function normalizeHookEvent(value: unknown): HookEvent | null {
  return typeof value === "string" && VALID_HOOK_EVENTS.has(value as HookEvent) ? value as HookEvent : null;
}

function cloneHookConfig(value: unknown): HookConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = normalizeHookEvent(safeProperty(value, "event"));
  const command = normalizeHookText(safeProperty(value, "command"), MAX_HOOK_COMMAND_CHARS);
  if (!event || !command) return null;
  const matcher = normalizeHookText(safeProperty(value, "matcher"), MAX_HOOK_MATCHER_CHARS);
  const timeout = normalizeTimeout(safeProperty(value, "timeout"));
  return omitUndefined({
    event,
    command,
    ...(matcher ? { matcher } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  });
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
  const rawDecision = safeProperty(value, "decision");
  const decision: NonNullable<HookResult["decision"]> = rawDecision === "approve" || rawDecision === "deny" || rawDecision === "continue"
    ? rawDecision
    : "continue";
  const message = sanitizeHookMessage(safeProperty(value, "message"));
  const modifiedInput = sanitizeModifiedInput(safeProperty(value, "modified_input"));
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
      return safeArrayItems(value, MAX_HOOK_JSON_ARRAY_ITEMS).map(item => {
        const normalized = sanitizeHookJsonValue(item, seen, depth + 1);
        return normalized === undefined ? null : normalized;
      });
    }

    const result: Record<string, unknown> = {};
    for (const [rawKey, child] of safeObjectEntries(value, MAX_HOOK_MODIFIED_INPUT_KEYS)) {
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
  return safeSliceTextBoundary(value, maxChars);
}

function safeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
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
    try {
      items.push(value[index]);
    } catch {
      // Skip hostile entries while preserving readable hook payload data.
    }
  }
  return items;
}

function safeObjectEntries(value: unknown, maxEntries: number): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  let keys: string[];
  try {
    keys = Object.keys(value).slice(0, Math.max(0, maxEntries));
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    const child = safeProperty(value, key);
    if (child !== undefined) entries.push([key, child]);
  }
  return entries;
}
