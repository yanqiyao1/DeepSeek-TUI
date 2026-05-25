/** Shell execution tool with exec policy integration. */

import { spawn } from "node:child_process";
import { PermissionLevel, type ToolExecutionContext } from "./base.js";
import { getRegistry } from "./registry.js";
import { checkCommand, isCommandReadOnly } from "./exec-policy.js";
import { formatJob, getJobManager, terminateProcessGroup } from "./jobs.js";
import { resolvePathAlias } from "./path-resolution.js";

const MAX_SHELL_OUTPUT_CHARS = 200_000;
const MAX_FOREGROUND_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_SHELL_COMMAND_CHARS = 20_000;
const MAX_SHELL_WORKDIR_CHARS = 4_096;
const MAX_SHELL_INPUT_CHARS = 50_000;
const MAX_SHELL_JOB_ID_CHARS = 80;
const JOB_ID_RE = /^job_[a-z0-9_]+$/;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function normalizeShellArgAliases(args: Record<string, unknown>): Record<string, unknown> {
  if (args.workdir !== undefined || args.cwd === undefined) return args;
  return { ...args, workdir: args.cwd };
}

function resolveWorkdir(args: Record<string, unknown>, context?: ToolExecutionContext): string {
  const base = context?.workspacePath || process.cwd();
  if (typeof args.workdir === "string" && args.workdir.trim()) return resolvePathAlias(args.workdir.trim(), base);
  if (typeof args.cwd === "string" && args.cwd.trim()) return resolvePathAlias(args.cwd.trim(), base);
  return base;
}

async function bash(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  const normalized = normalizeShellArgAliases(args);
  const optionError = validateShellStartOptions(normalized);
  if (optionError) return `Error: ${optionError}`;
  const command = commandArg(normalized);
  if (!command) return "Error: command must be a non-empty string";
  const commandError = validateShellText(command, "command", MAX_SHELL_COMMAND_CHARS);
  if (commandError) return `Error: ${commandError}`;
  const timeout = normalizeForegroundTimeout(normalized.timeout);
  const workdir = resolveWorkdir(normalized, context);
  if (normalized.background === true) {
    try {
      const timeoutMs = normalizeTimeout(normalized.timeout);
      const job = getJobManager().start(command, workdir, {
        pty: normalized.pty !== false,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      return `Started background job ${job.id} (pid ${job.pid ?? "unknown"}). Poll with exec_shell_wait or task_shell_wait.`;
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  // Check against exec policy
  const policy = checkCommand(command);
  if (policy.decision === "deny") {
    return `Error: Command blocked by policy: ${policy.justification}`;
  }
  // If policy says "ask", the mode's approval mechanism handles it
  return new Promise((resolve) => {
    try {
      const proc = spawn("bash", ["-c", command], {
        cwd: workdir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        detached: true,
      });
      let stdout = "", stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (proc.pid) terminateProcessGroup(proc.pid);
      }, timeout);
      proc.stdout.on("data", (d: Buffer) => { stdout = appendBoundedOutput(stdout, d.toString("utf-8")); });
      proc.stderr.on("data", (d: Buffer) => { stderr = appendBoundedOutput(stderr, d.toString("utf-8")); });
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        const parts: string[] = [];
        if (stdout) parts.push(stdout.trimEnd());
        if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
        if (timedOut) parts.push(`[timed out after ${timeout}ms]`);
        if (signal) parts.push(`[signal: ${signal}]`);
        parts.push(`[exit code: ${code}]`);
        resolve(parts.join("\n"));
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve(`Error executing command: ${err.message}`);
      });
    } catch (e: any) { resolve(`Error: ${e.message}`); }
  });
}

async function execShellWait(args: Record<string, unknown>): Promise<string> {
  const optionError = validateTailChars(args.tail_chars);
  if (optionError) return `Error: ${optionError}`;
  const id = jobIdArg(args);
  if (!id) return `Error: ${validateJobId(typeof args.id === "string" ? args.id.trim() : typeof args.job_id === "string" ? args.job_id.trim() : "")}`;
  const job = getJobManager().get(id);
  if (!job) return `Error: job not found: ${id}`;
  return formatJob(job, normalizeTailChars(args.tail_chars));
}

