import { getTaskManager } from "../engine/task-lifecycle.js";
import { formatJob, getJobManager } from "../tools/jobs.js";
import { formatTodoState } from "../tools/plan.js";
import { p } from "../ui/palette.js";
import type { SlashCommandHandler } from "./types.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeTailTextBoundary } from "../utils/text-boundary.js";

const MAX_SLASH_TASK_ID_CHARS = 80;
const MAX_SLASH_JOB_ID_CHARS = 80;
const MAX_SLASH_TASK_OUTPUT_CHARS = 200_000;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u001F\u007F]/g;

export const tasksCommand: SlashCommandHandler = ({ parts, cmd, runtime, write }) => {
  const tm = getTaskManager();
  const subcmd = parts[1];
  const id = normalizeSlashTaskId(parts[2]);
  if (runtime.liveReadonly && ["cancel", "complete"].includes(subcmd || "")) {
    write(p.warning(`/${cmd.slice(1)} ${subcmd} is not available while the agent is running. Use Esc to interrupt, or wait for the turn to finish.`));
    return;
  }
  if (subcmd === "read") {
    if (!id) {
      write(p.error("Usage: /tasks read <task-id>"));
      return;
    }
    const task = tm.getTask(id) || tm.getHistory().find(item => item.id === id);
    write(task ? safeJsonStringify(task, { space: 2 }) : p.error(`Task not found: ${id}`));
    return;
  }
  if (subcmd === "cancel") {
    if (!id) {
      write(p.error("Usage: /tasks cancel <task-id>"));
      return;
    }
    write(tm.killTask(id) ? p.success(`Cancelled task ${id}.`) : p.error(`Task not active: ${id}`));
    return;
  }
  if (subcmd === "complete") {
    if (!id) {
      write(p.error("Usage: /tasks complete <task-id> [output]"));
      return;
    }
    const payload = slashTaskOutput(parts, 3);
    if ("error" in payload) {
      write(p.error(payload.error));
      return;
    }
    write(tm.completeTask(id, payload.output) ? p.success(`Completed task ${id}.`) : p.error(`Task not active: ${id}`));
    return;
  }
  if (subcmd && subcmd !== "list") {
    write(p.error("Usage: /tasks [list|read <task-id>|cancel <task-id>|complete <task-id> [output]]"));
    return;
  }
  const checklist = formatTodoState();
  if (checklist) write(checklist);
  const stats = tm.getTaskStats();
  write(p.blueBold(`Durable tasks: ${stats.active} active, ${stats.total} total`));
  write(`  Completed: ${stats.completed} | Failed: ${stats.failed} | Killed: ${stats.killed}`);
  if (Object.keys(stats.byType).length) {
    write("  By type: " + Object.entries(stats.byType).map(([k, v]) => `${k}:${v}`).join(" "));
  }
  const active = tm.getActiveTasks();
  for (const t of active.slice(0, 10)) {
    const dur = ((Date.now() - t.startTime) / 1000).toFixed(0);
    write(`  ${t.status === "running" ? "◎" : "○"} [${t.id}] [${t.type}] ${t.description} (${dur}s)`);
  }
};

export const jobsCommand: SlashCommandHandler = ({ parts, cmd, runtime, write }) => {
  const subcmd = parts[1];
  const id = normalizeSlashJobId(parts[2]);
  if (runtime.liveReadonly && ["cancel", "prune"].includes(subcmd || "")) {
    write(p.warning(`/${cmd.slice(1)} ${subcmd} is not available while the agent is running. Use Esc to interrupt, or wait for the turn to finish.`));
    return;
  }
  if (subcmd === "cancel") {
    if (!id) {
      write(p.error("Usage: /jobs cancel <job-id>"));
      return;
    }
    write(getJobManager().cancel(id) ? p.success(`Cancelled job ${id}.`) : p.error(`Job not running: ${id}`));
    return;
  }
  if (subcmd === "show") {
    if (!id) {
      write(p.error("Usage: /jobs show <job-id>"));
      return;
    }
    const job = getJobManager().get(id);
    write(job ? formatJob(job, 4000) : p.error(`Job not found: ${id}`));
    return;
  }
  if (subcmd === "prune") {
    if (parts.length > 2) {
      write(p.error("Usage: /jobs prune"));
      return;
    }
    write(p.success(`Pruned ${getJobManager().prune()} old job(s).`));
    return;
  }
  if (subcmd && subcmd !== "list") {
    write(p.error("Usage: /jobs [list|show <job-id>|cancel <job-id>|prune]"));
    return;
  }
  const jobs = getJobManager().list();
  if (!jobs.length) {
    write(p.dim("No background jobs."));
    return;
  }
  for (const job of jobs.slice(0, 10)) {
    write(formatJob(job, 800));
    write("");
  }
};

function normalizeSlashTaskId(value: string | undefined): string {
  const id = typeof value === "string" ? value.trim() : "";
  return id
    && id.length <= MAX_SLASH_TASK_ID_CHARS
    && /^[A-Za-z0-9_-]+$/.test(id)
    && !CONTROL_TEXT_RE.test(id)
    ? id
    : "";
}

function normalizeSlashJobId(value: string | undefined): string {
  const id = typeof value === "string" ? value.trim() : "";
  return id
    && id.length <= MAX_SLASH_JOB_ID_CHARS
    && /^job_[a-z0-9_]+$/.test(id)
    && !CONTROL_TEXT_RE.test(id)
    ? id
    : "";
}

function slashTaskOutput(parts: string[], startIndex: number): { output?: string } | { error: string } {
  const raw = parts.slice(startIndex).join(" ");
  if (!raw) return {};
  if (CONTROL_TEXT_RE.test(raw)) return { error: "Task output must not contain control characters." };
  const sanitized = raw.replace(CONTROL_TEXT_GLOBAL_RE, " ");
  return {
    output: sanitized.length > MAX_SLASH_TASK_OUTPUT_CHARS
      ? safeTailTextBoundary(sanitized, MAX_SLASH_TASK_OUTPUT_CHARS)
      : sanitized,
  };
}
