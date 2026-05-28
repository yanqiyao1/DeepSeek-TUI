/** Durable task tools backed by the process task lifecycle manager. */

import { getTaskManager, type TaskType } from "../engine/task-lifecycle.js";
import { PermissionLevel, type ToolExecutionContext } from "./base.js";
import { checkCommand, isCommandReadOnly } from "./exec-policy.js";
import { getTodoState } from "./plan.js";
import { getRegistry } from "./registry.js";
import { resolvePathAlias } from "./path-resolution.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary, safeTailTextBoundary } from "../utils/text-boundary.js";

const MAX_TASK_TOOL_ID_CHARS = 80;
const MAX_TASK_TOOL_TEXT_CHARS = 2_000;
const MAX_TASK_TOOL_COMMAND_CHARS = 20_000;
const MAX_TASK_TOOL_WORKDIR_CHARS = 4_096;
const MAX_TASK_TOOL_OUTPUT_CHARS = 200_000;
const MAX_TASK_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_TASK_TOOL_ATTEMPTS = 10;
const TASK_TOOL_CONTROL_RE = /[\u0000-\u001F\u007F]/;
const TASK_TOOL_CONTROL_GLOBAL_RE = /[\u0000-\u001F\u007F]/g;

function parseType(value: unknown): TaskType {
  const type = typeof value === "string" ? safeTaskText(value, MAX_TASK_TOOL_TEXT_CHARS) : "background";
  if (["bash", "agent", "remote_agent", "workflow", "monitor", "sub_task", "background"].includes(type)) {
    return type as TaskType;
  }
  return "background";
}

function commandArg(args: Record<string, unknown>): string {
  return typeof args.command === "string" ? safeTaskText(args.command, MAX_TASK_TOOL_COMMAND_CHARS) : "";
}

function normalizeTaskArgAliases(args: Record<string, unknown>): Record<string, unknown> {
  if (args.workdir !== undefined || args.cwd === undefined) return args;
  return { ...args, workdir: args.cwd };
}

function resolveWorkdir(args: Record<string, unknown>, context?: ToolExecutionContext): string {
  const base = context?.workspacePath || process.cwd();
  const workdir = typeof args.workdir === "string" ? safeTaskText(args.workdir, MAX_TASK_TOOL_WORKDIR_CHARS) : "";
  if (workdir) return resolvePathAlias(workdir, base);
  const cwd = typeof args.cwd === "string" ? safeTaskText(args.cwd, MAX_TASK_TOOL_WORKDIR_CHARS) : "";
  if (cwd) return resolvePathAlias(cwd, base);
  return base;
}

