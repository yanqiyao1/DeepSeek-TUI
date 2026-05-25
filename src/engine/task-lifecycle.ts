/** Task lifecycle system with typed tasks, smart IDs, and terminal state tracking.
 *
 * Adopted from claude-code-rev: supports 7 task types with proper lifecycle
 * management, cryptographically random IDs, duration tracking, and
 * terminal-status detection for cleanup/dispatch.
 */

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkCommand } from "../tools/exec-policy.js";
import { createArtifact, linkArtifact } from "../artifacts/store.js";
import { seekcodeDataPath } from "../paths.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { canonicalizePathOrNearestExisting, isPathInsideRoot as isCanonicalPathInsideRoot } from "../tools/path-resolution.js";
import { terminateProcessGroup } from "../tools/jobs.js";

// ── Types ────────────────────────────────────────────────────

export type TaskType =
  | "bash"
  | "agent"
  | "remote_agent"
  | "workflow"
  | "monitor"
  | "sub_task"
  | "background";

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed";

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

export function isActiveStatus(status: TaskStatus): boolean {
  return status === "pending" || status === "running";
}

// ── Task ID ──────────────────────────────────────────────────

const TASK_ID_PREFIXES: Record<TaskType, string> = {
  bash: "b",
  agent: "a",
  remote_agent: "r",
  workflow: "w",
  monitor: "m",
  sub_task: "s",
  background: "bg",
};

// Case-insensitive-safe alphabet: digits + lowercase = 36 chars.
// 36^8 ≈ 2.8 trillion combinations.
const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const VALID_TASK_TYPES = new Set<TaskType>(["bash", "agent", "remote_agent", "workflow", "monitor", "sub_task", "background"]);
const VALID_TASK_STATUSES = new Set<TaskStatus>(["pending", "running", "completed", "failed", "killed"]);
const MAX_TASK_ID_LENGTH = 80;
const MAX_TASK_HISTORY = 500;
const MAX_TASK_TEXT_CHARS = 2_000;
const MAX_TASK_OUTPUT_CHARS = 200_000;
const MAX_TASK_COMMAND_CHARS = 20_000;
const MAX_TASK_WORKDIR_CHARS = 4_096;
const MAX_TASK_ARTIFACT_IDS = 500;
const MAX_TASK_ARTIFACT_ID_CHARS = 256;
const MAX_TASK_STORE_BYTES = 5_000_000;
const MAX_TASK_OUTPUT_FILE_BYTES = 2_000_000;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const VALID_SIGNALS = new Set<string>([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGPOLL",
  "SIGPWR",
  "SIGSYS",
]);

export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIXES[type] || "x";
  const bytes = randomBytes(8);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length];
  }
  return id;
}

// ── Task Record ──────────────────────────────────────────────

export interface TaskRecord {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  toolUseId?: string;
  agentId?: string;
  startTime: number;
  endTime?: number;
  totalPausedMs?: number;
  /** The output accumulated so far */
  output?: string;
  outputFile?: string;
  artifactIds?: string[];
  /** Whether the user has been notified of completion */
  notified: boolean;
  /** Progress events for this task */
  progress?: TaskProgress;
  /** Resumable queue payload. Currently supports shell commands. */
  queue?: TaskQueueSpec;
  attempts?: number;
  maxAttempts?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface TaskProgress {
  type: TaskType;
  percent?: number;
  message?: string;
  lastUpdate: number;
}

export interface TaskQueueSpec {
  kind: "shell";
  command: string;
  workdir: string;
  timeoutMs?: number;
}

// ── Task Manager ─────────────────────────────────────────────

export class TaskManager {
  private tasks: Map<string, TaskRecord> = new Map();
  private taskHistory: TaskRecord[] = []; // completed/failed/killed
  private maxHistory = 100;
  private dataFile: string | null;
  private workers: Map<string, ChildProcess> = new Map();

  constructor(dataFile = defaultTaskStoreFile()) {
    this.dataFile = dataFile;
    this.load();
  }