async function execShellInteract(args: Record<string, unknown>): Promise<string> {
  const id = jobIdArg(args);
  if (!id) return `Error: ${validateJobId(typeof args.id === "string" ? args.id.trim() : typeof args.job_id === "string" ? args.job_id.trim() : "")}`;
  if (typeof args.input !== "string") return "Error: input must be a string";
  const input = args.input;
  const inputError = validateShellText(input, "input", MAX_SHELL_INPUT_CHARS, false);
  if (inputError) return `Error: ${inputError}`;
  const ok = getJobManager().write(id, input);
  return ok ? `Sent ${input.length} byte(s) to ${id}.` : `Error: job is not running or not found: ${id}`;
}

async function execShellCancel(args: Record<string, unknown>): Promise<string> {
  const id = jobIdArg(args);
  if (!id) return `Error: ${validateJobId(typeof args.id === "string" ? args.id.trim() : typeof args.job_id === "string" ? args.job_id.trim() : "")}`;
  return getJobManager().cancel(id) ? `Cancelled job ${id}.` : `Error: job is not running or not found: ${id}`;
}

async function taskShellStart(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  return bash({ ...args, background: true }, context);
}

function normalizeTimeout(value: unknown): number | undefined {
  const timeout = strictNumber(value);
  return timeout !== undefined && timeout > 0 ? Math.min(Math.floor(timeout), MAX_FOREGROUND_TIMEOUT_MS) : undefined;
}

function normalizeForegroundTimeout(value: unknown): number {
  const timeout = normalizeTimeout(value);
  return timeout === undefined ? 120_000 : Math.min(timeout, MAX_FOREGROUND_TIMEOUT_MS);
}

function normalizeTailChars(value: unknown): number {
  const parsed = strictNumber(value);
  return parsed !== undefined && parsed > 0 ? Math.min(Math.floor(parsed), MAX_SHELL_OUTPUT_CHARS) : 4000;
}

function commandArg(args: Record<string, unknown>): string {
  if (typeof args.command !== "string") return "";
  return args.command.trim();
}

function validateOptionalFiniteNumber(value: unknown, key: "timeout" | "tail_chars"): string | null {
  if (value === undefined) return null;
  return strictNumber(value) !== undefined ? null : `${key} must be a number`;
}

function strictNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[-+]?\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validateOptionalBoolean(value: unknown, key: "background" | "pty"): string | null {
  if (value === undefined) return null;
  return typeof value === "boolean" ? null : `${key} must be a boolean`;
}

function validateShellStartOptions(args: Record<string, unknown>): string | null {
  for (const key of ["workdir", "cwd"] as const) {
    const value = args[key];
    if (value !== undefined && typeof value !== "string") return `${key} must be a string`;
    if (typeof value === "string") {
      const textError = validateShellText(value.trim(), key, MAX_SHELL_WORKDIR_CHARS, false);
      if (textError) return textError;
    }
  }
  return validateOptionalFiniteNumber(args.timeout, "timeout")
    || validateOptionalBoolean(args.background, "background")
    || validateOptionalBoolean(args.pty, "pty");
}

function validateTailChars(value: unknown): string | null {
  return validateOptionalFiniteNumber(value, "tail_chars");
}

function validateCommand(args: Record<string, unknown>) {
  const normalized = normalizeShellArgAliases(args);
  const command = commandArg(normalized);
  if (!command) return { ok: false as const, message: "command must be a non-empty string" };
  const commandError = validateShellText(command, "command", MAX_SHELL_COMMAND_CHARS);
  if (commandError) return { ok: false as const, message: commandError };
  const optionError = validateShellStartOptions(normalized);
  return optionError
    ? { ok: false as const, message: optionError }
    : {
        ok: true as const,
        args: {
          ...normalized,
          ...(typeof normalized.workdir === "string" && normalized.workdir.trim()
            ? { workdir: normalized.workdir.trim() }
            : {}),
          ...(normalized.workdir === undefined && typeof normalized.cwd === "string" && normalized.cwd.trim()
            ? { workdir: normalized.cwd.trim() }
            : {}),
        },
      };
}

function normalizeJobIdArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.id !== undefined || args.job_id === undefined) return args;
  return { ...args, id: args.job_id };
}

function validateJobIdArgs(args: Record<string, unknown>) {
  const normalized = normalizeJobIdArgs(args);
  const id = typeof normalized.id === "string" ? normalized.id.trim() : "";
  const idError = validateJobId(id);
  return idError
    ? { ok: false as const, message: idError }
    : { ok: true as const, args: { ...normalized, id } };
}

function jobIdArg(args: Record<string, unknown>): string | null {
  const raw = typeof args.id === "string"
    ? args.id
    : typeof args.job_id === "string"
      ? args.job_id
      : "";
  const id = raw.trim();
  return validateJobId(id) ? null : id;
}

function validateJobId(id: string): string | null {
  if (!id) return "id is required.";
  if (id.length > MAX_SHELL_JOB_ID_CHARS) return `id must be ${MAX_SHELL_JOB_ID_CHARS} characters or fewer.`;
  if (CONTROL_TEXT_RE.test(id)) return "id contains control characters";
  if (!JOB_ID_RE.test(id)) return "id contains invalid characters";
  return null;
}

function validateShellText(value: string, key: "command" | "workdir" | "cwd" | "input", maxChars: number, requireNonEmpty = true): string | null {
  if (requireNonEmpty && !value.trim()) return `${key} must be a non-empty string`;
  if (value.length > maxChars) return `${key} is too long`;
  if (CONTROL_TEXT_RE.test(value)) return `${key} contains control characters`;
  return null;
}

function appendBoundedOutput(existing: string, next: string): string {
  const combined = `${existing}${next}`.replace(CONTROL_TEXT_GLOBAL_RE, " ");
  return combined.length > MAX_SHELL_OUTPUT_CHARS ? combined.slice(combined.length - MAX_SHELL_OUTPUT_CHARS) : combined;
}

function shellPermissions(args: Record<string, unknown>) {
  const command = commandArg(args);
  const commandError = command ? validateShellText(command, "command", MAX_SHELL_COMMAND_CHARS) : "command must be a non-empty string";
  if (commandError) {
    return { decision: "deny" as const, reason: commandError, description: `Invalid shell command: ${commandError}` };
  }
  const policy = checkCommand(command);
  if (policy.decision === "allow") {
    return { decision: "allow" as const, description: `Read-only shell command: ${command}` };
  }
  if (policy.decision === "deny") {
    return { decision: "deny" as const, reason: policy.justification, description: `Blocked shell command: ${command}` };
  }
  return { decision: "ask" as const, reason: policy.justification, description: `Shell command requires approval: ${policy.justification}` };
}

function shellSearchOrRead(args: Record<string, unknown>) {
  const command = commandArg(args);
  if (!command || validateShellText(command, "command", MAX_SHELL_COMMAND_CHARS)) {
    return { isSearch: false, isRead: false, isList: false };
  }
  const first = command.split(/\s+/)[0]?.split("/").pop() || "";
  return {
    isSearch: ["grep", "egrep", "fgrep", "rg", "find"].includes(first),
    isRead: ["cat", "head", "tail", "wc", "stat", "file", "git"].includes(first),
    isList: ["ls", "find", "du"].includes(first),
  };
}

function matchShellPattern(pattern: string, command: string): boolean {
  const trimmedPattern = pattern.trim();
  const trimmedCommand = command.trim();
  if (!trimmedPattern) return false;
  const regexStr = "^" + trimmedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".") + "$";
  try {
    return new RegExp(regexStr, "i").test(trimmedCommand);
  } catch {
    return trimmedPattern === trimmedCommand;
  }
}

function shellActivity(action: string) {
  return (args: Record<string, unknown>) => {
    const command = commandArg(args);
    return command ? `${action} ${command}` : `${action} command`;
  };
}

function shellSummary(args: Record<string, unknown>): string {
  const command = commandArg(args);
  return command ? `Shell ${command}` : "Shell command";
}

