/** Durable task tools backed by the process task lifecycle manager. */

import { getTaskManager, type TaskType } from "../engine/task-lifecycle.js";
import { PermissionLevel, type ToolExecutionContext } from "./base.js";
import { checkCommand, isCommandReadOnly } from "./exec-policy.js";
import { getTodoState } from "./plan.js";
import { getRegistry } from "./registry.js";
import { resolvePathAlias } from "./path-resolution.js";

function parseType(value: unknown): TaskType {
  const type = typeof value === "string" ? value : "background";
  if (["bash", "agent", "remote_agent", "workflow", "monitor", "sub_task", "background"].includes(type)) {
    return type as TaskType;
  }
  return "background";
}

function commandArg(args: Record<string, unknown>): string {
  return typeof args.command === "string" ? args.command.trim() : "";
}

function normalizeTaskArgAliases(args: Record<string, unknown>): Record<string, unknown> {
  if (args.workdir !== undefined || args.cwd === undefined) return args;
  return { ...args, workdir: args.cwd };
}

function resolveWorkdir(args: Record<string, unknown>, context?: ToolExecutionContext): string {
  const base = context?.workspacePath || process.cwd();
  if (typeof args.workdir === "string" && args.workdir.trim()) return resolvePathAlias(args.workdir.trim(), base);
  if (typeof args.cwd === "string" && args.cwd.trim()) return resolvePathAlias(args.cwd.trim(), base);
  return base;
}

async function taskCreate(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  const normalized = normalizeTaskCreateArgs(normalizeTaskArgAliases(args));
  const optionError = validateTaskCreateOptionArgs(normalized);
  if (optionError) return `Error: ${optionError}`;
  const description = typeof normalized.description === "string"
    ? normalized.description.trim()
    : typeof normalized.prompt === "string"
      ? normalized.prompt.trim()
      : "";
  if (!description) return "Error: description is required.";
  if (normalized.type !== undefined) {
    if (typeof normalized.type !== "string") return "Error: type must be one of bash, agent, remote_agent, workflow, monitor, sub_task, or background.";
    if (!["bash", "agent", "remote_agent", "workflow", "monitor", "sub_task", "background"].includes(normalized.type)) {
      return "Error: type must be one of bash, agent, remote_agent, workflow, monitor, sub_task, or background.";
    }
  }
  if (normalized.command !== undefined && typeof normalized.command !== "string") return "Error: command must be a string.";
  const command = typeof normalized.command === "string" ? normalized.command.trim() : "";
  if (command) {
    const policy = checkCommand(command);
    if (policy.decision === "deny") return `Error: Command blocked by policy: ${policy.justification}`;
  }
  try {
    const timeoutMs = normalizeOptionalPositiveInt(normalized.timeout);
    const maxAttempts = normalizeOptionalPositiveInt(normalized.max_attempts);
    const task = command
      ? getTaskManager().enqueueShellTask(description, command, {
        workdir: resolveWorkdir(normalized, context),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      })
      : getTaskManager().createTask(parseType(normalized.type), description);
    if (!command) getTaskManager().startTask(task.id);
    return JSON.stringify({ id: task.id, status: task.status, type: task.type, description: task.description, queue: task.queue }, null, 2);
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
  return JSON.stringify({
    checklist,
    active,
    history: history.slice(-20),
    stats: manager.getTaskStats(),
  }, null, 2);
}

async function taskRead(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string"
    ? args.id.trim()
    : typeof args.task_id === "string"
      ? args.task_id.trim()
      : "";
  if (!id) return "Error: id is required.";
  const manager = getTaskManager();
  const task = manager.getTask(id) || manager.getHistory().find(item => item.id === id);
  return task ? JSON.stringify(task, null, 2) : `Error: task not found: ${id}`;
}

async function taskCancel(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string"
    ? args.id.trim()
    : typeof args.task_id === "string"
      ? args.task_id.trim()
      : "";
  if (!id) return "Error: id is required.";
  return getTaskManager().killTask(id) ? `Cancelled task ${id}.` : `Error: active task not found: ${id}`;
}

async function taskComplete(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string"
    ? args.id.trim()
    : typeof args.task_id === "string"
      ? args.task_id.trim()
      : "";
  if (!id) return "Error: id is required.";
  if (args.output !== undefined && typeof args.output !== "string") return "Error: output must be a string.";
  return getTaskManager().completeTask(id, args.output)
    ? `Completed task ${id}.`
    : `Error: active task not found: ${id}`;
}

async function taskFail(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string"
    ? args.id.trim()
    : typeof args.task_id === "string"
      ? args.task_id.trim()
      : "";
  if (!id) return "Error: id is required.";
  if (args.error !== undefined && typeof args.error !== "string") return "Error: error must be a string.";
  return getTaskManager().failTask(id, args.error)
    ? `Failed task ${id}.`
    : `Error: active task not found: ${id}`;
}

async function taskGateRun(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  const normalized = normalizeTaskArgAliases(args);
  const optionError = validateTaskGateOptionArgs(normalized);
  if (optionError) return `Error: ${optionError}`;
  const command = commandArg(normalized);
  if (!command) return "Error: command is required.";
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
  return JSON.stringify({
    command,
    workdir,
    passed,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(3)),
    output,
  }, null, 2);
}

function normalizeOptionalPositiveInt(value: unknown): number | undefined {
  const parsed = strictInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function validateOptionalFiniteNumber(value: unknown, key: "timeout" | "max_attempts"): string | null {
  if (value === undefined) return null;
  return strictInteger(value) !== undefined ? null : `${key} must be a number`;
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
  }
  return validateOptionalFiniteNumber(args.timeout, "timeout");
}

function validateTaskCreateOptionArgs(args: Record<string, unknown>): string | null {
  return validateTaskOptionArgs(args) || validateOptionalFiniteNumber(args.max_attempts, "max_attempts");
}

function validateTaskGateOptionArgs(args: Record<string, unknown>): string | null {
  return validateTaskOptionArgs(args);
}

function normalizeTaskCreateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const description = typeof args.description === "string"
    ? args.description.trim()
    : typeof args.prompt === "string"
      ? args.prompt.trim()
      : "";
  const type = typeof args.type === "string" ? args.type.trim() : args.type;
  const workdir = typeof args.workdir === "string" && args.workdir.trim()
    ? args.workdir.trim()
    : typeof args.cwd === "string" && args.cwd.trim()
      ? args.cwd.trim()
      : undefined;
  return {
    ...args,
    ...(description ? { description } : {}),
    ...(typeof type === "string" ? { type } : {}),
    ...(workdir ? { workdir } : {}),
  };
}

function taskDescriptionArg(args: Record<string, unknown>): string {
  if (typeof args.description === "string") return args.description.trim();
  if (typeof args.prompt === "string") return args.prompt.trim();
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
  return id
    ? { ok: true as const, args: { ...normalized, id } }
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
      if (normalized.command !== undefined && typeof normalized.command !== "string") {
        return { ok: false, message: "command must be a string" };
      }
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
      if (!commandArg(normalized)) return { ok: false, message: "command must be a non-empty string" };
      const optionError = validateTaskGateOptionArgs(normalized);
      if (optionError) return { ok: false, message: optionError };
      const workdir = typeof normalized.workdir === "string" && normalized.workdir.trim()
        ? normalized.workdir.trim()
        : typeof normalized.cwd === "string" && normalized.cwd.trim()
          ? normalized.cwd.trim()
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