  createTask(
    type: TaskType,
    description: string,
    options?: {
      toolUseId?: string;
      agentId?: string;
      queue?: TaskQueueSpec;
      attempts?: number;
      maxAttempts?: number;
      outputFile?: string;
    },
  ): TaskRecord {
    const taskType = normalizeTaskTypeForWrite(type);
    const taskDescription = normalizeTaskText(description, "description");
    const queue = options?.queue !== undefined ? normalizeTaskQueueForWrite(options.queue) : undefined;
    const attempts = options?.attempts !== undefined ? normalizeOptionalNonNegativeIntegerForWrite(options.attempts, "attempts") : undefined;
    const maxAttempts = options?.maxAttempts !== undefined ? normalizeOptionalPositiveIntegerForWrite(options.maxAttempts, "maxAttempts") : undefined;
    const id = generateTaskId(taskType);
    const task: TaskRecord = {
      id,
      type: taskType,
      status: "pending",
      description: taskDescription,
      startTime: Date.now(),
      notified: false,
    };
    if (options?.toolUseId !== undefined) task.toolUseId = normalizeOptionalTaskText(options.toolUseId, "toolUseId");
    if (options?.agentId !== undefined) task.agentId = normalizeOptionalTaskText(options.agentId, "agentId");
    if (queue !== undefined) task.queue = queue;
    if (attempts !== undefined) task.attempts = attempts;
    if (maxAttempts !== undefined) task.maxAttempts = maxAttempts;
    if (options?.outputFile !== undefined) {
      const outputFile = this.safeOutputFile(options.outputFile);
      if (outputFile) task.outputFile = outputFile;
    }
    this.tasks.set(id, task);
    this.persist();
    return task;
  }

  enqueueShellTask(
    description: string,
    command: string,
    options?: { workdir?: string; timeoutMs?: number; maxAttempts?: number },
  ): TaskRecord {
    const taskDescription = normalizeTaskText(description, "description");
    const shellCommand = normalizeTaskText(command, "command");
    const workdir = normalizeTaskPathText(options?.workdir || ".", "workdir");
    const timeoutMs = options?.timeoutMs !== undefined ? normalizeOptionalPositiveIntegerForWrite(options.timeoutMs, "timeoutMs") : undefined;
    const maxAttempts = normalizeOptionalPositiveIntegerForWrite(options?.maxAttempts || 1, "maxAttempts");
    const policy = checkCommand(shellCommand);
    if (policy.decision === "deny") {
      throw new Error(`Command blocked by policy: ${policy.justification}`);
    }
    const outputFile = this.taskOutputFile();
    const task = this.createTask("bash", taskDescription, {
      queue: {
        kind: "shell",
        command: shellCommand,
        workdir,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      attempts: 0,
      maxAttempts,
      ...(outputFile !== undefined ? { outputFile } : {}),
    });
    this.runQueue();
    return task;
  }

  startTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "pending") return false;
    task.status = "running";
    task.startTime = Date.now();
    this.persist();
    return true;
  }

