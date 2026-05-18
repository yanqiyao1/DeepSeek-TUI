import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearHooks, fireHooks, registerHook } from "../src/engine/hooks.js";
import { clearPersistentTaskStateForTests, getTaskManager, TaskManager } from "../src/engine/task-lifecycle.js";
import { MCPClient } from "../src/mcp/client.js";
import { MCPManager } from "../src/mcp/manager.js";
import { parseSSEFrames, SSETransport } from "../src/server/transport.js";
import { clearArtifactsForTests } from "../src/artifacts/store.js";
import { clearJobManagerForTests, getJobManager, reloadJobManagerForTests } from "../src/tools/jobs.js";
import { getRegistry } from "../src/tools/registry.js";
import { registerShellTool } from "../src/tools/shell.js";
import { registerTaskTools } from "../src/tools/tasks.js";
import { clearPlanState, registerPlanTools } from "../src/tools/plan.js";

let tmp: string;
let oldTasksDir: string | undefined;
let oldJobsDir: string | undefined;
let oldArtifactsDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-runtime-"));
  oldTasksDir = process.env.DEEPCODE_TASKS_DIR;
  oldJobsDir = process.env.DEEPCODE_JOBS_DIR;
  oldArtifactsDir = process.env.DEEPCODE_ARTIFACTS_DIR;
  process.env.DEEPCODE_TASKS_DIR = join(tmp, "tasks");
  process.env.DEEPCODE_JOBS_DIR = join(tmp, "jobs");
  process.env.DEEPCODE_ARTIFACTS_DIR = join(tmp, "artifacts");
  clearJobManagerForTests();
  clearArtifactsForTests();
  getRegistry().clear();
  clearPersistentTaskStateForTests();
  clearPlanState();
  clearHooks();
});

