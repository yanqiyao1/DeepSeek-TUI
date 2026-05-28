/** Background shell job manager used by shell tools and /jobs. */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkCommand } from "./exec-policy.js";
import { createArtifact, linkArtifact } from "../artifacts/store.js";
import { seekcodeDataPath } from "../paths.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { decodeUtf8Tail, safeSliceTextBoundary, safeTailTextBoundary } from "../utils/text-boundary.js";
import { canonicalizePathOrNearestExisting, isPathInsideRoot as isCanonicalPathInsideRoot } from "./path-resolution.js";

export type JobStatus = "running" | "completed" | "failed" | "killed" | "stale";

export interface ShellJob {
  id: string;
  command: string;
  workdir: string;
  status: JobStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt?: number;
  output: string;
  pid?: number;
  logFile?: string;
  inputFile?: string;
  statusFile?: string;
  commandFile?: string;
  supervisorFile?: string;
  artifactIds?: string[];
  pty?: boolean;
  reattachable?: boolean;
  lastInputAt?: number;
}

interface InternalJob extends ShellJob {
  proc?: ChildProcess;
  timeoutTimer?: NodeJS.Timeout;
}

const MAX_OUTPUT_CHARS = 200_000;
const MAX_JOB_ID_LENGTH = 80;
const MAX_JOB_COMMAND_CHARS = 20_000;
const MAX_JOB_WORKDIR_CHARS = 4_096;
const MAX_JOB_RECORD_BYTES = 1_000_000;
const MAX_JOB_FILES = 1_000;
const MAX_JOB_STATUS_BYTES = 64_000;
const MAX_JOB_INPUT_CHARS = 50_000;
const MAX_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_JOB_ARTIFACT_IDS = 500;
const MAX_JOB_ARTIFACT_ID_CHARS = 256;
const MAX_PROCESS_TABLE_BYTES = 2_000_000;
const RUNNING_JOB_STATUS_GRACE_MS = 2_000;
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
let atomicJobWriteCounter = 0;

interface StartOptions {
  pty?: boolean;
  timeoutMs?: number;
}

const VALID_JOB_STATUSES = new Set<JobStatus>(["running", "completed", "failed", "killed", "stale"]);

class JobManager {
  private jobs = new Map<string, InternalJob>();
  private dataDir: string;

  constructor(dataDir = defaultJobsDir()) {
    this.dataDir = dataDir;
    this.loadPersistedJobs();
  }

  start(command: string, workdir = ".", options: StartOptions = {}): ShellJob {
    const shellCommand = normalizeJobText(command, "command");
    const cwd = normalizeJobText(workdir, "workdir");
    const timeoutMs = normalizeStartTimeout(options.timeoutMs);
    const policy = checkCommand(shellCommand);
    if (policy.decision === "deny") {
      throw new Error(`Command blocked by policy: ${policy.justification}`);
    }

    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(this.dataDir, { recursive: true });
    const logFile = join(this.dataDir, `${id}.log`);
    const inputFile = join(this.dataDir, `${id}.in`);
    const statusFile = join(this.dataDir, `${id}.status.json`);
    const commandFile = join(this.dataDir, `${id}.cmd`);
    const supervisorFile = join(this.dataDir, `${id}.supervisor.sh`);
    const readyFile = join(this.dataDir, `${id}.ready.json`);
    const usePty = options.pty !== false;
    writeFileSync(logFile, "", { encoding: "utf-8", flag: "a" });
    writeFileSync(commandFile, shellCommand, "utf-8");
    writeFileSync(supervisorFile, supervisorScript(), { encoding: "utf-8", mode: 0o700 });
    try { rmSync(inputFile, { force: true }); } catch { /* ignore stale fifo */ }
    execFileSync("mkfifo", [inputFile]);

    const proc = spawn("bash", [supervisorFile, inputFile, logFile, commandFile, statusFile, readyFile, usePty ? "pty" : "pipe", String(timeoutMs)], {
      cwd,
      stdio: "ignore",
      detached: true,
      env: { ...process.env },
    });
    proc.unref();
    const job: InternalJob = {
      id,
      command: shellCommand,
      workdir: cwd,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      output: "",
      logFile,
      inputFile,
      statusFile,
      commandFile,
      supervisorFile,
      pty: usePty,
      reattachable: true,
      proc,
    };
    if (proc.pid !== undefined) job.pid = proc.pid;
    this.jobs.set(id, job);
    this.persistJob(job);
    if (timeoutMs > 0) {
      job.timeoutTimer = setTimeout(() => this.timeoutJob(job, timeoutMs), timeoutMs);
      job.timeoutTimer.unref?.();
    }
    proc.on("error", error => {
      this.clearTimeout(job);
      job.status = "failed";
      job.endedAt = Date.now();
      job.output = appendOutput(job.output, `\nError: ${error.message}`);
      delete job.proc;
      this.persistJob(job);
    });
    proc.on("exit", () => {
      this.clearTimeout(job);
      delete job.proc;
      this.refreshJob(job);
    });
    return this.snapshot(job);
  }

