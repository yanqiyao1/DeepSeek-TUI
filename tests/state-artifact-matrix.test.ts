import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  artifactRoot,
  clearArtifactsForTests,
  createArtifact,
  getArtifact,
  linkArtifact,
  listArtifactLinks,
  listArtifacts,
  readArtifact,
} from "../src/artifacts/store.js";
import {
  clearPersistentTaskStateForTests,
  generateTaskId,
  getTaskManager,
  isActiveStatus,
  isTerminalStatus,
  type TaskType,
} from "../src/engine/task-lifecycle.js";
import {
  DenialReason,
  checkApprovalCache,
  clearApprovalCache,
  getApprovalCache,
} from "../src/tools/approval-cache.js";
import { clearJobManagerForTests, formatJob } from "../src/tools/jobs.js";
import {
  addRule,
  checkPermission,
  clearAll as clearPermissionRules,
  forgetTool,
  rememberAlwaysAllow,
  rememberAlwaysDeny,
  removeRule,
} from "../src/tools/permission-ruleset.js";
import { getRegistry } from "../src/tools/registry.js";
import { registerArtifactTools } from "../src/tools/artifacts.js";
import { registerShellTool } from "../src/tools/shell.js";

let tmp: string;
let oldArtifactsDir: string | undefined;
let oldTasksDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-state-matrix-"));
  oldArtifactsDir = process.env.DEEPCODE_ARTIFACTS_DIR;
  oldTasksDir = process.env.DEEPCODE_TASKS_DIR;
  process.env.DEEPCODE_ARTIFACTS_DIR = join(tmp, "artifacts");
  process.env.DEEPCODE_TASKS_DIR = join(tmp, "tasks");
  clearArtifactsForTests();
  clearPersistentTaskStateForTests();
  clearApprovalCache();
  clearPermissionRules();
  clearJobManagerForTests();
  getRegistry().clear();
});