afterEach(() => {
  clearHooks();
  clearPlanState();
  getRegistry().clear();
  clearJobManagerForTests();
  clearArtifactsForTests();
  if (oldTasksDir === undefined) delete process.env.DEEPCODE_TASKS_DIR;
  else process.env.DEEPCODE_TASKS_DIR = oldTasksDir;
  if (oldJobsDir === undefined) delete process.env.DEEPCODE_JOBS_DIR;
  else process.env.DEEPCODE_JOBS_DIR = oldJobsDir;
  if (oldArtifactsDir === undefined) delete process.env.DEEPCODE_ARTIFACTS_DIR;
  else process.env.DEEPCODE_ARTIFACTS_DIR = oldArtifactsDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("shell tool", () => {
  it("terminates commands that exceed timeout", async () => {
    registerShellTool();

    const start = Date.now();
    const result = await getRegistry().lookup("bash")!.execute({ command: "sleep 2", timeout: 50, workdir: tmp });

    expect(Date.now() - start).toBeLessThan(1500);
    expect(result).toMatch(/timed out|signal|exit code/i);
  });

  it("kills foreground shell process groups on timeout", async () => {
    registerShellTool();
    const pidFile = join(tmp, "foreground-child.pid");

    const result = await getRegistry().lookup("bash")!.execute({
      command: `bash -lc 'sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait'`,
      timeout: 500,
      workdir: tmp,
    });
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());

    expect(result).toMatch(/timed out|signal/i);
    await waitFor(() => !isPidAlive(childPid), 2500);
  });

  it("treats invalid negative foreground timeouts as the default instead of timing out immediately", async () => {
    registerShellTool();

    const result = await getRegistry().lookup("bash")!.execute({
      command: "printf stable",
      timeout: -1,
      workdir: tmp,
    });

    expect(result).toContain("stable");
    expect(result).not.toContain("timed out");
    expect(result).toContain("[exit code: 0]");
  });

  it("rejects non-string bash commands without throwing", async () => {
    registerShellTool();

    await expect(getRegistry().lookup("bash")!.execute({ command: 123 as any, workdir: tmp })).resolves.toContain("command must be a non-empty string");
  });

  it("rejects malformed optional shell start arguments instead of silently falling back to defaults", async () => {
    registerShellTool();
    const bashTool = getRegistry().lookup("bash")!;
    const taskShellStart = getRegistry().lookup("task_shell_start")!;

    expect(await bashTool.validateInput?.(
      { command: "printf ok", workdir: { nested: true } as any },
      { tool_name: "bash", workspace_path: tmp, tool_def: bashTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await bashTool.validateInput?.(
      { command: "printf ok", cwd: { nested: true } as any },
      { tool_name: "bash", workspace_path: tmp, tool_def: bashTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await bashTool.validateInput?.(
      { command: "printf ok", timeout: { nested: true } as any },
      { tool_name: "bash", workspace_path: tmp, tool_def: bashTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("timeout must be a number"),
    });
    expect(await bashTool.validateInput?.(
      { command: "printf ok", background: "yes" as any },
      { tool_name: "bash", workspace_path: tmp, tool_def: bashTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("background must be a boolean"),
    });
    expect(await bashTool.validateInput?.(
      { command: "printf ok", pty: "yes" as any },
      { tool_name: "bash", workspace_path: tmp, tool_def: bashTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("pty must be a boolean"),
    });

    expect(await bashTool.execute({ command: "printf ok", workdir: { nested: true } as any })).toContain("workdir must be a string");
    expect(await bashTool.execute({ command: "printf ok", cwd: { nested: true } as any })).toContain("workdir must be a string");
    expect(await bashTool.execute({ command: "printf ok", timeout: { nested: true } as any })).toContain("timeout must be a number");
    expect(await bashTool.execute({ command: "printf ok", background: "yes" as any })).toContain("background must be a boolean");
    expect(await bashTool.execute({ command: "printf ok", pty: "yes" as any })).toContain("pty must be a boolean");

    expect(await taskShellStart.validateInput?.(
      { command: "printf ok", pty: "yes" as any },
      { tool_name: "task_shell_start", workspace_path: tmp, tool_def: taskShellStart },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("pty must be a boolean"),
    });
  });

  it("rejects non-string task gate commands instead of stringifying them into shell input", async () => {
    registerTaskTools();

    expect(await getRegistry().lookup("task_gate_run")!.execute({
      command: { nested: true } as any,
      workdir: tmp,
    })).toContain("command is required");
  });

  it("trims bash workdir aliases during validation and execution", async () => {
    registerShellTool();
    const bashTool = getRegistry().lookup("bash")!;

    expect(await bashTool.validateInput?.(
      { command: "pwd", cwd: `  ${tmp}  ` },
      { tool_name: "bash", workspace_path: tmp, tool_def: bashTool },
    )).toMatchObject({
      ok: true,
      args: {
        command: "pwd",
        workdir: tmp,
      },
    });

    const result = await bashTool.execute({ command: "pwd", workdir: `  ${tmp}  ` });

    expect(result).toContain(tmp);
    expect(result).toContain("[exit code: 0]");
  });

  it("resolves relative bash workdirs against the execution workspace context", async () => {
    registerShellTool();
    const workspace = join(tmp, "workspace");
    const nested = join(workspace, "pkg", "src");
    mkdirSync(nested, { recursive: true });

    const result = await getRegistry().lookup("bash")!.execute(
      { command: "pwd", workdir: "pkg/src" },
      { workspacePath: workspace },
    );

    expect(result).toContain(nested);
    expect(result).toContain("[exit code: 0]");
  });

  it("starts, polls, and cancels background shell jobs", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({ command: "printf hello && sleep 1", workdir: tmp });
    const id = started.match(/job_[a-z0-9_]+/)?.[0];

    expect(id).toBeTruthy();
    expect(await getRegistry().lookup("task_shell_wait")!.execute({ id })).toContain("hello");
    expect(await getRegistry().lookup("exec_shell_cancel")!.execute({ id })).toMatch(/Cancelled|not running/);
  });

  it("kills background job process groups when cancelled", async () => {
    registerShellTool();
    const pidFile = join(tmp, "background-child.pid");

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: `bash -lc 'sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait'`,
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => existsSync(pidFile));
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());

    expect(await getRegistry().lookup("exec_shell_cancel")!.execute({ id })).toContain("Cancelled");
    await waitFor(() => !isPidAlive(childPid), 2500);
  });

  it("times out background jobs and records failure output", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "echo start; sleep 5; echo never",
      workdir: tmp,
      timeout: 100,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    const output = await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(text => text.includes("status: failed") ? text : ""), 2500);

    expect(output).toContain("start");
    expect(output).toMatch(/timeout|exit_code: 124|exit_code: 137/i);
    expect(getJobManager().get(id)?.output).not.toContain("never");
  });

  it("persists background job logs and reattaches running jobs after restart", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "printf persisted && sleep 1",
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("\npersisted")));
    const before = getJobManager().get(id)!;

    expect(before.logFile).toBeTruthy();
    expect(existsSync(before.logFile!)).toBe(true);
    expect(readFileSync(before.logFile!, "utf-8")).toContain("persisted");

    reloadJobManagerForTests();
    const after = getJobManager().get(id);

    expect(after?.status).toBe("running");
    expect(after?.reattachable).toBe(true);
    expect(after?.output).toContain("persisted");
  });

  it("reattaches stdin to a running job after manager restart", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "bash -lc 'echo ready; IFS= read -r value; echo got:$value'",
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("ready")));

    reloadJobManagerForTests();
    expect(await getRegistry().lookup("exec_shell_interact")!.execute({ id, input: "after-restart\n" })).toContain("Sent");
    const done = await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("got:after-restart") ? output : ""));

    expect(done).toContain("status: completed");
  });

  it("normalizes invalid negative shell wait tails instead of slicing logs from the front", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "printf tail-check",
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("status: completed") ? output : ""));

    const output = await getRegistry().lookup("exec_shell_wait")!.execute({ id, tail_chars: -1 });

    expect(output).toContain("tail-check");
    expect(output).toContain("status: completed");
  });

  it("normalizes job_id aliases for shell job polling validation", async () => {
    registerShellTool();
    const waitTool = getRegistry().lookup("exec_shell_wait")!;
    const validation = await waitTool.validateInput?.(
      { job_id: "job_123", tail_chars: 20 },
      { tool_name: "exec_shell_wait", workspace_path: tmp, tool_def: waitTool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        id: "job_123",
        tail_chars: 20,
      },
    });
  });

  it("rejects malformed shell wait tail sizes instead of coercing them into defaults", async () => {
    registerShellTool();
    const waitTool = getRegistry().lookup("exec_shell_wait")!;
    const taskWaitTool = getRegistry().lookup("task_shell_wait")!;

    expect(await waitTool.validateInput?.(
      { id: "job_123", tail_chars: { nested: true } as any },
      { tool_name: "exec_shell_wait", workspace_path: tmp, tool_def: waitTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("tail_chars must be a number"),
    });
    expect(await taskWaitTool.validateInput?.(
      { id: "job_123", tail_chars: { nested: true } as any },
      { tool_name: "task_shell_wait", workspace_path: tmp, tool_def: taskWaitTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("tail_chars must be a number"),
    });

    expect(await waitTool.execute({ id: "job_123", tail_chars: { nested: true } as any })).toContain("tail_chars must be a number");
    for (const value of ["10.5", "100chars", "0x10", ""]) {
      expect(await waitTool.validateInput?.(
        { id: "job_123", tail_chars: value },
        { tool_name: "exec_shell_wait", workspace_path: tmp, tool_def: waitTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("tail_chars must be a number"),
      });
      expect(await taskWaitTool.validateInput?.(
        { id: "job_123", tail_chars: value },
        { tool_name: "task_shell_wait", workspace_path: tmp, tool_def: taskWaitTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("tail_chars must be a number"),
      });
      expect(await waitTool.execute({ id: "job_123", tail_chars: value })).toContain("tail_chars must be a number");
    }
  });

  it("rejects non-string shell job ids during validation instead of stringifying objects", async () => {
    registerShellTool();
    const waitTool = getRegistry().lookup("exec_shell_wait")!;

    expect(await waitTool.validateInput?.(
      { id: { nested: true } as any },
      { tool_name: "exec_shell_wait", workspace_path: tmp, tool_def: waitTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("id is required"),
    });
  });

  it("rejects non-string shell job ids during execution instead of looking up [object Object]", async () => {
    registerShellTool();

    expect(await getRegistry().lookup("exec_shell_wait")!.execute({ id: { nested: true } as any })).toContain("id is required");
    expect(await getRegistry().lookup("exec_shell_cancel")!.execute({ id: { nested: true } as any })).toContain("id is required");
    expect(await getRegistry().lookup("exec_shell_interact")!.execute({ id: { nested: true } as any, input: "hello" })).toContain("id is required");
  });

  it("rejects non-string shell stdin payloads during execution instead of stringifying objects into job input", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "bash -lc 'echo ready; sleep 1'",
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("ready")));

    expect(await getRegistry().lookup("exec_shell_interact")!.execute({ id, input: { nested: true } as any })).toContain("input must be a string");
  });

  it("starts background jobs with PTY support by default", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({ command: "printf pty-ok", workdir: tmp });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    const output = await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(text => text.includes("pty-ok") ? text : ""));

    expect(output).toContain("pty: yes");
    expect(output).toContain("pty-ok");
  });

  it("supports stdin interaction for PTY jobs", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "bash -lc 'echo pty-ready; IFS= read -r value; echo pty-got:$value'",
      workdir: tmp,
      pty: true,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("pty-ready")));

    expect(await getRegistry().lookup("exec_shell_interact")!.execute({ id, input: "catnip\n" })).toContain("Sent");
    const done = await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("pty-got:catnip") ? output : ""), 2500);

    expect(done).toContain("status: completed");
  });

  it("reloads only job metadata and ignores status helper json files", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({ command: "printf done", workdir: tmp, pty: false });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("status: completed")));

    reloadJobManagerForTests();
    const jobs = getJobManager().list();

    expect(jobs.map(job => job.id)).toEqual([id]);
    expect(jobs[0].status).toBe("completed");
  });

  it("ignores persisted job records with malformed typed fields during reload", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();

    const startedAt = Date.now() - 1_000;
    const endedAt = startedAt + 250;

    writeFileSync(join(jobsDir, "job_valid.json"), JSON.stringify({
      id: "job_valid",
      command: "printf kept",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt,
      endedAt,
      output: "kept\n",
    }), "utf-8");

    writeFileSync(join(jobsDir, "job_malformed.json"), JSON.stringify({
      id: { nested: true },
      command: "printf dropped",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt,
      endedAt,
      output: "dropped\n",
    }), "utf-8");

    reloadJobManagerForTests();
    const jobs = getJobManager().list();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: "job_valid",
      command: "printf kept",
      status: "completed",
      output: "kept\n",
    });
  });

  it("ignores malformed job status helper payloads instead of coercing them into successful completion", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();

    const statusFile = join(jobsDir, "job_status_malformed.status.json");
    writeFileSync(statusFile, JSON.stringify({ exitCode: false, endedAt: "0" }), "utf-8");
    writeFileSync(join(jobsDir, "job_status_malformed.json"), JSON.stringify({
      id: "job_status_malformed",
      command: "printf stale",
      workdir: tmp,
      status: "running",
      exitCode: null,
      startedAt: Date.now() - 1_000,
      output: "stale\n",
      statusFile,
      pid: 999_999_999,
    }), "utf-8");

    reloadJobManagerForTests();
    const job = getJobManager().get("job_status_malformed");

    expect(job).toMatchObject({
      id: "job_status_malformed",
      status: "stale",
      exitCode: null,
    });
    expect(job?.output).toContain("[stale] Supervisor is no longer running");
  });

  it("ignores persisted job records with unsafe ids, paths, pids, or blocked commands during reload", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    const outsideLog = join(tmp, "outside.log");
    getJobManager();
    writeFileSync(outsideLog, "SECRET\n", "utf-8");
    writeFileSync(join(jobsDir, "job_kept.json"), JSON.stringify({
      id: "job_kept",
      command: "printf kept",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now() - 2_000,
      endedAt: Date.now() - 1_000,
      output: "kept\n",
      logFile: join(jobsDir, "job_kept.log"),
    }), "utf-8");
    writeFileSync(join(jobsDir, "job_bad_id.json"), JSON.stringify({
      id: "../job_bad_id",
      command: "printf bad",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now(),
      output: "bad\n",
    }), "utf-8");
    writeFileSync(join(jobsDir, "job_bad_command.json"), JSON.stringify({
      id: "job_bad_command",
      command: "rm -rf /",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now(),
      output: "bad\n",
    }), "utf-8");
    writeFileSync(join(jobsDir, "job_bad_path.json"), JSON.stringify({
      id: "job_bad_path",
      command: "printf bad",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now(),
      output: "bad\n",
      logFile: outsideLog,
    }), "utf-8");
    writeFileSync(join(jobsDir, "job_bad_pid.json"), JSON.stringify({
      id: "job_bad_pid",
      command: "printf bad",
      workdir: tmp,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      output: "bad\n",
      pid: -1,
    }), "utf-8");

    reloadJobManagerForTests();
    const jobs = getJobManager().list();

    expect(jobs.map(job => job.id)).toEqual(["job_kept"]);
    expect(jobs[0].output).not.toContain("SECRET");
  });
});