  get(id: string): ShellJob | undefined {
    const job = this.jobs.get(id);
    return job ? this.snapshot(this.refreshJob(job)) : undefined;
  }

  list(): ShellJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(job => this.snapshot(this.refreshJob(job)));
  }

  write(id: string, input: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (typeof input !== "string" || input.length > MAX_JOB_INPUT_CHARS || CONTROL_TEXT_RE.test(input)) return false;
    this.refreshJob(job);
    if (
      job.status !== "running"
      || !job.inputFile
      || !isJobPathInsideRoot(job.inputFile, this.dataDir)
      || !existsSync(job.inputFile)
    ) {
      return false;
    }
    try {
      writeFileSync(job.inputFile, input, { encoding: "utf-8", flag: "a" });
      job.lastInputAt = Date.now();
      this.persistJob(job);
      return true;
    } catch {
      this.refreshJob(job);
      return false;
    }
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.refreshJob(job);
    if (job.status !== "running") return false;
    job.status = "killed";
    job.endedAt = Date.now();
    this.clearTimeout(job);
    if (job.pid) terminateProcessGroup(job.pid);
    delete job.proc;
    this.persistJob(job);
    return true;
  }

  prune(maxAgeMs = 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, job] of this.jobs) {
      this.refreshJob(job);
      if (job.status === "running") continue;
      if ((job.endedAt ?? job.startedAt) > now - maxAgeMs) continue;
      this.jobs.delete(id);
      this.removePersistedJob(id, job);
      removed++;
    }
    return removed;
  }

  clear(): void {
    for (const job of this.jobs.values()) {
      this.refreshJob(job);
      if (job.status === "running" && job.pid) terminateProcessGroup(job.pid);
      this.clearTimeout(job);
    }
    this.jobs.clear();
    try { rmSync(this.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  private snapshot(job: InternalJob): ShellJob {
    const { proc: _proc, timeoutTimer: _timeoutTimer, ...snapshot } = job;
    return {
      ...snapshot,
      ...(snapshot.artifactIds ? { artifactIds: [...snapshot.artifactIds] } : {}),
    };
  }

  private loadPersistedJobs(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      for (const file of readdirSync(this.dataDir).filter(name => /^job_[a-z0-9_]+\.json$/.test(name)).sort().slice(-MAX_JOB_FILES)) {
        try {
          const text = readSmallTextFile(join(this.dataDir, file), MAX_JOB_RECORD_BYTES);
          if (text === null) continue;
          const expectedId = file.slice(0, -".json".length);
          const job = parsePersistedJob(JSON.parse(text), this.dataDir, expectedId);
          if (!job) continue;
          delete job.proc;
          this.jobs.set(job.id, job);
          this.refreshJob(job);
        } catch {
          // skip corrupt job metadata
        }
      }
    } catch {
      // use memory-only jobs if persistence fails
    }
  }

  private persistJob(job: InternalJob): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const { proc: _proc, timeoutTimer: _timeoutTimer, ...snapshot } = job;
      writeJobFileAtomic(join(this.dataDir, `${job.id}.json`), safeJsonStringify(snapshot, { space: 2 }));
    } catch {
      // keep in-memory job state
    }
  }

  private removePersistedJob(id: string, job: InternalJob): void {
    try { rmSync(join(this.dataDir, `${id}.json`), { force: true }); } catch { /* ignore */ }
    for (const path of [
      job.logFile,
      job.inputFile,
      job.statusFile,
      job.statusFile ? `${job.statusFile}.pid` : undefined,
      job.commandFile,
      job.supervisorFile,
      join(this.dataDir, `${id}.ready.json`),
    ]) {
      if (!path) continue;
      if (!isJobPathInsideRoot(path, this.dataDir)) continue;
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  }

  private refreshJob(job: InternalJob): InternalJob {
    let changed = false;
    let outputChanged = false;
    if (job.logFile && isJobPathInsideRoot(job.logFile, this.dataDir) && existsSync(job.logFile)) {
      try {
        const output = readTextTail(job.logFile, MAX_OUTPUT_CHARS);
        if (output !== job.output) {
          job.output = output;
          outputChanged = true;
          changed = true;
        }
      } catch {
        // keep persisted output
      }
    }

    const status = readStatusFile(job.statusFile, this.dataDir)
      || (job.status === "running" && outputChanged ? waitForStatusFile(job.statusFile, this.dataDir, 50) : null);
    if (status && job.status !== "killed") {
      const exitCode = status.exitCode;
      const endedAt = status.endedAt ?? statusFileMtime(job.statusFile, this.dataDir) ?? Date.now();
      if (job.status !== (exitCode === 0 ? "completed" : "failed")) changed = true;
      job.status = exitCode === 0 ? "completed" : "failed";
      job.exitCode = exitCode;
      job.signal = null;
      job.endedAt = endedAt;
      this.clearTimeout(job);
      delete job.proc;
      this.archiveCompletedOutput(job);
    } else if (job.status === "running") {
      if (job.pid && isProcessAlive(job.pid)) {
        job.reattachable = Boolean(job.inputFile && isJobPathInsideRoot(job.inputFile, this.dataDir) && existsSync(job.inputFile));
      } else {
        const canReattachFiles = hasReattachableJobFiles(job, this.dataDir);
        const recentOutput = outputChanged && canReattachFiles;
        const ageMs = Date.now() - job.startedAt;
        if (recentOutput || (canReattachFiles && ageMs < RUNNING_JOB_STATUS_GRACE_MS)) {
          job.reattachable = Boolean(job.inputFile && isJobPathInsideRoot(job.inputFile, this.dataDir) && existsSync(job.inputFile));
        } else {
          job.status = "stale";
          job.endedAt = Date.now();
          this.clearTimeout(job);
          delete job.proc;
          job.output = appendOutput(job.output, "\n[stale] Supervisor is no longer running and no exit status was recorded.\n");
          changed = true;
        }
      }
    }

    if (changed) this.persistJob(job);
    return job;
  }

  private timeoutJob(job: InternalJob, timeoutMs: number): void {
    if (job.status !== "running") return;
    if (job.logFile && isJobPathInsideRoot(job.logFile, this.dataDir) && existsSync(job.logFile)) {
      try {
        job.output = readTextTail(job.logFile, MAX_OUTPUT_CHARS);
      } catch {
        // keep current output
      }
    }
    job.status = "failed";
    job.exitCode = 124;
    job.signal = null;
    job.endedAt = Date.now();
    job.output = appendOutput(job.output, `\n[timeout after ${timeoutMs}ms]\n`);
    this.clearTimeout(job);
    if (job.pid) terminateProcessGroup(job.pid);
    delete job.proc;
    this.archiveCompletedOutput(job);
    this.persistJob(job);
  }

  private clearTimeout(job: InternalJob): void {
    if (!job.timeoutTimer) return;
    clearTimeout(job.timeoutTimer);
    delete job.timeoutTimer;
  }

  private archiveCompletedOutput(job: InternalJob): void {
    if (job.artifactIds?.length || !job.output) return;
    try {
      const artifact = createArtifact({
        kind: "job_log",
        name: `${sanitizeDisplayText(job.id, MAX_JOB_ID_LENGTH) || "job"}.log`,
        content: job.output,
        extension: ".log",
        metadata: {
          job_id: sanitizeDisplayText(job.id, MAX_JOB_ID_LENGTH),
          command: sanitizeDisplayText(job.command, MAX_JOB_COMMAND_CHARS),
          workdir: sanitizeDisplayText(job.workdir, MAX_JOB_WORKDIR_CHARS),
          status: job.status,
        },
      });
      job.artifactIds = [artifact.id];
      linkArtifact(artifact.id, "job", job.id, { status: job.status });
    } catch {
      // Job state should not depend on artifact persistence.
    }
  }
}

