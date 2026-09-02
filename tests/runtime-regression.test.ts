import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearHooks, fireHooks, getHooks, registerHook } from "../src/engine/hooks.js";
import { clearPersistentTaskStateForTests, defaultTaskStoreFile, getTaskManager, TaskManager } from "../src/engine/task-lifecycle.js";
import { MCPClient } from "../src/mcp/client.js";
import { MCPManager } from "../src/mcp/manager.js";
import { defaultReconnectDelay, parseSSEFrames, SSETransport } from "../src/server/transport.js";
import { clearArtifactsForTests, readArtifact } from "../src/artifacts/store.js";
import { clearJobManagerForTests, defaultJobsDir, formatJob, getJobManager, reloadJobManagerForTests } from "../src/tools/jobs.js";
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
  it("applies deny policy to background shell commands", async () => {
    registerShellTool();

    const result = await getRegistry().lookup("bash")!.execute({
      command: "rm -rf /",
      background: true,
      pty: false,
      workdir: tmp,
    });

    expect(result).toContain("Command blocked by policy");
    expect(result).toContain("recursive root deletion");
    expect(existsSync(process.env.DEEPCODE_JOBS_DIR!)).toBe(false);
  });

  it("fails closed when the jobs directory is a symlink", async () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    const outside = join(tmp, "outside-jobs");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, jobsDir, "dir");

    registerShellTool();
    const result = await getRegistry().lookup("bash")!.execute({
      command: "printf should-not-start",
      background: true,
      pty: false,
      workdir: tmp,
    });

    expect(result).toContain("unsafe jobs directory");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("terminates commands that exceed timeout", async () => {
    registerShellTool();

    const start = Date.now();
    const result = await getRegistry().lookup("bash")!.execute({ command: "sleep 2", timeout: 100, workdir: tmp });

    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toMatch(/timed out|signal|exit code/i);
    expect(result).toContain("timed out after 100ms");
  });

  it("kills foreground shell process groups on timeout", async () => {
    registerShellTool();
    const pidFile = join(tmp, "foreground-child.pid");

    const resultPromise = getRegistry().lookup("bash")!.execute({
      command: `bash -lc 'sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait'`,
      timeout: 2_000,
      workdir: tmp,
    });
    await waitFor(() => existsSync(pidFile), 2500);
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());
    const result = await resultPromise;

    expect(result).toMatch(/timed out|signal/i);
    await waitFor(() => !isPidAlive(childPid), 2500);
  });

  it("kills foreground shell process groups when the tool signal is aborted", async () => {
    registerShellTool();
    const pidFile = join(tmp, "foreground-abort-child.pid");
    const controller = new AbortController();

    const resultPromise = getRegistry().lookup("bash")!.execute({
      command: `bash -lc 'sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait'`,
      timeout: 5_000,
      workdir: tmp,
    }, { signal: controller.signal });
    await waitFor(() => existsSync(pidFile));
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());
    controller.abort();
    const result = await resultPromise;

    expect(result).toContain("[aborted]");
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
    })).toContain("command must be a string");
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
      command: "printf persisted && sleep 5",
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

  it("does not cancel an unrelated process when a persisted job PID is reused", async () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    mkdirSync(jobsDir, { recursive: true });
    const unrelated = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    unrelated.unref();
    const unrelatedPid = unrelated.pid!;
    try {
      const id = "job_pid_reuse";
      const paths = {
        logFile: join(jobsDir, `${id}.log`),
        inputFile: join(jobsDir, `${id}.in`),
        statusFile: join(jobsDir, `${id}.status.json`),
        commandFile: join(jobsDir, `${id}.cmd`),
        supervisorFile: join(jobsDir, `${id}.supervisor.sh`),
      };
      for (const path of Object.values(paths)) writeFileSync(path, "", "utf-8");
      writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify({
        id,
        command: "sleep 30",
        workdir: tmp,
        status: "running",
        exitCode: null,
        signal: null,
        startedAt: Date.now(),
        output: "",
        pid: unrelatedPid,
        ...paths,
        artifactIds: [],
        pty: false,
        reattachable: true,
        lastInputAt: null,
        endedAt: null,
      }), "utf-8");

      reloadJobManagerForTests();
      expect(getJobManager().cancel(id)).toBe(true);
      expect(isPidAlive(unrelatedPid)).toBe(true);
    } finally {
      try { process.kill(unrelatedPid, "SIGTERM"); } catch { /* process may have exited */ }
    }
  });

  it("fails stdin writes promptly when a persisted FIFO has no reader", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    mkdirSync(jobsDir, { recursive: true });
    const id = "job_orphaned_fifo";
    const paths = {
      logFile: join(jobsDir, `${id}.log`),
      inputFile: join(jobsDir, `${id}.in`),
      statusFile: join(jobsDir, `${id}.status.json`),
      commandFile: join(jobsDir, `${id}.cmd`),
      supervisorFile: join(jobsDir, `${id}.supervisor.sh`),
    };
    writeFileSync(paths.logFile, "", "utf-8");
    execFileSync("mkfifo", [paths.inputFile]);
    writeFileSync(paths.statusFile, "", "utf-8");
    writeFileSync(paths.commandFile, "read value", "utf-8");
    writeFileSync(paths.supervisorFile, "", "utf-8");
    writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify({
      id,
      command: "read value",
      workdir: tmp,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      output: "",
      ...paths,
    }), "utf-8");

    reloadJobManagerForTests();
    const startedAt = Date.now();
    expect(getJobManager().write(id, "hello\n")).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("writes the full maximum-sized stdin payload to a background job", async () => {
    registerShellTool();
    const readerScript = join(tmp, "read-large-stdin.mjs");
    writeFileSync(readerScript, [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  input += chunk;",
      "  const newline = input.indexOf('\\n');",
      "  if (newline >= 0) { console.log(input.slice(0, newline).length); process.exit(0); }",
      "});",
    ].join("\n"), "utf-8");
    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: `${process.execPath} ${JSON.stringify(readerScript)}`,
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    const input = `${"x".repeat(49_999)}\n`;

    expect(getJobManager().write(id, input)).toBe(true);
    const done = await waitFor(() => {
      const job = getJobManager().get(id);
      return job?.status === "completed" ? job : null;
    }, 2_500);
    expect(done.output).toContain("49999");
  });

  it("keeps supervisor output on its opened file even if the log path is replaced", async () => {
    registerShellTool();
    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "sleep 0.2; printf safe-output",
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    const job = getJobManager().get(id)!;
    const outsideLog = join(tmp, "outside-supervisor.log");
    writeFileSync(outsideLog, "", "utf-8");
    rmSync(job.logFile!, { force: true });
    symlinkSync(outsideLog, job.logFile!, "file");

    const output = await waitFor(
      () => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(text => text.includes("status: completed") ? text : ""),
      2500,
    );

    expect(output).toContain("status: completed");
    expect(readFileSync(outsideLog, "utf-8")).not.toContain("safe-output");
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

  it("keeps shell output tails on full grapheme boundaries", async () => {
    registerShellTool();
    const family = "👨‍👩‍👧‍👦";

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "node -e 'process.stdout.write(\"x\".repeat(20) + \"👨‍👩‍👧‍👦\")'",
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("status: completed") ? output : ""));

    const output = await getRegistry().lookup("exec_shell_wait")!.execute({ id, tail_chars: 40 });
    const tail = output.split("reattachable: yes\n\n").at(-1) || "";

    expect(output).toContain("status: completed");
    expect(tail).toContain(family);
    expect(hasUnpairedSurrogate(tail)).toBe(false);

    const clipped = await getRegistry().lookup("exec_shell_wait")!.execute({ id, tail_chars: 10 });
    const clippedTail = clipped.split("reattachable: yes\n\n").at(-1) || "";
    expect(clippedTail).not.toContain(family);
    expect(clippedTail).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(clippedTail)).toBe(false);
  });

  it("reloads byte-clipped job logs without UTF-8 replacement characters", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();
    const startedAt = Date.now() - 1_000;
    const logFile = join(jobsDir, "job_utf8_tail.log");
    const statusFile = join(jobsDir, "job_utf8_tail.status.json");
    const emoji = "👨";
    writeFileSync(logFile, "x".repeat(200_000 * 4 - 2) + emoji + "tail", "utf-8");
    writeFileSync(statusFile, JSON.stringify({ exitCode: 0, endedAt: Date.now() }), "utf-8");
    writeFileSync(join(jobsDir, "job_utf8_tail.json"), JSON.stringify({
      id: "job_utf8_tail",
      command: "printf utf8",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt,
      endedAt: Date.now(),
      output: "",
      logFile,
      statusFile,
    }), "utf-8");

    reloadJobManagerForTests();
    const output = getJobManager().get("job_utf8_tail")!.output;

    expect(output).toContain("tail");
    expect(output).not.toContain("\ufffd");
    expect(hasUnpairedSurrogate(output)).toBe(false);
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

  it("rejects malformed shell job ids during validation and execution", async () => {
    registerShellTool();
    const waitTool = getRegistry().lookup("exec_shell_wait")!;
    const cancelTool = getRegistry().lookup("exec_shell_cancel")!;
    const interactTool = getRegistry().lookup("exec_shell_interact")!;

    for (const id of ["../job_escape", "job_bad\u0000id", `job_${"x".repeat(90)}`]) {
      expect(await waitTool.validateInput?.(
        { id },
        { tool_name: "exec_shell_wait", workspace_path: tmp, tool_def: waitTool },
      )).toMatchObject({ ok: false });
      expect(await cancelTool.validateInput?.(
        { id },
        { tool_name: "exec_shell_cancel", workspace_path: tmp, tool_def: cancelTool },
      )).toMatchObject({ ok: false });
      expect(await interactTool.validateInput?.(
        { id, input: "hello" },
        { tool_name: "exec_shell_interact", workspace_path: tmp, tool_def: interactTool },
      )).toMatchObject({ ok: false });
      expect(await waitTool.execute({ id })).toMatch(/id contains|id must be/);
      expect(await cancelTool.execute({ id })).toMatch(/id contains|id must be/);
      expect(await interactTool.execute({ id, input: "hello" })).toMatch(/id contains|id must be/);
    }
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

  it("handles shell tool argument getters without throwing from validation or execution", async () => {
    registerShellTool();
    const waitTool = getRegistry().lookup("exec_shell_wait")!;
    const interactTool = getRegistry().lookup("exec_shell_interact")!;
    const cancelTool = getRegistry().lookup("exec_shell_cancel")!;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "id", {
      enumerable: true,
      get() {
        throw new Error("id getter failed");
      },
    });
    Object.defineProperty(hostile, "tail_chars", {
      enumerable: true,
      get() {
        throw new Error("tail getter failed");
      },
    });
    Object.defineProperty(hostile, "input", {
      enumerable: true,
      get() {
        throw new Error("input getter failed");
      },
    });

    expect(await waitTool.validateInput?.(hostile, { tool_name: "exec_shell_wait", workspace_path: tmp, tool_def: waitTool })).toMatchObject({ ok: false });
    expect(await interactTool.validateInput?.(hostile, { tool_name: "exec_shell_interact", workspace_path: tmp, tool_def: interactTool })).toMatchObject({ ok: false });
    expect(await cancelTool.validateInput?.(hostile, { tool_name: "exec_shell_cancel", workspace_path: tmp, tool_def: cancelTool })).toMatchObject({ ok: false });
    await expect(waitTool.execute(hostile)).resolves.not.toContain("getter failed");
    await expect(interactTool.execute(hostile)).resolves.not.toContain("getter failed");
    await expect(cancelTool.execute(hostile)).resolves.toContain("id is required");
    expect(() => waitTool.getPermissionPatterns?.(hostile)).not.toThrow();
    expect(() => interactTool.getToolUseSummary?.(hostile)).not.toThrow();
    expect(() => cancelTool.toAutoClassifierInput?.(hostile)).not.toThrow();
  });

  it("handles shell command argument getters across tool callbacks", async () => {
    registerShellTool();
    const bashTool = getRegistry().lookup("bash")!;
    const taskStartTool = getRegistry().lookup("task_shell_start")!;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "command", {
      enumerable: true,
      get() {
        throw new Error("command getter failed");
      },
    });
    Object.defineProperty(hostile, "background", {
      enumerable: true,
      get() {
        throw new Error("background getter failed");
      },
    });
    const hostileOptions: Record<string, unknown> = { command: "printf ok" };
    Object.defineProperty(hostileOptions, "workdir", {
      enumerable: true,
      get() {
        throw new Error("workdir getter failed");
      },
    });
    Object.defineProperty(hostileOptions, "timeout", {
      enumerable: true,
      get() {
        throw new Error("timeout getter failed");
      },
    });
    Object.defineProperty(hostileOptions, "pty", {
      enumerable: true,
      get() {
        throw new Error("pty getter failed");
      },
    });

    expect(await bashTool.validateInput?.(hostile, { tool_name: "bash", workspace_path: tmp, tool_def: bashTool })).toMatchObject({ ok: false });
    expect(await bashTool.validateInput?.(hostileOptions, { tool_name: "bash", workspace_path: tmp, tool_def: bashTool })).toMatchObject({
      ok: false,
      message: expect.not.stringContaining("getter failed"),
    });
    expect(await taskStartTool.validateInput?.(hostileOptions, { tool_name: "task_shell_start", workspace_path: tmp, tool_def: taskStartTool })).toMatchObject({
      ok: false,
      message: expect.not.stringContaining("getter failed"),
    });
    await expect(bashTool.execute(hostile, { workspacePath: tmp })).resolves.not.toContain("getter failed");
    await expect(bashTool.execute(hostileOptions, { workspacePath: tmp })).resolves.not.toContain("getter failed");
    await expect(taskStartTool.execute(hostileOptions, { workspacePath: tmp })).resolves.not.toContain("getter failed");
    expect(() => bashTool.readOnly?.(hostile)).not.toThrow();
    expect(() => bashTool.destructive?.(hostile)).not.toThrow();
    expect(() => bashTool.concurrencySafe?.(hostile)).not.toThrow();
    expect(() => bashTool.getPermissionPatterns?.(hostile)).not.toThrow();
    expect(() => bashTool.preparePermissionMatcher?.(hostile)).not.toThrow();
    expect(() => bashTool.toAutoClassifierInput?.(hostile)).not.toThrow();
    expect(() => bashTool.getActivityDescription?.(hostile)).not.toThrow();
    expect(() => bashTool.getToolUseSummary?.(hostile)).not.toThrow();
    expect(() => taskStartTool.getPermissionPatterns?.(hostileOptions)).not.toThrow();
    expect(() => taskStartTool.preparePermissionMatcher?.(hostileOptions)).not.toThrow();
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

  it("reports UTF-8 byte counts for shell stdin interaction", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "bash -lc 'echo byte-ready; IFS= read -r value; echo byte-got:$value'",
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("byte-ready")));

    expect(await getRegistry().lookup("exec_shell_interact")!.execute({ id, input: "你🙂\n" })).toContain("Sent 8 byte(s)");
    const done = await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("byte-got:你🙂") ? output : ""), 2500);

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

  it("persists job metadata atomically without exposing temp records", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({ command: "printf atomic-job", workdir: tmp, pty: false });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("status: completed")));

    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    const files = readdirSync(jobsDir);
    expect(files).toContain(`${id}.json`);
    expect(files.some(file => file.includes(`${id}.json`) && file.endsWith(".tmp"))).toBe(false);
  });

  it("ignores orphaned atomic job metadata temp files during reload", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();

    writeFileSync(join(jobsDir, ".job_orphan.json.123.456.0.tmp"), JSON.stringify({
      id: "job_orphan",
      command: "printf orphan",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now() - 1_000,
      output: "orphan\n",
    }), "utf-8");
    writeFileSync(join(jobsDir, "job_visible.json"), JSON.stringify({
      id: "job_visible",
      command: "printf visible",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now() - 500,
      output: "visible\n",
    }), "utf-8");

    reloadJobManagerForTests();

    expect(getJobManager().list().map(job => job.id)).toEqual(["job_visible"]);
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

  it("keeps valid persisted job artifact ids while filtering malformed entries", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();
    writeFileSync(join(jobsDir, "job_hostile_optional.json"), JSON.stringify({
      id: "job_hostile_optional",
      command: "printf kept",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now() - 500,
      output: "kept\n",
      artifactIds: ["bad\0id", { nested: true }, "artifact-ok", " artifact-later ", "artifact-ok"],
    }), "utf-8");

    reloadJobManagerForTests();
    expect(getJobManager().get("job_hostile_optional")).toMatchObject({
      id: "job_hostile_optional",
      artifactIds: ["artifact-ok", "artifact-later"],
      output: "kept\n",
    });
  });

  it("ignores persisted job records whose filename does not match the record id", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();

    writeFileSync(join(jobsDir, "job_filename.json"), JSON.stringify({
      id: "job_different",
      command: "printf bad",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now() - 100,
      output: "bad\n",
    }), "utf-8");

    reloadJobManagerForTests();

    expect(getJobManager().list()).toEqual([]);
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

  it("accepts valid job status helper payloads without coercing optional timestamps", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();

    const statusFile = join(jobsDir, "job_status_hostile.status.json");
    writeFileSync(statusFile, JSON.stringify({ exitCode: 0, endedAt: Date.now() }), "utf-8");
    writeFileSync(join(jobsDir, "job_status_hostile.json"), JSON.stringify({
      id: "job_status_hostile",
      command: "printf stale",
      workdir: tmp,
      status: "running",
      exitCode: null,
      startedAt: Date.now() - 5_000,
      output: "pending\n",
      statusFile,
      pid: 999_999_999,
    }), "utf-8");

    reloadJobManagerForTests();
    expect(getJobManager().get("job_status_hostile")).toMatchObject({ status: "completed", exitCode: 0 });
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

  it("ignores symlinked job metadata files during reload", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    const outside = join(tmp, "outside-job.json");
    getJobManager();
    writeFileSync(outside, JSON.stringify({
      id: "job_linked",
      command: "printf bad",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now() - 100,
      output: "bad\n",
    }), "utf-8");
    symlinkSync(outside, join(jobsDir, "job_linked.json"));

    reloadJobManagerForTests();

    expect(getJobManager().list()).toEqual([]);
  });

  it("bounds persisted job files, logs, status payloads, output, and artifact ids", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();
    const startedAt = Date.now() - 2_000;
    const logFile = join(jobsDir, "job_bounded.log");
    const statusFile = join(jobsDir, "job_bounded.status.json");
    writeFileSync(logFile, `${"x".repeat(210_000)}tail\u0007`, "utf-8");
    writeFileSync(statusFile, JSON.stringify({ exitCode: 0, endedAt: Date.now() }), "utf-8");
    writeFileSync(join(jobsDir, "job_bounded.json"), JSON.stringify({
      id: "job_bounded",
      command: "printf bounded",
      workdir: tmp,
      status: "running",
      exitCode: null,
      startedAt,
      output: `${"y".repeat(210_000)}old\u0001`,
      logFile,
      statusFile,
      pid: 999_999_999,
      artifactIds: Array.from({ length: 510 }, (_, index) => `artifact-${index}`),
    }), "utf-8");
    writeFileSync(join(jobsDir, "job_bad_status.status.json"), "x".repeat(70_000), "utf-8");
    writeFileSync(join(jobsDir, "job_bad_status.json"), JSON.stringify({
      id: "job_bad_status",
      command: "printf stale",
      workdir: tmp,
      status: "running",
      exitCode: null,
      startedAt,
      output: "stale",
      statusFile: join(jobsDir, "job_bad_status.status.json"),
      pid: 999_999_999,
    }), "utf-8");
    writeFileSync(join(jobsDir, "job_too_large.json"), JSON.stringify({
      id: "job_too_large",
      command: "printf bad",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt,
      output: "bad",
      padding: "x".repeat(1_100_000),
    }), "utf-8");

    reloadJobManagerForTests();
    const bounded = getJobManager().get("job_bounded")!;
    const stale = getJobManager().get("job_bad_status")!;

    expect(bounded.status).toBe("completed");
    expect(bounded.output).toHaveLength(200_000);
    expect(bounded.output).toContain("tail ");
    expect(bounded.output).not.toContain("\u0007");
    expect(bounded.artifactIds).toHaveLength(500);
    expect(bounded.artifactIds?.at(-1)).toBe("artifact-499");
    expect(stale.status).toBe("stale");
    expect(getJobManager().get("job_too_large")).toBeUndefined();
  });

  it("keeps oversized persisted job output on grapheme boundaries", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();
    const family = "👨‍👩‍👧‍👦";
    const prefix = "x".repeat(20);
    const suffix = "y".repeat(199_994);
    writeFileSync(join(jobsDir, "job_grapheme_output.json"), JSON.stringify({
      id: "job_grapheme_output",
      command: "printf grapheme",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now() - 1_000,
      endedAt: Date.now(),
      output: `${prefix}${family}${suffix}`,
    }), "utf-8");

    reloadJobManagerForTests();
    const job = getJobManager().get("job_grapheme_output")!;

    expect(job.output.length).toBeLessThanOrEqual(200_000);
    expect(job.output).not.toContain(family);
    expect(job.output).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(job.output)).toBe(false);
  });

  it("bounds formatted job output tails defensively", () => {
    const formatted = formatJob({
      id: "job_format",
      command: "printf format",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      signal: null,
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
      output: `${"x".repeat(210_000)}tail`,
      pty: false,
      reattachable: false,
    }, 1_000_000);

    expect(formatted).toContain("tail");
    expect(formatted.length).toBeLessThan(205_000);
  });

  it("formats malformed job snapshots defensively", () => {
    const formatted = formatJob({
      id: "job_bad\u0000id",
      command: "printf\u0000bad",
      workdir: `${tmp}\u0000bad`,
      status: "weird" as any,
      exitCode: 999 as any,
      signal: "SIG_NOT_REAL" as any,
      startedAt: Date.now() + 10_000,
      endedAt: Date.now(),
      output: "hello\u0007world",
      pid: -1,
      logFile: "bad\u0000log",
      inputFile: "bad\u0000input",
      pty: false,
      reattachable: false,
    }, 200);

    expect(formatted).not.toContain("\u0000");
    expect(formatted).not.toContain("\u0007");
    expect(formatted).toContain("status: stale");
    expect(formatted).not.toContain("exit_code: 999");
    expect(formatted).not.toContain("SIG_NOT_REAL");
    expect(formatted).toContain("hello world");
  });

  it("formats job snapshots with hostile getters defensively", () => {
    const job: Record<string, unknown> = {
      id: "job_getters",
      command: "printf ok",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      signal: null,
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
      output: "ok",
    };
    Object.defineProperty(job, "output", {
      enumerable: true,
      get() {
        throw new Error("output getter failed");
      },
    });
    Object.defineProperty(job, "logFile", {
      enumerable: true,
      get() {
        throw new Error("log getter failed");
      },
    });

    expect(() => formatJob(job as any)).not.toThrow();
    const formatted = formatJob(job as any);
    expect(formatted).toContain("job_getters");
    expect(formatted).not.toContain("getter failed");
  });

  it("returns defensive background job snapshots", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();
    writeFileSync(join(jobsDir, "job_snapshot.json"), JSON.stringify({
      id: "job_snapshot",
      command: "printf snapshot",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
      output: "snapshot\n",
      artifactIds: ["artifact-one"],
    }), "utf-8");
    reloadJobManagerForTests();

    const first = getJobManager().get("job_snapshot")!;
    first.artifactIds!.push("mutated");
    const second = getJobManager().get("job_snapshot")!;

    expect(second.artifactIds).toEqual(["artifact-one"]);
  });

  it("ignores persisted job records whose missing paths escape through symlink parents", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    const outside = join(tmp, "outside-job-root");
    const link = join(jobsDir, "linked-outside");
    mkdirSync(outside, { recursive: true });
    getJobManager();
    symlinkSync(outside, link, "dir");

    writeFileSync(join(jobsDir, "job_kept.json"), JSON.stringify({
      id: "job_kept",
      command: "printf kept",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now() - 2_000,
      endedAt: Date.now() - 1_000,
      output: "kept\n",
    }), "utf-8");
    writeFileSync(join(jobsDir, "job_symlink_path.json"), JSON.stringify({
      id: "job_symlink_path",
      command: "printf bad",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: Date.now(),
      output: "bad\n",
      logFile: join(link, "future.log"),
    }), "utf-8");

    reloadJobManagerForTests();

    expect(getJobManager().list().map(job => job.id)).toEqual(["job_kept"]);
  });

  it("drops persisted running jobs with escaped status or input files", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    const outside = join(tmp, "outside-job-state");
    const statusFile = join(outside, "status.json");
    const inputFile = join(outside, "input.fifo");
    mkdirSync(outside, { recursive: true });
    writeFileSync(statusFile, JSON.stringify({ exitCode: 0, endedAt: Date.now() }), "utf-8");
    writeFileSync(inputFile, "", "utf-8");
    getJobManager();

    writeFileSync(join(jobsDir, "job_escape_state.json"), JSON.stringify({
      id: "job_escape_state",
      command: "printf stale",
      workdir: tmp,
      status: "running",
      exitCode: null,
      startedAt: Date.now() - 1000,
      output: "pending\n",
      statusFile,
      inputFile,
      pid: 999_999_999,
    }), "utf-8");

    reloadJobManagerForTests();
    const job = getJobManager().get("job_escape_state");

    expect(job).toBeUndefined();
    expect(getJobManager().write("job_escape_state", "hello")).toBe(false);
    expect(readFileSync(inputFile, "utf-8")).toBe("");
  });

  it("ignores persisted job records with impossible exit codes or unknown signals", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();

    writeFileSync(join(jobsDir, "job_bad_exit.json"), JSON.stringify({
      id: "job_bad_exit",
      command: "printf bad",
      workdir: tmp,
      status: "failed",
      exitCode: 999,
      startedAt: Date.now(),
      output: "bad\n",
    }), "utf-8");
    writeFileSync(join(jobsDir, "job_bad_signal.json"), JSON.stringify({
      id: "job_bad_signal",
      command: "printf bad",
      workdir: tmp,
      status: "failed",
      exitCode: null,
      signal: "SIG_NOT_REAL",
      startedAt: Date.now(),
      output: "bad\n",
    }), "utf-8");

    reloadJobManagerForTests();

    expect(getJobManager().list()).toEqual([]);
  });

  it("ignores blank job dir env values and trims configured job dirs", () => {
    const oldSeek = process.env.SEEKCODE_JOBS_DIR;
    const oldDeepcode = process.env.DEEPCODE_JOBS_DIR;
    const oldDeepseek = process.env.DEEPSEEK_JOBS_DIR;
    try {
      process.env.SEEKCODE_JOBS_DIR = " ";
      process.env.DEEPCODE_JOBS_DIR = ` ${join(tmp, "deepcode-jobs")} `;
      process.env.DEEPSEEK_JOBS_DIR = join(tmp, "deepseek-jobs");

      expect(defaultJobsDir()).toBe(join(tmp, "deepcode-jobs"));
    } finally {
      if (oldSeek === undefined) delete process.env.SEEKCODE_JOBS_DIR;
      else process.env.SEEKCODE_JOBS_DIR = oldSeek;
      if (oldDeepcode === undefined) delete process.env.DEEPCODE_JOBS_DIR;
      else process.env.DEEPCODE_JOBS_DIR = oldDeepcode;
      if (oldDeepseek === undefined) delete process.env.DEEPSEEK_JOBS_DIR;
      else process.env.DEEPSEEK_JOBS_DIR = oldDeepseek;
    }
  });

  it("rejects persisted jobs with fractional timestamps or NUL strings", () => {
    const jobsDir = process.env.DEEPCODE_JOBS_DIR!;
    getJobManager();
    writeFileSync(join(jobsDir, "job_fractional.json"), JSON.stringify({
      id: "job_fractional",
      command: "printf bad",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: 100.5,
      output: "bad\n",
    }), "utf-8");
    writeFileSync(join(jobsDir, "job_nul.json"), JSON.stringify({
      id: "job_nul",
      command: "printf bad\u0000hidden",
      workdir: tmp,
      status: "completed",
      exitCode: 0,
      startedAt: 100,
      output: "bad\n",
    }), "utf-8");

    reloadJobManagerForTests();

    expect(getJobManager().list()).toEqual([]);
  });

  it("rejects NUL stdin writes to running jobs", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("bash")!.execute({
      command: "read line; printf %s \"$line\"",
      background: true,
      pty: false,
      workdir: tmp,
    });
    const id = started.match(/job_[a-z0-9_]+/)![0]!;

    expect(getJobManager().write(id, "bad\u0000input\n")).toBe(false);
    expect(getJobManager().cancel(id)).toBe(true);
  });

  it("bounds shell foreground output and rejects oversized shell inputs", async () => {
    registerShellTool();
    const bashTool = getRegistry().lookup("bash")!;
    const interactTool = getRegistry().lookup("exec_shell_interact")!;

    expect(await bashTool.validateInput?.(
      { command: "x".repeat(20_001) },
      { tool_name: "bash", workspace_path: tmp, tool_def: bashTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("command is too long"),
    });
    expect(await bashTool.validateInput?.(
      { command: "printf ok", workdir: `${tmp}\u0007` },
      { tool_name: "bash", workspace_path: tmp, tool_def: bashTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir contains control characters"),
    });
    expect(await interactTool.validateInput?.(
      { id: "job_large", input: "x".repeat(50_001) },
      { tool_name: "exec_shell_interact", workspace_path: tmp, tool_def: interactTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("input is too long"),
    });

    const output = await bashTool.execute({
      command: `${process.execPath} -e "process.stdout.write('x'.repeat(210000)); process.stdout.write('tail'); process.stderr.write('bad\\\\u0007err')"`,
      workdir: tmp,
      timeout: 5_000,
    });

    expect(output).toContain("tail");
    expect(output).toContain("bad err");
    expect(output).not.toContain("\u0007");
    expect(output.length).toBeLessThan(205_000);
  });

  it("decodes split foreground shell UTF-8 output without replacement characters", async () => {
    registerShellTool();
    const output = await getRegistry().lookup("bash")!.execute({
      command: `${process.execPath} -e "process.stdout.write(Buffer.from([0xf0])); setTimeout(() => process.stdout.write(Buffer.from([0x9f,0x91,0xa8])), 20); process.stderr.write(Buffer.from([0xf0])); setTimeout(() => process.stderr.write(Buffer.from([0x9f,0x91,0xa8])), 20);"`,
      workdir: tmp,
      timeout: 5_000,
    });

    expect(output).toContain("👨");
    expect(output).not.toContain("\ufffd");
    expect(hasUnpairedSurrogate(output)).toBe(false);
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

  it("kills queued shell process groups on timeout", async () => {
    registerTaskTools();
    const pidFile = join(tmp, "queued-child.pid");

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Timeout child task",
      command: `bash -lc 'sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait'`,
      workdir: tmp,
      timeout: 2_000,
    }));
    await waitFor(() => existsSync(pidFile), 2500);
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());
    await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "failed" ? task : null;
    }, 2500);

    await waitFor(() => !isPidAlive(childPid), 2500);
  });

  it("kills queued shell process groups when cancelled", async () => {
    registerTaskTools();
    const pidFile = join(tmp, "queued-cancel-child.pid");

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Cancel child task",
      command: `bash -lc 'sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait'`,
      workdir: tmp,
      timeout: 5_000,
    }));
    await waitFor(() => existsSync(pidFile));
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());
    const result = await getRegistry().lookup("task_cancel")!.execute({ id: created.id });

    expect(result).toContain("Cancelled");
    await waitFor(() => !isPidAlive(childPid), 2500);
  });

  it("archives failed queued task output after the final exit status is appended", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Archive failed output",
      command: "printf failed-task && exit 7",
      workdir: tmp,
    }));
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "failed" ? task : null;
    }, 2500);
    const artifactText = readArtifact(done.artifactIds![done.artifactIds!.length - 1]!);

    expect(done.output).toContain("[exit code: 7]");
    expect(artifactText).toContain("failed-task");
    expect(artifactText).toContain("[exit code: 7]");
  });

  it("keeps queued task output files within byte limits on grapheme boundaries", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Large unicode output",
      command: "node -e 'process.stdout.write(\"a\".repeat(1999998) + \"👨‍👩‍👧‍👦tail\")'",
      workdir: tmp,
    }));
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "completed" ? task : null;
    }, 3500);
    const outputFile = done.outputFile!;
    const archived = readFileSync(outputFile, "utf-8");

    expect(statSync(outputFile).size).toBeLessThanOrEqual(2_000_000);
    expect(archived).not.toContain("👨‍👩‍👧‍👦");
    expect(archived).not.toContain("\u200d");
    expect(archived).not.toContain("\ufffd");
    expect(hasUnpairedSurrogate(archived)).toBe(false);
  });

  it("decodes split queued task UTF-8 output without replacement characters", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Split unicode task output",
      command: `${process.execPath} -e "process.stdout.write(Buffer.from([0xf0])); setTimeout(() => process.stdout.write(Buffer.from([0x9f,0x91,0xa8])), 20); process.stderr.write(Buffer.from([0xf0])); setTimeout(() => process.stderr.write(Buffer.from([0x9f,0x91,0xa8])), 20);"`,
      workdir: tmp,
    }));
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "completed" ? task : null;
    }, 3500);

    expect(done.output).toContain("👨");
    expect(done.output).not.toContain("\ufffd");
    expect(hasUnpairedSurrogate(done.output || "")).toBe(false);
  });

  it("rejects invalid negative queued task timeouts instead of crashing spawn", async () => {
    registerTaskTools();

    const result = await getRegistry().lookup("task_create")!.execute({
      description: "Negative timeout task",
      command: "printf queued-ok",
      workdir: tmp,
      timeout: -1,
    });

    expect(result).toContain("timeout must be a positive integer");
    expect(getTaskManager().getActiveTasks()).toEqual([]);
    expect(getTaskManager().getHistory()).toEqual([]);
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

  it("rejects invalid negative gate timeouts instead of surfacing spawn range errors", async () => {
    registerShellTool();
    registerTaskTools();

    const result = await getRegistry().lookup("task_gate_run")!.execute({
      command: "printf gate-ok",
      workdir: tmp,
      timeout: -1,
    });

    expect(result).toContain("timeout must be a positive integer");
    expect(result).not.toContain("out of range");
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

  it("persists non-JSON task fields safely", () => {
    const store = join(tmp, "tasks", "tasks.json");
    const manager = new TaskManager(store);
    const task = manager.createTask("background", "Odd task");
    const progress: Record<string, unknown> = { type: "background", lastUpdate: Date.now(), count: 1n, fn: () => "ignored" };
    progress.self = progress;
    (task as any).progress = progress;

    expect(manager.completeTask(task.id, "done")).toBe(true);

    const persisted = JSON.parse(readFileSync(store, "utf-8"));
    expect(persisted.history[0].progress).toMatchObject({
      count: "1",
      fn: null,
      self: "[Circular]",
    });
    const reloaded = new TaskManager(store);
    expect(reloaded.getHistory()[0].progress).toMatchObject({
      type: "background",
      lastUpdate: expect.any(Number),
    });
    expect((reloaded.getHistory()[0].progress as any).self).toBeUndefined();
  });

  it("normalizes task write options and progress with hostile getters", () => {
    const store = join(tmp, "tasks", "tasks.json");
    const manager = new TaskManager(store);
    const options: Record<string, unknown> = {
      toolUseId: "tool-1",
      agentId: "agent-1",
      queue: { kind: "shell", command: "printf ok", workdir: tmp },
      attempts: 0,
      maxAttempts: 1,
    };
    Object.defineProperty(options, "outputFile", {
      enumerable: true,
      get() {
        throw new Error("output file getter failed");
      },
    });
    const progress: Record<string, unknown> = {
      type: "background",
      percent: 50,
      lastUpdate: 1,
      message: "halfway",
    };
    Object.defineProperty(progress, "ignored", {
      enumerable: true,
      get() {
        throw new Error("ignored getter failed");
      },
    });

    expect(() => manager.createTask("background", "Hostile options", options as any)).not.toThrow();
    const task = manager.getActiveTasks()[0]!;
    expect(() => manager.updateProgress(task.id, progress as any)).not.toThrow();
    expect(manager.getTask(task.id)?.progress).toMatchObject({ type: "background", percent: 50, message: "halfway" });
  });

  it("rejects hostile task queue getters on write without corrupting manager state", () => {
    const store = join(tmp, "tasks", "tasks.json");
    const manager = new TaskManager(store);
    const queue: Record<string, unknown> = { kind: "shell", command: "printf ok", workdir: tmp };
    Object.defineProperty(queue, "command", {
      enumerable: true,
      get() {
        throw new Error("command getter failed");
      },
    });

    expect(() => manager.createTask("bash", "Bad queue", { queue: queue as any })).toThrow(/command/);
    expect(manager.getActiveTasks()).toEqual([]);
  });

  it("persists durable task state atomically without exposing temp stores", () => {
    const store = join(tmp, "tasks", "tasks.json");
    const manager = new TaskManager(store);
    const task = manager.createTask("background", "Atomic task store");

    expect(manager.completeTask(task.id, "done")).toBe(true);

    const files = readdirSync(join(tmp, "tasks"));
    expect(files).toContain("tasks.json");
    expect(files.some(file => file.includes("tasks.json") && file.endsWith(".tmp"))).toBe(false);
    expect(new TaskManager(store).getHistory()[0]).toMatchObject({
      id: task.id,
      status: "completed",
      description: "Atomic task store",
    });
  });

  it("ignores orphaned durable task temp stores during reload", () => {
    const tasksDir = join(tmp, "tasks");
    const store = join(tasksDir, "tasks.json");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, ".tasks.json.123.456.0.tmp"), JSON.stringify({
      active: [],
      history: [{
        id: "bgorphan",
        type: "background",
        status: "completed",
        description: "Orphan temp task",
        startTime: 100,
        endTime: 200,
        notified: true,
      }],
    }), "utf-8");
    writeFileSync(store, JSON.stringify({
      active: [],
      history: [{
        id: "bgvisible",
        type: "background",
        status: "completed",
        description: "Visible task",
        startTime: 100,
        endTime: 200,
        notified: true,
      }],
    }), "utf-8");

    const reloaded = new TaskManager(store);

    expect(reloaded.getHistory().map(task => task.id)).toEqual(["bgvisible"]);
  });

  it("does not follow symlinked task stores during reload", () => {
    const tasksDir = join(tmp, "tasks");
    const outsideStore = join(tmp, "outside-tasks.json");
    const store = join(tasksDir, "tasks.json");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(outsideStore, JSON.stringify({
      active: [],
      history: [{
        id: "bgoutside",
        type: "background",
        status: "completed",
        description: "Outside task store",
        startTime: 100,
        endTime: 200,
        notified: true,
      }],
    }), "utf-8");
    symlinkSync(outsideStore, store, "file");

    const reloaded = new TaskManager(store);

    expect(reloaded.getActiveTasks()).toEqual([]);
    expect(reloaded.getHistory()).toEqual([]);
  });

  it("fails closed when the task store directory is a symlink", () => {
    const tasksDir = join(tmp, "tasks");
    const outside = join(tmp, "outside-task-store");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "tasks.json"), JSON.stringify({ active: [], history: [] }), "utf-8");
    symlinkSync(outside, tasksDir, "dir");

    const manager = new TaskManager(join(tasksDir, "tasks.json"));

    expect(manager.getActiveTasks()).toEqual([]);
    const task = manager.createTask("background", "should stay in memory");
    expect(task.status).toBe("pending");
    expect(JSON.parse(readFileSync(join(outside, "tasks.json"), "utf-8"))).toEqual({ active: [], history: [] });
    expect(readdirSync(outside)).toEqual(["tasks.json"]);
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

  it("ignores persisted task records with symlink-escaped output files or invalid signals", () => {
    const store = join(tmp, "tasks", "tasks.json");
    const tasksDir = join(tmp, "tasks");
    const outside = join(tmp, "outside-task-root");
    const link = join(tasksDir, "linked-outside");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, link, "dir");
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
          id: "bgescape",
          type: "background",
          status: "running",
          description: "Escaped output",
          startTime: 100,
          notified: false,
          outputFile: join(link, "future.log"),
        },
      ],
      history: [
        {
          id: "badsignal",
          type: "background",
          status: "failed",
          description: "Bad signal",
          startTime: 100,
          notified: false,
          signal: "SIG_NOT_REAL",
        },
      ],
    }, null, 2), "utf-8");

    const reloaded = new TaskManager(store);

    expect(reloaded.getHistory()).toEqual([
      expect.objectContaining({
        id: "bgkept01",
        status: "killed",
        description: "Kept task",
      }),
    ]);
  });

  it("deduplicates persisted task artifact ids and rejects empty entries", () => {
    const store = join(tmp, "tasks", "tasks.json");
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    writeFileSync(store, JSON.stringify({
      active: [],
      history: [
        {
          id: "bgdone01",
          type: "background",
          status: "completed",
          description: "Done",
          startTime: 100,
          endTime: 200,
          notified: true,
          artifactIds: ["art-1", "art-1", " art-2 "],
        },
        {
          id: "bgbadart",
          type: "background",
          status: "completed",
          description: "Bad artifact ids",
          startTime: 100,
          endTime: 200,
          notified: true,
          artifactIds: ["art-1", ""],
        },
        {
          id: "bgmixedart",
          type: "background",
          status: "completed",
          description: "Mixed artifact ids",
          startTime: 100,
          endTime: 200,
          notified: true,
          artifactIds: ["bad\0id", { nested: true }, " art-3 ", "art-3", "art-4"],
        },
      ],
    }, null, 2), "utf-8");

    const reloaded = new TaskManager(store);

    expect(reloaded.getHistory().map(task => ({ id: task.id, artifactIds: task.artifactIds }))).toEqual([
      { id: "bgdone01", artifactIds: ["art-1", "art-2"] },
      { id: "bgbadart", artifactIds: ["art-1"] },
      { id: "bgmixedart", artifactIds: ["art-3", "art-4"] },
    ]);
  });

  it("bounds persisted task store, task text, output, progress, and artifact id replay", () => {
    const oversizedStore = join(tmp, "tasks", "oversized.json");
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    writeFileSync(oversizedStore, "x".repeat(5_000_001), "utf-8");
    expect(new TaskManager(oversizedStore).getHistory()).toEqual([]);

    const store = join(tmp, "tasks", "tasks.json");
    const artifactIds = Array.from({ length: 510 }, (_, index) => `artifact-${index}`);
    writeFileSync(store, JSON.stringify({
      active: [],
      history: [
        {
          id: "bgbounded",
          type: "background",
          status: "completed",
          description: "Bounded output",
          startTime: 100,
          endTime: 200,
          notified: true,
          output: `${"x".repeat(210_000)}tail\u0007`,
          progress: { type: "background", lastUpdate: 100, message: `${"m".repeat(2_500)}\u0001` },
          artifactIds,
        },
        {
          id: "bgtoolong",
          type: "background",
          status: "completed",
          description: "d".repeat(2_001),
          startTime: 100,
          endTime: 200,
          notified: true,
        },
        {
          id: "bgbadartifact",
          type: "background",
          status: "completed",
          description: "Bad artifact",
          startTime: 100,
          endTime: 200,
          notified: true,
          artifactIds: ["ok", "x".repeat(257)],
        },
      ],
    }, null, 2), "utf-8");

    const reloaded = new TaskManager(store);
    const bounded = reloaded.getHistory()[0];

    expect(reloaded.getHistory().map(task => task.id)).toEqual(["bgbounded", "bgbadartifact"]);
    expect(bounded.id).toBe("bgbounded");
    expect(bounded.output).toHaveLength(200_000);
    expect(bounded.output).toContain("tail ");
    expect(bounded.output).not.toContain("\u0007");
    expect(bounded.progress?.message).toHaveLength(2_000);
    expect(bounded.progress?.message).not.toContain("\u0001");
    expect(bounded.artifactIds).toHaveLength(500);
    expect(bounded.artifactIds?.at(-1)).toBe("artifact-499");
    expect(reloaded.getHistory()[1].artifactIds).toEqual(["ok"]);
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

  it("skips unreadable persisted task list items while keeping later valid tasks", () => {
    const store = join(tmp, "tasks", "tasks.json");
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    writeFileSync(store, JSON.stringify({
      active: [
        { broken: true },
        {
          id: "bgvalid02",
          type: "background",
          status: "completed",
          description: "Valid later task",
          startTime: 100,
          endTime: 200,
          notified: true,
        },
      ],
      history: [],
    }), "utf-8");

    const reloaded = new TaskManager(store);

    expect(reloaded.getHistory()).toEqual([
      expect.objectContaining({ id: "bgvalid02", status: "completed" }),
    ]);
  });

  it("drops persisted task records with hostile nested progress and queue fields", () => {
    const store = join(tmp, "tasks", "tasks.json");
    mkdirSync(join(tmp, "tasks"), { recursive: true });
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
          id: "bgprogress",
          type: "background",
          status: "running",
          description: "Bad progress",
          startTime: 100,
          notified: false,
          progress: { type: "background", percent: 10, lastUpdate: 100, message: { nested: true } },
        },
        {
          id: "bqueuebad",
          type: "bash",
          status: "running",
          description: "Bad queue",
          startTime: 100,
          notified: false,
          queue: { kind: "shell", command: { nested: true }, workdir: tmp },
        },
      ],
      history: [],
    }, null, 2), "utf-8");

    const reloaded = new TaskManager(store);

    expect(reloaded.getHistory()).toEqual([
      expect.objectContaining({ id: "bgkept01", status: "killed" }),
    ]);
  });

  it("ignores blank task dir env values and trims configured task dirs", () => {
    const oldSeek = process.env.SEEKCODE_TASKS_DIR;
    const oldDeepcode = process.env.DEEPCODE_TASKS_DIR;
    const oldDeepseek = process.env.DEEPSEEK_TASKS_DIR;
    try {
      process.env.SEEKCODE_TASKS_DIR = " ";
      process.env.DEEPCODE_TASKS_DIR = ` ${join(tmp, "deepcode-tasks")} `;
      process.env.DEEPSEEK_TASKS_DIR = join(tmp, "deepseek-tasks");

      expect(defaultTaskStoreFile()).toBe(join(tmp, "deepcode-tasks", "tasks.json"));
    } finally {
      if (oldSeek === undefined) delete process.env.SEEKCODE_TASKS_DIR;
      else process.env.SEEKCODE_TASKS_DIR = oldSeek;
      if (oldDeepcode === undefined) delete process.env.DEEPCODE_TASKS_DIR;
      else process.env.DEEPCODE_TASKS_DIR = oldDeepcode;
      if (oldDeepseek === undefined) delete process.env.DEEPSEEK_TASKS_DIR;
      else process.env.DEEPSEEK_TASKS_DIR = oldDeepseek;
    }
  });

  it("rejects persisted task records with fractional timestamps, invalid progress, or NUL strings", () => {
    const store = join(tmp, "tasks", "tasks.json");
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    writeFileSync(store, JSON.stringify({
      active: [
        {
          id: "bgfraction",
          type: "background",
          status: "running",
          description: "Fractional",
          startTime: 100.5,
          notified: false,
        },
        {
          id: "bgprogress",
          type: "background",
          status: "running",
          description: "Bad progress",
          startTime: 100,
          notified: false,
          progress: { type: "background", percent: 101, lastUpdate: 100 },
        },
        {
          id: "bgnuldesc",
          type: "background",
          status: "running",
          description: "Bad\u0000description",
          startTime: 100,
          notified: false,
        },
      ],
      history: [],
    }, null, 2), "utf-8");

    const reloaded = new TaskManager(store);

    expect(reloaded.getActiveTasks()).toEqual([]);
    expect(reloaded.getHistory()).toEqual([]);
  });

  it("rejects persisted queued tasks with NUL workdirs or commands", () => {
    const store = join(tmp, "tasks", "tasks.json");
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    writeFileSync(store, JSON.stringify({
      active: [
        {
          id: "bnulqueue1",
          type: "bash",
          status: "running",
          description: "Bad queue command",
          startTime: 100,
          notified: false,
          queue: { kind: "shell", command: "printf bad\u0000hidden", workdir: tmp },
          attempts: 0,
          maxAttempts: 1,
        },
        {
          id: "bnulqueue2",
          type: "bash",
          status: "running",
          description: "Bad queue workdir",
          startTime: 100,
          notified: false,
          queue: { kind: "shell", command: "printf bad", workdir: `${tmp}\u0000hidden` },
          attempts: 0,
          maxAttempts: 1,
        },
      ],
      history: [],
    }, null, 2), "utf-8");

    const reloaded = new TaskManager(store);

    expect(reloaded.getActiveTasks()).toEqual([]);
    expect(reloaded.getHistory()).toEqual([]);
  });
});