describe("task tools", () => {
  it("creates, lists, reads, completes, and persists durable tasks", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({ description: "Investigate bug" }));
    const listed = await getRegistry().lookup("task_list")!.execute({});
    const read = await getRegistry().lookup("task_read")!.execute({ id: created.id });
    const completed = await getRegistry().lookup("task_complete")!.execute({ id: created.id, output: "done" });
    const reloaded = getTaskManager().getHistory().find(task => task.id === created.id);

    expect(listed).toContain(created.id);
    expect(read).toContain("Investigate bug");
    expect(completed).toContain("Completed");
    expect(reloaded?.status).toBe("completed");
  });

  it("includes checklist_write state in task_list output", async () => {
    registerPlanTools();
    registerTaskTools();

    await getRegistry().lookup("checklist_write")!.execute({
      items: [
        { content: "Draft experiment plan", status: "in_progress" },
        { content: "Define core method", status: "pending" },
      ],
    });
    const listed = JSON.parse(await getRegistry().lookup("task_list")!.execute({}));

    expect(listed.checklist).toMatchObject([
      { id: 1, content: "Draft experiment plan", status: "in_progress" },
      { id: 2, content: "Define core method", status: "pending" },
    ]);
    expect(listed.stats.total).toBe(0);
  });

  it("executes queued shell tasks and keeps completed artifacts", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Durable echo",
      command: "printf queued-task",
      workdir: tmp,
    }));
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "completed" ? task : null;
    });

    expect(done.output).toContain("queued-task");
    expect(done.outputFile && existsSync(done.outputFile)).toBe(true);
  });

  it("retries queued shell tasks up to max attempts", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Retry once",
      command: "if [ ! -f retry.marker ]; then touch retry.marker; echo first; exit 1; fi; echo second",
      workdir: tmp,
      max_attempts: 2,
    }));
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "completed" ? task : null;
    }, 2500);

    expect(done.attempts).toBe(2);
    expect(done.output).toContain("Retrying queued task");
    expect(done.output).toContain("second");
  });

  it("marks timed-out queued shell tasks as failed", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Timeout task",
      command: "sleep 5",
      workdir: tmp,
      timeout: 100,
    }));
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "failed" ? task : null;
    }, 2500);

    expect(done.signal || done.exitCode).toBeTruthy();
    expect(done.output).toMatch(/exit code|signal/i);
  });

  it("normalizes invalid negative queued task timeouts instead of crashing spawn", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Negative timeout task",
      command: "printf queued-ok",
      workdir: tmp,
      timeout: -1,
    }));
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "completed" ? task : null;
    }, 2500);

    expect(done.output).toContain("queued-ok");
    expect(done.output).not.toContain("The value of \"timeout\" is out of range");
  });

  it("rejects malformed string task numeric options instead of silently defaulting them", async () => {
    registerTaskTools();
    const taskCreate = getRegistry().lookup("task_create")!;
    const gateTool = getRegistry().lookup("task_gate_run")!;

    for (const value of ["10.5", "100ms", "0x10", ""]) {
      expect(await taskCreate.validateInput?.(
        { description: "bad timeout", command: "printf ok", workdir: tmp, timeout: value },
        { tool_name: "task_create", workspace_path: tmp, tool_def: taskCreate },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("timeout must be a number"),
      });
      expect(await taskCreate.execute({
        description: "bad timeout",
        command: "printf ok",
        workdir: tmp,
        timeout: value,
      })).toContain("timeout must be a number");

      expect(await gateTool.validateInput?.(
        { command: "printf ok", workdir: tmp, timeout: value },
        { tool_name: "task_gate_run", workspace_path: tmp, tool_def: gateTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("timeout must be a number"),
      });
      expect(await gateTool.execute({ command: "printf ok", workdir: tmp, timeout: value })).toContain("timeout must be a number");
    }

    for (const value of ["2.5", "2x", "0x10", ""]) {
      expect(await taskCreate.validateInput?.(
        { description: "bad attempts", command: "printf ok", workdir: tmp, max_attempts: value },
        { tool_name: "task_create", workspace_path: tmp, tool_def: taskCreate },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("max_attempts must be a number"),
      });
      expect(await taskCreate.execute({
        description: "bad attempts",
        command: "printf ok",
        workdir: tmp,
        max_attempts: value,
      })).toContain("max_attempts must be a number");
    }
  });

  it("runs task verification gates with pass and fail evidence", async () => {
    registerShellTool();
    registerTaskTools();

    const passed = JSON.parse(await getRegistry().lookup("task_gate_run")!.execute({ command: "printf pass", workdir: tmp }));
    const failed = JSON.parse(await getRegistry().lookup("task_gate_run")!.execute({ command: "printf fail && exit 7", workdir: tmp }));

    expect(passed).toMatchObject({ passed: true });
    expect(passed.output).toContain("pass");
    expect(failed).toMatchObject({ passed: false });
    expect(failed.output).toContain("[exit code: 7]");
  });

  it("normalizes invalid negative gate timeouts instead of surfacing spawn range errors", async () => {
    registerShellTool();
    registerTaskTools();

    const passed = JSON.parse(await getRegistry().lookup("task_gate_run")!.execute({
      command: "printf gate-ok",
      workdir: tmp,
      timeout: -1,
    }));

    expect(passed).toMatchObject({ passed: true });
    expect(passed.output).toContain("gate-ok");
    expect(passed.output).not.toContain("out of range");
  });

  it("trims task_gate_run workdir aliases during validation and execution", async () => {
    registerShellTool();
    registerTaskTools();
    const gateTool = getRegistry().lookup("task_gate_run")!;

    expect(await gateTool.validateInput?.(
      { command: "pwd", cwd: `  ${tmp}  ` },
      { tool_name: "task_gate_run", workspace_path: tmp, tool_def: gateTool },
    )).toMatchObject({
      ok: true,
      args: {
        command: "pwd",
        workdir: tmp,
      },
    });

    const result = JSON.parse(await gateTool.execute({ command: "pwd", workdir: `  ${tmp}  ` }));

    expect(result.workdir).toBe(tmp);
    expect(result.passed).toBe(true);
    expect(result.output).toContain(tmp);
  });

  it("requeues resumable tasks after manager restart instead of killing them", async () => {
    const store = join(tmp, "tasks", "tasks.json");
    const manager = new TaskManager(store);
    const task = manager.createTask("bash", "Restartable", {
      queue: { kind: "shell", command: "printf resumed", workdir: tmp },
      attempts: 0,
      maxAttempts: 1,
    });
    manager.startTask(task.id);

    const reloaded = new TaskManager(store);
    const done = await waitFor(() => {
      const finished = reloaded.getHistory().find(item => item.id === task.id);
      return finished?.status === "completed" ? finished : null;
    });

    expect(done.output).toContain("resumed");
  });

  it("does not requeue persisted shell tasks whose commands are blocked by policy", () => {
    const store = join(tmp, "tasks", "tasks.json");
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    writeFileSync(store, JSON.stringify({
      active: [
        {
          id: "bblocked1",
          type: "bash",
          status: "running",
          description: "Blocked requeue",
          startTime: Date.now() - 1000,
          notified: false,
          queue: { kind: "shell", command: "rm -rf /", workdir: tmp },
          attempts: 0,
          maxAttempts: 1,
        },
      ],
      history: [],
    }, null, 2), "utf-8");

    const reloaded = new TaskManager(store);

    expect(reloaded.getActiveTasks()).toEqual([]);
    expect(reloaded.getHistory()).toEqual([
      expect.objectContaining({
        id: "bblocked1",
        status: "failed",
        output: expect.stringContaining("blocked by policy"),
      }),
    ]);
  });

  it("ignores persisted task records with unsafe ids, paths, or counters during reload", () => {
    const store = join(tmp, "tasks", "tasks.json");
    const outsideOutput = join(tmp, "outside-task.log");
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    writeFileSync(outsideOutput, "SECRET", "utf-8");
    writeFileSync(store, JSON.stringify({
      active: [
        {
          id: "bgkept01",
          type: "background",
          status: "running",
          description: "Kept task",
          startTime: 100,
          notified: false,
        },
        {
          id: "../bgbadid",
          type: "background",
          status: "running",
          description: "Bad id",
          startTime: 100,
          notified: false,
        },
        {
          id: "bgbadpath",
          type: "background",
          status: "running",
          description: "Bad output path",
          startTime: 100,
          notified: false,
          outputFile: outsideOutput,
        },
        {
          id: "bgbadcount",
          type: "bash",
          status: "running",
          description: "Bad attempts",
          startTime: 100,
          notified: false,
          queue: { kind: "shell", command: "printf ok", workdir: tmp, timeoutMs: -1 },
          attempts: -1,
          maxAttempts: 1,
        },
      ],
      history: [],
    }, null, 2), "utf-8");

    const reloaded = new TaskManager(store);

    expect(reloaded.getActiveTasks()).toEqual([]);
    expect(reloaded.getHistory()).toEqual([
      expect.objectContaining({
        id: "bgkept01",
        status: "killed",
        description: "Kept task",
      }),
    ]);
  });

  it("ignores malformed persisted task records without dropping neighboring valid tasks on reload", () => {
    const store = join(tmp, "tasks", "tasks.json");
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    writeFileSync(store, JSON.stringify({
      active: [
        {
          id: "bgvalid01",
          type: "background",
          status: "running",
          description: "Valid active task",
          startTime: 100,
          notified: false,
        },
        {
          id: { nested: true },
          type: "background",
          status: "running",
          description: "Broken active task",
          startTime: 200,
          notified: false,
        },
      ],
      history: [
        {
          id: "bgdone001",
          type: "background",
          status: "completed",
          description: "Valid completed task",
          startTime: 50,
          endTime: 75,
          notified: true,
        },
        {
          id: "bgbad001",
          type: "background",
          status: { nested: true },
          description: "Broken completed task",
          startTime: 60,
          notified: true,
        },
      ],
    }, null, 2), "utf-8");

    const reloaded = new TaskManager(store);

    expect(reloaded.getActiveTasks()).toEqual([]);
    expect(reloaded.getHistory()).toEqual([
      expect.objectContaining({
        id: "bgvalid01",
        status: "killed",
        description: "Valid active task",
      }),
      expect.objectContaining({
        id: "bgdone001",
        status: "completed",
        description: "Valid completed task",
      }),
    ]);
  });
});

