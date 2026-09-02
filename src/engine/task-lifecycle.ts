/** Task lifecycle system with typed tasks, smart IDs, and terminal state tracking.
 *
 * Adopted from claude-code-rev: supports 7 task types with proper lifecycle
 * management, cryptographically random IDs, duration tracking, and
 * terminal-status detection for cleanup/dispatch.
 */

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkCommand } from "../tools/exec-policy.js";
import { createArtifact, linkArtifact } from "../artifacts/store.js";
import { seekcodeDataPath } from "../paths.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary, safeTailTextBoundary, safeUtf8PrefixByBytes } from "../utils/text-boundary.js";
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
let atomicTaskWriteCounter = 0;
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
    const queueOption = safeProperty(options, "queue");
    const attemptsOption = safeProperty(options, "attempts");
    const maxAttemptsOption = safeProperty(options, "maxAttempts");
    const outputFileOption = safeProperty(options, "outputFile");
    const queue = queueOption !== undefined ? normalizeTaskQueueForWrite(queueOption as TaskQueueSpec) : undefined;
    const attempts = attemptsOption !== undefined ? normalizeOptionalNonNegativeIntegerForWrite(attemptsOption as number, "attempts") : undefined;
    const maxAttempts = maxAttemptsOption !== undefined ? normalizeOptionalPositiveIntegerForWrite(maxAttemptsOption as number, "maxAttempts") : undefined;
    const id = generateTaskId(taskType);
    const task: TaskRecord = {
      id,
      type: taskType,
      status: "pending",
      description: taskDescription,
      startTime: Date.now(),
      notified: false,
    };
    const toolUseId = safeProperty(options, "toolUseId");
    const agentId = safeProperty(options, "agentId");
    if (toolUseId !== undefined) task.toolUseId = normalizeOptionalTaskText(toolUseId as string, "toolUseId");
    if (agentId !== undefined) task.agentId = normalizeOptionalTaskText(agentId as string, "agentId");
    if (queue !== undefined) task.queue = queue;
    if (attempts !== undefined) task.attempts = attempts;
    if (maxAttempts !== undefined) task.maxAttempts = maxAttempts;
    if (outputFileOption !== undefined) {
      const outputFile = typeof outputFileOption === "string" ? this.safeOutputFile(outputFileOption) : undefined;
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
    const workdirOption = safeProperty(options, "workdir");
    const timeoutOption = safeProperty(options, "timeoutMs");
    const maxAttemptsOption = safeProperty(options, "maxAttempts");
    const workdir = normalizeTaskPathText(typeof workdirOption === "string" ? workdirOption : ".", "workdir");
    const timeoutMs = timeoutOption !== undefined ? normalizeOptionalPositiveIntegerForWrite(timeoutOption as number, "timeoutMs") : undefined;
    const maxAttempts = normalizeOptionalPositiveIntegerForWrite((maxAttemptsOption as number | undefined) || 1, "maxAttempts");
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
      ensureSafeTaskDataDir(dirname(this.dataFile));
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
      ensureSafeTaskDataDir(dirname(this.dataFile));
      writeTaskFileAtomic(this.dataFile, safeJsonStringify({
        active: [...this.tasks.values()],
        history: this.taskHistory.slice(-this.maxHistory),
      }, { space: 2 }));
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
      const terminateWorker = () => {
        if (proc.pid) terminateProcessGroup(proc.pid);
        else {
          try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        }
      };
      if (spec.timeoutMs && spec.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          if ((task.attempts || 0) >= (task.maxAttempts || 1)) {
            this.finishQueuedTask(task, 124, "SIGTERM", `Timed out after ${spec.timeoutMs}ms`);
            const cleanupTimer = setTimeout(terminateWorker, 25);
            cleanupTimer.unref?.();
            return;
          }
          terminateWorker();
        }, spec.timeoutMs);
        timeoutTimer.unref?.();
      }
      const clearTimeoutTimer = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      };
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const appendText = (prefix: string, decoded: string) => {
        if (!decoded) return;
        const text = prefix + decoded;
        task.output = appendTaskOutput(task.output, text);
        if (task.outputFile && this.isTaskPathInsideDataRoot(task.outputFile)) {
          try {
            appendTaskOutputFile(task.outputFile, text, dirname(this.dataFile || task.outputFile));
          } catch {
            // keep in-memory/persisted output if artifact write fails
          }
        }
        this.persist();
      };
      proc.stdout.on("data", data => appendText("", stdoutDecoder.write(data)));
      proc.stderr.on("data", data => appendText("[stderr] ", stderrDecoder.write(data)));
      proc.on("error", error => {
        clearTimeoutTimer();
        this.workers.delete(task.id);
        if (isTerminalStatus(task.status)) return;
        this.finishQueuedTask(task, 1, null, `Error: ${error.message}`);
      });
      proc.on("close", (code, signal) => {
        clearTimeoutTimer();
        appendText("", stdoutDecoder.end());
        appendText("[stderr] ", stderrDecoder.end());
        this.workers.delete(task.id);
        if (isTerminalStatus(task.status)) return;
        const finalCode = timedOut ? 124 : code;
        const finalSignal = timedOut ? signal ?? "SIGTERM" : signal;
        this.finishQueuedTask(
          task,
          finalCode,
          finalSignal,
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
  const root = dirname(defaultTaskStoreFile());
  if (isSafeExistingTaskDataDir(root)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function cleanupAtomicTaskTemp(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

function ensureSafeTaskDataDir(path: string): void {
  const resolved = resolve(path);
  const missing: string[] = [];
  let current = resolved;
  let anchor: string | undefined;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe task data directory: ${path}`);
      anchor ??= current;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      missing.unshift(basename(current));
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!anchor) throw new Error(`unsafe task data directory: ${path}`);
  current = anchor;
  for (const segment of missing) {
    const next = join(current, segment);
    try {
      mkdirSync(next);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe task data directory: ${path}`);
    current = next;
  }
}

function isSafeExistingTaskDataDir(path: string): boolean {
  let current = resolve(path);
  try {
    while (true) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  } catch {
    return false;
  }
}

function assertSafeTaskStoreTarget(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe task store target");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return;
    throw error;
  }
}

function writeTaskFileAtomic(path: string, payload: string): void {
  assertSafeTaskStoreTarget(path);
  const dir = dirname(path);
  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${atomicTaskWriteCounter++}.tmp`);
  try {
    writeFileSync(tmpPath, payload, { encoding: "utf-8", flag: "wx" });
    assertSafeTaskStoreTarget(path);
    renameSync(tmpPath, path);
  } catch (error) {
    cleanupAtomicTaskTemp(tmpPath);
    throw error;
  }
}

function parsePersistedTaskState(value: unknown, dataRoot?: string): { active: TaskRecord[]; history: TaskRecord[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { active: [], history: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    active: parsePersistedTaskList(safeProperty(record, "active"), dataRoot),
    history: parsePersistedTaskList(safeProperty(record, "history"), dataRoot),
  };
}

function parsePersistedTaskList(value: unknown, dataRoot?: string): TaskRecord[] {
  if (!Array.isArray(value)) return [];
  const parsed: TaskRecord[] = [];
  for (const item of safeArrayItems(value, MAX_TASK_HISTORY, true)) {
    const task = parsePersistedTask(item, dataRoot);
    if (task) parsed.push(task);
  }
  return parsed;
}

function parsePersistedTask(value: unknown, dataRoot?: string): TaskRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = safeTaskId(safeProperty(record, "id"));
  const type = parseTaskType(safeProperty(record, "type"));
  const status = parseTaskStatus(safeProperty(record, "status"));
  const description = nonEmptyString(safeProperty(record, "description"), MAX_TASK_TEXT_CHARS);
  const startTime = finiteNumber(safeProperty(record, "startTime"));
  const notifiedValue = safeProperty(record, "notified");
  const notified = typeof notifiedValue === "boolean" ? notifiedValue : null;
  if (!id || !type || !status || !description || startTime === null || notified === null) return null;

  const toolUseId = optionalString(safeProperty(record, "toolUseId"));
  const agentId = optionalString(safeProperty(record, "agentId"));
  const endTime = optionalFiniteNumber(safeProperty(record, "endTime"));
  const totalPausedMs = optionalFiniteNumber(safeProperty(record, "totalPausedMs"));
  const output = optionalSanitizedString(safeProperty(record, "output"), MAX_TASK_OUTPUT_CHARS, true);
  const outputFile = optionalPathInsideRoot(safeProperty(record, "outputFile"), dataRoot);
  const artifactIds = optionalStringArray(safeProperty(record, "artifactIds"));
  const progress = optionalTaskProgress(safeProperty(record, "progress"));
  const queue = optionalTaskQueue(safeProperty(record, "queue"));
  const attempts = optionalNonNegativeInteger(safeProperty(record, "attempts"));
  const maxAttempts = optionalPositiveInteger(safeProperty(record, "maxAttempts"));
  const exitCode = optionalNullableFiniteNumber(safeProperty(record, "exitCode"));
  const signal = optionalSignal(safeProperty(record, "signal"));

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
  const type = parseTaskType(safeProperty(record, "type"));
  const lastUpdate = finiteNumber(safeProperty(record, "lastUpdate"));
  const percent = optionalProgressPercent(safeProperty(record, "percent"));
  const message = optionalSanitizedString(safeProperty(record, "message"), MAX_TASK_TEXT_CHARS);
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
  if (safeProperty(record, "kind") !== "shell") return undefined;
  const command = nonEmptyString(safeProperty(record, "command"), MAX_TASK_COMMAND_CHARS);
  const workdir = nonEmptyString(safeProperty(record, "workdir"), MAX_TASK_WORKDIR_CHARS);
  const timeoutMs = optionalPositiveInteger(safeProperty(record, "timeoutMs"));
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
    ? keepTail ? safeTailTextBoundary(sanitized, maxChars) : safeSliceTextBoundary(sanitized, maxChars)
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
  const seen = new Set<string>();
  for (const item of safeArrayItems(value, MAX_TASK_ARTIFACT_IDS * 2)) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > MAX_TASK_ARTIFACT_ID_CHARS || CONTROL_TEXT_RE.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    items.push(trimmed);
    if (items.length >= MAX_TASK_ARTIFACT_IDS) break;
  }
  return items;
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
  return safeTailTextBoundary(combined, MAX_TASK_OUTPUT_CHARS);
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
  if (!value || typeof value !== "object" || safeProperty(value, "kind") !== "shell") {
    throw new Error("queue kind must be shell.");
  }
  const command = normalizeTaskText(safeProperty(value, "command") as string, "command");
  const workdir = normalizeTaskPathText(safeProperty(value, "workdir") as string, "workdir");
  const timeout = safeProperty(value, "timeoutMs");
  const timeoutMs = timeout !== undefined ? normalizeOptionalPositiveIntegerForWrite(timeout as number, "timeoutMs") : undefined;
  return {
    kind: "shell",
    command,
    workdir,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function normalizeTaskProgressForWrite(progress: TaskProgress): TaskProgress {
  const type = normalizeTaskTypeForWrite(safeProperty(progress, "type") as TaskType);
  const percent = safeProperty(progress, "percent");
  if (percent !== undefined && (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)) {
    throw new Error("progress percent must be between 0 and 100.");
  }
  const progressMessage = safeProperty(progress, "message");
  const message = progressMessage !== undefined ? normalizeOptionalTaskText(progressMessage as string, "progress message") : undefined;
  return {
    type,
    lastUpdate: Date.now(),
    ...(percent !== undefined ? { percent: percent as number } : {}),
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
  let fd: number | undefined;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return readFileSync(fd, "utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function appendTaskOutputFile(path: string, text: string, dataRoot: string): void {
  // Re-check the parent before opening and use O_NOFOLLOW so a replacement
  // race cannot redirect output to a symlink target.
  if (!isPathInsideRoot(path, dataRoot)) return;
  ensureSafeTaskDataDir(dirname(path));
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size >= MAX_TASK_OUTPUT_FILE_BYTES) return;
    const bounded = safeUtf8PrefixByBytes(text, MAX_TASK_OUTPUT_FILE_BYTES - stats.size);
    if (bounded) writeSync(fd, bounded, undefined, "utf-8");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function safeProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeArrayItems(value: unknown, maxItems: number, fromEnd = false): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return [];
  }
  const limit = Math.max(0, Math.floor(maxItems));
  const start = fromEnd ? Math.max(0, length - limit) : 0;
  const end = fromEnd ? length : Math.min(length, limit);
  const items: unknown[] = [];
  for (let index = start; index < end; index++) {
    try {
      items.push(value[index]);
    } catch {
      continue;
    }
  }
  return items;
}

function killChildProcessGroup(proc: ChildProcess): void {
  if (!proc.pid || !Number.isSafeInteger(proc.pid) || proc.pid <= 0) return;
  terminateProcessGroup(proc.pid);
}