function cleanupAtomicJobTemp(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

function assertSafeJobMetadataTarget(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe job metadata target");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return;
    throw error;
  }
}

function writeJobFileAtomic(path: string, payload: string): void {
  assertSafeJobMetadataTarget(path);
  const dir = dirname(path);
  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${atomicJobWriteCounter++}.tmp`);
  try {
    writeFileSync(tmpPath, payload, { encoding: "utf-8", flag: "wx" });
    assertSafeJobMetadataTarget(path);
    renameSync(tmpPath, path);
  } catch (error) {
    cleanupAtomicJobTemp(tmpPath);
    throw error;
  }
}

function parsePersistedJob(value: unknown, dataDir = defaultJobsDir(), expectedId?: string): InternalJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = safeJobId(safeProperty(record, "id"));
  if (expectedId !== undefined && id !== expectedId) return null;
  const command = nonEmptyString(safeProperty(record, "command"), MAX_JOB_COMMAND_CHARS);
  const workdir = nonEmptyString(safeProperty(record, "workdir"), MAX_JOB_WORKDIR_CHARS);
  const rawStatus = safeProperty(record, "status");
  const status = typeof rawStatus === "string" && VALID_JOB_STATUSES.has(rawStatus as JobStatus)
    ? rawStatus as JobStatus
    : null;
  const startedAt = finiteNumber(safeProperty(record, "startedAt"));
  const output = optionalSanitizedString(safeProperty(record, "output"), MAX_OUTPUT_CHARS, true);
  if (!id || !command || !workdir || !status || startedAt === null || output === null || output === undefined) return null;
  if (checkCommand(command).decision === "deny") return null;

  const exitCode = nullableFiniteNumber(safeProperty(record, "exitCode"));
  if (exitCode === undefined) return null;
  const endedAt = optionalFiniteNumber(safeProperty(record, "endedAt"));
  const pid = optionalPositiveInteger(safeProperty(record, "pid"));
  const lastInputAt = optionalFiniteNumber(safeProperty(record, "lastInputAt"));
  const signal = optionalSignal(safeProperty(record, "signal"));
  const logFile = optionalPathInsideRoot(safeProperty(record, "logFile"), dataDir);
  const inputFile = optionalPathInsideRoot(safeProperty(record, "inputFile"), dataDir);
  const statusFile = optionalPathInsideRoot(safeProperty(record, "statusFile"), dataDir);
  const commandFile = optionalPathInsideRoot(safeProperty(record, "commandFile"), dataDir);
  const supervisorFile = optionalPathInsideRoot(safeProperty(record, "supervisorFile"), dataDir);
  const artifactIds = optionalStringArray(safeProperty(record, "artifactIds"));
  const pty = optionalBoolean(safeProperty(record, "pty"));
  const reattachable = optionalBoolean(safeProperty(record, "reattachable"));

  if (
    endedAt === undefined
    || pid === undefined
    || lastInputAt === undefined
    || signal === undefined
    || logFile === undefined
    || inputFile === undefined
    || statusFile === undefined
    || commandFile === undefined
    || supervisorFile === undefined
    || artifactIds === undefined
    || pty === undefined
    || reattachable === undefined
  ) {
    return null;
  }

  return {
    id,
    command,
    workdir,
    status,
    exitCode,
    signal,
    startedAt,
    output,
    ...(endedAt !== null ? { endedAt } : {}),
    ...(pid !== null ? { pid } : {}),
    ...(logFile !== null ? { logFile } : {}),
    ...(inputFile !== null ? { inputFile } : {}),
    ...(statusFile !== null ? { statusFile } : {}),
    ...(commandFile !== null ? { commandFile } : {}),
    ...(supervisorFile !== null ? { supervisorFile } : {}),
    ...(artifactIds !== null ? { artifactIds } : {}),
    ...(pty !== null ? { pty } : {}),
    ...(reattachable !== null ? { reattachable } : {}),
    ...(lastInputAt !== null ? { lastInputAt } : {}),
  };
}

function nonEmptyString(value: unknown, maxChars = MAX_JOB_COMMAND_CHARS): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxChars && !CONTROL_TEXT_RE.test(trimmed) ? trimmed : null;
}

function safeJobId(value: unknown): string | null {
  const id = nonEmptyString(value);
  return id && id.length <= MAX_JOB_ID_LENGTH && /^job_[a-z0-9_]+$/.test(id) ? id : null;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.length <= MAX_JOB_COMMAND_CHARS && !CONTROL_TEXT_RE.test(value) ? value : undefined;
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

function optionalFiniteNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  const seen = new Set<string>();
  for (const item of safeArrayItems(value, MAX_JOB_ARTIFACT_IDS * 2)) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > MAX_JOB_ARTIFACT_ID_CHARS || CONTROL_TEXT_RE.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    items.push(trimmed);
    if (items.length >= MAX_JOB_ARTIFACT_IDS) break;
  }
  return items;
}

function optionalPathInsideRoot(value: unknown, root: string): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  if (!value.trim() || value.length > MAX_JOB_WORKDIR_CHARS || CONTROL_TEXT_RE.test(value)) return undefined;
  return isJobPathInsideRoot(value, root) ? value : undefined;
}

function isJobPathInsideRoot(path: string, root: string): boolean {
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

let manager: JobManager | null = null;

export function getJobManager(): JobManager {
  if (!manager) manager = new JobManager();
  return manager;
}

export function clearJobManagerForTests(): void {
  manager?.clear();
  manager = null;
}

export function reloadJobManagerForTests(): void {
  manager = null;
}

export function formatJob(job: ShellJob, tailChars = 4000): string {
  const boundedTailChars = normalizeTailChars(tailChars);
  const rawStartedAt = safeProperty(job, "startedAt");
  const rawEndedAt = safeProperty(job, "endedAt");
  const rawPid = safeProperty(job, "pid");
  const startedAt = typeof rawStartedAt === "number" && Number.isSafeInteger(rawStartedAt) && rawStartedAt >= 0
    ? rawStartedAt
    : Date.now();
  const endedAt = typeof rawEndedAt === "number" && Number.isSafeInteger(rawEndedAt) && rawEndedAt >= startedAt
    ? rawEndedAt
    : Date.now();
  const elapsed = Math.max(0, (endedAt - startedAt) / 1000);
  const status = safeProperty(job, "status");
  const exitCode = safeProperty(job, "exitCode");
  const signal = safeProperty(job, "signal");
  const logFile = safeProperty(job, "logFile");
  const inputFile = safeProperty(job, "inputFile");
  const pty = safeProperty(job, "pty");
  const reattachable = safeProperty(job, "reattachable");
  const lines = [
    `id: ${sanitizeDisplayText(safeProperty(job, "id"), MAX_JOB_ID_LENGTH) || "unknown"}`,
    `status: ${typeof status === "string" && VALID_JOB_STATUSES.has(status as JobStatus) ? status : "stale"}`,
    `command: ${sanitizeDisplayText(safeProperty(job, "command"), MAX_JOB_COMMAND_CHARS)}`,
    `cwd: ${sanitizeDisplayText(safeProperty(job, "workdir"), MAX_JOB_WORKDIR_CHARS)}`,
    `elapsed: ${elapsed.toFixed(1)}s`,
  ];
  if (isExitCode(exitCode)) lines.push(`exit_code: ${exitCode}`);
  if (typeof signal === "string" && VALID_SIGNALS.has(signal)) lines.push(`signal: ${signal}`);
  if (typeof rawPid === "number" && Number.isSafeInteger(rawPid) && rawPid > 0) lines.push(`pid: ${rawPid}`);
  if (logFile) lines.push(`log: ${sanitizeDisplayText(logFile, MAX_JOB_WORKDIR_CHARS)}`);
  if (inputFile) lines.push(`input: ${sanitizeDisplayText(inputFile, MAX_JOB_WORKDIR_CHARS)}`);
  lines.push(`pty: ${pty ? "yes" : "no"}`);
  lines.push(`reattachable: ${reattachable ? "yes" : "no"}`);
  const output = sanitizeOutputText(safeProperty(job, "output"), MAX_OUTPUT_CHARS);
  if (output) lines.push("", safeTailTextBoundary(output, boundedTailChars).trimEnd());
  return lines.join("\n");
}

export function defaultJobsDir(): string {
  const configured = firstJobsDirEnvValue();
  if (configured) return resolve(configured);
  return seekcodeDataPath("jobs");
}

function appendOutput(existing: string | undefined, next: string): string {
  const combined = `${existing || ""}${next}`.replace(CONTROL_TEXT_GLOBAL_RE, " ");
  return safeTailTextBoundary(combined, MAX_OUTPUT_CHARS);
}

function normalizeJobText(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a non-empty string.`);
  const trimmed = value.trim();
  const maxChars = label === "command" ? MAX_JOB_COMMAND_CHARS : MAX_JOB_WORKDIR_CHARS;
  if (!trimmed || trimmed.length > maxChars || CONTROL_TEXT_RE.test(trimmed)) throw new Error(`${label} must be a non-empty string.`);
  return trimmed;
}