async function taskCreate(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  const normalized = normalizeTaskCreateArgs(normalizeTaskArgAliases(args));
  const optionError = validateTaskCreateOptionArgs(normalized);
  if (optionError) return `Error: ${optionError}`;
  const description = typeof normalized.description === "string"
    ? safeTaskText(normalized.description, MAX_TASK_TOOL_TEXT_CHARS)
    : typeof normalized.prompt === "string"
      ? safeTaskText(normalized.prompt, MAX_TASK_TOOL_TEXT_CHARS)
      : "";
  if (!description) return "Error: description is required.";
  if (normalized.type !== undefined) {
    if (typeof normalized.type !== "string") return "Error: type must be one of bash, agent, remote_agent, workflow, monitor, sub_task, or background.";
    if (!["bash", "agent", "remote_agent", "workflow", "monitor", "sub_task", "background"].includes(normalized.type)) {
      return "Error: type must be one of bash, agent, remote_agent, workflow, monitor, sub_task, or background.";
    }
  }
  const commandError = validateTaskCommandValue(normalized.command, { required: false });
  if (commandError) return `Error: ${commandError}`;
  const command = typeof normalized.command === "string" ? safeTaskText(normalized.command, MAX_TASK_TOOL_COMMAND_CHARS) : "";
  if (command) {
    const policy = checkCommand(command);
    if (policy.decision === "deny") return `Error: Command blocked by policy: ${policy.justification}`;
  }
  try {
    const timeoutMs = normalizeOptionalPositiveInt(normalized.timeout);
    const maxAttempts = normalizeMaxAttempts(normalized.max_attempts);
    const task = command
      ? getTaskManager().enqueueShellTask(description, command, {
        workdir: resolveWorkdir(normalized, context),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      })
      : getTaskManager().createTask(parseType(normalized.type), description);
    if (!command) getTaskManager().startTask(task.id);
    return safeJsonStringify({ id: task.id, status: task.status, type: task.type, description: task.description, queue: task.queue }, { space: 2 });
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function taskList(): Promise<string> {
  const manager = getTaskManager();
  const active = manager.getActiveTasks();
  const history = manager.getHistory();
  const checklist = getTodoState();
  if (!active.length && !history.length && !checklist.length) return "No tasks.";
  return safeJsonStringify({
    checklist,
    active,
    history: history.slice(-20),
    stats: manager.getTaskStats(),
  }, { space: 2 });
}

async function taskRead(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string"
    ? normalizeTaskToolId(args.id)
    : typeof args.task_id === "string"
      ? normalizeTaskToolId(args.task_id)
      : "";
  if (!id) return "Error: id is required.";
  const manager = getTaskManager();
  const task = manager.getTask(id) || manager.getHistory().find(item => item.id === id);
  return task ? safeJsonStringify(task, { space: 2 }) : `Error: task not found: ${id}`;
}

async function taskCancel(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string"
    ? normalizeTaskToolId(args.id)
    : typeof args.task_id === "string"
      ? normalizeTaskToolId(args.task_id)
      : "";
  if (!id) return "Error: id is required.";
  return getTaskManager().killTask(id) ? `Cancelled task ${id}.` : `Error: active task not found: ${id}`;
}

async function taskComplete(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string"
    ? normalizeTaskToolId(args.id)
    : typeof args.task_id === "string"
      ? normalizeTaskToolId(args.task_id)
      : "";
  if (!id) return "Error: id is required.";
  if (args.output !== undefined && typeof args.output !== "string") return "Error: output must be a string.";
  const output = typeof args.output === "string" ? safeTaskValueText(args.output, MAX_TASK_TOOL_OUTPUT_CHARS, true) : undefined;
  return getTaskManager().completeTask(id, output)
    ? `Completed task ${id}.`
    : `Error: active task not found: ${id}`;
}

async function taskFail(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string"
    ? normalizeTaskToolId(args.id)
    : typeof args.task_id === "string"
      ? normalizeTaskToolId(args.task_id)
      : "";
  if (!id) return "Error: id is required.";
  if (args.error !== undefined && typeof args.error !== "string") return "Error: error must be a string.";
  const error = typeof args.error === "string" ? safeTaskValueText(args.error, MAX_TASK_TOOL_OUTPUT_CHARS, true) : undefined;
  return getTaskManager().failTask(id, error)
    ? `Failed task ${id}.`
    : `Error: active task not found: ${id}`;
}

async function taskGateRun(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  const normalized = normalizeTaskArgAliases(args);
  const optionError = validateTaskGateOptionArgs(normalized);
  if (optionError) return `Error: ${optionError}`;
  const commandError = validateTaskCommandValue(normalized.command, { required: true });
  if (commandError) return `Error: ${commandError}`;
  const command = commandArg(normalized);
  const { getRegistry } = await import("./registry.js");
  const bash = getRegistry().lookup("bash");
  if (!bash) return "Error: bash tool is unavailable.";
  const started = Date.now();
  const workdir = resolveWorkdir(normalized, context);
  const output = await bash.execute({
    command,
    workdir,
    timeout: normalizeOptionalPositiveInt(normalized.timeout) ?? 120_000,
  }, context);
  const passed = /\[exit code: 0\]\s*$/m.test(output);
  return safeJsonStringify({
    command,
    workdir,
    passed,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(3)),
    output,
  }, { space: 2 });
}

function normalizeOptionalPositiveInt(value: unknown): number | undefined {
  const parsed = strictInteger(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return Math.min(parsed, MAX_TASK_TOOL_TIMEOUT_MS);
}

function normalizeMaxAttempts(value: unknown): number | undefined {
  const parsed = strictInteger(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return Math.min(parsed, MAX_TASK_TOOL_ATTEMPTS);
}

function validateOptionalFiniteNumber(value: unknown, key: "timeout" | "max_attempts"): string | null {
  if (value === undefined) return null;
  const parsed = strictInteger(value);
  if (parsed === undefined) return `${key} must be a number`;
  if (parsed <= 0) return `${key} must be a positive integer`;
  if (key === "timeout" && parsed > MAX_TASK_TOOL_TIMEOUT_MS) return `${key} must be at most ${MAX_TASK_TOOL_TIMEOUT_MS}`;
  if (key === "max_attempts" && parsed > MAX_TASK_TOOL_ATTEMPTS) return `${key} must be at most ${MAX_TASK_TOOL_ATTEMPTS}`;
  return null;
}

function strictInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[-+]?\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validateTaskOptionArgs(args: Record<string, unknown>): string | null {
  for (const key of ["workdir", "cwd"] as const) {
    const value = args[key];
    if (value !== undefined && typeof value !== "string") return `${key} must be a string`;
    if (typeof value === "string" && TASK_TOOL_CONTROL_RE.test(value)) return `${key} contains control characters`;
    if (typeof value === "string" && value.trim().length > MAX_TASK_TOOL_WORKDIR_CHARS) return `${key} is too long`;
  }
  return validateOptionalFiniteNumber(args.timeout, "timeout");
}

function validateTaskCreateOptionArgs(args: Record<string, unknown>): string | null {
  return validateTaskOptionArgs(args) || validateOptionalFiniteNumber(args.max_attempts, "max_attempts");
}

function validateTaskGateOptionArgs(args: Record<string, unknown>): string | null {
  return validateTaskOptionArgs(args);
}

function validateTaskCommandValue(value: unknown, options: { required: boolean }): string | null {
  if (value === undefined) return options.required ? "command must be a non-empty string" : null;
  if (typeof value !== "string") return "command must be a string";
  const trimmed = value.trim();
  if (!trimmed) return "command must be a non-empty string";
  if (TASK_TOOL_CONTROL_RE.test(value)) return "command contains control characters";
  if (trimmed.length > MAX_TASK_TOOL_COMMAND_CHARS) return "command is too long";
  return null;
}

function normalizeTaskCreateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const description = typeof args.description === "string"
    ? safeTaskText(args.description, MAX_TASK_TOOL_TEXT_CHARS)
    : typeof args.prompt === "string"
      ? safeTaskText(args.prompt, MAX_TASK_TOOL_TEXT_CHARS)
      : "";
  const type = typeof args.type === "string" ? safeTaskText(args.type, MAX_TASK_TOOL_TEXT_CHARS) : args.type;
  const workdir = typeof args.workdir === "string" && safeTaskText(args.workdir, MAX_TASK_TOOL_WORKDIR_CHARS)
    ? safeTaskText(args.workdir, MAX_TASK_TOOL_WORKDIR_CHARS)
    : typeof args.cwd === "string" && safeTaskText(args.cwd, MAX_TASK_TOOL_WORKDIR_CHARS)
      ? safeTaskText(args.cwd, MAX_TASK_TOOL_WORKDIR_CHARS)
      : undefined;
  return {
    ...args,
    ...(description ? { description } : {}),
    ...(typeof type === "string" ? { type } : {}),
    ...(workdir ? { workdir } : {}),
  };
}

function taskDescriptionArg(args: Record<string, unknown>): string {
  if (typeof args.description === "string") return safeTaskText(args.description, MAX_TASK_TOOL_TEXT_CHARS);
  if (typeof args.prompt === "string") return safeTaskText(args.prompt, MAX_TASK_TOOL_TEXT_CHARS);
  return "";
}

function validateTaskType(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return "type must be one of bash, agent, remote_agent, workflow, monitor, sub_task, or background";
  return ["bash", "agent", "remote_agent", "workflow", "monitor", "sub_task", "background"].includes(value)
    ? null
    : "type must be one of bash, agent, remote_agent, workflow, monitor, sub_task, or background";
}

function normalizeTaskIdArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.id !== undefined || args.task_id === undefined) return args;
  return { ...args, id: args.task_id };
}