describe("MCPClient", () => {
  it("rejects pending requests when stdio server exits", async () => {
    const server = join(tmp, "server.mjs");
    writeFileSync(server, "process.exit(0);\n");
    const client = new MCPClient({ name: "dead", transport: "stdio", command: process.execPath, args: [server], env: {} });

    await client.connect();

    await expect(client.initialize()).rejects.toThrow(/exited|closed|timed out/i);
  });

  it("registers only sanitized MCP tool names from server and tool identifiers", async () => {
    const registeredTools = [
      { name: "safe_tool", description: "safe", inputSchema: { type: "object", properties: {} } },
      { name: "bad-name", description: "bad hyphen", inputSchema: { type: "object", properties: {} } },
      { name: "../escape", description: "bad path", inputSchema: { type: "object", properties: {} } },
      { name: "tool with spaces", description: "bad spaces", inputSchema: { type: "object", properties: {} } },
      { name: "123bad", description: "bad leading digit", inputSchema: { type: "object", properties: {} } },
    ];
    const client = {
      callTool: async (name: string, args: Record<string, unknown>) => `${name}:${JSON.stringify(args)}`,
    };
    const manager = new MCPManager({
      mcp_servers: [],
    } as any);

    (manager as any).registerTools({ name: "team.server/1" }, client, registeredTools);

    expect(getRegistry().lookup("mcp_team_server_1_safe_tool")).toBeTruthy();
    expect(await getRegistry().lookup("mcp_team_server_1_safe_tool")!.execute({ ok: true })).toBe("safe_tool:{\"ok\":true}");
    expect(getRegistry().listAll().filter(tool => tool.name.startsWith("mcp_")).map(tool => tool.name)).toEqual(["mcp_team_server_1_safe_tool"]);
    expect(getRegistry().lookup("mcp_team.server/1_safe_tool")).toBeUndefined();
    expect(getRegistry().lookup("mcp_team_server_1_bad-name")).toBeUndefined();

    await manager.disconnectAll();
  });
});

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 1500): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (last) return last as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for condition");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