function normalizeStartTimeout(value: number | undefined): number {
  if (value === undefined || value === null) return 0;
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_JOB_TIMEOUT_MS) : 0;
}

function firstJobsDirEnvValue(): string | undefined {
  for (const key of ["SEEKCODE_JOBS_DIR", "DEEPCODE_JOBS_DIR", "DEEPSEEK_JOBS_DIR"]) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed && trimmed.length <= MAX_JOB_WORKDIR_CHARS && !CONTROL_TEXT_RE.test(trimmed)) return trimmed;
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !isZombieProcess(pid);
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function isZombieProcess(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    const output = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8", timeout: 500, maxBuffer: 1024 });
    return output.trim().startsWith("Z");
  } catch {
    return false;
  }
}

export function terminateProcessGroup(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const members = processGroupMembers(pid);
  const leaves = leafProcessGroupMembers(members, pid);
  signalProcessGroupOrPid(pid, "SIGTERM");
  if (!leaves.length) {
    setTimeout(() => signalProcessGroupOrPid(pid, "SIGKILL"), 100).unref?.();
    return;
  }

  signalPids(leaves, "SIGTERM");
  setTimeout(() => {
    const refreshed = processGroupMembers(pid);
    const descendants = processGroupDescendants(refreshed, pid);
    signalPids(descendants, "SIGTERM");
    signalProcessGroupOrPid(pid, "SIGKILL");
    setTimeout(() => {
      signalPids(processGroupDescendants(processGroupMembers(pid), pid), "SIGKILL");
      signalProcessGroupOrPid(pid, "SIGKILL");
    }, 75).unref?.();
  }, 100).unref?.();
}