  completeTask(taskId: string, output?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !isActiveStatus(task.status)) return false;
    task.status = "completed";
    task.endTime = Date.now();
    if (output) task.output = appendTaskOutput(undefined, output);
    this.archiveTask(task);
    this.persist();
    return true;
  }

  failTask(taskId: string, error?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !isActiveStatus(task.status)) return false;
    task.status = "failed";
    task.endTime = Date.now();
    if (error) task.output = appendTaskOutput(undefined, error);
    this.archiveTask(task);
    this.persist();
    return true;
  }

  killTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalStatus(task.status)) return false;
    const worker = this.workers.get(taskId);
    if (worker) {
      killChildProcessGroup(worker);
      this.workers.delete(taskId);
    }
    task.status = "killed";
    task.endTime = Date.now();
    this.archiveTask(task);
    this.persist();
    return true;
  }

  updateProgress(taskId: string, progress: TaskProgress): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !isActiveStatus(task.status)) return false;
    task.progress = normalizeTaskProgressForWrite(progress);
    this.persist();
    return true;
  }

  setNotified(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.notified = true;
    this.persist();
  }

  private archiveTask(task: TaskRecord): void {
    this.tasks.delete(task.id);
    this.taskHistory.push(task);
    if (this.taskHistory.length > this.maxHistory) {
      this.taskHistory = this.taskHistory.slice(-this.maxHistory);
    }
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  getActiveTasks(): TaskRecord[] {
    return [...this.tasks.values()].filter(t => isActiveStatus(t.status));
  }

  getTasksByType(type: TaskType): TaskRecord[] {
    return [...this.tasks.values()].filter(t => t.type === type);
  }

  getHistory(): TaskRecord[] {
    return [...this.taskHistory];
  }

  getTaskStats(): TaskStats {
    const active = this.getActiveTasks();
    const byType: Partial<Record<TaskType, number>> = {};
    for (const t of active) {
      byType[t.type] = (byType[t.type] || 0) + 1;
    }
    return {
      active: active.length,
      total: this.taskHistory.length + active.length,
      completed: this.taskHistory.filter(t => t.status === "completed").length,
      failed: this.taskHistory.filter(t => t.status === "failed").length,
      killed: this.taskHistory.filter(t => t.status === "killed").length,
      byType,
    };
  }

  clear(): void {
    for (const [taskId, worker] of this.workers) {
      killChildProcessGroup(worker);
      this.workers.delete(taskId);
    }
    this.tasks.clear();
    this.taskHistory = [];
    this.persist();
  }

  private load(): void {
    if (!this.dataFile) return;
    try {
      const persisted = readSmallTextFile(this.dataFile, MAX_TASK_STORE_BYTES);
      if (persisted === null) return;
      const raw = parsePersistedTaskState(JSON.parse(persisted), dirname(this.dataFile));
      for (const task of raw.active) {
        if (task.queue && isActiveStatus(task.status)) {
          const policy = checkCommand(task.queue.command);
          if (policy.decision === "deny") {
            task.status = "failed";
            task.endTime = Date.now();
            task.output = appendTaskOutput(task.output, `Requeued command blocked by policy: ${policy.justification}`);
            this.taskHistory.push(task);
            continue;
          }
          task.status = "pending";
          delete task.endTime;
          task.output = appendTaskOutput(task.output, `${task.output ? "\n" : ""}Requeued after process restart`);
          this.tasks.set(task.id, task);
        } else if (task.status === "pending" || task.status === "running") {
          task.status = "killed";
          task.endTime = Date.now();
          task.output = appendTaskOutput(task.output, `${task.output ? "\n" : ""}Interrupted by process restart`);
          this.taskHistory.push(task);
        } else {
          this.taskHistory.push(task);
        }
      }
      this.taskHistory.push(...raw.history);
      this.taskHistory = this.taskHistory.slice(-this.maxHistory);
      queueMicrotask(() => this.runQueue());
    } catch {
      // no persisted state yet
    }
  }

  private persist(): void {
    if (!this.dataFile) return;
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true });
      writeFileSync(this.dataFile, safeJsonStringify({
        active: [...this.tasks.values()],
        history: this.taskHistory.slice(-this.maxHistory),
      }, { space: 2 }), "utf-8");
    } catch {
      // keep memory state if persistence fails
    }
  }

  private runQueue(): void {
    for (const task of this.tasks.values()) {
      if (!task.queue || task.status !== "pending" || this.workers.has(task.id)) continue;
      this.startQueuedShellTask(task);
    }
  }

  private startQueuedShellTask(task: TaskRecord): void {
    if (!task.queue || task.queue.kind !== "shell") return;
    const spec = task.queue;
    task.status = "running";
    task.startTime = Date.now();
    delete task.endTime;
    task.attempts = (task.attempts || 0) + 1;
    task.output = appendTaskOutput(task.output, `$ ${spec.command}\n`);
    this.persist();

    try {
      const proc = spawn("bash", ["-c", spec.command], {
        cwd: spec.workdir,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env },
      });
      this.workers.set(task.id, proc);
      let timeoutTimer: NodeJS.Timeout | undefined;
      let timedOut = false;
      if (spec.timeoutMs && spec.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          if (proc.pid) terminateProcessGroup(proc.pid);
          else {
            try { proc.kill("SIGTERM"); } catch { /* ignore */ }
          }
        }, spec.timeoutMs);
        timeoutTimer.unref?.();
      }
      const clearTimeoutTimer = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      };
      const append = (prefix: string, chunk: Buffer) => {
        task.output = appendTaskOutput(task.output, prefix + chunk.toString("utf-8"));
        if (task.outputFile && this.isTaskPathInsideDataRoot(task.outputFile)) {
          try {
            mkdirSync(dirname(task.outputFile), { recursive: true });
            const existingSize = existingFileSize(task.outputFile);
            if (existingSize < MAX_TASK_OUTPUT_FILE_BYTES) {
              const remaining = MAX_TASK_OUTPUT_FILE_BYTES - existingSize;
              appendFileSync(task.outputFile, (prefix + chunk.toString("utf-8")).slice(0, remaining), "utf-8");
            }
          } catch {
            // keep in-memory/persisted output if artifact write fails
          }
        }
        this.persist();
      };
      proc.stdout.on("data", data => append("", data));
      proc.stderr.on("data", data => append("[stderr] ", data));
      proc.on("error", error => {
        clearTimeoutTimer();
        this.workers.delete(task.id);
        this.finishQueuedTask(task, 1, null, `Error: ${error.message}`);
      });
      proc.on("close", (code, signal) => {
        clearTimeoutTimer();
        this.workers.delete(task.id);
        if (task.status === "killed") return;
        this.finishQueuedTask(
          task,
          code ?? (timedOut ? 124 : null),
          signal ?? (timedOut ? "SIGTERM" : null),
          timedOut && spec.timeoutMs ? `Timed out after ${spec.timeoutMs}ms` : undefined,
        );
      });
    } catch (error: any) {
      this.finishQueuedTask(task, 1, null, `Error: ${error.message}`);
    }
  }

  private finishQueuedTask(task: TaskRecord, code: number | null, signal: NodeJS.Signals | null, error?: string): void {
    task.exitCode = code;
    task.signal = signal;
    if (error) task.output = appendTaskOutput(task.output, error);
    const willRetry = code !== 0 && (task.attempts || 0) < (task.maxAttempts || 1);
    if (code !== 0 && !willRetry) {
      task.output = appendTaskOutput(task.output, `[exit code: ${code ?? "null"}${signal ? `, signal: ${signal}` : ""}]`);
    }
    if (task.output) {
      this.archiveQueuedOutput(task, code === 0 ? "completed" : willRetry ? "running" : "failed");
    }
    if (code === 0) {
      this.completeTask(task.id);
      return;
    }
    if (willRetry) {
      task.status = "pending";
      task.output = appendTaskOutput(task.output, `\nRetrying queued task (${task.attempts}/${task.maxAttempts})\n`);
      this.persist();
      queueMicrotask(() => this.runQueue());
      return;
    }
    this.failTask(task.id);
  }

  private archiveQueuedOutput(task: TaskRecord, status: TaskStatus): void {
    if (!task.output) return;
    try {
      const artifact = createArtifact({
        kind: "task_log",
        name: `${task.id}.log`,
        content: task.output,
        extension: ".log",
        metadata: { task_id: task.id, command: task.queue?.command, workdir: task.queue?.workdir },
      });
      task.artifactIds = [...new Set([...(task.artifactIds || []), artifact.id])];
      linkArtifact(artifact.id, "task", task.id, { status });
    } catch {
      // Task completion should not depend on artifact persistence.
    }
  }

  private taskOutputFile(): string | undefined {
    if (!this.dataFile) return undefined;
    return join(dirname(this.dataFile), "artifacts", `${generateTaskId("background")}.log`);
  }

  private safeOutputFile(path: string): string | undefined {
    if (!this.dataFile) return path;
    return this.isTaskPathInsideDataRoot(path) ? path : undefined;
  }

  private isTaskPathInsideDataRoot(path: string): boolean {
    return Boolean(this.dataFile && isPathInsideRoot(path, dirname(this.dataFile)));
  }
}