afterEach(() => {
  clearArtifactsForTests();
  clearPersistentTaskStateForTests();
  clearApprovalCache();
  clearPermissionRules();
  clearJobManagerForTests();
  getRegistry().clear();
  if (oldArtifactsDir === undefined) delete process.env.DEEPCODE_ARTIFACTS_DIR;
  else process.env.DEEPCODE_ARTIFACTS_DIR = oldArtifactsDir;
  if (oldTasksDir === undefined) delete process.env.DEEPCODE_TASKS_DIR;
  else process.env.DEEPCODE_TASKS_DIR = oldTasksDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("approval cache matrix", () => {
  it.each([
    ["string", { path: "a.txt" }, "{\"path\":\"a.txt\"}"],
    ["reordered object", { b: 2, a: 1 }, "{\"a\":1,\"b\":2}"],
    ["array values", { files: ["b", "a"] }, "{\"files\":[\"b\",\"a\"]}"],
    ["nested object", { payload: { z: 2, a: 1 } }, "{\"payload\":{\"a\":1,\"z\":2}}"],
    ["undefined field omitted", { path: "a.txt", mode: undefined }, "{\"path\":\"a.txt\"}"],
  ])("matches normalized denial cache keys for %s args", (_label, args, fragment) => {
    const cache = getApprovalCache();
    cache.rememberDenial("write", DenialReason.USER_DENIED, args);

    const result = checkApprovalCache("write", "ask", JSON.parse(JSON.stringify(args)));

    expect(result.decision).toBe("denied");
    expect(result.reason).toContain(DenialReason.USER_DENIED);
    expect(cache.getDenialHistory().at(-1)?.key).toContain(fragment);
  });

  it.each([
    ["once approval consumed after one use", "once", { path: "a.txt" }, ["approved", "ask"]],
    ["always approval stays reusable for matching args", "always", { command: "npm test" }, ["approved", "approved"]],
  ])("%s", (_label, scope, args, expected) => {
    const cache = getApprovalCache();
    cache.rememberApproval("bash", scope as "once" | "always", args);

    expect(checkApprovalCache("bash", "ask", args).decision).toBe(expected[0]);
    expect(checkApprovalCache("bash", "ask", args).decision).toBe(expected[1]);
  });

  it("does not apply always approval cache entries to different args", () => {
    const cache = getApprovalCache();
    cache.rememberApproval("bash", "always", { command: "npm test" });

    expect(checkApprovalCache("bash", "ask", { command: "npm run build" }).decision).toBe("ask");
  });

  it.each([
    ["always_allow bypasses cache", "read", "always_allow", { path: "README.md" }, "approved"],
    ["unknown ask stays ask", "write", "ask", { path: "README.md" }, "ask"],
    ["different args do not match once approval", "write", "ask", { path: "b.txt" }, "ask"],
  ])("%s", (_label, tool, permission, args, expected) => {
    const cache = getApprovalCache();
    cache.rememberApproval("write", "once", { path: "a.txt" });

    expect(checkApprovalCache(tool, permission, args).decision).toBe(expected);
  });
});

describe("permission rules matrix", () => {
  it.each([
    ["read", { toolName: "read" }, "allow"],
    ["ls", { toolName: "ls" }, "allow"],
    ["search", { toolName: "search" }, "allow"],
    ["glob", { toolName: "glob" }, "allow"],
    ["git_status", { toolName: "git_status" }, "allow"],
    ["git_diff", { toolName: "git_diff" }, "allow"],
    ["git_log", { toolName: "git_log" }, "allow"],
    ["git_branch", { toolName: "git_branch" }, "allow"],
    ["web_search", { toolName: "web_search" }, "allow"],
    ["web_fetch", { toolName: "web_fetch" }, "allow"],
    ["think", { toolName: "think" }, "allow"],
    ["get_goal", { toolName: "get_goal" }, "allow"],
    ["plan_status", { toolName: "plan_status" }, "allow"],
    ["agent_status", { toolName: "agent_status" }, "allow"],
    ["checklist_write", { toolName: "checklist_write" }, "allow"],
    ["update_plan", { toolName: "update_plan" }, "allow"],
    ["note", { toolName: "note" }, "allow"],
    ["rlm_query", { toolName: "rlm_query" }, "allow"],
    ["spawn_agent", { toolName: "spawn_agent" }, "allow"],
    ["sub_agent", { toolName: "sub_agent" }, "allow"],
    ["write", { toolName: "write" }, "ask"],
    ["edit", { toolName: "edit" }, "ask"],
    ["apply_patch", { toolName: "apply_patch" }, "ask"],
    ["bash", { toolName: "bash" }, "ask"],
  ])("applies the default permission action for %s", (_tool, request, expected) => {
    expect(checkPermission(request as any).action).toBe(expected);
  });

  it.each([
    ["rm -rf", { toolName: "bash", toolArgs: { command: "rm -rf /tmp" } }, "deny"],
    ["rm -fr root", { toolName: "bash", toolArgs: { command: "rm -fr /" } }, "deny"],
    ["rm split flags", { toolName: "bash", toolArgs: { command: "rm -r -f /" } }, "deny"],
    ["rm long flags", { toolName: "bash", toolArgs: { command: "rm --recursive --force /" } }, "deny"],
    ["rm separator root", { toolName: "bash", toolArgs: { command: "rm -rf -- /" } }, "deny"],
    ["raw device write", { toolName: "bash", toolArgs: { command: "cat zero > /dev/sda" } }, "deny"],
    ["raw nvme write", { toolName: "bash", toolArgs: { command: "cat zero > /dev/nvme0n1" } }, "deny"],
    ["mkfs", { toolName: "bash", toolArgs: { command: "mkfs.ext4 /dev/sda1" } }, "deny"],
    ["mkfs command", { toolName: "bash", toolArgs: { command: "mkfs /dev/sda1" } }, "deny"],
    ["dd raw copy", { toolName: "bash", toolArgs: { command: "dd if=input of=/dev/disk0" } }, "deny"],
    ["dd reversed raw copy", { toolName: "bash", toolArgs: { command: "dd of=/dev/sda if=/dev/zero" } }, "deny"],
    ["chmod 777", { toolName: "bash", toolArgs: { command: "chmod 777 script.sh" } }, "deny"],
    ["chmod 0777", { toolName: "bash", toolArgs: { command: "chmod 0777 script.sh" } }, "deny"],
    ["chmod symbolic rwx", { toolName: "bash", toolArgs: { command: "chmod a+rwx script.sh" } }, "deny"],
    ["fork bomb", { toolName: "bash", toolArgs: { command: ":(){ :|:& };:" } }, "deny"],
  ])("matches destructive default bash rules for %s", (_label, request, expected) => {
    expect(checkPermission(request as any).action).toBe(expected);
  });

  it.each([
    "rm -rf /",
    "rm -fr /",
    "rm -r -f /",
    "rm --recursive --force /",
    "dd of=/dev/sda if=/dev/zero",
    "cat zero > /dev/nvme0n1",
    "mkfs /dev/sda1",
    "chmod a+rwx script.sh",
  ])("does not let session always-allow override built-in dangerous bash deny rule for %s", (command) => {
    rememberAlwaysAllow("bash", { command });

    expect(checkPermission({ toolName: "bash", toolArgs: { command } }).action).toBe("deny");
  });

  it.each([
    "rm -rf /",
    "rm -fr /",
    "rm -r -f /",
    "rm --recursive --force /",
    "dd of=/dev/sda if=/dev/zero",
    "cat zero > /dev/nvme0n1",
    "mkfs /dev/sda1",
    "chmod a+rwx script.sh",
  ])("does not let tool-prepared shell matchers override built-in dangerous deny rule for %s", (command) => {
    registerShellTool();
    const tool = getRegistry().lookup("bash")!;
    addRule({ permission: "bash", pattern: command, action: "allow" });

    expect(checkPermission({
      toolName: "bash",
      toolArgs: { command },
      patterns: [command],
      matchesPattern: tool.preparePermissionMatcher?.({ command }),
    }).action).toBe("deny");
  });

  it.each([
    ["default read allow", { toolName: "read", toolArgs: { path: "README.md" } }, "allow"],
    ["default write ask", { toolName: "write", toolArgs: { path: "README.txt" } }, "ask"],
    ["default fork bomb deny", { toolName: "bash", toolArgs: { command: ":(){ :|:& };:" } }, "deny"],
    ["glob match by args", { toolName: "write", toolArgs: { path: "docs/readme.md" }, patterns: ["docs/readme.md"] }, "allow"],
    ["glob no match falls back", { toolName: "write", toolArgs: { path: "docs/readme.txt" }, patterns: ["docs/readme.txt"] }, "ask"],
    ["question wildcard matches single char", { toolName: "write", toolArgs: { path: "a.ts" }, patterns: ["a.ts"] }, "deny"],
  ])("%s", (_label, request, expected) => {
    addRule({ permission: "write", pattern: "*.md", action: "allow" });
    addRule({ permission: "write", pattern: "?.ts", action: "deny" });

    expect(checkPermission(request as any).action).toBe(expected);
  });

  it("lets pattern-specific session memory override custom rules until forgotten", () => {
    addRule({ permission: "bash", pattern: "npm *", action: "deny" });
    rememberAlwaysAllow("bash", { command: "npm test" });
    expect(checkPermission({ toolName: "bash", toolArgs: { command: "npm test" } }).action).toBe("allow");
    expect(checkPermission({ toolName: "bash", toolArgs: { command: "npm run build" } }).action).toBe("deny");

    rememberAlwaysDeny("bash", { command: "npm test" });
    expect(checkPermission({ toolName: "bash", toolArgs: { command: "npm test" } }).action).toBe("deny");

    forgetTool("bash", { command: "npm test" });
    expect(checkPermission({ toolName: "bash", toolArgs: { command: "npm test" } })).toMatchObject({
      action: "deny",
      matchedRule: "bash:npm *",
    });
  });

  it("replaces and removes duplicate custom rules deterministically", () => {
    addRule({ permission: "write", pattern: "*.ts", action: "ask" });
    addRule({ permission: "write", pattern: "*.ts", action: "deny" });

    expect(checkPermission({ toolName: "write", patterns: ["src/app.ts"] }).action).toBe("deny");
    expect(removeRule("write", "*.ts")).toBe(true);
    expect(removeRule("write", "*.ts")).toBe(false);
    expect(checkPermission({ toolName: "write", patterns: ["src/app.ts"] }).action).toBe("ask");
  });
});

describe("task lifecycle matrix", () => {
  it.each([
    ["pending", true, false],
    ["running", true, false],
    ["completed", false, true],
    ["failed", false, true],
    ["killed", false, true],
  ])("classifies task status %s", (status, active, terminal) => {
    expect(isActiveStatus(status as any)).toBe(active);
    expect(isTerminalStatus(status as any)).toBe(terminal);
  });

  it.each([
    ["bash", /^b[a-z0-9]{8}$/],
    ["agent", /^a[a-z0-9]{8}$/],
    ["remote_agent", /^r[a-z0-9]{8}$/],
    ["workflow", /^w[a-z0-9]{8}$/],
    ["monitor", /^m[a-z0-9]{8}$/],
    ["sub_task", /^s[a-z0-9]{8}$/],
    ["background", /^bg[a-z0-9]{8}$/],
  ])("generates ids with the expected prefix for %s tasks", (type, pattern) => {
    expect(generateTaskId(type as TaskType)).toMatch(pattern);
  });

  it("tracks task stats across active and archived tasks", () => {
    const manager = getTaskManager();
    const background = manager.createTask("background", "Pending background");
    const agent = manager.createTask("agent", "Running agent");
    const shell = manager.createTask("bash", "Shell task");

    expect(manager.startTask(agent.id)).toBe(true);
    expect(manager.completeTask(agent.id, "done")).toBe(true);
    expect(manager.failTask(shell.id, "boom")).toBe(true);

    const stats = manager.getTaskStats();

    expect(stats).toMatchObject({
      active: 1,
      total: 3,
      completed: 1,
      failed: 1,
      killed: 0,
      byType: { background: 1 },
    });
    expect(manager.getActiveTasks().map(task => task.id)).toEqual([background.id]);
  });

  it("kills non-queued pending tasks and prevents duplicate state transitions", () => {
    const manager = getTaskManager();
    const task = manager.createTask("background", "Idle task");

    expect(manager.killTask(task.id)).toBe(true);
    expect(manager.killTask(task.id)).toBe(false);
    expect(manager.completeTask(task.id)).toBe(false);
    expect(manager.failTask(task.id)).toBe(false);
    expect(manager.getHistory().find(item => item.id === task.id)?.status).toBe("killed");
  });
});

describe("job formatting matrix", () => {
  it.each([
    [
      "completed job",
      {
        id: "job_1",
        command: "printf hello",
        workdir: "/tmp/workspace",
        status: "completed",
        exitCode: 0,
        signal: null,
        startedAt: 1_000,
        endedAt: 3_500,
        output: "hello",
        pid: 42,
        pty: false,
        reattachable: false,
      },
      ["status: completed", "exit_code: 0", "pty: no", "reattachable: no", "hello"],
    ],
    [
      "signaled job",
      {
        id: "job_2",
        command: "sleep 30",
        workdir: "/tmp/workspace",
        status: "failed",
        exitCode: null,
        signal: "SIGTERM",
        startedAt: 2_000,
        endedAt: 4_000,
        output: "",
        pty: true,
        reattachable: true,
      },
      ["status: failed", "signal: SIGTERM", "pty: yes", "reattachable: yes"],
    ],
  ])("formats %s", (_label, job, expectedParts) => {
    const text = formatJob(job as any, 50);
    for (const part of expectedParts) expect(text).toContain(part);
  });

  it("trims job output to the requested tail length", () => {
    const text = formatJob({
      id: "job_tail",
      command: "printf output",
      workdir: "/tmp/workspace",
      status: "completed",
      exitCode: 0,
      signal: null,
      startedAt: 0,
      endedAt: 1000,
      output: "abcdefghij",
      pty: false,
      reattachable: false,
    } as any, 4);

    expect(text).toContain("ghij");
    expect(text).not.toContain("abcd");
  });
});

describe("artifact store matrix", () => {
  it.each([
    ["default extension from name", { kind: "log", name: "run.log", content: "hello" }, ".log"],
    ["sanitized extension", { kind: "diag", name: "diag", extension: "../json", content: "hello" }, ".json"],
    ["fallback extension", { kind: "diag", name: "diag", extension: "!!!", content: "hello" }, ".txt"],
  ])("creates artifacts with %s", (_label, options, expectedExt) => {
    const artifact = createArtifact(options as any);
    expect(artifact.path.endsWith(expectedExt)).toBe(true);
    expect(artifact.metadataPath.endsWith(".json")).toBe(true);
  });

  it("deduplicates ids when artifacts share kind, content, and timestamp", () => {
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const first = createArtifact({ kind: "same", name: "a.txt", content: "identical" });
      const second = createArtifact({ kind: "same", name: "a.txt", content: "identical" });

      expect(first.id).not.toBe(second.id);
      expect(listArtifacts(10).map(record => record.id).sort()).toEqual([first.id, second.id].sort());
    } finally {
      Date.now = originalNow;
    }
  });

  it("finds artifacts by id even when they are older than the 500-record listing window", () => {
    const first = createArtifact({ kind: "old", name: "0.txt", content: "oldest" });
    for (let index = 1; index <= 520; index++) {
      createArtifact({ kind: "bulk", name: `${index}.txt`, content: String(index) });
    }

    expect(getArtifact(first.id)?.id).toBe(first.id);
    expect(readArtifact(first.id)).toContain("oldest");
  });

  it.each([
    ["session", "sess-1"],
    ["turn", "sess-1:3"],
    ["task", "task-1"],
    ["job", "job-1"],
  ])("links artifacts by %s scope", (scope, target) => {
    const artifact = createArtifact({ kind: "evidence", name: "proof.txt", content: "proof" });
    linkArtifact(artifact.id, scope as any, target, { ok: true });

    expect(listArtifactLinks({ scope: scope as any, target_id: target })[0]).toMatchObject({
      artifact_id: artifact.id,
      scope,
      target_id: target,
    });
  });

  it("does not duplicate identical artifact links", () => {
    const artifact = createArtifact({ kind: "evidence", name: "proof.txt", content: "proof" });

    linkArtifact(artifact.id, "session", "s1");
    linkArtifact(artifact.id, "session", "s1");

    expect(listArtifactLinks({ scope: "session", target_id: "s1" })).toHaveLength(1);
  });

  it("rejects malformed artifact metadata instead of writing unreadable records", () => {
    expect(() => createArtifact({
      kind: "evidence",
      name: "proof.txt",
      content: "proof",
      metadata: [] as any,
    })).toThrow(/metadata must be an object/i);
  });

  it("rejects malformed direct artifact create arguments before writing records", () => {
    expect(() => createArtifact({ kind: "" as any, name: "proof.txt", content: "proof" })).toThrow(/kind must be a non-empty string/i);
    expect(() => createArtifact({ kind: "evidence", name: "" as any, content: "proof" })).toThrow(/name must be a non-empty string/i);
    expect(() => createArtifact({ kind: "evidence", name: "proof.txt", content: { nested: true } as any })).toThrow(/content must be a string or Buffer/i);
    expect(() => createArtifact({ kind: "evidence", name: "proof.txt", content: "proof", extension: [] as any })).toThrow(/extension must be a string/i);
    expect(listArtifacts()).toEqual([]);
  });

  it("rejects malformed artifact link metadata instead of persisting links that disappear on reload", () => {
    const artifact = createArtifact({ kind: "evidence", name: "proof.txt", content: "proof" });

    expect(() => linkArtifact(artifact.id, "session", "s1", [] as any)).toThrow(/metadata must be an object/i);
    expect(listArtifactLinks({ scope: "session", target_id: "s1" })).toEqual([]);
  });

  it("rejects malformed direct artifact link arguments before persisting index rows", () => {
    const artifact = createArtifact({ kind: "evidence", name: "proof.txt", content: "proof" });

    expect(() => linkArtifact({ nested: true } as any, "session", "s1")).toThrow(/artifact_id must be a non-empty string/i);
    expect(() => linkArtifact(artifact.id, "weird" as any, "s1")).toThrow(/scope must be one of/i);
    expect(() => linkArtifact(artifact.id, "session", "" as any)).toThrow(/target_id must be a non-empty string/i);
    expect(listArtifactLinks()).toEqual([]);
  });

  it("skips malformed persisted artifact link rows instead of returning fake link state", () => {
    const artifact = createArtifact({ kind: "evidence", name: "proof.txt", content: "proof" });
    const indexPath = join(process.env.DEEPCODE_ARTIFACTS_DIR!, "index.json");

    expect(existsSync(indexPath)).toBe(false);
    writeFileSync(indexPath, JSON.stringify([
      {
        artifact_id: artifact.id,
        scope: "session",
        target_id: "s1",
        created_at: "2026-01-01T00:00:00.000Z",
        metadata: { ok: true },
      },
      {
        artifact_id: { nested: true },
        scope: "session",
        target_id: "s2",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        artifact_id: artifact.id,
        scope: "weird",
        target_id: "s3",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ], null, 2), "utf-8");

    expect(listArtifactLinks()).toEqual([
      expect.objectContaining({
        artifact_id: artifact.id,
        scope: "session",
        target_id: "s1",
      }),
    ]);
    expect(listArtifactLinks({ target_id: "s2" })).toEqual([]);
    expect(listArtifactLinks({ target_id: "s3" })).toEqual([]);
  });

  it("sanitizes lookup ids and reports missing artifacts clearly", () => {
    const artifact = createArtifact({ kind: "safe", name: "safe.txt", content: "ok" });

    expect(getArtifact(`../${artifact.id}`)?.id).toBe(artifact.id);
    expect(readArtifact("missing-artifact")).toContain("artifact not found");
  });

  it("ignores forged artifact metadata that points outside the artifact root", () => {
    const artifact = createArtifact({ kind: "safe", name: "safe.txt", content: "ok" });
    const secret = join(tmp, "secret.txt");
    writeFileSync(secret, "SECRET", "utf-8");
    const metadata = JSON.parse(readFileSync(artifact.metadataPath, "utf-8"));
    metadata.path = secret;
    writeFileSync(artifact.metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

    expect(getArtifact(artifact.id)).toBeUndefined();
    expect(readArtifact(artifact.id)).toContain("artifact not found");
  });

  it("honors explicit artifact roots from the environment", () => {
    expect(artifactRoot()).toBe(join(tmp, "artifacts"));
  });

  it.each([
    ["scope filter", { scope: "session" }, ["session", "session"]],
    ["target filter", { target_id: "turn-1" }, ["turn-1"]],
    ["artifact filter", undefined, []],
  ])("filters artifact links for %s", (_label, filter, expected) => {
    const first = createArtifact({ kind: "evidence", name: "a.txt", content: "a" });
    const second = createArtifact({ kind: "evidence", name: "b.txt", content: "b" });
    const third = createArtifact({ kind: "evidence", name: "c.txt", content: "c" });
    linkArtifact(first.id, "session", "s1");
    linkArtifact(second.id, "session", "s2");
    linkArtifact(third.id, "turn", "turn-1");

    if (!filter) {
      expect(listArtifactLinks({ artifact_id: third.id }).map(link => link.artifact_id)).toEqual([third.id]);
      return;
    }

    const links = listArtifactLinks(filter as any);
    if ("scope" in filter) expect(links.map(link => link.scope)).toEqual(expected);
    else expect(links.map(link => link.target_id)).toEqual(expected);
  });
});

describe("artifact tool matrix", () => {
  it.each([
    ["default limit", {}, 3],
    ["zero limit coerced to one", { limit: 0 }, 1],
    ["negative limit coerced to one", { limit: -5 }, 1],
    ["large limit capped by available records", { limit: 50 }, 3],
    ["fractional limit floors to one", { limit: 1.8 }, 1],
  ])("lists artifacts with %s", async (_label, args, expectedCount) => {
    registerArtifactTools();
    createArtifact({ kind: "log", name: "a.log", content: "a" });
    createArtifact({ kind: "diag", name: "b.txt", content: "b" });
    createArtifact({ kind: "log", name: "c.log", content: "c" });

    const listed = JSON.parse(await getRegistry().lookup("artifact_list")!.execute(args as any));

    expect(listed).toHaveLength(expectedCount);
  });

  it.each([
    ["kind filter log", { kind: "log" }, ["log", "log"]],
    ["kind filter diag", { kind: "diag" }, ["diag"]],
  ])("filters artifact lists for %s", async (_label, args, expectedKinds) => {
    registerArtifactTools();
    createArtifact({ kind: "log", name: "a.log", content: "a" });
    createArtifact({ kind: "diag", name: "b.txt", content: "b" });
    createArtifact({ kind: "log", name: "c.log", content: "c" });

    const listed = JSON.parse(await getRegistry().lookup("artifact_list")!.execute(args as any));

    expect(listed.map((record: any) => record.kind)).toEqual(expectedKinds);
  });

  it.each([
    ["full read", 200_000, false, "abcdef"],
    ["zero-byte read", 0, true, ""],
    ["negative read clamps to zero", -5, true, ""],
    ["short read truncates", 3, true, "abc"],
  ])("reads artifacts with %s", async (_label, maxBytes, truncated, expectedTail) => {
    registerArtifactTools();
    const created = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({
      kind: "log",
      name: "run.log",
      content: "abcdef",
    }));

    const read = await getRegistry().lookup("artifact_read")!.execute({ id: created.id, max_bytes: maxBytes });

    expect(read).toContain(`"truncated": ${truncated}`);
    expect(read.endsWith(expectedTail)).toBe(true);
  });

  it.each([
    ["default env root", "DEEPSEEK_ARTIFACTS_DIR", "seek"],
    ["deepcode root", "DEEPSEEK_ARTIFACTS_DIR", undefined],
    ["seekcode root wins", "SEEKCODE_ARTIFACTS_DIR", "seekcode"],
  ])("resolves artifact roots when %s is set", (_label, envKey, marker) => {
    const oldSeek = process.env.SEEKCODE_ARTIFACTS_DIR;
    const oldDeepseek = process.env.DEEPSEEK_ARTIFACTS_DIR;
    const oldDeepcode = process.env.DEEPCODE_ARTIFACTS_DIR;
    try {
      delete process.env.SEEKCODE_ARTIFACTS_DIR;
      delete process.env.DEEPSEEK_ARTIFACTS_DIR;
      delete process.env.DEEPCODE_ARTIFACTS_DIR;
      if (envKey === "SEEKCODE_ARTIFACTS_DIR") {
        process.env.SEEKCODE_ARTIFACTS_DIR = join(tmp, "seekcode-artifacts");
        process.env.DEEPSEEK_ARTIFACTS_DIR = join(tmp, "deepseek-artifacts");
      } else if (marker === "seek") {
        process.env.DEEPSEEK_ARTIFACTS_DIR = join(tmp, "deepseek-artifacts");
      } else {
        process.env.DEEPCODE_ARTIFACTS_DIR = join(tmp, "deepcode-artifacts");
      }

      const root = artifactRoot();
      expect(root).toContain(marker || "deepcode");
    } finally {
      if (oldSeek === undefined) delete process.env.SEEKCODE_ARTIFACTS_DIR;
      else process.env.SEEKCODE_ARTIFACTS_DIR = oldSeek;
      if (oldDeepseek === undefined) delete process.env.DEEPSEEK_ARTIFACTS_DIR;
      else process.env.DEEPSEEK_ARTIFACTS_DIR = oldDeepseek;
      if (oldDeepcode === undefined) delete process.env.DEEPCODE_ARTIFACTS_DIR;
      else process.env.DEEPCODE_ARTIFACTS_DIR = oldDeepcode;
    }
  });
});