interface ProcessGroupMember {
  pid: number;
  ppid: number;
  pgid: number;
}

function processGroupMembers(rootPid: number): ProcessGroupMember[] {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return [];
  try {
    const output = execFileSync("ps", ["-eo", "pid=,ppid=,pgid="], { encoding: "utf-8", timeout: 1000, maxBuffer: MAX_PROCESS_TABLE_BYTES });
    return output
      .split("\n")
      .map(line => {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
        return Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(pgid)
          ? { pid, ppid, pgid }
          : null;
      })
      .filter((member): member is ProcessGroupMember => member !== null && member.pgid === rootPid);
  } catch {
    return [];
  }
}

function leafProcessGroupMembers(members: ProcessGroupMember[], rootPid: number): number[] {
  const parents = new Set(members.map(member => member.ppid));
  return members
    .filter(member => member.pid !== rootPid && !parents.has(member.pid))
    .map(member => member.pid);
}

function processGroupDescendants(members: ProcessGroupMember[], rootPid: number): number[] {
  return members
    .filter(member => member.pid !== rootPid)
    .sort((a, b) => processDepth(b, members) - processDepth(a, members))
    .map(member => member.pid);
}

function processDepth(member: ProcessGroupMember, members: ProcessGroupMember[]): number {
  const byPid = new Map(members.map(item => [item.pid, item]));
  let depth = 0;
  let current: ProcessGroupMember | undefined = member;
  const seen = new Set<number>();
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    const parent = byPid.get(current.ppid);
    if (!parent) break;
    depth++;
    current = parent;
  }
  return depth;
}