export interface TaskStats {
  active: number;
  total: number;
  completed: number;
  failed: number;
  killed: number;
  byType: Partial<Record<TaskType, number>>;
}

// Singleton
let taskManagerInstance: TaskManager | null = null;
export function getTaskManager(): TaskManager {
  if (!taskManagerInstance) taskManagerInstance = new TaskManager();
  return taskManagerInstance;
}
export function clearTaskManager(): void {
  taskManagerInstance?.clear();
  taskManagerInstance = null;
}

export function defaultTaskStoreFile(): string {
  const configured = firstTaskDirEnvValue();
  if (configured) return join(resolve(configured), "tasks.json");
  return seekcodeDataPath("tasks", "tasks.json");
}

export function clearPersistentTaskStateForTests(): void {
  clearTaskManager();
  try { rmSync(dirname(defaultTaskStoreFile()), { recursive: true, force: true }); } catch { /* ignore */ }
}

function parsePersistedTaskState(value: unknown, dataRoot?: string): { active: TaskRecord[]; history: TaskRecord[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { active: [], history: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    active: parsePersistedTaskList(record.active, dataRoot),
    history: parsePersistedTaskList(record.history, dataRoot),
  };
}

function parsePersistedTaskList(value: unknown, dataRoot?: string): TaskRecord[] {
  if (!Array.isArray(value)) return [];
  const parsed: TaskRecord[] = [];
  for (const item of value.slice(-MAX_TASK_HISTORY)) {
    const task = parsePersistedTask(item, dataRoot);
    if (task) parsed.push(task);
  }
  return parsed;
}

function parsePersistedTask(value: unknown, dataRoot?: string): TaskRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = safeTaskId(record.id);
  const type = parseTaskType(record.type);
  const status = parseTaskStatus(record.status);
  const description = nonEmptyString(record.description, MAX_TASK_TEXT_CHARS);
  const startTime = finiteNumber(record.startTime);
  const notified = typeof record.notified === "boolean" ? record.notified : null;
  if (!id || !type || !status || !description || startTime === null || notified === null) return null;

  const toolUseId = optionalString(record.toolUseId);
  const agentId = optionalString(record.agentId);
  const endTime = optionalFiniteNumber(record.endTime);
  const totalPausedMs = optionalFiniteNumber(record.totalPausedMs);
  const output = optionalSanitizedString(record.output, MAX_TASK_OUTPUT_CHARS, true);
  const outputFile = optionalPathInsideRoot(record.outputFile, dataRoot);
  const artifactIds = optionalStringArray(record.artifactIds);
  const progress = optionalTaskProgress(record.progress);
  const queue = optionalTaskQueue(record.queue);
  const attempts = optionalNonNegativeInteger(record.attempts);
  const maxAttempts = optionalPositiveInteger(record.maxAttempts);
  const exitCode = optionalNullableFiniteNumber(record.exitCode);
  const signal = optionalSignal(record.signal);

  if (
    toolUseId === undefined
    || agentId === undefined
    || endTime === undefined
    || totalPausedMs === undefined
    || output === undefined
    || outputFile === undefined
    || artifactIds === undefined
    || progress === undefined
    || queue === undefined
    || attempts === undefined
    || maxAttempts === undefined
    || exitCode === undefined
    || signal === undefined
  ) {
    return null;
  }

  return {
    id,
    type,
    status,
    description,
    startTime,
    notified,
    ...(toolUseId !== null ? { toolUseId } : {}),
    ...(agentId !== null ? { agentId } : {}),
    ...(endTime !== null ? { endTime } : {}),
    ...(totalPausedMs !== null ? { totalPausedMs } : {}),
    ...(output !== null ? { output } : {}),
    ...(outputFile !== null ? { outputFile } : {}),
    ...(artifactIds !== null ? { artifactIds } : {}),
    ...(progress !== null ? { progress } : {}),
    ...(queue !== null ? { queue } : {}),
    ...(attempts !== null ? { attempts } : {}),
    ...(maxAttempts !== null ? { maxAttempts } : {}),
    ...(exitCode !== null ? { exitCode } : {}),
    ...(signal !== null ? { signal } : {}),
  };
}