function shellReadOnly(args: Record<string, unknown>): boolean {
  const command = commandArg(args);
  return Boolean(command && !validateShellText(command, "command", MAX_SHELL_COMMAND_CHARS) && isCommandReadOnly(command));
}

function shellDestructive(args: Record<string, unknown>): boolean {
  const command = commandArg(args);
  return Boolean(!command || validateShellText(command, "command", MAX_SHELL_COMMAND_CHARS) || checkCommand(command).decision === "deny");
}

export function registerShellTool(): void {
  const r = getRegistry();
  r.register({
    name: "bash", description: "Execute a shell command. Returns stdout, stderr, exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer", default: 120000 },
        workdir: { type: "string", default: "." },
        background: { type: "boolean", default: false },
        pty: { type: "boolean", default: true, description: "Run background command under a PTY-compatible script wrapper." },
      },
      required: ["command"],
    },
    execute: bash,
    permission: PermissionLevel.ASK,
    checkPermissions: (ctx) => shellPermissions(ctx.tool_args),
    validateInput: (args) => validateCommand(args),
    readOnly: shellReadOnly,
    destructive: shellDestructive,
    concurrencySafe: (args) => shellReadOnly(args) && args.background !== true,
    searchHint: "run shell command",
    resultKind: "text",
    isSearchOrReadCommand: shellSearchOrRead,
    getPermissionPatterns: (args) => {
      const command = commandArg(args);
      return command ? [command] : [];
    },
    preparePermissionMatcher: (args) => {
      const command = commandArg(args);
      return (pattern) => matchShellPattern(pattern, command);
    },
    toAutoClassifierInput: (args) => commandArg(args),
    getActivityDescription: shellActivity("Running"),
    getToolUseSummary: shellSummary,
    getTranscriptSearchText: (result) => result,
    renderMetadata: { userFacingName: "Shell", icon: "terminal", resultKind: "text" },
    category: "shell",
    parallelOk: false,
  });
  r.register({
    name: "exec_shell_wait",
    description: "Poll a background shell job by id and return status plus output tail.",
    parameters: { type: "object", properties: { id: { type: "string" }, job_id: { type: "string", description: "Alias for id." }, tail_chars: { type: "integer", default: 4000 } } },
    execute: execShellWait,
    permission: PermissionLevel.ALWAYS_ALLOW,
    readOnly: true,
    validateInput: (args) => {
      const validated = validateJobIdArgs(args);
      if (!validated.ok) return validated;
      const normalizedArgs: Record<string, unknown> = validated.args;
      const optionError = validateTailChars(normalizedArgs.tail_chars);
      return optionError ? { ok: false as const, message: optionError } : validated;
    },
    searchHint: "poll background shell output",
    resultKind: "task",
    getPermissionPatterns: (args) => typeof args.id === "string" ? [args.id.trim()] : typeof args.job_id === "string" ? [args.job_id.trim()] : [],
    getToolUseSummary: (args) => `Poll ${typeof args.id === "string" ? args.id.trim() : typeof args.job_id === "string" ? args.job_id.trim() : "job"}`,
    getTranscriptSearchText: (result) => result,
    renderMetadata: { userFacingName: "Shell output", icon: "terminal", resultKind: "task" },
    category: "shell",
    parallelOk: true,
  });
  r.register({
    name: "exec_shell_interact",
    description: "Send stdin to a running background shell job.",
    parameters: { type: "object", properties: { id: { type: "string" }, job_id: { type: "string", description: "Alias for id." }, input: { type: "string" } }, required: ["input"] },
    execute: execShellInteract,
    permission: PermissionLevel.ASK,
    validateInput: (args) => {
      const validated = validateJobIdArgs(args);
      if (!validated.ok) return validated;
      const normalizedArgs: Record<string, unknown> = validated.args;
      if (typeof normalizedArgs.input !== "string") return { ok: false, message: "input must be a string" };
      const inputError = validateShellText(normalizedArgs.input, "input", MAX_SHELL_INPUT_CHARS, false);
      return inputError ? { ok: false as const, message: inputError } : validated;
    },
    searchHint: "send stdin to job",
    resultKind: "task",
    getPermissionPatterns: (args) => typeof args.id === "string" ? [args.id.trim()] : typeof args.job_id === "string" ? [args.job_id.trim()] : [],
    getToolUseSummary: (args) => `Send input to ${typeof args.id === "string" ? args.id.trim() : typeof args.job_id === "string" ? args.job_id.trim() : "job"}`,
    toAutoClassifierInput: (args) => ({ job: typeof args.id === "string" ? args.id : args.job_id, input: args.input }),
    renderMetadata: { userFacingName: "Shell input", icon: "terminal", resultKind: "task" },
    category: "shell",
    parallelOk: false,
    deferLoading: true,
  });
  r.register({
    name: "exec_shell_cancel",
    description: "Cancel a running background shell job by id.",
    parameters: { type: "object", properties: { id: { type: "string" }, job_id: { type: "string", description: "Alias for id." } } },
    execute: execShellCancel,
    permission: PermissionLevel.ASK,
    destructive: true,
    validateInput: validateJobIdArgs,
    searchHint: "cancel shell job",
    resultKind: "task",
    getPermissionPatterns: (args) => typeof args.id === "string" ? [args.id.trim()] : typeof args.job_id === "string" ? [args.job_id.trim()] : [],
    getToolUseSummary: (args) => `Cancel ${typeof args.id === "string" ? args.id.trim() : typeof args.job_id === "string" ? args.job_id.trim() : "job"}`,
    toAutoClassifierInput: (args) => ({ cancel_job: typeof args.id === "string" ? args.id : args.job_id }),
    renderMetadata: { userFacingName: "Cancel shell", icon: "x-circle", resultKind: "task" },
    category: "shell",
    parallelOk: true,
  });
  r.register({
    name: "task_shell_start",
    description: "Start a long-running shell command in the background and return immediately.",
    parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string", default: "." }, timeout: { type: "integer", default: 120000 }, pty: { type: "boolean", default: true } }, required: ["command"] },
    execute: taskShellStart,
    permission: PermissionLevel.ASK,
    validateInput: (args) => validateCommand(args),
    readOnly: shellReadOnly,
    destructive: shellDestructive,
    searchHint: "start background shell command",
    resultKind: "task",
    isSearchOrReadCommand: shellSearchOrRead,
    getPermissionPatterns: (args) => {
      const command = commandArg(args);
      return command ? [command] : [];
    },
    preparePermissionMatcher: (args) => {
      const command = commandArg(args);
      return (pattern) => matchShellPattern(pattern, command);
    },
    toAutoClassifierInput: (args) => commandArg(args),
    getActivityDescription: shellActivity("Starting"),
    getToolUseSummary: shellSummary,
    getTranscriptSearchText: (result) => result,
    renderMetadata: { userFacingName: "Background shell", icon: "terminal", resultKind: "task" },
    category: "shell",
    parallelOk: true,
  });
  r.register({
    name: "task_shell_wait",
    description: "Poll a long-running task shell job by id.",
    parameters: { type: "object", properties: { id: { type: "string" }, job_id: { type: "string", description: "Alias for id." }, tail_chars: { type: "integer", default: 4000 } } },
    execute: execShellWait,
    permission: PermissionLevel.ALWAYS_ALLOW,
    readOnly: true,
    validateInput: (args) => {
      const validated = validateJobIdArgs(args);
      if (!validated.ok) return validated;
      const normalizedArgs: Record<string, unknown> = validated.args;
      const optionError = validateTailChars(normalizedArgs.tail_chars);
      return optionError ? { ok: false as const, message: optionError } : validated;
    },
    searchHint: "poll task shell output",
    resultKind: "task",
    getPermissionPatterns: (args) => typeof args.id === "string" ? [args.id.trim()] : typeof args.job_id === "string" ? [args.job_id.trim()] : [],
    getToolUseSummary: (args) => `Poll ${typeof args.id === "string" ? args.id.trim() : typeof args.job_id === "string" ? args.job_id.trim() : "task shell"}`,
    getTranscriptSearchText: (result) => result,
    renderMetadata: { userFacingName: "Task shell output", icon: "terminal", resultKind: "task" },
    category: "shell",
    parallelOk: true,
  });
}