describe("SSE frame parser", () => {
  it("parses CRLF frames and preserves unfinished remainder", () => {
    const parsed = parseSSEFrames("event: content\r\ndata: hello\r\n\r\ndata: partial");

    expect(parsed.frames).toEqual([{ event: "content", data: "hello" }]);
    expect(parsed.remaining).toBe("data: partial");
  });

  it("ignores keepalive comments without dropping data frames that include comments", () => {
    const parsed = parseSSEFrames(": keepalive\n\nevent: msg\n: ignored\ndata: ok\n\n");

    expect(parsed.frames).toEqual([{ event: "msg", data: "ok" }]);
  });
});

describe("SSE transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reconnects after liveness timeout instead of disabling auto-reconnect", async () => {
    vi.useFakeTimers();
    let firstController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            firstController = controller;
            // Hold the connection open without sending any data.
          },
        }),
      });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const onMessage = vi.fn();
    const onError = vi.fn();
    const getReconnectDelay = vi.fn(() => 0);
    const onStateChange = vi.fn();
    const transport = new SSETransport({
      url: "http://localhost/sse",
      events: { onMessage, onError, onStateChange },
      getReconnectDelay,
    });

    try {
      const connectPromise = transport.connect();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(45_000);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "SSE liveness timeout" }));
      expect(getReconnectDelay).toHaveBeenCalledWith(0);
      expect(transport.currentState).toBe("connecting");
      expect(onStateChange).toHaveBeenNthCalledWith(1, "connecting");
      expect(onStateChange.mock.calls.map(args => args[0])).toContain("disconnected");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onMessage).not.toHaveBeenCalled();

      transport.disconnect();
      firstController?.close();
      await connectPromise;
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("reconnects when the SSE stream ends cleanly", async () => {
    vi.useFakeTimers();
    let secondController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: once\n\n"));
            controller.close();
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            secondController = controller;
            controller.enqueue(new TextEncoder().encode("data: twice\n\n"));
          },
        }),
      });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const onMessage = vi.fn();
    const transport = new SSETransport({
      url: "http://localhost/sse",
      events: { onMessage },
      getReconnectDelay: () => 0,
    });

    try {
      await transport.connect();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onMessage).toHaveBeenNthCalledWith(1, "once");
      expect(onMessage).toHaveBeenNthCalledWith(2, "twice");
    } finally {
      transport.disconnect();
      secondController?.close();
      globalThis.fetch = oldFetch;
    }
  });
});

describe("hooks", () => {
  it("aggregates hook messages and lets deny win", async () => {
    registerHook({ event: "PreToolUse", command: `${process.execPath} -e "console.log(JSON.stringify({decision:'continue', message:'first'}))"` });
    registerHook({ event: "PreToolUse", command: `${process.execPath} -e "console.log(JSON.stringify({decision:'deny', message:'blocked'}))"` });
    registerHook({ event: "PreToolUse", command: `${process.execPath} -e "console.log(JSON.stringify({decision:'approve', message:'late'}))"` });

    const result = await fireHooks("PreToolUse", { tool_name: "bash", tool_input: { command: "echo hi" }, cwd: tmp });

    expect(result.decision).toBe("deny");
    expect(result.message).toBe("blocked");
    expect(result.fired).toBe(2);
  });
});