function validateTaskIdArgs(args: Record<string, unknown>) {
  const normalized = normalizeTaskIdArgs(args);
  const id = typeof normalized.id === "string" ? normalized.id.trim() : "";
  const safeId = normalizeTaskToolId(id);
  return id
    ? safeId
      ? { ok: true as const, args: { ...normalized, id: safeId } }
      : { ok: false as const, message: "id is required" }
    : { ok: false as const, message: "id is required" };
}

function validateTaskIdWithOptionalString(key: "output" | "error") {
  return (args: Record<string, unknown>) => {
    const validated = validateTaskIdArgs(args);
    if (!validated.ok) return validated;
    const normalizedArgs: Record<string, unknown> = validated.args;
    const value = normalizedArgs[key];
    return value === undefined || typeof value === "string"
      ? validated
      : { ok: false as const, message: `${key} must be a string` };
  };
}

function normalizeTaskToolId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed
    && trimmed.length <= MAX_TASK_TOOL_ID_CHARS
    && /^[A-Za-z0-9_-]+$/.test(trimmed)
    && !TASK_TOOL_CONTROL_RE.test(trimmed)
    ? trimmed
    : "";
}

function safeTaskText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars || TASK_TOOL_CONTROL_RE.test(trimmed)) return "";
  return trimmed;
}