function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, signal); } catch { /* ignore stale processes */ }
  }
}

function signalProcessGroupOrPid(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* ignore */ }
  }
}

function readStatusFile(path: string | undefined, root: string): { exitCode: number; endedAt?: number } | null {
  if (!path || !existsSync(path)) return null;
  if (!isJobPathInsideRoot(path, root)) return null;
  try {
    const text = readSmallTextFile(path, MAX_JOB_STATUS_BYTES);
    if (text === null) return null;
    const parsed = JSON.parse(text) as { exitCode?: unknown; endedAt?: unknown };
    const exitCodeValue = safeProperty(parsed, "exitCode");
    const exitCode = isExitCode(exitCodeValue) ? exitCodeValue : null;
    if (exitCode === null) return null;
    const endedAtValue = safeProperty(parsed, "endedAt");
    const endedAt = typeof endedAtValue === "number" && Number.isSafeInteger(endedAtValue) && endedAtValue >= 0 ? endedAtValue : undefined;
    return endedAt === undefined ? { exitCode } : { exitCode, endedAt };
  } catch {
    return null;
  }
}

function normalizeTailChars(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 4000;
  return Math.max(1, Math.min(parsed, MAX_OUTPUT_CHARS));
}

function readSmallTextFile(path: string, maxBytes: number): string | null {
  const linkStats = lstatSync(path);
  if (!linkStats.isFile()) return null;
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > maxBytes) return null;
  return readFileSync(path, "utf-8");
}