function parseTaskType(value: unknown): TaskType | null {
  return typeof value === "string" && VALID_TASK_TYPES.has(value as TaskType) ? value as TaskType : null;
}

function parseTaskStatus(value: unknown): TaskStatus | null {
  return typeof value === "string" && VALID_TASK_STATUSES.has(value as TaskStatus) ? value as TaskStatus : null;
}

function optionalTaskProgress(value: unknown): TaskProgress | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const type = parseTaskType(record.type);
  const lastUpdate = finiteNumber(record.lastUpdate);
  const percent = optionalProgressPercent(record.percent);
  const message = optionalSanitizedString(record.message, MAX_TASK_TEXT_CHARS);
  if (!type || lastUpdate === null || percent === undefined || message === undefined) return undefined;
  return {
    type,
    lastUpdate,
    ...(percent !== null ? { percent } : {}),
    ...(message !== null ? { message } : {}),
  };
}

function optionalTaskQueue(value: unknown): TaskQueueSpec | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "shell") return undefined;
  const command = nonEmptyString(record.command, MAX_TASK_COMMAND_CHARS);
  const workdir = nonEmptyString(record.workdir, MAX_TASK_WORKDIR_CHARS);
  const timeoutMs = optionalPositiveInteger(record.timeoutMs);
  if (!command || !workdir || timeoutMs === undefined) return undefined;
  return {
    kind: "shell",
    command,
    workdir,
    ...(timeoutMs !== null ? { timeoutMs } : {}),
  };
}