function safeTaskValueText(value: string, maxChars: number, keepTail = false): string {
  const sanitized = value.replace(TASK_TOOL_CONTROL_GLOBAL_RE, " ");
  if (sanitized.length <= maxChars) return sanitized;
  return keepTail ? safeTailTextBoundary(sanitized, maxChars) : safeSliceTextBoundary(sanitized, maxChars);
}

export function registerTaskTools(): void {
  const registry = getRegistry();
  registry.register({
    name: "task_create",
    description: "Create a durable task record for long-running agent work.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string", description: "Alias for description." },
        type: { type: "string", enum: ["bash", "agent", "remote_agent", "workflow", "monitor", "sub_task", "background"], default: "background" },
        command: { type: "string", description: "Optional shell command to enqueue and execute durably." },
        workdir: { type: "string", default: "." },
        timeout: { type: "integer", default: 120000 },
        max_attempts: { type: "integer", default: 1 },
      },
    },
    execute: taskCreate,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "task",
    parallelOk: true,
    checkPermissions: (ctx) => {
      const command = commandArg(ctx.tool_args);
      if (!command) return { decision: "allow" };
      const policy = checkCommand(command);
      if (policy.decision === "allow") return { decision: "allow" };
      if (policy.decision === "deny") return { decision: "deny", reason: policy.justification };
      return { decision: "ask", reason: policy.justification, description: `Task command requires approval: ${policy.justification}` };
    },
    searchHint: "create durable task",
    resultKind: "task",
    readOnly: false,
    validateInput: (args) => {
      const normalized = normalizeTaskCreateArgs(normalizeTaskArgAliases(args));
      if (!taskDescriptionArg(normalized)) return { ok: false, message: "description is required" };
      const typeError = validateTaskType(normalized.type);
      if (typeError) return { ok: false, message: typeError };
      const commandError = validateTaskCommandValue(normalized.command, { required: false });
      if (commandError) return { ok: false, message: commandError };
      const optionError = validateTaskCreateOptionArgs(normalized);
      if (optionError) return { ok: false, message: optionError };
      return { ok: true, args: normalized };
    },
  });
  registry.register({
    name: "task_list",
    description: "List active and recently completed durable tasks.",
    parameters: { type: "object", properties: {} },
    execute: taskList,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "task",
    parallelOk: true,
    readOnly: true,
    searchHint: "list durable tasks",
    resultKind: "task",
  });
  registry.register({
    name: "task_read",
    description: "Read a durable task by id.",
    parameters: { type: "object", properties: { id: { type: "string" }, task_id: { type: "string", description: "Alias for id." } } },
    execute: taskRead,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "task",
    parallelOk: true,
    readOnly: true,
    validateInput: validateTaskIdArgs,
    searchHint: "read durable task",
    resultKind: "task",
  });
  registry.register({
    name: "task_cancel",
    description: "Cancel an active durable task by id.",
    parameters: { type: "object", properties: { id: { type: "string" }, task_id: { type: "string", description: "Alias for id." } } },
    execute: taskCancel,
    permission: PermissionLevel.ASK,
    category: "task",
    parallelOk: true,
    destructive: true,
    validateInput: validateTaskIdArgs,
    searchHint: "cancel durable task",
    resultKind: "task",
  });
  registry.register({
    name: "task_complete",
    description: "Mark an active durable task as completed.",
    parameters: { type: "object", properties: { id: { type: "string" }, task_id: { type: "string", description: "Alias for id." }, output: { type: "string" } } },
    execute: taskComplete,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "task",
    parallelOk: true,
    validateInput: validateTaskIdWithOptionalString("output"),
    searchHint: "complete durable task",
    resultKind: "task",
  });
  registry.register({
    name: "task_fail",
    description: "Mark an active durable task as failed.",
    parameters: { type: "object", properties: { id: { type: "string" }, task_id: { type: "string", description: "Alias for id." }, error: { type: "string" } } },
    execute: taskFail,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "task",
    parallelOk: true,
    validateInput: validateTaskIdWithOptionalString("error"),
    searchHint: "mark task failed",
    resultKind: "task",
  });
  registry.register({
    name: "task_gate_run",
    description: "Run a verification command and return structured gate evidence.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string", default: "." },
        timeout: { type: "integer", default: 120000 },
      },
      required: ["command"],
    },
    execute: taskGateRun,
    permission: PermissionLevel.ASK,
    category: "task",
    parallelOk: false,
    checkPermissions: (ctx) => {
      const command = commandArg(ctx.tool_args);
      if (!command) return { decision: "allow" };
      const policy = checkCommand(command);
      if (policy.decision === "allow") return { decision: "allow" };
      if (policy.decision === "deny") return { decision: "deny", reason: policy.justification };
      return { decision: "ask", reason: policy.justification, description: `Task command requires approval: ${policy.justification}` };
    },
    validateInput: (args) => {
      const normalized = normalizeTaskArgAliases(args);
      const commandError = validateTaskCommandValue(normalized.command, { required: true });
      if (commandError) return { ok: false, message: commandError };
      const optionError = validateTaskGateOptionArgs(normalized);
      if (optionError) return { ok: false, message: optionError };
      const workdir = typeof normalized.workdir === "string" && normalized.workdir.trim()
        ? safeTaskText(normalized.workdir, MAX_TASK_TOOL_WORKDIR_CHARS)
        : typeof normalized.cwd === "string" && normalized.cwd.trim()
          ? safeTaskText(normalized.cwd, MAX_TASK_TOOL_WORKDIR_CHARS)
          : undefined;
      return {
        ok: true,
        args: {
          ...normalized,
          ...(workdir ? { workdir } : {}),
        },
      };
    },
    readOnly: (args) => isCommandReadOnly(commandArg(args)),
    destructive: (args) => checkCommand(commandArg(args)).decision === "deny",
    searchHint: "run verification gate",
    resultKind: "task",
  });
}