function readTextTail(path: string, maxChars: number): string {
  const stats = statSync(path);
  if (!stats.isFile()) return "";
  const bytesToRead = Math.min(stats.size, maxChars * 4);
  if (bytesToRead <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, Math.max(0, stats.size - bytesToRead));
    return safeTailTextBoundary(decodeUtf8Tail(buffer.subarray(0, bytesRead), stats.size > bytesToRead).replace(CONTROL_TEXT_GLOBAL_RE, " "), maxChars);
  } finally {
    closeSync(fd);
  }
}

function waitForStatusFile(path: string | undefined, root: string, timeoutMs: number): { exitCode: number; endedAt?: number } | null {
  const deadline = Date.now() + timeoutMs;
  do {
    const status = readStatusFile(path, root);
    if (status) return status;
    sleepSync(5);
  } while (Date.now() < deadline);
  return null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function statusFileMtime(path: string | undefined, root: string): number | undefined {
  if (!path) return undefined;
  if (!isJobPathInsideRoot(path, root)) return undefined;
  try { return statSync(path).mtimeMs; } catch { return undefined; }
}

function statusFileUpdatedRecently(path: string | undefined, root: string, maxAgeMs: number): boolean {
  const mtime = statusFileMtime(path, root);
  return mtime !== undefined && Date.now() - mtime <= maxAgeMs;
}

function hasReattachableJobFiles(job: InternalJob, root: string): boolean {
  return Boolean(
    job.logFile
    && job.inputFile
    && job.statusFile
    && job.commandFile
    && job.supervisorFile
    && isJobPathInsideRoot(job.logFile, root)
    && isJobPathInsideRoot(job.inputFile, root)
    && isJobPathInsideRoot(job.statusFile, root)
    && isJobPathInsideRoot(job.commandFile, root)
    && isJobPathInsideRoot(job.supervisorFile, root)
    && existsSync(job.logFile)
    && existsSync(job.inputFile)
    && existsSync(job.commandFile)
    && existsSync(job.supervisorFile),
  );
}

function supervisorScript(): string {
  return `#!/usr/bin/env bash
set +e
fifo="$1"
log="$2"
command_file="$3"
status="$4"
ready="$5"
mode="$6"
timeout_ms="\${7:-0}"
echo "$$" > "$status.pid"
touch "$log"
exec 3<>"$fifo"
now_ms() {
  perl -MTime::HiRes=time -e 'printf "%.0f\\n", time() * 1000' 2>/dev/null || echo "$(($(date +%s) * 1000))"
}
now="$(now_ms)"
printf '{"readyAt":%s}\\n' "$now" > "$ready"
cmd="$(cat "$command_file")"
run_with_timeout() {
  if [[ "$timeout_ms" =~ ^[0-9]+$ ]] && [[ "$timeout_ms" -gt 0 ]] && command -v timeout >/dev/null 2>&1; then
    seconds="$(( (timeout_ms + 999) / 1000 ))"
    timeout --kill-after=1s "$seconds"s "$@"
  else
    "$@"
  fi
}
if [[ "$mode" == "pty" ]] && command -v script >/dev/null 2>&1 && script --version >/dev/null 2>&1; then
  run_with_timeout script -q -f -e -c "$cmd" "$log" <&3
  code=$?
else
  run_with_timeout bash -lc "$cmd" <&3 >>"$log" 2>&1
  code=$?
fi
if [[ "$code" == "124" || "$code" == "137" ]]; then
  printf '\\n[timeout after %sms]\\n' "$timeout_ms" >> "$log"
fi
ended="$(now_ms)"
printf '{"exitCode":%s,"endedAt":%s}\\n' "$code" "$ended" > "$status"
exit "$code"
`;
}

function sanitizeDisplayText(value: unknown, maxChars: number): string {
  return safeSliceTextBoundary(String(value ?? "").replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim(), maxChars);
}

function sanitizeOutputText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const sanitized = value.replace(CONTROL_TEXT_GLOBAL_RE, " ");
  return safeTailTextBoundary(sanitized, maxChars);
}

function safeProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  try {
    return (source as Record<string, unknown>)[key];
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
  const limit = Math.max(0, Math.floor(maxItems));
  const items: unknown[] = [];
  for (let index = 0; index < Math.min(length, limit); index++) {
    try {
      items.push(value[index]);
    } catch {
      continue;
    }
  }
  return items;
}
