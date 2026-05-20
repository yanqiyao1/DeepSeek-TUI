/** Background shell job manager used by shell tools and /jobs. */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkCommand } from "./exec-policy.js";
import { createArtifact, linkArtifact } from "../artifacts/store.js";
import { seekcodeDataPath } from "../paths.js";

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
    const policy = checkCommand(command);
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
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0 ? Math.floor(options.timeoutMs!) : 0;
    writeFileSync(logFile, "", { encoding: "utf-8", flag: "a" });
    writeFileSync(commandFile, command, "utf-8");
    writeFileSync(supervisorFile, supervisorScript(), { encoding: "utf-8", mode: 0o700 });
    try { rmSync(inputFile, { force: true }); } catch { /* ignore stale fifo */ }
    execFileSync("mkfifo", [inputFile]);

    const proc = spawn("bash", [supervisorFile, inputFile, logFile, commandFile, statusFile, readyFile, usePty ? "pty" : "pipe", String(timeoutMs)], {
      cwd: workdir,
      stdio: "ignore",
      detached: true,
      env: { ...process.env },
    });
    proc.unref();
    const job: InternalJob = {
      id,
      command,
      workdir,
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
    this.refreshJob(job);
    if (job.status !== "running" || !job.inputFile || !existsSync(job.inputFile)) return false;
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
    return { ...snapshot };
  }

  private loadPersistedJobs(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      for (const file of readdirSync(this.dataDir).filter(name => /^job_[a-z0-9_]+\.json$/.test(name))) {
        try {
          const job = parsePersistedJob(JSON.parse(readFileSync(join(this.dataDir, file), "utf-8")), this.dataDir);
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
      writeFileSync(join(this.dataDir, `${job.id}.json`), JSON.stringify(snapshot, null, 2), "utf-8");
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
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  }

  private refreshJob(job: InternalJob): InternalJob {
    let changed = false;
    let outputChanged = false;
    if (job.logFile && isJobPathInsideRoot(job.logFile, this.dataDir) && existsSync(job.logFile)) {
      try {
        const output = readFileSync(job.logFile, "utf-8").slice(-MAX_OUTPUT_CHARS);
        if (output !== job.output) {
          job.output = output;
          outputChanged = true;
          changed = true;
        }
      } catch {
        // keep persisted output
      }
    }

    const status = readStatusFile(job.statusFile)
      || (job.status === "running" && outputChanged ? waitForStatusFile(job.statusFile, 50) : null);
    if (status && job.status !== "killed") {
      const exitCode = status.exitCode;
      const endedAt = status.endedAt || statusFileMtime(job.statusFile) || Date.now();
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
        job.reattachable = Boolean(job.inputFile && existsSync(job.inputFile));
      } else {
        job.status = "stale";
        job.endedAt = Date.now();
        this.clearTimeout(job);
        delete job.proc;
        job.output = appendOutput(job.output, "\n[stale] Supervisor is no longer running and no exit status was recorded.\n");
        changed = true;
      }
    }

    if (changed) this.persistJob(job);
    return job;
  }

  private timeoutJob(job: InternalJob, timeoutMs: number): void {
    if (job.status !== "running") return;
    if (job.logFile && existsSync(job.logFile)) {
      try {
        job.output = readFileSync(job.logFile, "utf-8").slice(-MAX_OUTPUT_CHARS);
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
    const artifact = createArtifact({
      kind: "job_log",
      name: `${job.id}.log`,
      content: job.output,
      extension: ".log",
      metadata: { job_id: job.id, command: job.command, workdir: job.workdir, status: job.status },
    });
    job.artifactIds = [artifact.id];
    linkArtifact(artifact.id, "job", job.id, { status: job.status });
  }
}

function parsePersistedJob(value: unknown, dataDir = defaultJobsDir()): InternalJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = safeJobId(record.id);
  const command = nonEmptyString(record.command);
  const workdir = nonEmptyString(record.workdir);
  const status = typeof record.status === "string" && VALID_JOB_STATUSES.has(record.status as JobStatus)
    ? record.status as JobStatus
    : null;
  const startedAt = finiteNumber(record.startedAt);
  const output = typeof record.output === "string" ? record.output : null;
  if (!id || !command || !workdir || !status || startedAt === null || output === null) return null;
  if (checkCommand(command).decision === "deny") return null;

  const exitCode = nullableFiniteNumber(record.exitCode);
  if (exitCode === undefined) return null;
  const endedAt = optionalFiniteNumber(record.endedAt);
  const pid = optionalPositiveInteger(record.pid);
  const lastInputAt = optionalFiniteNumber(record.lastInputAt);
  const signal = optionalSignal(record.signal);
  const logFile = optionalPathInsideRoot(record.logFile, dataDir);
  const inputFile = optionalPathInsideRoot(record.inputFile, dataDir);
  const statusFile = optionalPathInsideRoot(record.statusFile, dataDir);
  const commandFile = optionalPathInsideRoot(record.commandFile, dataDir);
  const supervisorFile = optionalPathInsideRoot(record.supervisorFile, dataDir);
  const artifactIds = optionalStringArray(record.artifactIds);
  const pty = optionalBoolean(record.pty);
  const reattachable = optionalBoolean(record.reattachable);

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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeJobId(value: unknown): string | null {
  const id = nonEmptyString(value);
  return id && /^job_[a-z0-9_]+$/.test(id) ? id : null;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function optionalSignal(value: unknown): NodeJS.Signals | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value as NodeJS.Signals : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function optionalPathInsideRoot(value: unknown, root: string): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  if (!value.trim()) return undefined;
  return isJobPathInsideRoot(value, root) ? value : undefined;
}

function isJobPathInsideRoot(path: string, root: string): boolean {
  try {
    const resolvedRoot = realpathSync(resolve(root));
    const resolved = existsSync(path) ? realpathSync(path) : resolve(path);
    const rel = relative(resolvedRoot, resolved);
    return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
  } catch {
    return false;
  }
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
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const lines = [
    `id: ${job.id}`,
    `status: ${job.status}`,
    `command: ${job.command}`,
    `cwd: ${job.workdir}`,
    `elapsed: ${elapsed.toFixed(1)}s`,
  ];
  if (job.exitCode !== null) lines.push(`exit_code: ${job.exitCode}`);
  if (job.signal) lines.push(`signal: ${job.signal}`);
  if (job.pid) lines.push(`pid: ${job.pid}`);
  if (job.logFile) lines.push(`log: ${job.logFile}`);
  if (job.inputFile) lines.push(`input: ${job.inputFile}`);
  lines.push(`pty: ${job.pty ? "yes" : "no"}`);
  lines.push(`reattachable: ${job.reattachable ? "yes" : "no"}`);
  if (job.output) lines.push("", job.output.slice(-tailChars).trimEnd());
  return lines.join("\n");
}

export function defaultJobsDir(): string {
  if (process.env.SEEKCODE_JOBS_DIR) return resolve(process.env.SEEKCODE_JOBS_DIR);
  if (process.env.DEEPCODE_JOBS_DIR) return resolve(process.env.DEEPCODE_JOBS_DIR);
  if (process.env.DEEPSEEK_JOBS_DIR) return resolve(process.env.DEEPSEEK_JOBS_DIR);
  return seekcodeDataPath("jobs");
}

function appendOutput(existing: string | undefined, next: string): string {
  const combined = `${existing || ""}${next}`;
  return combined.length > MAX_OUTPUT_CHARS ? combined.slice(combined.length - MAX_OUTPUT_CHARS) : combined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

export function terminateProcessGroup(pid: number): void {
  const members = processGroupMembers(pid);
  const leaves = leafProcessGroupMembers(members, pid);
  if (!leaves.length) {
    signalProcessGroupOrPid(pid, "SIGTERM");
    setTimeout(() => signalProcessGroupOrPid(pid, "SIGKILL"), 250).unref?.();
    return;
  }

  signalPids(leaves, "SIGTERM");
  setTimeout(() => {
    const refreshed = processGroupMembers(pid);
    const descendants = processGroupDescendants(refreshed, pid);
    signalPids(descendants, "SIGTERM");
    setTimeout(() => {
      signalPids(processGroupDescendants(processGroupMembers(pid), pid), "SIGKILL");
      signalProcessGroupOrPid(pid, "SIGTERM");
      setTimeout(() => signalProcessGroupOrPid(pid, "SIGKILL"), 250).unref?.();
    }, 100).unref?.();
  }, 150).unref?.();
}

interface ProcessGroupMember {
  pid: number;
  ppid: number;
  pgid: number;
}

function processGroupMembers(rootPid: number): ProcessGroupMember[] {
  try {
    const output = execFileSync("ps", ["-eo", "pid=,ppid=,pgid="], { encoding: "utf-8", timeout: 1000 });
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
    try { process.kill(pid, signal); } catch { /* ignore stale processes */ }
  }
}

function signalProcessGroupOrPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* ignore */ }
  }
}

function readStatusFile(path?: string): { exitCode: number; endedAt?: number } | null {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { exitCode?: unknown; endedAt?: unknown };
    const exitCode = typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode) ? parsed.exitCode : null;
    if (exitCode === null) return null;
    const endedAt = typeof parsed.endedAt === "number" && Number.isFinite(parsed.endedAt) ? parsed.endedAt : undefined;
    return endedAt === undefined ? { exitCode } : { exitCode, endedAt };
  } catch {
    return null;
  }
}

function waitForStatusFile(path: string | undefined, timeoutMs: number): { exitCode: number; endedAt?: number } | null {
  const deadline = Date.now() + timeoutMs;
  do {
    const status = readStatusFile(path);
    if (status) return status;
    sleepSync(5);
  } while (Date.now() < deadline);
  return null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function statusFileMtime(path?: string): number | undefined {
  if (!path) return undefined;
  try { return statSync(path).mtimeMs; } catch { return undefined; }
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