describe("MCPClient", () => {
  it("builds the SSE message endpoint before query parameters", async () => {
    const oldFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ id: "ignored", result: { tools: [] } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const client = new MCPClient({ name: "query", transport: "sse", url: "https://mcp.test/sse?token=abc" } as any);
    try {
      await expect(client.listTools()).rejects.toThrow("did not match request");
      expect(requestedUrl).toBe("https://mcp.test/sse/message?token=abc");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("rejects non-object SSE JSON responses", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("null", { status: 200 })) as typeof globalThis.fetch;
    const client = new MCPClient({ name: "primitive", transport: "sse", url: "http://mcp.test" } as any);
    try {
      await expect(client.listTools()).rejects.toThrow("did not match request");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("rejects SSE JSON-RPC responses without the request id", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: { tools: [] } }), { status: 200 })) as typeof globalThis.fetch;
    const client = new MCPClient({ name: "missing-id", transport: "sse", url: "http://mcp.test" } as any);
    try {
      await expect(client.listTools()).rejects.toThrow("did not match request");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("rejects non-success HTTP responses from SSE MCP servers", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: { tools: [] } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch;
    const client = new MCPClient({ name: "remote", transport: "sse", url: "http://mcp.test" } as any);

    try {
      await expect(client.listTools()).rejects.toThrow("MCP SSE request failed: HTTP 500");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("bounds successful SSE MCP response bodies before JSON parsing", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: { padding: "x".repeat(1_000_001) } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch;
    const client = new MCPClient({ name: "remote-large", transport: "sse", url: "http://mcp.test" } as any);

    try {
      await expect(client.listTools()).rejects.toThrow("MCP SSE response exceeded limit");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("aborts hanging SSE MCP requests when their timeout expires", async () => {
    const oldFetch = globalThis.fetch;
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal;
      requestSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof globalThis.fetch;
    const client = new MCPClient({ name: "remote-hanging", transport: "sse", url: "http://mcp.test" } as any);

    try {
      const pending = expect(client.listTools()).rejects.toThrow(/timed out|aborted/i);
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = oldFetch;
    }
  });

  it("rejects pending requests when stdio server exits", async () => {
    const server = join(tmp, "server.mjs");
    writeFileSync(server, "process.exit(0);\n");
    const client = new MCPClient({ name: "dead", transport: "stdio", command: process.execPath, args: [server], env: {} });

    await client.connect();

    await expect(client.initialize()).rejects.toThrow(/exited|closed|timed out/i);
  });

  it("terminates stdio servers that would otherwise keep the CLI process alive", async () => {
    const server = join(tmp, "sticky-server.mjs");
    writeFileSync(server, "setInterval(() => {}, 1000);\n");
    const client = new MCPClient({ name: "sticky", transport: "stdio", command: process.execPath, args: [server], env: {} });

    await client.connect();
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it("rejects oversized unterminated MCP stdio lines before they grow without bound", async () => {
    const server = join(tmp, "oversized-line-server.mjs");
    writeFileSync(server, `
process.stdin.on("data", () => {
  process.stdout.write("x".repeat(1_100_000));
});
setInterval(() => {}, 1000);
`, "utf-8");
    const client = new MCPClient({ name: "oversized", transport: "stdio", command: process.execPath, args: [server], env: {} });

    await client.connect();
    await expect(client.initialize()).rejects.toThrow(/line exceeded|exited|disconnected/i);
    await client.disconnect();
  });

  it("decodes split MCP stdio UTF-8 output and stderr", async () => {
    const server = join(tmp, "split-mcp-server.mjs");
    writeFileSync(server, `
process.stdin.on("data", data => {
  const line = data.toString("utf-8").trim();
  if (!line) return;
  const req = JSON.parse(line);
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: "👨" } }) + "\\n", "utf-8");
  process.stdout.write(body.subarray(0, body.indexOf(Buffer.from("👨", "utf-8")) + 1));
  setTimeout(() => process.stdout.write(body.subarray(body.indexOf(Buffer.from("👨", "utf-8")) + 1)), 20);
  process.stderr.write(Buffer.from([0xf0]));
  setTimeout(() => process.stderr.write(Buffer.from([0x9f, 0x91, 0xa8])), 20);
});
setInterval(() => {}, 1000);
`, "utf-8");
    const client = new MCPClient({ name: "split", transport: "stdio", command: process.execPath, args: [server], env: {} });

    await client.connect();
    const result = await client.initialize();
    await waitFor(() => client.getStderrTail().includes("👨"));

    expect(result).toEqual({ ok: "👨" });
    expect(client.getStderrTail()).not.toContain("\ufffd");
    expect(hasUnpairedSurrogate(client.getStderrTail())).toBe(false);
    await client.disconnect();
  });

  it("registers only sanitized MCP tool names from server and tool identifiers", async () => {
    const registeredTools = [
      { name: "safe_tool", description: "safe", inputSchema: { type: "object", properties: {} } },
      { name: "bad-name", description: "bad hyphen", inputSchema: { type: "object", properties: {} } },
      { name: "../escape", description: "bad path", inputSchema: { type: "object", properties: {} } },
      { name: "tool with spaces", description: "bad spaces", inputSchema: { type: "object", properties: {} } },
      { name: "123bad", description: "bad leading digit", inputSchema: { type: "object", properties: {} } },
      { name: "x".repeat(33), description: "too long", inputSchema: { type: "object", properties: {} } },
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

  it("bounds MCP tool registration, sanitizes schemas, and cleans error output", async () => {
    const schema: Record<string, unknown> = { type: "object", properties: { x: { default: 1n } } };
    schema.self = schema;
    const registeredTools = [
      { name: "alpha", description: "alpha\u0000 desc", inputSchema: schema },
      ...Array.from({ length: 120 }, (_, index) => ({
        name: `tool_${index}`,
        description: `tool ${index}`,
        inputSchema: { type: "object", properties: {} },
      })),
    ];
    const client = {
      callTool: async (name: string) => {
        if (name === "alpha") throw new Error("remote\u0000 boom\n" + "x".repeat(3000));
        return name;
      },
    };
    const manager = new MCPManager({
      mcp_servers: [],
    } as any);

    (manager as any).registerTools({ name: "srv" }, client, registeredTools);
    const alpha = getRegistry().lookup("mcp_srv_alpha")!;

    expect(getRegistry().listAll().filter(tool => tool.name.startsWith("mcp_srv_"))).toHaveLength(100);
    expect(alpha.description).toBe("[MCP:srv] alpha desc");
    expect((alpha.parameters.properties as any).x.default).toBe("1");
    expect(alpha.parameters.self).toBe("[Circular]");
    const result = await alpha.execute({});
    expect(result).toContain("remote boom");
    expect(result).not.toContain("\u0000");
    expect(result.length).toBeLessThan(2100);

    await manager.disconnectAll();
  });

  it("formats MCP tool content with non-JSON parts safely", async () => {
    const circular: Record<string, unknown> = { count: 1n, fn: () => "ignored" };
    circular.self = circular;
    const client = Object.create(MCPClient.prototype) as MCPClient & {
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    client.request = async () => ({
      content: [
        { type: "text", text: "plain" },
        circular,
      ],
    });

    const result = await client.callTool("demo", {});

    expect(result).toContain("plain");
    expect(result).toContain("\"count\":\"1\"");
    expect(result).toContain("\"self\":\"[Circular]\"");
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
    return !isZombiePid(pid);
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function isZombiePid(pid: number): boolean {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8", timeout: 500, maxBuffer: 1024 }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

describe("SSE frame parser", () => {
  it("parses CRLF frames and preserves unfinished remainder", () => {
    const parsed = parseSSEFrames("event: content\r\ndata: hello\r\n\r\ndata: partial");

    expect(parsed.frames).toEqual([{ event: "content", data: "hello" }]);
    expect(parsed.remaining).toBe("data: partial");
  });

  it("preserves CRLF boundaries split across incremental chunks", () => {
    const first = parseSSEFrames("event: content\r");
    expect(first.frames).toEqual([]);
    expect(first.remaining).toBe("event: content\r");

    const second = parseSSEFrames(`${first.remaining}\ndata: hello\r\n\r`);
    expect(second.frames).toEqual([]);

    const third = parseSSEFrames(`${second.remaining}\n`);
    expect(third.frames).toEqual([{ event: "content", data: "hello" }]);
    expect(third.remaining).toBe("");
  });

  it("ignores keepalive comments without dropping data frames that include comments", () => {
    const parsed = parseSSEFrames(": keepalive\n\nevent: msg\n: ignored\ndata: ok\n\n");

    expect(parsed.frames).toEqual([{ event: "msg", data: "ok" }]);
  });

  it("ignores unsafe SSE fields and bounds oversized unfinished buffers", () => {
    const parsed = parseSSEFrames("bad field: drop\nevent: ok\nid: 7\ndata: yes\n\n");
    const huge = parseSSEFrames(`${"x".repeat(1_000_050)}data: tail`);
    const family = "👨‍👩‍👧‍👦";
    const marker = "data: tail";
    const unicodeHuge = parseSSEFrames(`${family}${"x".repeat(1_000_002 - family.length - marker.length)}${marker}`);
    const unsafeValue = parseSSEFrames("event: bad\u0000event\ndata: ok\n\n");
    const longEvent = parseSSEFrames(`event: ${"e".repeat(9000)}\ndata: ok\n\n`);

    expect(parsed.frames).toEqual([{ event: "ok", id: "7", data: "yes" }]);
    expect(huge.frames).toEqual([]);
    expect(huge.remaining.length).toBeLessThanOrEqual(1_000_000);
    expect(huge.remaining).toContain("data: tail");
    expect(unicodeHuge.remaining).not.toContain(family);
    expect(unicodeHuge.remaining).not.toContain("\u200d");
    expect(unicodeHuge.remaining).toContain(marker);
    expect(hasUnpairedSurrogate(unicodeHuge.remaining)).toBe(false);
    expect(unsafeValue.frames).toEqual([{ data: "ok" }]);
    expect(longEvent.frames).toEqual([{ data: "ok" }]);
  });

  it("limits frames per parse and preserves a safe remainder", () => {
    const payload = Array.from({ length: 1_050 }, (_, index) => `event: e${index}\ndata: ${index}\n\n`).join("");
    const parsed = parseSSEFrames(payload);

    expect(parsed.frames).toHaveLength(1_000);
    expect(parsed.frames[0]).toEqual({ event: "e0", data: "0" });
    expect(parsed.remaining).toContain("event: e1000");
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

  it("normalizes transport URL, headers, and reconnect delays", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const onError = vi.fn();
    const transport = new SSETransport({
      url: " http://localhost/sse?keep=1#drop ",
      headers: {
        authorization: "Bearer ok",
        " bad\nheader": "drop",
        "x-bad": "bad\r\nvalue",
      },
      events: { onError },
      getReconnectDelay: () => Number.NaN,
    });

    try {
      transport.connect().catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledWith("http://localhost/sse?keep=1", expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer ok" }),
      }));
      expect(Object.keys(fetchMock.mock.calls[0][1].headers)).not.toEqual(expect.arrayContaining([" bad\nheader", "x-bad"]));
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "SSE connection failed: HTTP 500" }));
      expect(transport.currentState).toBe("connecting");
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      transport.disconnect();
      globalThis.fetch = oldFetch;
    }
  });

  it("handles hostile SSE transport option getters without leaking errors", () => {
    const throwingUrl = { get url() { throw new Error("url getter should not leak"); } };
    const throwingOptions = {
      url: "http://localhost/sse",
      get headers() { throw new Error("headers getter should not leak"); },
      get events() { throw new Error("events getter should not leak"); },
      get autoReconnect() { throw new Error("autoReconnect getter should not leak"); },
      get getReconnectDelay() { throw new Error("delay getter should not leak"); },
    };

    try {
      new SSETransport(throwingUrl as any);
      throw new Error("expected SSETransport to reject missing URL");
    } catch (error: any) {
      expect(error.message).toContain("SSE URL is required");
      expect(error.message).not.toContain("getter should not leak");
    }
    expect(() => new SSETransport(throwingOptions as any)).not.toThrow(/getter should not leak/);
  });

  it("rejects unsafe transport URLs and keeps closed state after abort races", async () => {
    expect(() => new SSETransport({ url: "ftp://localhost/sse" })).toThrow(/http or https/);
    expect(() => new SSETransport({ url: "http://user:pass@localhost/sse" })).toThrow(/credentials/);
    expect(() => new SSETransport({ url: "not a url" })).toThrow(/valid URL/);

    let rejectRead: ((error: Error) => void) | undefined;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => { rejectRead = reject; }),
        }),
      },
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const transport = new SSETransport({ url: "http://localhost/sse" });

    try {
      const connectPromise = transport.connect();
      await waitFor(() => rejectRead ? true : null);
      transport.close();
      rejectRead?.(Object.assign(new Error("aborted"), { name: "AbortError" }));
      await connectPromise;
      expect(transport.currentState).toBe("closed");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("normalizes reconnect delay attempts", () => {
    expect(defaultReconnectDelay(Number.NaN)).toBeGreaterThanOrEqual(1000);
    expect(defaultReconnectDelay(-5)).toBeGreaterThanOrEqual(1000);
    expect(defaultReconnectDelay(1000)).toBeLessThanOrEqual(31_000);
  });

  it("gives up after a continuous reconnect cycle instead of resetting the timeout per attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const transport = new SSETransport({
      url: "http://localhost/sse",
      getReconnectDelay: () => 1_000,
    });

    try {
      void transport.connect();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The next failed attempt is still part of the same reconnect cycle.
      vi.setSystemTime(600_001);
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(transport.currentState).toBe("closed");
    } finally {
      transport.close();
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

  it("treats keepalive comment chunks as liveness and avoids duplicate reconnect timers", async () => {
    vi.useFakeTimers();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controllerRef = controller;
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        },
      }),
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const onError = vi.fn();
    const transport = new SSETransport({
      url: "http://localhost/sse",
      events: { onError },
      getReconnectDelay: () => 5_000,
    });

    try {
      const connectPromise = transport.connect();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(44_000);
      expect(onError).not.toHaveBeenCalledWith(expect.objectContaining({ message: "SSE liveness timeout" }));
      transport.disconnect();
      transport.disconnect();
      controllerRef?.close();
      await connectPromise;
      expect(transport.currentState).toBe("disconnected");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("reports oversized SSE stream chunks and reconnects through the normal path", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(260_000)));
          controller.close();
        },
      }),
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const onError = vi.fn();
    const transport = new SSETransport({
      url: "http://localhost/sse",
      events: { onError },
      getReconnectDelay: () => 0,
    });

    try {
      void transport.connect();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "SSE chunk is too large" }));
      expect(transport.currentState).toBe("connecting");
    } finally {
      transport.disconnect();
      globalThis.fetch = oldFetch;
    }
  });

  it("does not reconnect or leave connecting state after close races", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const transport = new SSETransport({
      url: "http://localhost/sse",
      getReconnectDelay: () => 1_000,
    });

    try {
      void transport.connect();
      await Promise.resolve();
      await Promise.resolve();
      expect(transport.currentState).toBe("connecting");
      transport.close();
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(transport.currentState).toBe("closed");
    } finally {
      transport.close();
      globalThis.fetch = oldFetch;
    }
  });

  it("lets liveness error handlers close without scheduling a stale reconnect", async () => {
    vi.useFakeTimers();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controllerRef = controller;
        },
      }),
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    let transport: SSETransport;
    transport = new SSETransport({
      url: "http://localhost/sse",
      events: {
        onError: () => transport.close(),
      },
      getReconnectDelay: () => 0,
    });

    try {
      const connectPromise = transport.connect();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(45_000);
      await vi.advanceTimersByTimeAsync(0);
      controllerRef?.close();
      await connectPromise;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(transport.currentState).toBe("closed");
    } finally {
      transport.close();
      globalThis.fetch = oldFetch;
    }
  });

  it("isolates throwing transport callbacks from stream cleanup", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: once\n\n"));
          controller.close();
        },
      }),
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const onError = vi.fn();
    const transport = new SSETransport({
      url: "http://localhost/sse",
      autoReconnect: false,
      events: {
        onMessage: () => { throw new Error("callback failed"); },
        onStateChange: state => {
          if (state === "connected") throw new Error("state callback failed");
        },
        onError,
      },
    });

    try {
      await expect(transport.connect()).resolves.toBeUndefined();

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "state callback failed" }));
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "callback failed" }));
      expect(transport.currentState).toBe("disconnected");
    } finally {
      transport.close();
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

  it("serializes non-JSON hook payloads safely", async () => {
    registerHook({
      event: "PreToolUse",
      command: `${process.execPath} -e "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => { const p = JSON.parse(s); console.log(JSON.stringify({message: p.tool_input.count + '/' + p.tool_input.self})); });"`,
    });
    const toolInput: Record<string, unknown> = { count: 1n };
    toolInput.self = toolInput;

    const result = await fireHooks("PreToolUse", { tool_name: "bash", tool_input: toolInput });

    expect(result).toMatchObject({ decision: "continue", message: "1/[Circular]", fired: 1 });
  });

  it("skips hostile hook config, payload, and result getters while preserving readable fields", async () => {
    const config: Record<string, unknown> = {
      event: "PreToolUse",
      command: `${process.execPath} -e "console.log(JSON.stringify({decision:'approve', message:'ok', modified_input:{kept:true}}))"`,
      matcher: "bash",
      timeout: 1000,
    };
    Object.defineProperty(config, "ignored", {
      enumerable: true,
      get() {
        throw new Error("config getter failed");
      },
    });
    registerHook(config as any);
    const input: Record<string, unknown> = { command: "echo ok", kept: true };
    Object.defineProperty(input, "bad", {
      enumerable: true,
      get() {
        throw new Error("input getter failed");
      },
    });
    const result = await fireHooks("PreToolUse", {
      tool_name: "bash",
      tool_input: input,
      cwd: tmp,
    });

    expect(getHooks()).toEqual([
      expect.objectContaining({ event: "PreToolUse", matcher: "bash", timeout: 1000 }),
    ]);
    expect(result).toMatchObject({ decision: "approve", message: "ok", modified_input: { kept: true }, fired: 1 });
    clearHooks();
  });

  it("keeps hook JSON output sibling fields after result sanitization", async () => {
    registerHook({
      event: "PreToolUse",
      command: `${process.execPath} -e "console.log(JSON.stringify({decision:'approve',message:'kept',modified_input:{safe:true}}));"`,
    });

    const result = await fireHooks("PreToolUse", { tool_name: "bash", tool_input: { command: "echo ok" }, cwd: tmp });

    expect(result).toMatchObject({ decision: "approve", message: "kept", modified_input: { safe: true }, fired: 1 });
  });

  it("decodes split hook UTF-8 output without replacement characters", async () => {
    registerHook({
      event: "Stop",
      command: `${process.execPath} -e "process.stdout.write(Buffer.from([0xf0])); setTimeout(() => process.stdout.write(Buffer.from([0x9f,0x91,0xa8])), 20);"`,
    });

    const result = await fireHooks("Stop", { cwd: tmp });

    expect(result).toMatchObject({ decision: "continue", message: "👨", fired: 1 });
    expect(result.message).not.toContain("\ufffd");
  });

  it("terminates hook child process groups on timeout", async () => {
    const pidFile = join(tmp, "hook-child.pid");
    registerHook({
      event: "Stop",
      command: `${process.execPath} -e 'const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn("sleep", ["30"]); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);'`,
      timeout: 500,
    });

    const result = await fireHooks("Stop", { cwd: tmp });

    expect(result).toMatchObject({ decision: "continue", fired: 1 });
    expect(result.message).toContain("Hook timed out");
    await waitFor(() => existsSync(pidFile), 500);
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());
    await waitFor(() => !isPidAlive(childPid), 2500);
  });
});