function nonEmptyString(value: unknown, maxChars = MAX_TASK_TEXT_CHARS): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxChars && !CONTROL_TEXT_RE.test(trimmed) ? trimmed : null;
}

function safeTaskId(value: unknown): string | null {
  const id = nonEmptyString(value);
  return id && id.length <= MAX_TASK_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

function optionalString(value: unknown, maxChars = MAX_TASK_TEXT_CHARS): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.length <= maxChars && !CONTROL_TEXT_RE.test(value) ? value : undefined;
}

function optionalSanitizedString(value: unknown, maxChars: number, keepTail = false): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(CONTROL_TEXT_GLOBAL_RE, " ");
  return sanitized.length > maxChars
    ? keepTail ? sanitized.slice(sanitized.length - maxChars) : sanitized.slice(0, maxChars)
    : sanitized;
}

function optionalSignal(value: unknown): NodeJS.Signals | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && VALID_SIGNALS.has(value as NodeJS.Signals) ? value as NodeJS.Signals : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return isExitCode(value) ? value : undefined;
}

function optionalNullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return isExitCode(value) ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalProgressPercent(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value.slice(0, MAX_TASK_ARTIFACT_IDS)) {
    if (typeof item !== "string") return undefined;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > MAX_TASK_ARTIFACT_ID_CHARS || CONTROL_TEXT_RE.test(trimmed)) return undefined;
    items.push(trimmed);
  }
  return [...new Set(items)];
}

function optionalPathInsideRoot(value: unknown, root?: string): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  if (!value.trim() || value.length > MAX_TASK_WORKDIR_CHARS || CONTROL_TEXT_RE.test(value)) return undefined;
  if (!root) return value;
  return isPathInsideRoot(value, root) ? value : undefined;
}

function isPathInsideRoot(path: string, root: string): boolean {
  try {
    const resolvedRoot = canonicalizePathOrNearestExisting(resolve(root));
    const resolved = canonicalizePathOrNearestExisting(path);
    return isCanonicalPathInsideRoot(resolved, resolvedRoot);
  } catch {
    return false;
  }
}

function isExitCode(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 255;
}

function appendTaskOutput(existing: string | undefined, next: string): string {
  const combined = `${existing || ""}${next}`.replace(CONTROL_TEXT_GLOBAL_RE, " ");
  return combined.length > MAX_TASK_OUTPUT_CHARS ? combined.slice(combined.length - MAX_TASK_OUTPUT_CHARS) : combined;
}

function normalizeTaskTypeForWrite(value: TaskType): TaskType {
  if (!VALID_TASK_TYPES.has(value)) {
    throw new Error("type must be one of bash, agent, remote_agent, workflow, monitor, sub_task, or background.");
  }
  return value;
}

function normalizeTaskText(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a non-empty string.`);
  const trimmed = value.trim();
  const maxChars = label === "command" ? MAX_TASK_COMMAND_CHARS : MAX_TASK_TEXT_CHARS;
  if (!trimmed || trimmed.length > maxChars || CONTROL_TEXT_RE.test(trimmed)) throw new Error(`${label} must be a non-empty string.`);
  return trimmed;
}

function normalizeTaskPathText(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TASK_WORKDIR_CHARS || CONTROL_TEXT_RE.test(trimmed)) throw new Error(`${label} must be a string.`);
  return trimmed;
}

function normalizeOptionalTaskText(value: string, label: string): string {
  return normalizeTaskText(value, label);
}

function normalizeTaskQueueForWrite(value: TaskQueueSpec): TaskQueueSpec {
  if (!value || typeof value !== "object" || value.kind !== "shell") {
    throw new Error("queue kind must be shell.");
  }
  const command = normalizeTaskText(value.command, "command");
  const workdir = normalizeTaskPathText(value.workdir, "workdir");
  const timeoutMs = value.timeoutMs !== undefined ? normalizeOptionalPositiveIntegerForWrite(value.timeoutMs, "timeoutMs") : undefined;
  return {
    kind: "shell",
    command,
    workdir,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function normalizeTaskProgressForWrite(progress: TaskProgress): TaskProgress {
  const type = normalizeTaskTypeForWrite(progress.type);
  const percent = progress.percent;
  if (percent !== undefined && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
    throw new Error("progress percent must be between 0 and 100.");
  }
  const message = progress.message !== undefined ? normalizeOptionalTaskText(progress.message, "progress message") : undefined;
  return {
    type,
    lastUpdate: Date.now(),
    ...(percent !== undefined ? { percent } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

function normalizeOptionalNonNegativeIntegerForWrite(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function normalizeOptionalPositiveIntegerForWrite(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function firstTaskDirEnvValue(): string | undefined {
  for (const key of ["SEEKCODE_TASKS_DIR", "DEEPCODE_TASKS_DIR", "DEEPSEEK_TASKS_DIR"]) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed && trimmed.length <= MAX_TASK_WORKDIR_CHARS && !CONTROL_TEXT_RE.test(trimmed)) return trimmed;
  }
  return undefined;
}

function readSmallTextFile(path: string, maxBytes: number): string | null {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > maxBytes) return null;
  return readFileSync(path, "utf-8");
}

function existingFileSize(path: string): number {
  try {
    const stats = statSync(path);
    return stats.isFile() && Number.isSafeInteger(stats.size) && stats.size > 0 ? stats.size : 0;
  } catch {
    return 0;
  }
}

function killChildProcessGroup(proc: ChildProcess): void {
  if (!proc.pid || !Number.isSafeInteger(proc.pid) || proc.pid <= 0) return;
  terminateProcessGroup(proc.pid);
}
