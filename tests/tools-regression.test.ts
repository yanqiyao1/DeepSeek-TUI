import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { DeepSeekClient } from "../src/client/deepseek.js";
import type { StreamEvent } from "../src/client/base.js";
import type { Config } from "../src/config.js";
import { explainConfig, loadConfig, migrateProjectConfig, migrateUserConfig, validateConfig } from "../src/config.js";
import { calculateCost } from "../src/cost/pricing.js";
import { ContextCompactor, projectMessagesForRequest } from "../src/engine/compact.js";
import type { EngineRuntimeEvent } from "../src/engine/events.js";
import { Engine } from "../src/engine/loop.js";
import { clearHooks, registerHook } from "../src/engine/hooks.js";
import { ImmutablePrefix } from "../src/engine/prefix.js";
import { getTaskManager } from "../src/engine/task-lifecycle.js";
import { getMode } from "../src/modes/base.js";
import { ConversationHistory } from "../src/session/history.js";
import { createSession } from "../src/session/types.js";
import { getRegistry } from "../src/tools/registry.js";
import { PermissionLevel } from "../src/tools/base.js";
import { registerFileTools } from "../src/tools/file-ops.js";
import { registerGitTools } from "../src/tools/git.js";
import { registerPatchTool } from "../src/tools/patch.js";
import { applyPatch as applyAdvancedPatch } from "../src/tools/patch-advanced.js";
import { registerShellTool } from "../src/tools/shell.js";
import { registerTaskTools } from "../src/tools/tasks.js";
import { registerWebTools } from "../src/tools/web.js";
import { SideGit } from "../src/rollback/side-git.js";
import { registerToolSearchTool } from "../src/tools/tool-search.js";
import { registerDiagnosticsTools } from "../src/tools/diagnostics.js";
import { registerArtifactTools } from "../src/tools/artifacts.js";
import { registerBuiltInTools } from "../src/tools/setup.js";
import { clearArtifactsForTests, listArtifactLinks, readArtifact } from "../src/artifacts/store.js";
import { clearMCPManagerForTests, getMCPManager } from "../src/mcp/manager.js";
import { activateSkill, applySkillToUserInput, fetchRegistrySkills, installSkillFromArchive, scanSkills, trustSkill, uninstallSkill, updateSkill } from "../src/engine/skills.js";
import { writeUserConfigRaw } from "../src/config.js";

let tmp: string;
let oldArtifactsDir: string | undefined;
let oldHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-tools-"));
  oldArtifactsDir = process.env.DEEPCODE_ARTIFACTS_DIR;
  oldHome = process.env.HOME;
  process.env.DEEPCODE_ARTIFACTS_DIR = join(tmp, "artifacts");
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  clearArtifactsForTests();
  getRegistry().clear();
  clearHooks();
});

afterEach(async () => {
  clearHooks();
  await clearMCPManagerForTests();
  clearArtifactsForTests();
  if (oldArtifactsDir === undefined) delete process.env.DEEPCODE_ARTIFACTS_DIR;
  else process.env.DEEPCODE_ARTIFACTS_DIR = oldArtifactsDir;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("file tools", () => {
  it("glob matches nested paths with normal wildcard semantics", async () => {
    registerFileTools();
    writeFileSync(join(tmp, "a.ts"), "root");
    const nested = join(tmp, "src", "nested");
    await getRegistry().lookup("write")!.execute({ path: join(nested, "b.ts"), content: "nested", root: tmp });
    writeFileSync(join(nested, "c.js"), "nope");

    const result = await getRegistry().lookup("glob")!.execute({ path: tmp, pattern: "src/**/*.ts" });

    expect(result).toContain("src/nested/b.ts");
    expect(result).not.toContain("a.ts");
    expect(result).not.toContain("c.js");
  });

  it("search treats patterns literally and does not execute shell substitutions", async () => {
    registerFileTools();
    rmSync("SHOULD_NOT_EXIST", { force: true });
    writeFileSync(join(tmp, "notes.txt"), "literal $(touch SHOULD_NOT_EXIST) marker\n");

    const result = await getRegistry().lookup("search")!.execute({ path: tmp, pattern: "$(touch SHOULD_NOT_EXIST)" });

    expect(result).toContain("notes.txt");
    expect(existsSync(join(tmp, "SHOULD_NOT_EXIST"))).toBe(false);
    expect(existsSync("SHOULD_NOT_EXIST")).toBe(false);
  });

  it("supports opt-in regex search while keeping literal search as the default", async () => {
    registerFileTools();
    writeFileSync(join(tmp, "notes.txt"), "ticket-123\nliteral ticket-[0-9]+\n");

    const literal = await getRegistry().lookup("search")!.execute({ path: tmp, pattern: "ticket-[0-9]+" });
    const regex = await getRegistry().lookup("search")!.execute({ path: tmp, pattern: "ticket-[0-9]+", regex: true });

    expect(literal).toContain("literal ticket-[0-9]+");
    expect(literal).not.toContain("ticket-123");
    expect(regex).toContain("ticket-123");
  });

  it("edit rejects an empty old_string instead of corrupting the file", async () => {
    registerFileTools();
    const file = join(tmp, "file.txt");
    writeFileSync(file, "abc");

    const result = await getRegistry().lookup("edit")!.execute({ path: file, old_string: "", new_string: "x", root: tmp });

    expect(result).toMatch(/old_string.*empty/i);
    expect(readFileSync(file, "utf-8")).toBe("abc");
  });

  it("handles paths with spaces and Chinese characters", async () => {
    registerFileTools();
    const dir = join(tmp, "目录 with spaces");
    const file = join(dir, "文件 名.txt");

    const write = await getRegistry().lookup("write")!.execute({ path: file, content: "你好\nsecond line", root: tmp });
    const read = await getRegistry().lookup("read")!.execute({ path: file, root: tmp });
    const list = await getRegistry().lookup("ls")!.execute({ path: dir });
    const search = await getRegistry().lookup("search")!.execute({ path: dir, pattern: "你好" });
    const glob = await getRegistry().lookup("glob")!.execute({ path: tmp, pattern: "目录 with spaces/*.txt" });

    expect(write).toContain("Successfully wrote");
    expect(write).toContain("[diff]");
    expect(write).toContain("+ 你好");
    expect(read).toContain("你好");
    expect(list).toContain("文件 名.txt");
    expect(search).toContain("文件 名.txt");
    expect(glob).toContain("目录 with spaces/文件 名.txt");
  });

  it("resolves relative file paths from the explicit root", async () => {
    registerFileTools();
    const root = join(tmp, "workspace root");
    mkdirSync(root, { recursive: true });

    const write = await getRegistry().lookup("write")!.execute({ path: "目录/文件.txt", content: "root-relative", root });
    const read = await getRegistry().lookup("read")!.execute({ path: "目录/文件.txt", root });
    const list = await getRegistry().lookup("ls")!.execute({ path: "目录", root });
    const search = await getRegistry().lookup("search")!.execute({ path: ".", pattern: "root-relative", root });
    const glob = await getRegistry().lookup("glob")!.execute({ path: ".", pattern: "目录/*.txt", root });

    expect(write).toContain("Successfully wrote");
    expect(write).toContain("[diff]");
    expect(read).toBe("root-relative");
    expect(list).toContain("文件.txt");
    expect(search).toContain("文件.txt");
    expect(glob).toContain("目录/文件.txt");
  });

  it("writes new files to absolute paths without requiring an explicit root", async () => {
    registerFileTools();
    const file = join(tmp, "absolute", "nested", "note.md");

    const result = await getRegistry().lookup("write")!.execute({ path: file, content: "# absolute\n" });

    expect(result).toContain("Successfully wrote");
    expect(readFileSync(file, "utf-8")).toBe("# absolute\n");
  });

  it("handles relative ls/search/glob paths without requiring an explicit root", async () => {
    registerFileTools();
    const oldCwd = process.cwd();
    process.chdir(tmp);
    try {
      mkdirSync(join("src", "nested"), { recursive: true });
      writeFileSync(join("src", "nested", "file.txt"), "needle\n");

      const list = await getRegistry().lookup("ls")!.execute({ path: "src" });
      const search = await getRegistry().lookup("search")!.execute({ path: "src", pattern: "needle" });
      const glob = await getRegistry().lookup("glob")!.execute({ path: "src", pattern: "nested/*.txt" });

      expect(list).toContain("nested/");
      expect(search).toContain("file.txt");
      expect(glob).toContain("nested/file.txt");
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("reads and writes empty files without fabricating content", async () => {
    registerFileTools();
    const file = join(tmp, "empty.txt");

    const write = await getRegistry().lookup("write")!.execute({ path: file, content: "", root: tmp });
    const read = await getRegistry().lookup("read")!.execute({ path: file, root: tmp });

    expect(write).toContain("Successfully wrote 0 bytes");
    expect(read).toBe("");
    expect(readFileSync(file, "utf-8")).toBe("");
  });

  it("rejects non-string file tool inputs during execution instead of coercing objects into paths and patterns", async () => {
    registerFileTools();
    const file = join(tmp, "direct-exec.txt");
    writeFileSync(file, "alpha\nbeta\n");

    expect(await getRegistry().lookup("read")!.execute({ path: { nested: true } as any, root: tmp })).toContain("path must be a non-empty string");
    expect(await getRegistry().lookup("write")!.execute({ path: file, content: { nested: true } as any, root: tmp })).toContain("content must be a string");
    expect(await getRegistry().lookup("edit")!.execute({ path: file, old_string: { nested: true } as any, new_string: "x", root: tmp })).toContain("old_string must be a non-empty string");
    expect(await getRegistry().lookup("ls")!.execute({ path: { nested: true } as any, root: tmp })).toContain("path must be a string");
    expect(await getRegistry().lookup("search")!.execute({ path: tmp, pattern: { nested: true } as any })).toContain("pattern must be a non-empty string");
    expect(await getRegistry().lookup("glob")!.execute({ path: tmp, pattern: { nested: true } as any })).toContain("pattern must be a non-empty string");
    expect(readFileSync(file, "utf-8")).toBe("alpha\nbeta\n");
  });

  it("rejects malformed optional file tool inputs instead of silently normalizing them away", async () => {
    registerFileTools();
    const file = join(tmp, "typed-options.txt");
    writeFileSync(file, "alpha\nbeta\n");
    const readTool = getRegistry().lookup("read")!;
    const editTool = getRegistry().lookup("edit")!;
    const lsTool = getRegistry().lookup("ls")!;
    const searchTool = getRegistry().lookup("search")!;
    const globTool = getRegistry().lookup("glob")!;

    expect(await readTool.validateInput?.(
      { path: file, root: { nested: true } as any },
      { tool_name: "read", workspace_path: tmp, tool_def: readTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("root must be a string"),
    });
    expect(await readTool.validateInput?.(
      { path: file, offset: { nested: true } as any },
      { tool_name: "read", workspace_path: tmp, tool_def: readTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("offset must be a number"),
    });
    expect(await readTool.validateInput?.(
      { path: file, limit: { nested: true } as any },
      { tool_name: "read", workspace_path: tmp, tool_def: readTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("limit must be a number"),
    });
    expect(await editTool.validateInput?.(
      { path: file, old_string: "alpha", new_string: "beta", replace_all: "yes" as any },
      { tool_name: "edit", workspace_path: tmp, tool_def: editTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("replace_all must be a boolean"),
    });
    expect(await lsTool.validateInput?.(
      { root: { nested: true } as any },
      { tool_name: "ls", workspace_path: tmp, tool_def: lsTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("root must be a string"),
    });
    expect(await searchTool.validateInput?.(
      { path: tmp, pattern: "alpha", case_sensitive: "no" as any },
      { tool_name: "search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("case_sensitive must be a boolean"),
    });
    expect(await searchTool.validateInput?.(
      { path: tmp, pattern: "alpha", include: { nested: true } as any },
      { tool_name: "search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("include must be a string"),
    });
    expect(await globTool.validateInput?.(
      { path: tmp, pattern: "*.txt", root: { nested: true } as any },
      { tool_name: "glob", workspace_path: tmp, tool_def: globTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("root must be a string"),
    });

    expect(await readTool.execute({ path: file, offset: { nested: true } as any })).toContain("offset must be a number");
    expect(await readTool.execute({ path: file, limit: { nested: true } as any })).toContain("limit must be a number");
    expect(await editTool.execute({ path: file, old_string: "alpha", new_string: "beta", replace_all: "yes" as any })).toContain("replace_all must be a boolean");
    expect(await lsTool.execute({ root: { nested: true } as any })).toContain("root must be a string");
    expect(await searchTool.execute({ path: tmp, pattern: "alpha", case_sensitive: "no" as any })).toContain("case_sensitive must be a boolean");
    expect(await searchTool.execute({ path: tmp, pattern: "alpha", include: { nested: true } as any })).toContain("include must be a string");
    expect(await globTool.execute({ path: tmp, pattern: "*.txt", root: { nested: true } as any })).toContain("root must be a string");
  });

  it("clamps negative read offsets to the start of the file", async () => {
    registerFileTools();
    const file = join(tmp, "offset.txt");
    writeFileSync(file, "first\nsecond\nthird\n");

    const read = await getRegistry().lookup("read")!.execute({ path: file, root: tmp, offset: -5, limit: 1 });

    expect(read).toBe("first");
  });

  it("accepts common path/content aliases for write validation", async () => {
    registerFileTools();
    const file = join(tmp, "alias-target.txt");
    const writeTool = getRegistry().lookup("write")!;
    const validation = await writeTool.validateInput?.(
      { file_path: file, text: "alias body", root: tmp },
      { tool_name: "write", workspace_path: tmp, tool_def: writeTool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        path: file,
        content: "alias body",
      },
    });

    const result = await writeTool.execute(validation!.args!, { workspacePath: tmp });

    expect(result).toContain("Successfully wrote");
    expect(readFileSync(file, "utf-8")).toBe("alias body");
  });

  it("truncates very large write diffs to keep tool results cheap", async () => {
    registerFileTools();
    const file = join(tmp, "huge.txt");
    const content = Array.from({ length: 400 }, (_, index) => `line-${index}-${"x".repeat(80)}`).join("\n");

    const result = await getRegistry().lookup("write")!.execute({ path: file, content, root: tmp });

    expect(result).toContain("[diff]");
    expect(result).toContain("more diff lines");
    expect(result.length).toBeLessThan(20_000);
  });

  it("does not follow symlinks that escape the requested root", async () => {
    registerFileTools();
    const root = join(tmp, "root");
    const outside = join(tmp, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "SECRET_TOKEN\n");
    symlinkSync(outside, join(root, "linked-outside"), "dir");

    const read = await getRegistry().lookup("read")!.execute({ path: join(root, "linked-outside", "secret.txt"), root });
    const glob = await getRegistry().lookup("glob")!.execute({ path: root, pattern: "**/*.txt" });
    const search = await getRegistry().lookup("search")!.execute({ path: root, pattern: "SECRET_TOKEN" });

    expect(read).toMatch(/outside root|symlink|escape/i);
    expect(glob).not.toContain("secret.txt");
    expect(search).toContain("No matches found");
    expect(search).not.toContain("secret.txt");
  });

  it("rejects direct symlink roots that escape the workspace boundary", async () => {
    registerFileTools();
    const root = join(tmp, "root");
    const outside = join(tmp, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "SECRET_TOKEN\n");
    symlinkSync(outside, join(root, "linked-outside"), "dir");
    const linked = join(root, "linked-outside");

    const list = await getRegistry().lookup("ls")!.execute({ path: linked, root });
    const search = await getRegistry().lookup("search")!.execute({ path: linked, pattern: "SECRET_TOKEN", root });
    const glob = await getRegistry().lookup("glob")!.execute({ path: linked, pattern: "**/*.txt", root });

    expect(list).toMatch(/symlink|escape/i);
    expect(search).toMatch(/symlink|escape/i);
    expect(glob).toMatch(/symlink|escape/i);
  });
});

describe("git and patch tools", () => {
  it("git_diff handles file names with spaces", async () => {
    registerGitTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "file with space.txt"), "old\n");
    await run("git add . && git commit -m init");
    writeFileSync(join(tmp, "file with space.txt"), "new\n");

    const result = await getRegistry().lookup("git_diff")!.execute({ workdir: tmp, files: "file with space.txt" });

    expect(result).toContain("-old");
    expect(result).toContain("+new");
  });

  it("git_diff handles Unicode file names in nested directories", async () => {
    registerGitTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    mkdirSync(join(tmp, "目录"), { recursive: true });
    writeFileSync(join(tmp, "目录", "文件 名.txt"), "旧内容\n");
    await run("git add . && git commit -m init");
    writeFileSync(join(tmp, "目录", "文件 名.txt"), "新内容\n");

    const result = await getRegistry().lookup("git_diff")!.execute({ workdir: tmp, files: ["目录/文件 名.txt"] });

    expect(result).toContain("-旧内容");
    expect(result).toContain("+新内容");
  });

  it("rejects malformed git tool inputs instead of coercing them into fake git args", async () => {
    registerGitTools();
    const gitDiff = getRegistry().lookup("git_diff")!;
    const gitLog = getRegistry().lookup("git_log")!;
    const gitStatus = getRegistry().lookup("git_status")!;

    expect(await gitDiff.validateInput?.(
      { workdir: { nested: true } as any },
      { tool_name: "git_diff", workspace_path: tmp, tool_def: gitDiff },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await gitDiff.validateInput?.(
      { workdir: tmp, files: [join(tmp, "tracked.txt"), 7] as any },
      { tool_name: "git_diff", workspace_path: tmp, tool_def: gitDiff },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("files must be a string or array of strings"),
    });
    expect(await gitLog.validateInput?.(
      { n: { nested: true } as any },
      { tool_name: "git_log", workspace_path: tmp, tool_def: gitLog },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("n must be a positive integer"),
    });

    expect(await gitStatus.execute({ cwd: { nested: true } as any })).toContain("workdir must be a string");
    expect(await gitDiff.execute({ workdir: tmp, files: [join(tmp, "tracked.txt"), 7] as any })).toContain("files must be a string or array of strings");
    expect(await gitLog.execute({ workdir: tmp, n: { nested: true } as any })).toContain("n must be a positive integer");
  });

  it("trims git workdir aliases during validation and execution", async () => {
    registerGitTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "tracked.txt"), "tracked\n");
    await run("git add . && git commit -m init");
    writeFileSync(join(tmp, "tracked.txt"), "changed\n");
    const tool = getRegistry().lookup("git_status")!;

    expect(await tool.validateInput?.(
      { workdir: `  ${tmp}  ` },
      { tool_name: "git_status", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: true,
      args: {
        workdir: tmp,
      },
    });

    const result = await tool.execute({ cwd: `  ${tmp}  ` });

    expect(result).toContain("tracked.txt");
  });

  it("apply_patch cleans up temp files after a failed patch", async () => {
    registerPatchTool();
    const before = tempPatchFiles();

    const result = await getRegistry().lookup("apply_patch")!.execute({ patch: "not a patch" });

    expect(result).toMatch(/Patch failed/i);
    expect(tempPatchFiles()).toEqual(before);
  });

  it("advanced patch add excludes diff headers from file contents", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result[0]).toMatchObject({ type: "add", path: "new.txt" });
    expect(readFileSync(join(tmp, "new.txt"), "utf-8")).toBe("hello\nworld");
  });

  it("registered apply_patch includes a compact diff preview", async () => {
    registerPatchTool();
    writeFileSync(join(tmp, "preview.txt"), "old\n");
    const patch = [
      "diff --git a/preview.txt b/preview.txt",
      "index 1111111..2222222 100644",
      "--- a/preview.txt",
      "+++ b/preview.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const result = await getRegistry().lookup("apply_patch")!.execute({ patch, workdir: tmp });

    expect(result).toContain("Patch applied successfully");
    expect(result).toContain("[diff]");
    expect(result).toContain("- old");
    expect(result).toContain("+ new");
  });

  it("rejects non-string apply_patch payloads instead of throwing during execution", async () => {
    registerPatchTool();

    const result = await getRegistry().lookup("apply_patch")!.execute({
      patch: { nested: true } as any,
      workdir: tmp,
    });

    expect(result).toContain("patch must be a non-empty string");
  });

  it("advanced patch rejects paths that escape the workdir", () => {
    const outside = join(tmp, "..", "outside.txt");
    const patch = [
      "diff --git a/../outside.txt b/../outside.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/../outside.txt",
      "@@ -0,0 +1 @@",
      "+owned",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result[0].type).toBe("error");
    expect(result[0].message).toMatch(/escapes workdir/i);
    expect(existsSync(outside)).toBe(false);
  });

  it("advanced patch deletes files in ESM without require", () => {
    const file = join(tmp, "delete-me.txt");
    writeFileSync(file, "remove\n");
    const patch = [
      "diff --git a/delete-me.txt b/delete-me.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/delete-me.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-remove",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result[0]).toMatchObject({ type: "delete", path: "delete-me.txt" });
    expect(existsSync(file)).toBe(false);
  });

  it("advanced patch applies multi-file changes atomically on failure", () => {
    writeFileSync(join(tmp, "a.txt"), "before-a\n");
    writeFileSync(join(tmp, "b.txt"), "before-b\n");
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-before-a",
      "+after-a",
      "diff --git a/b.txt b/b.txt",
      "index 1111111..2222222 100644",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-missing-b",
      "+after-b",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result.some(item => item.type === "error")).toBe(true);
    expect(readFileSync(join(tmp, "a.txt"), "utf-8")).toBe("before-a\n");
    expect(readFileSync(join(tmp, "b.txt"), "utf-8")).toBe("before-b\n");
  });

  it("registered apply_patch uses workdir and keeps multi-file failures atomic", async () => {
    registerPatchTool();
    writeFileSync(join(tmp, "a.txt"), "before-a\n");
    writeFileSync(join(tmp, "b.txt"), "before-b\n");
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-before-a",
      "+after-a",
      "diff --git a/b.txt b/b.txt",
      "index 1111111..2222222 100644",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-missing-b",
      "+after-b",
      "",
    ].join("\n");

    const result = await getRegistry().lookup("apply_patch")!.execute({ patch, workdir: tmp });

    expect(result).toMatch(/Patch failed/i);
    expect(readFileSync(join(tmp, "a.txt"), "utf-8")).toBe("before-a\n");
    expect(readFileSync(join(tmp, "b.txt"), "utf-8")).toBe("before-b\n");
  });

  it("registered apply_patch normalizes cwd aliases during validation", async () => {
    registerPatchTool();
    const tool = getRegistry().lookup("apply_patch")!;
    const validation = await tool.validateInput?.(
      { patch: "diff --git a/a b/a\n", cwd: tmp },
      { tool_name: "apply_patch", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        patch: "diff --git a/a b/a\n",
        workdir: tmp,
      },
    });
  });

  it("registered apply_patch honors cwd aliases during direct execution even when workdir is an empty placeholder", async () => {
    registerPatchTool();
    const workspace = join(tmp, "patch-alias-exec");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "note.txt"), "before\n");
    const patch = [
      "diff --git a/note.txt b/note.txt",
      "--- a/note.txt",
      "+++ b/note.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");

    const result = await getRegistry().lookup("apply_patch")!.execute({
      patch,
      workdir: "",
      cwd: workspace,
    });

    expect(result).toMatch(/Patch applied successfully/i);
    expect(readFileSync(join(workspace, "note.txt"), "utf-8")).toBe("after\n");
    expect(existsSync(join(tmp, "note.txt"))).toBe(false);
  });

  it("registered apply_patch ignores whitespace-only workdir placeholders so cwd aliases still apply", async () => {
    registerPatchTool();
    const workspace = join(tmp, "patch-whitespace-alias-exec");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "note.txt"), "before\n");
    const patch = [
      "diff --git a/note.txt b/note.txt",
      "--- a/note.txt",
      "+++ b/note.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const tool = getRegistry().lookup("apply_patch")!;

    expect(await tool.validateInput?.(
      { patch, workdir: "   ", cwd: workspace },
      { tool_name: "apply_patch", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: true,
      args: {
        patch,
        workdir: workspace,
        cwd: workspace,
      },
    });

    const result = await tool.execute({
      patch,
      workdir: "   ",
      cwd: workspace,
    });

    expect(result).toMatch(/Patch applied successfully/i);
    expect(readFileSync(join(workspace, "note.txt"), "utf-8")).toBe("after\n");
    expect(existsSync(join(tmp, "note.txt"))).toBe(false);
  });

  it("rejects non-string apply_patch workdirs instead of coercing them into fake patch roots", async () => {
    registerPatchTool();
    const tool = getRegistry().lookup("apply_patch")!;

    expect(await tool.validateInput?.(
      { patch: "diff --git a/a b/a\n", cwd: { nested: true } as any },
      { tool_name: "apply_patch", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });

    const result = await tool.execute({
      patch: "diff --git a/a b/a\n",
      cwd: { nested: true } as any,
    });

    expect(result).toContain("workdir must be a string");
  });

  it("advanced patch dry-run does not create parent directories", () => {
    const patch = [
      "diff --git a/嵌套 dir/new.txt b/嵌套 dir/new.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/嵌套 dir/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp, dryRun: true });

    expect(result[0]).toMatchObject({ type: "add", path: "嵌套 dir/new.txt" });
    expect(existsSync(join(tmp, "嵌套 dir"))).toBe(false);
  });

  it("advanced patch rejects missing deletes before changing other files", () => {
    writeFileSync(join(tmp, "a.txt"), "before-a\n");
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-before-a",
      "+after-a",
      "diff --git a/missing.txt b/missing.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/missing.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result.some(item => item.type === "error")).toBe(true);
    expect(readFileSync(join(tmp, "a.txt"), "utf-8")).toBe("before-a\n");
  });

  it("advanced patch applies renames from the source path", () => {
    writeFileSync(join(tmp, "old name.txt"), "before\n");
    const patch = [
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 50%",
      "rename from old name.txt",
      "rename to new name.txt",
      "--- a/old name.txt",
      "+++ b/new name.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result[0]).toMatchObject({ type: "update", path: "new name.txt" });
    expect(existsSync(join(tmp, "old name.txt"))).toBe(false);
    expect(readFileSync(join(tmp, "new name.txt"), "utf-8")).toBe("after\n");
  });

  it("advanced patch rejects writes through symlinks that escape the workdir", () => {
    const outside = join(tmp, "outside");
    const root = join(tmp, "root");
    const workdir = join(root, "workdir");
    mkdirSync(outside, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(outside, "target.txt"), "outside\n");
    symlinkSync(join(outside, "target.txt"), join(workdir, "linked.txt"));
    const patch = [
      "diff --git a/linked.txt b/linked.txt",
      "index 1111111..2222222 100644",
      "--- a/linked.txt",
      "+++ b/linked.txt",
      "@@ -1 +1 @@",
      "-outside",
      "+owned",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir });

    expect(result[0].type).toBe("error");
    expect(result[0].message).toMatch(/symlink|escapes workdir/i);
    expect(readFileSync(join(outside, "target.txt"), "utf-8")).toBe("outside\n");
  });

  it("advanced patch applies the intended repeated block instead of the first textual match", () => {
    const file = join(tmp, "repeat.txt");
    writeFileSync(file, [
      "start",
      "common",
      "target",
      "common",
      "middle",
      "common",
      "target",
      "common",
      "end",
      "",
    ].join("\n"));
    const patch = [
      "diff --git a/repeat.txt b/repeat.txt",
      "index 1111111..2222222 100644",
      "--- a/repeat.txt",
      "+++ b/repeat.txt",
      "@@ -6,3 +6,3 @@",
      " common",
      "-target",
      "+patched",
      " common",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result[0]).toMatchObject({ type: "update", path: "repeat.txt" });
    expect(readFileSync(file, "utf-8")).toBe([
      "start",
      "common",
      "target",
      "common",
      "middle",
      "common",
      "patched",
      "common",
      "end",
      "",
    ].join("\n"));
  });
});

describe("tool catalog", () => {
  it("loads workspace-local custom tools with ASK permission and conflict-safe names", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "hello.cjs"), [
      "module.exports = [",
      "  tool({",
      "    name: 'hello_tool',",
      "    description: 'Say hello from a local tool',",
      "    parameters: { type: 'object', properties: { name: { type: 'string' } } },",
      "    readOnly: true,",
      "    validate(args) { return typeof args.name === 'string' ? { ok: true, args } : 'name must be a string'; },",
      "    run(args) { return `hello ${args.name}`; }",
      "  }),",
      "  tool({ name: 'read', description: 'conflicting read', run() { return 'custom read'; } })",
      "];",
    ].join("\n"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const list = JSON.parse(await getRegistry().lookup("custom_tools")!.execute({})) as { tools: Array<{ name: string; requested_name: string }> };
    const hello = getRegistry().lookup("hello_tool")!;
    const conflict = getRegistry().lookup("custom_read")!;

    expect(list.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "hello_tool", requested_name: "hello_tool" }),
      expect.objectContaining({ name: "custom_read", requested_name: "read" }),
    ]));
    expect(hello.permission).toBe(PermissionLevel.ASK);
    expect(hello.readOnly).toBe(true);
    expect(await hello.execute({ name: "Ada" })).toBe("hello Ada");
    expect(await hello.validateInput?.(
      { name: 7 as any },
      { tool_name: "hello_tool", workspace_path: tmp, tool_def: hello },
    )).toMatchObject({ ok: false, message: "name must be a string" });
    expect(await conflict.execute({})).toBe("custom read");
    expect(getRegistry().lookup("read")?.name).toBe("read");
  });

  it("returns stable sorted schemas and activates deferred tools through tool_search", async () => {
    getRegistry().register({
      name: "z_deferred",
      description: "rare github helper",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      deferLoading: true,
      execute: async () => "ok",
    });
    getRegistry().register({
      name: "a_active",
      description: "common helper",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => "ok",
    });
    registerToolSearchTool();

    expect(getRegistry().listAll().map(tool => tool.name)).toEqual(["a_active", "tool_enable", "tool_search", "tool_stats", "z_deferred"]);
    expect(getRegistry().listActive().map(tool => tool.name)).toEqual(["a_active", "tool_enable", "tool_search", "tool_stats"]);
    expect(getRegistry().toOpenAISchemas().map((schema: any) => schema.function.name)).toEqual(["a_active", "tool_enable", "tool_search", "tool_stats", "z_deferred"]);
    await getRegistry().lookup("tool_search")!.execute({ query: "github" });
    expect(getRegistry().listActive().map(tool => tool.name)).toEqual(["a_active", "tool_enable", "tool_search", "tool_stats", "z_deferred"]);
  });

  it("tracks tool failures and degrades unhealthy tools", async () => {
    registerToolSearchTool();
    getRegistry().register({
      name: "flaky",
      description: "flaky tool",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => "Error: fail",
    });
    const stats = getRegistry().recordCall("flaky", false, 5);
    const reason = getRegistry().degradeIfUnhealthy("flaky", 1);

    expect(stats.failures).toBe(1);
    expect(reason).toContain("disabled");
    expect(getRegistry().listActive().map(tool => tool.name)).not.toContain("flaky");
    expect(await getRegistry().lookup("tool_enable")!.execute({ name: "flaky" })).toContain("Enabled");
  });

  it("normalizes capability metadata, aliases, and search hints", async () => {
    getRegistry().register({
      name: "read",
      aliases: ["old_read"],
      description: "custom read helper",
      searchHint: "notebook context lookup",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      maxResultSizeChars: 1234,
      execute: async () => "ok",
    });

    expect(getRegistry().lookup("old_read")?.name).toBe("read");
    expect(getRegistry().search("notebook readonly")[0]?.tool.name).toBe("read");
    expect(getRegistry().toolStats().find(item => item.name === "read")).toMatchObject({
      read_only: true,
      concurrency_safe: true,
      search_hint: "notebook context lookup",
      max_result_size_chars: 1234,
    });

    getRegistry().register({
      name: "read",
      aliases: ["new_read"],
      description: "replacement read helper",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => "new",
    });

    expect(getRegistry().lookup("old_read")).toBeUndefined();
    expect(getRegistry().lookup("new_read")?.name).toBe("read");
  });

  it("tool_search activates by searchHint and renders capability tags", async () => {
    getRegistry().register({
      name: "rare_reader",
      description: "rare helper",
      searchHint: "notebook context lookup",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      readOnly: true,
      deferLoading: true,
      execute: async () => "ok",
    });
    registerToolSearchTool();

    const result = await getRegistry().lookup("tool_search")!.execute({ query: "notebook" });

    expect(result).toContain("rare_reader");
    expect(result).toContain("read-only");
    expect(result).toContain("concurrent");
    expect(result).toContain("hint: notebook context lookup");
    expect(getRegistry().listActive().map(tool => tool.name)).toContain("rare_reader");
  });

  it("registers diagnostics and deferred ecosystem tools", () => {
    registerDiagnosticsTools();

    expect(getRegistry().lookup("diagnostics")).toBeTruthy();
    expect(getRegistry().lookup("github_issue_context")?.deferLoading).toBe(true);
    expect(getRegistry().lookup("automation_create")?.deferLoading).toBe(true);
  });
});

describe("side git rollback", () => {
  it("snapshots and restores workspaces whose paths contain spaces", async () => {
    const workspace = join(tmp, "workspace with spaces");
    await import("node:fs").then(({ mkdirSync }) => mkdirSync(workspace, { recursive: true }));
    const file = join(workspace, "file.txt");
    writeFileSync(file, "before\n");
    const sideGit = new SideGit(workspace);

    expect(await sideGit.init()).toBe(true);
    const snap = await sideGit.snapshotPre(1);
    expect(snap).toBeTruthy();
    writeFileSync(file, "after\n");
    const snapshots = await sideGit.listSnapshots();

    expect(snapshots[0].message).toBe("pre-turn-1");
    expect(await sideGit.restoreTo(snapshots[0].hash)).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("before\n");
  });

  it("restores dirty tracked and untracked changes in Unicode paths", async () => {
    const workspace = join(tmp, "工作区 with spaces");
    mkdirSync(workspace, { recursive: true });
    const tracked = join(workspace, "文件.txt");
    const addedAfterSnapshot = join(workspace, "新增.txt");
    writeFileSync(tracked, "before\n");
    const sideGit = new SideGit(workspace);

    expect(await sideGit.init()).toBe(true);
    const snap = await sideGit.snapshotPre("中文 turn");
    expect(snap).toBeTruthy();
    writeFileSync(tracked, "after\n");
    writeFileSync(addedAfterSnapshot, "new\n");
    const snapshots = await sideGit.listSnapshots();

    expect(await sideGit.restoreTo(snapshots[0].hash)).toBe(true);
    expect(readFileSync(tracked, "utf-8")).toBe("before\n");
    expect(existsSync(addedAfterSnapshot)).toBe(false);
  });

  it("preserves side-git history and removes files added by later snapshots", async () => {
    const workspace = join(tmp, "restore history");
    mkdirSync(workspace, { recursive: true });
    const original = join(workspace, "原始.txt");
    const later = join(workspace, "later file.txt");
    writeFileSync(original, "before\n");
    const sideGit = new SideGit(workspace);

    expect(await sideGit.init()).toBe(true);
    const pre = await sideGit.snapshotPre(1);
    expect(pre).toBeTruthy();
    writeFileSync(original, "after\n");
    writeFileSync(later, "new\n");
    expect(await sideGit.snapshotPost(1)).toBeTruthy();
    const snapshots = await sideGit.listSnapshots();

    expect(await sideGit.restoreTo(snapshots.find(item => item.message === "pre-turn-1")!.hash)).toBe(true);
    expect(readFileSync(original, "utf-8")).toBe("before\n");
    expect(existsSync(later)).toBe(false);
    expect(existsSync(join(workspace, ".seekcode", "side-git", "HEAD"))).toBe(true);
    expect((await sideGit.listSnapshots()).map(item => item.message)).toEqual(["post-turn-1", "pre-turn-1"]);
  });

  it("removes ignored files that were created after the snapshot", async () => {
    const workspace = join(tmp, "ignored cleanup");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, ".gitignore"), "ignored.log\n");
    const ignored = join(workspace, "ignored.log");
    const sideGit = new SideGit(workspace);

    expect(await sideGit.init()).toBe(true);
    const snap = await sideGit.snapshotPre(1);
    expect(snap).toBeTruthy();
    writeFileSync(ignored, "temporary\n");
    const snapshots = await sideGit.listSnapshots();

    expect(await sideGit.restoreTo(snapshots[0].hash)).toBe(true);
    expect(existsSync(ignored)).toBe(false);
  });
});

describe("engine", () => {
  it("computes deterministic immutable prefix hashes", () => {
    const prefixA = new ImmutablePrefix({
      systemPrompt: "system",
      toolSchemas: [
        { type: "function", function: { name: "b", parameters: { type: "object" } } },
        { function: { parameters: { type: "object" }, name: "a" }, type: "function" },
      ],
      memoryIndex: "memory",
    });
    const prefixB = new ImmutablePrefix({
      systemPrompt: "system",
      toolSchemas: [
        { function: { parameters: { type: "object" }, name: "b" }, type: "function" },
        { type: "function", function: { name: "a", parameters: { type: "object" } } },
      ],
      memoryIndex: "memory",
    });

    expect(prefixA.hash).toBe(prefixB.hash);
    expect(prefixA.metadata).toMatchObject({
      hash: prefixA.hash,
      tool_count: 2,
      system_chars: 6,
      memory_index_chars: 6,
    });
  });

  it("uses a pinned tool schema prefix across turns even when deferred tools auto-activate", async () => {
    getRegistry().register({
      name: "a_active",
      description: "always active",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => "active",
    });
    getRegistry().register({
      name: "rare_reader",
      description: "rare_reader deferred context trigger",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      deferLoading: true,
      execute: async () => "rare",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const pinnedSchemas = getRegistry().toOpenAISchemas();
    const prefix = new ImmutablePrefix({ systemPrompt: "system", toolSchemas: pinnedSchemas });
    const client = new FakeClient([
      { type: "done", finish_reason: "stop", usage: null, content: "first", reasoning_content: null, tool_calls: [] },
      { type: "done", finish_reason: "stop", usage: null, content: "second", reasoning_content: null, tool_calls: [] },
    ]);
    const events: EngineRuntimeEvent[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry(), prefix);

    await engine.runTurn("hello", getMode("agent"), { onRuntimeEvent: async event => { events.push(event); } });
    await engine.runTurn("please use rare_reader", getMode("agent"), { onRuntimeEvent: async event => { events.push(event); } });

    expect(getRegistry().listActive().map(tool => tool.name)).toContain("rare_reader");
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].tools).toEqual(pinnedSchemas);
    expect(client.calls[1].tools).toEqual(pinnedSchemas);
    expect(client.calls[1].tools.map((schema: any) => schema.function.name)).toContain("rare_reader");
    const prefixEvents = events.filter(event => event.type === "prefix_pinned");
    expect(prefixEvents.map(event => (event.data as any).hash)).toEqual([prefix.hash, prefix.hash]);
    const apiEvents = events.filter(event => event.type === "api_call_start");
    expect(apiEvents.every(event => (event.data as any).prefix_hash === prefix.hash)).toBe(true);
  });

  it("rejects inactive tools at dispatch even when they are present in the stable schema prefix", async () => {
    getRegistry().register({
      name: "rare_reader",
      description: "rare_reader deferred context trigger",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      deferLoading: true,
      execute: async () => "rare",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const prefix = new ImmutablePrefix({
      systemPrompt: "system",
      toolSchemas: getRegistry().toOpenAISchemas(),
    });
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "rare_reader", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry(), prefix);

    const result = await engine.runTurn("call hidden helper directly", getMode("agent"));

    expect(client.calls[0].tools.map((schema: any) => schema.function.name)).toContain("rare_reader");
    expect(result.tool_results[0]).toMatchObject({
      name: "rare_reader",
      is_error: true,
    });
    expect(result.tool_results[0].content).toContain("not active");
  });

  it("records errored tool executions in the turn result", async () => {
    getRegistry().register({
      name: "fail_tool",
      description: "fails",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => { throw new Error("boom"); },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "fail_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results).toHaveLength(1);
    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("boom");
  });

  it("records structured sub-agent error results as tool failures", async () => {
    getRegistry().register({
      name: "spawn_agent",
      description: "spawn",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => [
        "<deepseek:subagent.error>",
        "  agent_id: agent_1",
        "  summary: |",
        "    upstream auth failed",
        "</deepseek:subagent.error>",
      ].join("\n"),
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "spawn_agent", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results).toHaveLength(1);
    expect(result.tool_results[0]).toMatchObject({ name: "spawn_agent", is_error: true });
    expect(result.tool_results[0].content).toContain("<deepseek:subagent.error>");
  });

  it("honors session plan mode even if a stale agent mode object is passed to the engine", async () => {
    registerFileTools();
    const session = createSession({ workspace_path: tmp, mode: "plan" });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{ id: "call_1", name: "write", arguments: { path: "x.txt", content: "bad" } }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig({ mode: "plan" as any }), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results).toHaveLength(1);
    expect(result.tool_results[0]).toMatchObject({ name: "write", is_error: true });
    expect(result.tool_results[0].content).toContain("not active");
  });

  it("records unknown tool calls in the turn result", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "missing_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const previews: string[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      onToolExecuted: async (_name, preview) => { previews.push(preview); },
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_results).toHaveLength(1);
    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("Unknown tool");
    expect(previews[0]).toContain("Unknown tool");
  });

  it("passes full successful tool output to UI previews so diff blocks survive", async () => {
    getRegistry().register({
      name: "diff_tool",
      description: "returns a diff",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "file",
      execute: async () => [
        "Successfully edited x.ts",
        "",
        "[diff]",
        "  ── x.ts ──",
        "- old",
        "+ new",
      ].join("\n"),
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "diff_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const previews: string[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), {
      onToolExecuted: async (_name, preview) => { previews.push(preview); },
    });

    expect(previews[0]).toContain("[diff]");
    expect(previews[0]).toContain("+ new");
  });

  it("emits stable runtime events while keeping legacy UI callbacks compatible", async () => {
    getRegistry().register({
      name: "event_tool",
      description: "returns ok",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => "event tool ok",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      [
        { type: "thinking", text: "think" } as any,
        { type: "content", text: "call tool" } as any,
        { type: "tool_call_begin", index: 0, tool_call_id: "call_1", name: "event_tool" } as any,
        { type: "done", finish_reason: "tool_calls", usage: null, content: "call tool", reasoning_content: "think", tool_calls: [{ id: "call_1", name: "event_tool", arguments: {} }] },
      ],
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const events: EngineRuntimeEvent[] = [];
    const legacy: string[] = [];
    const engine = new Engine({ ...testConfig(), reasoning_effort: "high" }, session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), {
      onRuntimeEvent: async (event) => { events.push(event); },
      onThinking: async (text) => { legacy.push(`thinking:${text}`); },
      onContent: async (text) => { legacy.push(`content:${text}`); },
      onToolCallStart: async (name) => { legacy.push(`tool_call:${name}`); },
      onToolExecuted: async (name, preview) => { legacy.push(`tool_result:${name}:${preview}`); },
    });

    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      "user_message",
      "api_call_start",
      "thinking_delta",
      "content_delta",
      "tool_call_begin",
      "assistant_message",
      "tool_call",
      "tool_result",
    ]));
    expect(events.find(event => event.type === "tool_result")).toMatchObject({
      type: "tool_result",
      data: { name: "event_tool", content: "event tool ok", is_error: false },
      preview: "event tool ok",
    });
    expect(legacy).toEqual(expect.arrayContaining([
      "thinking:think",
      "content:call tool",
      "tool_call:event_tool",
      "tool_result:event_tool:event tool ok",
    ]));
  });

  it("runs adjacent read-only concurrency-safe tool calls in parallel and commits results in call order", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];
    getRegistry().register({
      name: "read_one",
      description: "read one",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      readOnly: true,
      execute: async () => {
        started.push("read_one");
        await first.promise;
        return "one";
      },
    });
    getRegistry().register({
      name: "read_two",
      description: "read two",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      readOnly: true,
      execute: async () => {
        started.push("read_two");
        await second.promise;
        return "two";
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [
        { id: "call_1", name: "read_one", arguments: {} },
        { id: "call_2", name: "read_two", arguments: {} },
      ] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const turn = engine.runTurn("go", getMode("agent"));
    await waitFor(() => started.length === 2);
    second.resolve();
    await sleep(10);
    expect(session.messages.filter(message => message.role === "tool")).toHaveLength(0);
    first.resolve();
    const result = await turn;

    expect(started).toEqual(["read_one", "read_two"]);
    expect(result.tool_results.map(result => result.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(session.messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(["call_1", "call_2"]);
  });

  it("keeps write and unsafe tool calls as serial barriers between parallel-safe reads", async () => {
    const readBefore = deferred<void>();
    const write = deferred<void>();
    const readAfter = deferred<void>();
    const started: string[] = [];
    getRegistry().register({
      name: "read_before",
      description: "read before",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      readOnly: true,
      execute: async () => {
        started.push("read_before");
        await readBefore.promise;
        return "before";
      },
    });
    getRegistry().register({
      name: "write_tool",
      description: "write",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: false,
      readOnly: false,
      execute: async () => {
        started.push("write_tool");
        await write.promise;
        return "wrote";
      },
    });
    getRegistry().register({
      name: "read_after",
      description: "read after",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      readOnly: true,
      execute: async () => {
        started.push("read_after");
        await readAfter.promise;
        return "after";
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [
        { id: "call_1", name: "read_before", arguments: {} },
        { id: "call_2", name: "write_tool", arguments: {} },
        { id: "call_3", name: "read_after", arguments: {} },
      ] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const turn = engine.runTurn("go", getMode("agent"));
    await waitFor(() => started.includes("read_before"));
    expect(started).toEqual(["read_before"]);
    readBefore.resolve();
    await waitFor(() => started.includes("write_tool"));
    expect(started).toEqual(["read_before", "write_tool"]);
    write.resolve();
    await waitFor(() => started.includes("read_after"));
    expect(started).toEqual(["read_before", "write_tool", "read_after"]);
    readAfter.resolve();
    const result = await turn;

    expect(result.tool_results.map(result => result.tool_call_id)).toEqual(["call_1", "call_2", "call_3"]);
  });

  it("stores oversized tool results as artifacts and sends only a preview to the model", async () => {
    const largeOutput = [
      "head-marker",
      "A".repeat(60_000),
      "tail-marker",
    ].join("\n");
    getRegistry().register({
      name: "large_tool",
      description: "returns a large result",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => largeOutput,
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "large_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const previews: string[] = [];
    const runtimeArtifactIds: string[][] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      onToolExecuted: async (_name, preview) => { previews.push(preview); },
      onRuntimeItem: async (item) => {
        if (item.type === "tool_result") runtimeArtifactIds.push(item.artifact_ids || []);
      },
    });

    expect(result.artifact_ids).toHaveLength(1);
    const artifactId = result.artifact_ids[0];
    expect(previews[0]).toContain("[Tool result stored as artifact]");
    expect(previews[0]).toContain(`artifact_id: ${artifactId}`);
    expect(previews[0]).not.toContain("A".repeat(20_000));
    expect(result.tool_results[0].content).toContain("[Tool result stored as artifact]");
    expect(result.tool_results[0].content).toContain(`artifact_id: ${artifactId}`);
    expect(result.tool_results[0].content).toContain("artifact_read");
    expect(result.tool_results[0].content.length).toBeLessThan(10_000);
    expect(result.tool_results[0].content).not.toContain("A".repeat(20_000));
    expect(runtimeArtifactIds[0]).toContain(artifactId);

    const toolMessage = session.messages.find(message => message.role === "tool" && message.tool_call_id === "call_1");
    expect(toolMessage?.content).toBe(result.tool_results[0].content);
    expect(client.calls[1].messages.find((message: any) => message.role === "tool")?.content).toBe(result.tool_results[0].content);
    expect(readArtifact(artifactId)).toContain(largeOutput);
  });

  it("uses per-tool result budgets instead of only the global default", async () => {
    const output = `small-head\n${"B".repeat(800)}\nsmall-tail`;
    getRegistry().register({
      name: "budget_tool",
      description: "returns a result over its own budget",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      maxResultSizeChars: 100,
      execute: async () => output,
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "budget_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.artifact_ids).toHaveLength(1);
    expect(result.tool_results[0].content).toContain("[Tool result stored as artifact]");
    expect(result.tool_results[0].content).not.toContain("B".repeat(500));
    expect(readArtifact(result.artifact_ids[0])).toContain(output);
  });

  it("validates tool input before execution and returns a structured tool error", async () => {
    let executed = false;
    getRegistry().register({
      name: "validated_tool",
      description: "validates input",
      parameters: { type: "object", properties: { required_value: { type: "string" } } },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      validateInput: (args) => typeof args.required_value === "string" && args.required_value
        ? { ok: true }
        : { ok: false, message: "required_value is required" },
      execute: async () => { executed = true; return "should not run"; },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "validated_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "handled", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(executed).toBe(false);
    expect(result.tool_results[0]).toMatchObject({ is_error: true });
    expect(result.tool_results[0].content).toContain("required_value is required");
    expect(client.calls[1].messages.find((message: any) => message.role === "tool")?.content).toContain("invalid input");
  });

  it("re-checks sandbox boundaries after validateInput rewrites tool arguments", async () => {
    let executed = false;
    getRegistry().register({
      name: "write",
      description: "write",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ASK,
      category: "file",
      parallelOk: false,
      validateInput: () => ({
        ok: true,
        args: { path: "../escape.txt", content: "rewritten" },
      }),
      execute: async () => {
        executed = true;
        return "should not run";
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "write", arguments: { path: "inside.txt", content: "x" } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(executed).toBe(false);
    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("sandbox");
    expect(existsSync(join(tmp, "..", "escape.txt"))).toBe(false);
  });

  it("requests approval with validateInput-normalized arguments", async () => {
    let approvalArgs: Record<string, unknown> | null = null;
    let executed = false;
    getRegistry().register({
      name: "ask_tool",
      description: "ask tool",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ASK,
      category: "test",
      parallelOk: false,
      validateInput: () => ({
        ok: true,
        args: { path: "normalized.txt", content: "normalized" },
      }),
      execute: async () => {
        executed = true;
        return "should not run";
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "ask_tool", arguments: { path: "raw.txt", content: "raw" } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async (_toolName, args) => {
        approvalArgs = args;
        return false;
      },
    });

    expect(executed).toBe(false);
    expect(approvalArgs).toEqual({ path: "normalized.txt", content: "normalized" });
    expect(result.tool_results[0].content).toContain("denied");
  });

  it("preserves file root aliases through engine default injection", async () => {
    registerFileTools();
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace, { recursive: true });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "write",
          arguments: { path: "alias.txt", content: "alias body", workspace },
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async () => true,
    });

    expect(result.tool_results[0]).toMatchObject({ is_error: false });
    expect(readFileSync(join(workspace, "alias.txt"), "utf-8")).toBe("alias body");
    expect(existsSync(join(tmp, "alias.txt"))).toBe(false);
  });

  it("ignores whitespace-only file root placeholders so valid cwd aliases still apply", async () => {
    registerFileTools();
    const workspace = join(tmp, "file-root-alias-exec");
    mkdirSync(workspace, { recursive: true });

    const result = await getRegistry().lookup("write")!.execute({
      path: "alias.txt",
      content: "alias body",
      root: "   ",
      cwd: workspace,
    });

    expect(result).toContain("Successfully wrote");
    expect(readFileSync(join(workspace, "alias.txt"), "utf-8")).toBe("alias body");
    expect(existsSync(join(tmp, "alias.txt"))).toBe(false);
  });

  it("ignores whitespace-only file root placeholders and falls back to the path location", async () => {
    registerFileTools();
    const workspace = join(tmp, "file-root-fallback");
    mkdirSync(workspace, { recursive: true });
    const file = join(workspace, "note.txt");
    writeFileSync(file, "hello\n");

    const result = await getRegistry().lookup("read")!.execute({
      path: file,
      root: "   ",
    });

    expect(result).toBe("hello\n");
  });

  it("preserves apply_patch cwd aliases through engine default injection", async () => {
    registerPatchTool();
    const workspace = join(tmp, "patch-workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "note.txt"), "before\n");
    const patch = [
      "diff --git a/note.txt b/note.txt",
      "--- a/note.txt",
      "+++ b/note.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "apply_patch",
          arguments: { patch, cwd: workspace },
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async () => true,
    });

    expect(result.tool_results[0]).toMatchObject({ is_error: false });
    expect(readFileSync(join(workspace, "note.txt"), "utf-8")).toBe("after\n");
    expect(existsSync(join(tmp, "note.txt"))).toBe(false);
  });

  it("runs bash in the session workspace when workdir is omitted", async () => {
    registerShellTool();
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "bash",
          arguments: { command: "pwd" },
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async () => true,
    });

    expect(result.tool_results[0]).toMatchObject({ is_error: false });
    expect(result.tool_results[0].content).toContain(tmp);
  });

  it("runs task_create shell queues in the session workspace when workdir is omitted", async () => {
    registerTaskTools();
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "task_create",
          arguments: { description: "pwd task", command: "pwd" },
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async () => true,
    });
    const created = JSON.parse(result.tool_results[0].content);
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "completed" ? task : null;
    }, 2500);

    expect(done.output).toContain(tmp);
  });

  it("runs task_gate_run in the session workspace when workdir is omitted", async () => {
    registerShellTool();
    registerTaskTools();
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "task_gate_run",
          arguments: { command: "pwd" },
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async () => true,
    });
    const gate = JSON.parse(result.tool_results[0].content);

    expect(gate.workdir).toBe(tmp);
    expect(gate.output).toContain(tmp);
  });

  it("runs git_status in the session workspace when workdir is omitted", async () => {
    registerGitTools();
    const { execSync } = await import("node:child_process");
    const workspace = join(tmp, "git-workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: workspace, stdio: "ignore" });
    execSync("git config user.name 'Test User'", { cwd: workspace, stdio: "ignore" });
    execSync("git add tracked.txt", { cwd: workspace, stdio: "ignore" });
    execSync("git commit -m init", { cwd: workspace, stdio: "ignore" });
    writeFileSync(join(workspace, "tracked.txt"), "changed\n");

    const session = createSession({ workspace_path: workspace });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "git_status",
          arguments: {},
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results[0]).toMatchObject({ is_error: false });
    expect(result.tool_results[0].content).toContain("tracked.txt");
  });

  it("runs diagnostics in the session workspace when workdir is omitted", async () => {
    registerDiagnosticsTools();
    const workspace = join(tmp, "diag-workspace");
    mkdirSync(workspace, { recursive: true });

    const session = createSession({ workspace_path: workspace });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "diagnostics",
          arguments: {},
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));
    const payload = JSON.parse(result.tool_results[0].content);

    expect(payload.cwd).toBe(workspace);
  });

  it("preserves explicit cwd aliases for git_status through the engine path", async () => {
    registerGitTools();
    const { execSync } = await import("node:child_process");
    const workspace = join(tmp, "workspace");
    const repo = join(workspace, "git-cwd-workspace");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "tracked.txt"), "tracked\n");
    execSync("git init", { cwd: repo, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: repo, stdio: "ignore" });
    execSync("git config user.name 'Test User'", { cwd: repo, stdio: "ignore" });
    execSync("git add tracked.txt", { cwd: repo, stdio: "ignore" });
    execSync("git commit -m init", { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "tracked.txt"), "changed\n");

    const session = createSession({ workspace_path: workspace });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "git_status",
          arguments: { cwd: repo },
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results[0]).toMatchObject({ is_error: false });
    expect(result.tool_results[0].content).toContain("tracked.txt");
  });

  it("preserves explicit cwd aliases for bash through the engine path", async () => {
    registerShellTool();
    const workspace = join(tmp, "workspace");
    const shellDir = join(workspace, "bash-cwd-workspace");
    mkdirSync(shellDir, { recursive: true });

    const session = createSession({ workspace_path: workspace });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "bash",
          arguments: { command: "pwd", cwd: shellDir },
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async () => true,
    });

    expect(result.tool_results[0]).toMatchObject({ is_error: false });
    expect(result.tool_results[0].content).toContain(shellDir);
  });

  it("resolves relative bash workdirs through the engine against the session workspace", async () => {
    registerShellTool();
    const workspace = join(tmp, "workspace");
    const shellDir = join(workspace, "pkg", "src");
    mkdirSync(shellDir, { recursive: true });

    const session = createSession({ workspace_path: workspace });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "bash",
          arguments: { command: "pwd", workdir: "pkg/src" },
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async () => true,
    });

    expect(result.tool_results[0]).toMatchObject({ is_error: false });
    expect(result.tool_results[0].content).toContain(shellDir);
  });

  it("runs pr_attempt_record in the session workspace when workdir is omitted", async () => {
    registerDiagnosticsTools();
    getRegistry().activate("pr_attempt_record");
    const { execSync } = await import("node:child_process");
    const workspace = join(tmp, "attempt-workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: workspace, stdio: "ignore" });
    execSync("git config user.name 'Test User'", { cwd: workspace, stdio: "ignore" });
    execSync("git add tracked.txt", { cwd: workspace, stdio: "ignore" });
    execSync("git commit -m init", { cwd: workspace, stdio: "ignore" });
    writeFileSync(join(workspace, "tracked.txt"), "changed\n");

    const session = createSession({ workspace_path: workspace });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [{
          id: "call_1",
          name: "pr_attempt_record",
          arguments: {},
        }],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));
    const recorded = JSON.parse(result.tool_results[0].content);

    expect(recorded.status).toContain("tracked.txt");
  });

  it("runs git_log and git_branch in the session workspace when workdir is omitted", async () => {
    registerGitTools();
    const { execSync } = await import("node:child_process");
    const workspace = join(tmp, "git-log-workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: workspace, stdio: "ignore" });
    execSync("git config user.name 'Test User'", { cwd: workspace, stdio: "ignore" });
    execSync("git checkout -b feature/test-branch", { cwd: workspace, stdio: "ignore" });
    execSync("git add tracked.txt", { cwd: workspace, stdio: "ignore" });
    execSync("git commit -m init", { cwd: workspace, stdio: "ignore" });

    const session = createSession({ workspace_path: workspace });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      {
        type: "done",
        finish_reason: "tool_calls",
        usage: null,
        content: "",
        reasoning_content: null,
        tool_calls: [
          { id: "call_1", name: "git_log", arguments: {} },
          { id: "call_2", name: "git_branch", arguments: {} },
        ],
      },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results[0].content).toContain("init");
    expect(result.tool_results[1].content).toContain("feature/test-branch");
  });

  it("emits tool progress events and rendered result metadata", async () => {
    getRegistry().register({
      name: "progress_tool",
      description: "reports progress",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      renderProgress: (progress) => ({ kind: "task", preview: `rendered ${progress.message}` }),
      renderResult: (result) => ({ kind: "json", preview: `rendered result ${result}` }),
      renderMetadata: { userFacingName: "Progress", icon: "activity", resultKind: "json" },
      getActivityDescription: () => "Inspecting progress",
      getToolUseSummary: () => "Progress summary",
      toAutoClassifierInput: () => ({ action: "progress" }),
      getTranscriptSearchText: (result) => `searchable ${result}`,
      execute: async (_args, context) => {
        await context?.onProgress?.({ message: "halfway", percent: 50 });
        return "ok";
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "progress_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const events: EngineRuntimeEvent[] = [];
    const previews: string[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), {
      onRuntimeEvent: async (event) => { events.push(event); },
      onToolExecuted: async (_name, preview) => { previews.push(preview); },
    });

    const progress = events.find(event => event.type === "tool_progress");
    const toolCall = events.find(event => event.type === "tool_call");
    const resultEvent = events.find(event => event.type === "tool_result");
    expect(toolCall).toMatchObject({
      data: {
        metadata: {
          activity: "Inspecting progress",
          summary: "Progress summary",
          classifierInput: { action: "progress" },
          render: { userFacingName: "Progress", icon: "activity", resultKind: "json" },
        },
      },
    });
    expect(progress).toMatchObject({
      data: { tool: "progress_tool", progress: { message: "halfway", percent: 50 } },
      rendered: { preview: "rendered halfway" },
    });
    expect(resultEvent).toMatchObject({
      rendered: { kind: "json", preview: "rendered result ok" },
      metadata: { transcriptSearchText: "searchable ok" },
    });
    expect(previews[0]).toBe("rendered result ok");
  });

  it("records denied tool calls in the turn result", async () => {
    getRegistry().register({
      name: "ask_tool",
      description: "needs approval",
      parameters: { type: "object", properties: {} },
      permission: "ask" as any,
      category: "test",
      parallelOk: true,
      execute: async () => "should not run",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "ask_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_results).toHaveLength(1);
    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("denied");
  });

  it("sends errored tool results back to the next model call", async () => {
    getRegistry().register({
      name: "fail_tool",
      description: "fails",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => "Error: failed intentionally",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: { prompt_tokens: 5, completion_tokens: 1 }, content: "", reasoning_content: "need fail", tool_calls: [{ id: "call_1", name: "fail_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: { prompt_tokens: 7, completion_tokens: 2, prompt_cache_hit_tokens: 3, prompt_tokens_details: { cached_tokens: 3 } } as any, content: "handled", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine({ ...testConfig(), reasoning_effort: "high" }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(client.calls[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        tool_calls: [{ id: "call_1", name: "fail_tool", arguments: {} }],
        reasoning_content: "need fail",
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_1",
        name: "fail_tool",
        content: "Error: failed intentionally",
        is_error: true,
      }),
    ]));
    expect(result.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 3,
      prompt_cache_hit_tokens: 3,
      prompt_tokens_details: { cached_tokens: 3 },
    });
  });

  it("passes AbortSignal from engine turns into the client", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());
    const controller = new AbortController();

    await engine.runTurn("go", getMode("agent"), undefined, { signal: controller.signal });

    expect(client.lastSignal).toBe(controller.signal);
  });

  it("passes AbortSignal from engine turns into tools", async () => {
    let seenSignal: AbortSignal | undefined;
    getRegistry().register({
      name: "signal_tool",
      description: "records signal",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async (_args, context) => {
        seenSignal = context?.signal;
        return "ok";
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const controller = new AbortController();
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "signal_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), undefined, { signal: controller.signal });

    expect(seenSignal).toBe(controller.signal);
  });

  it("stops streaming promptly after AbortSignal is triggered", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const controller = new AbortController();
    const client = new FakeClient([[
      { type: "content", text: "first" } as any,
      { type: "content", text: "second" } as any,
      { type: "done", finish_reason: "stop", usage: null, content: "firstsecond", reasoning_content: null, tool_calls: [] },
    ]]);
    const content: string[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await expect(engine.runTurn("go", getMode("agent"), {
      onContent: async (text) => {
        content.push(text);
        controller.abort();
      },
    }, { signal: controller.signal })).rejects.toThrow(/aborted/i);

    expect(content).toEqual(["first"]);
    expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(0);
  });

  it("normalizes aborted tool termination instead of leaking low-level terminated errors", async () => {
    const controller = new AbortController();
    getRegistry().register({
      name: "terminating_tool",
      description: "throws after abort",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: false,
      execute: async () => {
        controller.abort();
        throw new Error("terminated");
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "terminating_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "should not be called", reasoning_content: null, tool_calls: [] },
    ]);
    const events: EngineRuntimeEvent[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      onRuntimeEvent: async (event) => { events.push(event); },
    }, { signal: controller.signal });

    expect(result.tool_results).toHaveLength(1);
    expect(result.tool_results[0].content).toContain("interrupted before tool 'terminating_tool' completed (abort requested)");
    expect(result.tool_results[0].content).not.toContain("terminated");
    expect(events.find(event => event.type === "tool_result")).toMatchObject({
      type: "tool_result",
      data: { is_error: true },
    });
    expect(client.calls).toHaveLength(1);
  });

  it("records tool budget exhaustion as an error result and stops the turn", async () => {
    getRegistry().register({
      name: "ok_tool",
      description: "ok",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => "ok",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [
        { id: "call_1", name: "ok_tool", arguments: {} },
        { id: "call_2", name: "ok_tool", arguments: {} },
      ] },
      { type: "done", finish_reason: "stop", usage: null, content: "should not be called", reasoning_content: null, tool_calls: [] },
    ]);
    const runtimeItems: string[] = [];
    const engine = new Engine({ ...testConfig(), tool_call_budget_per_turn: 1 }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      onRuntimeItem: async (item) => { runtimeItems.push(item.type); },
    });

    expect(result.tool_calls.map(call => call.id)).toEqual(["call_1", "call_2"]);
    expect(result.tool_results).toHaveLength(2);
    expect(result.tool_results[1]).toMatchObject({ tool_call_id: "call_2", is_error: true });
    expect(result.tool_results[1].content).toContain("tool call budget exceeded");
    expect(runtimeItems).toContain("tool_budget_exceeded");
    expect(client.calls).toHaveLength(1);
  });

  it("fills pending tool results when a turn is interrupted during tool execution", async () => {
    let engine: Engine;
    getRegistry().register({
      name: "interrupting_tool",
      description: "interrupts the turn",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: false,
      execute: async () => {
        engine.interrupt();
        return "Error: interrupted";
      },
    });
    getRegistry().register({
      name: "pending_tool",
      description: "should not run",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: false,
      execute: async () => "should not run",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [
        { id: "call_1", name: "interrupting_tool", arguments: {} },
        { id: "call_2", name: "pending_tool", arguments: {} },
      ] },
      { type: "done", finish_reason: "stop", usage: null, content: "should not be called", reasoning_content: null, tool_calls: [] },
    ]);
    engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    const assistant = session.messages.find(message => message.role === "assistant" && message.tool_calls?.length);
    const toolResults = session.messages.filter(message => message.role === "tool");
    expect(assistant?.tool_calls?.map(call => call.id)).toEqual(["call_1", "call_2"]);
    expect(toolResults.map(message => message.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(result.tool_results.map(item => item.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(result.tool_results[1].content).toContain("interrupted before tool");
    expect(client.calls).toHaveLength(1);
  });

  it("injects context intervention markers under token pressure", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    history.addUser("x".repeat(600));
    const client = new FakeClient([
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const interventions: unknown[] = [];
    const engine = new Engine({ ...testConfig(), context_limit: 100 }, session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), {
      onContextIntervention: async (intervention) => { interventions.push(intervention); },
    });

    expect(interventions.length).toBeGreaterThan(0);
    expect(session.messages.some(message => message.name === "context_verification")).toBe(true);
  });

  it("adds explicit compaction boundary messages when compacting context", () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    for (let i = 0; i < 16; i++) {
      history.addUser(`old user ${i} ${"x".repeat(400)}`);
      history.addAssistant(`old assistant ${i}`, null, "reasoning".repeat(80));
    }
    const compactor = new ContextCompactor({ ...testConfig(), context_limit: 100 });

    const result = compactor.compact(history);

    const boundary = session.messages.find(message => message.name === "context_compaction_boundary");
    const summary = session.messages.find(message => message.name === "context_summary");
    const projectedMessages = projectMessagesForRequest(session.messages);
    expect(result.boundary_id).toBeTruthy();
    expect(result.removed_messages).toBeGreaterThan(0);
    expect(boundary?.role).toBe("system");
    expect(summary?.role).toBe("system");
    expect(boundary?.content).toContain("[Context compaction boundary]");
    expect(boundary?.content).toContain(`boundary_id: ${result.boundary_id}`);
    expect(boundary?.content).toContain("preserve_from_index:");
    expect(boundary?.content).toContain("removed_messages:");
    expect(boundary?.content).toContain("recovery:");
    expect(summary?.content).toContain("[Earlier conversation summarized");
    expect(result.actions.some(action => action.includes("summary boundary appended"))).toBe(true);
    expect(projectedMessages.some(message => message.role === "user" && message.content?.includes("old user 0"))).toBe(false);
    expect(projectedMessages.some(message => message.role === "user" && message.content?.includes("old user 15"))).toBe(true);
  });

  it("keeps historical tool results intact while compacting the request projection", () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    history.addUser("inspect");
    history.addAssistant("calling tool", [{ id: "call_1", name: "read", arguments: { path: "big.txt" } }], null);
    const toolPayload = tokenFlood("tool_payload", 260);
    history.addToolResult({ tool_call_id: "call_1", name: "read", content: toolPayload, is_error: false });
    for (let i = 0; i < 8; i++) {
      history.addUser(`follow up ${i}`);
      history.addAssistant(`answer ${i}`);
    }

    const compactor = new ContextCompactor({ ...testConfig(), context_limit: 120 });
    compactor.compact(history);

    const toolMessage = session.messages.find(message => message.role === "tool" && message.tool_call_id === "call_1");
    const summary = session.messages.find(message => message.name === "context_summary");
    expect(toolMessage?.content).toBe(toolPayload);
    expect(summary?.content).toContain("tool read [ok]");
    expect(summary?.content).toContain("tool_payload_0");
  });

  it("emits prefix_invalidated after compaction and sends a projected request", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    for (let i = 0; i < 16; i++) {
      history.addUser(`old user ${i} ${tokenFlood(`old_user_${i}`, 160)}`);
      history.addAssistant(`old assistant ${i}`);
    }
    const client = new FakeClient([
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const events: EngineRuntimeEvent[] = [];
    const engine = new Engine({ ...testConfig(), context_limit: 100 }, session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), {
      onRuntimeEvent: async (event) => { events.push(event); },
    });

    const invalidation = events.find(event => event.type === "prefix_invalidated");
    const requestMessages = (client.calls[0]?.messages || []) as Array<{ role?: string; content?: string; name?: string }>;
    expect(invalidation).toMatchObject({
      type: "prefix_invalidated",
      data: { reason: "context_compaction" },
    });
    expect(requestMessages.some(message => message.name === "context_compaction_boundary")).toBe(true);
    expect(requestMessages.some(message => message.name === "context_summary")).toBe(true);
    expect(requestMessages.some(message => message.role === "user" && message.content?.includes("old user 0"))).toBe(false);
    expect(requestMessages.some(message => message.role === "user" && message.content?.includes("old user 15"))).toBe(true);
    expect(requestMessages.some(message => message.role === "user" && message.content === "go")).toBe(true);
  });

  it("compacts and retries when the provider rejects a prompt as too long", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    for (let i = 0; i < 16; i++) {
      history.addUser(`old user ${i} ${"x".repeat(320)}`);
      history.addAssistant(`old assistant ${i}`, null, "reasoning".repeat(40));
    }
    const client = new PromptTooLongThenOkClient();
    const events: EngineRuntimeEvent[] = [];
    const engine = new Engine({ ...testConfig(), context_limit: 100_000 }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("continue", getMode("agent"), {
      onRuntimeEvent: async (event) => { events.push(event); },
    });

    const apiStarts = events.filter(event => event.type === "api_call_start");
    const secondRequestMessages = client.calls[1].messages as Array<{ name?: string; role?: string; content?: string }>;
    expect(result.iterations).toBe(1);
    expect(client.calls).toHaveLength(2);
    expect(session.messages.some(message => message.name === "context_compaction_boundary")).toBe(true);
    expect(session.messages.some(message => message.name === "context_verification")).toBe(true);
    expect(events.some(event => event.type === "prefix_invalidated")).toBe(true);
    expect(apiStarts[0].data.prompt_recovery).toBeUndefined();
    expect(apiStarts[1].data).toMatchObject({ retry: 1, prompt_recovery: true });
    expect(secondRequestMessages.some(message => message.name === "context_compaction_boundary")).toBe(true);
    expect(secondRequestMessages.some(message => message.name === "context_summary")).toBe(true);
    expect(secondRequestMessages.some(message => message.role === "user" && message.content?.includes("old user 0"))).toBe(false);
  });

  it("keeps request projection anchored to only the latest compaction boundary after repeated compactions", () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    for (let i = 0; i < 24; i++) {
      history.addUser(`user ${i} ${"x".repeat(220)}`);
      history.addAssistant(`assistant ${i}`, null, i % 2 === 0 ? "reasoning".repeat(20) : null);
    }
    const compactor = new ContextCompactor({ ...testConfig(), context_limit: 120 });

    const first = compactor.compact(history);
    for (let i = 24; i < 34; i++) {
      history.addUser(`later user ${i} ${"y".repeat(220)}`);
      history.addAssistant(`later assistant ${i}`);
    }
    const second = compactor.compact(history);
    const projected = projectMessagesForRequest(session.messages);
    const boundaries = projected.filter(message => message.name === "context_compaction_boundary");
    const summaries = projected.filter(message => message.name === "context_summary");

    expect(first.boundary_id).toBeTruthy();
    expect(second.boundary_id).toBeTruthy();
    expect(second.boundary_id).not.toBe(first.boundary_id);
    expect(boundaries).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(boundaries[0].content).toContain(`boundary_id: ${second.boundary_id}`);
    expect(projected.some(message => message.content?.includes(first.boundary_id!))).toBe(false);
    expect(projected.some(message => message.role === "user" && message.content?.includes("user 0"))).toBe(false);
    expect(projected.some(message => message.role === "user" && message.content?.includes("later user 33"))).toBe(true);
  });

  it("replays prior assistant tool calls and tool results in stable order across multiple turns", async () => {
    getRegistry().register({
      name: "alpha_tool",
      description: "alpha",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => "alpha-result",
    });
    getRegistry().register({
      name: "beta_tool",
      description: "beta",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => "beta-result",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "alpha_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "first turn done", reasoning_content: null, tool_calls: [] },
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_2", name: "beta_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "second turn done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await engine.runTurn("turn one", getMode("agent"));
    await engine.runTurn("turn two", getMode("agent"));

    const secondRequestMessages = client.calls[2].messages as Array<{ role?: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string; name?: string; content?: string }>;
    const relevant = secondRequestMessages.filter(message =>
      (message.role === "assistant" && message.tool_calls?.length)
      || message.role === "tool",
    );

    expect(relevant.map(message => message.role === "assistant" ? message.tool_calls?.[0]?.id : message.tool_call_id)).toEqual(["call_1", "call_1"]);
    expect(relevant[0]).toMatchObject({ role: "assistant" });
    expect(relevant[1]).toMatchObject({ role: "tool", name: "alpha_tool", content: "alpha-result" });
  });

  it("emits distinct prefix invalidations across repeated compacting turns and keeps only the latest boundary in requests", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    for (let i = 0; i < 20; i++) {
      history.addUser(`seed user ${i} ${"z".repeat(220)}`);
      history.addAssistant(`seed assistant ${i}`);
    }
    const client = new FakeClient([
      { type: "done", finish_reason: "stop", usage: null, content: "after first compaction", reasoning_content: null, tool_calls: [] },
      { type: "done", finish_reason: "stop", usage: null, content: "after second compaction", reasoning_content: null, tool_calls: [] },
    ]);
    const events: EngineRuntimeEvent[] = [];
    const engine = new Engine({ ...testConfig(), context_limit: 100 }, session, history, client as any, getRegistry());

    await engine.runTurn("first compacting turn", getMode("agent"), {
      onRuntimeEvent: async (event) => { events.push(event); },
    });
    for (let i = 0; i < 8; i++) {
      history.addUser(`post turn user ${i} ${"q".repeat(220)}`);
      history.addAssistant(`post turn assistant ${i}`);
    }
    await engine.runTurn("second compacting turn", getMode("agent"), {
      onRuntimeEvent: async (event) => { events.push(event); },
    });

    const invalidations = events.filter(event => event.type === "prefix_invalidated");
    const firstBoundaryId = (invalidations[0]?.data as any)?.boundary_id;
    const secondBoundaryId = (invalidations[1]?.data as any)?.boundary_id;
    const secondRequestMessages = client.calls[1].messages as Array<{ name?: string; content?: string }>;
    const secondBoundaries = secondRequestMessages.filter(message => message.name === "context_compaction_boundary");

    expect(invalidations).toHaveLength(2);
    expect(firstBoundaryId).toBeTruthy();
    expect(secondBoundaryId).toBeTruthy();
    expect(secondBoundaryId).not.toBe(firstBoundaryId);
    expect(secondBoundaries).toHaveLength(1);
    expect(secondBoundaries[0].content).toContain(`boundary_id: ${secondBoundaryId}`);
    expect(secondRequestMessages.some(message => message.content?.includes(firstBoundaryId))).toBe(false);
  });

  it("blocks tool paths that escape the workspace boundary", async () => {
    getRegistry().register({
      name: "write",
      description: "write",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "file",
      parallelOk: false,
      execute: async () => "should not run",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "write", arguments: { path: "../escape.txt", content: "x" } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("sandbox");
  });

  it("blocks bash commands that escape the workspace boundary through relative paths", async () => {
    registerShellTool();
    const workspace = join(tmp, "workspace");
    const subdir = join(workspace, "pkg", "src");
    mkdirSync(subdir, { recursive: true });
    const session = createSession({ workspace_path: workspace });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "bash", arguments: { command: "cat ../../../escape.txt", workdir: subdir } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("sandbox");
  });

  it("requires sandbox approval for mutations in untrusted workspaces", async () => {
    getRegistry().register({
      name: "write",
      description: "write",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "file",
      parallelOk: false,
      execute: async () => "should not run",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "write", arguments: { path: "inside.txt", content: "x" } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    let approvalRequests = 0;
    const engine = new Engine({ ...testConfig(), approval_policy: "untrusted" }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async () => { approvalRequests++; return false; },
    });

    expect(approvalRequests).toBe(1);
    expect(result.tool_results[0].content).toContain("denied");
  });

  it("does not request approval for sandbox ask paths while running in yolo mode", async () => {
    registerFileTools();
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "write", arguments: { path: "inside.txt", content: "x" } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    let approvalRequests = 0;
    const engine = new Engine({
      ...testConfig(),
      mode: "yolo",
      approval_policy: "untrusted",
      trusted_workspaces: [],
    }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("yolo"), {
      requestApproval: async () => {
        approvalRequests++;
        return false;
      },
    });

    expect(approvalRequests).toBe(0);
    expect(result.tool_results[0]).toMatchObject({ name: "write", is_error: false });
    expect(readFileSync(join(tmp, "inside.txt"), "utf-8")).toBe("x");
  });

  it("uses the active yolo mode instead of the config snapshot when deciding sandbox approvals", async () => {
    registerFileTools();
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "write", arguments: { path: "inside.txt", content: "x" } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    let approvalRequests = 0;
    const engine = new Engine({
      ...testConfig(),
      mode: "agent",
      approval_policy: "untrusted",
      trusted_workspaces: [],
    }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("yolo"), {
      requestApproval: async () => {
        approvalRequests++;
        return false;
      },
    });

    expect(approvalRequests).toBe(0);
    expect(result.tool_results[0]).toMatchObject({ name: "write", is_error: false });
    expect(readFileSync(join(tmp, "inside.txt"), "utf-8")).toBe("x");
  });

  it("uses the active agent mode instead of the config snapshot when sandbox approval is required", async () => {
    registerFileTools();
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "write", arguments: { path: "inside.txt", content: "x" } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    let approvalRequests = 0;
    const engine = new Engine({
      ...testConfig(),
      mode: "yolo",
      approval_policy: "untrusted",
      trusted_workspaces: [],
    }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async () => {
        approvalRequests++;
        return false;
      },
    });

    expect(approvalRequests).toBe(1);
    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("denied");
    expect(existsSync(join(tmp, "inside.txt"))).toBe(false);
  });

  it("blocks tool execution when a PreToolUse hook denies it", async () => {
    let executed = false;
    getRegistry().register({
      name: "hooked_tool",
      description: "hooked",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => { executed = true; return "should not run"; },
    });
    registerHook({
      event: "PreToolUse",
      matcher: "hooked_tool",
      command: `${process.execPath} -e "console.log(JSON.stringify({decision:'deny', message:'hook blocked'}))"`,
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "hooked_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(executed).toBe(false);
    expect(result.tool_results[0]).toMatchObject({ is_error: true });
    expect(result.tool_results[0].content).toContain("hook blocked");
  });

  it("re-checks sandbox boundaries after PreToolUse modifies tool arguments", async () => {
    let executed = false;
    getRegistry().register({
      name: "write",
      description: "write",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "file",
      parallelOk: false,
      execute: async () => {
        executed = true;
        return "should not run";
      },
    });
    registerHook({
      event: "PreToolUse",
      matcher: "write",
      command: `${process.execPath} -e "console.log(JSON.stringify({decision:'continue', modified_input:{path:'../escape.txt', content:'rewritten'}}))"`,
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "write", arguments: { path: "inside.txt", content: "x" } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(executed).toBe(false);
    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("sandbox");
    expect(existsSync(join(tmp, "..", "escape.txt"))).toBe(false);
  });
});

describe("config and pricing", () => {
  it("creates ~/.seekcode/config.toml with defaults on first config load", () => {
    const userConfig = join(process.env.HOME!, ".seekcode", "config.toml");

    expect(existsSync(userConfig)).toBe(false);
    const cfg = loadConfig();

    expect(cfg.api_key).toBe("");
    expect(existsSync(userConfig)).toBe(true);
    expect(readFileSync(userConfig, "utf-8")).toContain('api_key = ""');
  });

  it("does not auto-copy legacy user config on first config load", () => {
    const legacyUserDir = join(process.env.HOME!, ".config", "deepseek");
    const userConfig = join(process.env.HOME!, ".seekcode", "config.toml");
    mkdirSync(legacyUserDir, { recursive: true });
    writeFileSync(join(legacyUserDir, "config.toml"), 'api_key = "legacy-key"\nbaseUrl = "http://legacy.local"\n');

    const cfg = loadConfig();

    expect(cfg.api_key).toBe("");
    expect(existsSync(userConfig)).toBe(true);
    const raw = readFileSync(userConfig, "utf-8");
    expect(raw).toContain('api_key = ""');
    expect(raw).not.toContain("legacy-key");
    expect(raw).not.toContain("baseUrl");
  });

  it("migrates legacy user config only when explicitly requested", () => {
    const legacyUserDir = join(process.env.HOME!, ".config", "deepseek");
    const userConfig = join(process.env.HOME!, ".seekcode", "config.toml");
    mkdirSync(legacyUserDir, { recursive: true });
    writeFileSync(join(legacyUserDir, "config.toml"), 'api_key = "legacy-key"\nbaseUrl = "http://legacy.local"\n');

    expect(loadConfig().api_key).toBe("");
    const report = migrateUserConfig();

    expect(report.changed).toBe(true);
    expect(report.actions.join("\n")).toContain("copied legacy config");
    const raw = readFileSync(userConfig, "utf-8");
    expect(raw).toContain("legacy-key");
    expect(raw).toContain("base_url");
    expect(raw).not.toContain("baseUrl");
  });

  it("ignores invalid numeric environment values instead of throwing", () => {
    const old = process.env.DEEPSEEK_MAX_TOKENS;
    process.env.DEEPSEEK_MAX_TOKENS = "not-a-number";
    try {
      expect(() => loadConfig({})).not.toThrow();
      expect(loadConfig({}).max_tokens).toBe(8192);
    } finally {
      if (old === undefined) delete process.env.DEEPSEEK_MAX_TOKENS;
      else process.env.DEEPSEEK_MAX_TOKENS = old;
    }
  });

  it("applies provider defaults and V4 context limits", () => {
    const cfg = loadConfig({ provider: "nvidia-nim", model: "deepseek-v4-flash" });

    expect(cfg.base_url).toBe("https://integrate.api.nvidia.com/v1");
    expect(cfg.model).toBe("deepseek-ai/deepseek-v4-flash");
    expect(cfg.context_limit).toBe(1_000_000);
  });

  it("keeps explicit base_url when switching provider config", () => {
    const cfg = loadConfig({ provider: "openrouter", model: "deepseek-v4-pro", base_url: "http://proxy.local/v1" });

    expect(cfg.base_url).toBe("http://proxy.local/v1");
    expect(cfg.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("loads ~/.seekcode config without implicitly reading legacy DeepSeek paths", () => {
    const legacyUserDir = join(process.env.HOME!, ".config", "deepseek");
    const userDir = join(process.env.HOME!, ".seekcode");
    const legacyProjectDir = join(tmp, ".deepseek");
    const projectDir = join(tmp, ".seekcode");
    mkdirSync(legacyUserDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    mkdirSync(legacyProjectDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(legacyUserDir, "config.toml"), 'api_key = "legacy-user-key"\nmodel = "deepseek-v4-flash"\n');
    writeFileSync(join(userDir, "config.toml"), 'api_key = "seekcode-user-key"\n');
    writeFileSync(join(legacyProjectDir, "config.toml"), 'mode = "plan"\n');
    writeFileSync(join(projectDir, "config.toml"), 'mode = "agent"\n');
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const cfg = loadConfig();
      const explain = explainConfig();

      expect(cfg.api_key).toBe("seekcode-user-key");
      expect(cfg.model).toBe("deepseek-v4-pro");
      expect(cfg.mode).toBe("agent");
      expect(explain.sources.map(source => source.source)).toEqual(["user", "project", "env", "cli"]);
      expect(explain.conflicts.some(conflict => conflict.key === "api_key")).toBe(false);
      expect(explain.conflicts.some(conflict => conflict.key === "mode" && conflict.winner === "project")).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it("does not produce negative input costs when cached tokens exceed input tokens", () => {
    expect(calculateCost("deepseek-v4-pro", 10, 0, 20)).toBeGreaterThanOrEqual(0);
  });

  it("migrates legacy config keys without changing conflicting canonical keys", () => {
    const userConfig = join(process.env.HOME!, ".seekcode", "config.toml");
    mkdirSync(join(process.env.HOME!, ".seekcode"), { recursive: true });
    writeFileSync(userConfig, [
      'apiKey = "legacy"',
      'api_key = "canonical"',
      'baseUrl = "http://legacy.local"',
      "",
    ].join("\n"));

    const report = migrateUserConfig();
    const migrated = readFileSync(userConfig, "utf-8");

    expect(report.warnings.join("\n")).toContain("apiKey");
    expect(report.actions.join("\n")).toContain("baseUrl");
    expect(migrated).toContain("api_key");
    expect(migrated).toContain("base_url");
    expect(migrated).not.toContain("apiKey");
  });

  it("validates semantic config errors and explains source conflicts", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    const projectDir = join(tmp, ".seekcode");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(userDir, "config.toml"), 'model = "user-model"\n[[mcp_servers]]\nname = "bad"\ntransport = "stdio"\n');
    writeFileSync(join(projectDir, "config.toml"), 'model = "project-model"\n');
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const validation = validateConfig();
      const explain = explainConfig();

      expect(validation.ok).toBe(false);
      expect(validation.issues.some(issue => issue.key === "mcp_servers.0.command")).toBe(true);
      expect(explain.conflicts.some(conflict => conflict.key === "model" && conflict.winner === "project")).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("loads, migrates, and validates web configuration", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "config.toml"), [
      "[web]",
      "enabled = true",
      'searchEngine = "duckduckgo"',
      'allowedDomains = ["example.com"]',
      'blocked_domains = ["blocked.example"]',
      'googleApiKey = "google-user-key"',
      'googleCx = "google-cx"',
      'exaApiKey = "exa-user-key"',
      'kagiApiKey = "kagi-user-key"',
      'braveApiKey = "brave-user-key"',
      'semanticScholarApiKey = "s2-user-key"',
      'pubmedApiKey = "pubmed-user-key"',
      'searxngUrl = "https://search.example"',
      'proxy = "http://proxy.example:8080"',
      "searchTimeoutMs = 2500",
      "",
    ].join("\n"));

    const report = migrateUserConfig();
    const cfg = loadConfig();
    const validation = validateConfig();

    expect(report.actions.join("\n")).toContain("web.searchEngine");
    expect(cfg.web.search_engine).toBe("duckduckgo");
    expect(cfg.web.allowed_domains).toEqual(["example.com"]);
    expect(cfg.web.blocked_domains).toEqual(["blocked.example"]);
    expect(cfg.web.google_api_key).toBe("google-user-key");
    expect(cfg.web.google_cx).toBe("google-cx");
    expect(cfg.web.exa_api_key).toBe("exa-user-key");
    expect(cfg.web.kagi_api_key).toBe("kagi-user-key");
    expect(cfg.web.brave_api_key).toBe("brave-user-key");
    expect(cfg.web.semantic_scholar_api_key).toBe("s2-user-key");
    expect(cfg.web.pubmed_api_key).toBe("pubmed-user-key");
    expect(cfg.web.searxng_url).toBe("https://search.example");
    expect(cfg.web.proxy).toBe("http://proxy.example:8080");
    expect(cfg.web.search_timeout_ms).toBe(2500);
    expect(validation.ok).toBe(true);
  });

  it("rejects invalid web proxy config", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "config.toml"), [
      "[web]",
      'proxy = "socks5://proxy.example:1080"',
      "",
    ].join("\n"));

    const validation = validateConfig();

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.key === "web.proxy")).toBe(true);
  });
});

describe("skills system", () => {
  it("discovers workspace skills before global skills and injects metadata only", () => {
    const home = join(tmp, "home-skills");
    const workspaceSkill = join(tmp, ".agents", "skills", "demo");
    const globalSkill = join(home, ".seekcode", "skills", "demo");
    mkdirSync(workspaceSkill, { recursive: true });
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(join(workspaceSkill, "SKILL.md"), skillMd("demo", "workspace skill", "workspace body secret"));
    writeFileSync(join(globalSkill, "SKILL.md"), skillMd("demo", "global skill", "global body secret"));

    const result = scanSkills(tmp, home, { includeSystem: false });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].description).toBe("workspace skill");
    expect(result.errors.some(error => error.includes("duplicate skill 'demo'"))).toBe(true);
  });

  it("activates a skill for the next user request", () => {
    const dir = join(tmp, "skills", "writer");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd("writer", "write carefully", "Always use short sentences."));

    const activated = activateSkill("writer", { workspaceDir: tmp, skillsDir: join(tmp, "skills") });
    const input = applySkillToUserInput("draft this", activated.instruction!);

    expect(activated.ok).toBe(true);
    expect(input).toContain("Always use short sentences.");
    expect(input).toContain("User request:\ndraft this");
  });

  it("uses ephemeral instructions only for the immediate turn and does not retain them in session history", async () => {
    const requests: any[] = [];
    const client = {
      send: async function* (messages: any[]) {
        requests.push(messages);
        yield { type: "done", finish_reason: "stop", usage: null, content: "ok", reasoning_content: null, tool_calls: [] };
      },
    };
    const session = createSession({ mode: "agent", model: "deepseek-v4-pro", workspace_path: tmp });
    const history = new ConversationHistory(session);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await engine.runTurn("first", getMode("agent"), undefined, { ephemeralInstructions: "SKILL_SENTINEL_ENGINE" });
    await engine.runTurn("second", getMode("agent"));

    expect(requests).toHaveLength(2);
    expect(requests[0].some((message: any) => String(message.content || "").includes("SKILL_SENTINEL_ENGINE"))).toBe(true);
    expect(requests[1].some((message: any) => String(message.content || "").includes("SKILL_SENTINEL_ENGINE"))).toBe(false);
    expect(session.messages.some(message => String(message.content || "").includes("SKILL_SENTINEL_ENGINE"))).toBe(false);
  });

  it("installs, trusts, and uninstalls a skill from a safe archive", () => {
    const archive = tarGz([
      { path: "repo-main/good/SKILL.md", data: skillMd("good", "safe skill", "Do good work.") },
      { path: "repo-main/good/references/info.txt", data: "reference" },
    ]);

    const installed = installSkillFromArchive(archive, "github:owner/repo", join(tmp, "installed"));
    const trusted = trustSkill("good", { workspaceDir: tmp, skillsDir: join(tmp, "installed") });

    expect(installed.name).toBe("good");
    expect(existsSync(join(installed.path, "references", "info.txt"))).toBe(true);
    expect(trusted).toContain("Trusted skill");
    const uninstalled = uninstallSkill("good", { skillsDir: join(tmp, "installed") });
    expect(uninstalled).toContain("Uninstalled skill");
    expect(existsSync(installed.path)).toBe(false);
  });

  it("rejects skill archives with traversal or symlink entries", () => {
    const traversal = tarGz([
      { path: "repo-main/skill/SKILL.md", data: skillMd("bad", "bad skill", "bad") },
      { path: "../escape.txt", data: "escape" },
    ]);
    const symlink = tarGz([
      { path: "repo-main/skill/SKILL.md", data: skillMd("bad", "bad skill", "bad") },
      { path: "repo-main/skill/link", data: "", type: "2", linkname: "/etc/passwd" },
    ]);

    expect(() => installSkillFromArchive(traversal, "x", join(tmp, "installed"))).toThrow(/escapes destination/);
    expect(() => installSkillFromArchive(symlink, "x", join(tmp, "installed"))).toThrow(/symlinks/);
  });

  it("applies skill precedence across workspace, project, configured, and compat roots", () => {
    const configured = join(tmp, "configured-skills");
    const workspaceSkill = join(tmp, ".agents", "skills", "same");
    const projectSkill = join(tmp, ".seekcode", "skills", "project-only");
    const configuredSkill = join(configured, "configured-only");
    const configuredDuplicate = join(configured, "same");
    const compatSkill = join(process.env.HOME!, ".claude", "skills", "compat-only");
    mkdirSync(workspaceSkill, { recursive: true });
    mkdirSync(projectSkill, { recursive: true });
    mkdirSync(configuredSkill, { recursive: true });
    mkdirSync(configuredDuplicate, { recursive: true });
    mkdirSync(compatSkill, { recursive: true });
    writeFileSync(join(workspaceSkill, "SKILL.md"), skillMd("same", "workspace wins", "workspace body"));
    writeFileSync(join(configuredDuplicate, "SKILL.md"), skillMd("same", "configured loses", "configured body"));
    writeFileSync(join(projectSkill, "SKILL.md"), skillMd("project-only", "project skill", "project body"));
    writeFileSync(join(configuredSkill, "SKILL.md"), skillMd("configured-only", "configured skill", "configured body"));
    writeFileSync(join(compatSkill, "SKILL.md"), skillMd("compat-only", "compat skill", "compat body"));

    const registry = scanSkills(tmp, process.env.HOME!, { skillsDir: configured, includeSystem: false });
    const names = registry.skills.map(skill => skill.name).sort();

    expect(names).toEqual(["compat-only", "configured-only", "project-only", "same"]);
    expect(registry.skills.find(skill => skill.name === "same")?.description).toBe("workspace wins");
    expect(registry.errors.some(error => error.includes("duplicate skill 'same'"))).toBe(true);
  });

  it("rejects absolute, prefixed traversal, and NUL skill archive entries", () => {
    const absolute = tarGz([
      { path: "/repo-main/skill/SKILL.md", data: skillMd("bad", "bad skill", "bad") },
    ]);
    const prefixedTraversal = tarGz([
      { path: "repo-main/skill/SKILL.md", data: skillMd("bad", "bad skill", "bad") },
      { path: "repo-main/skill/../escape.txt", data: "escape" },
    ]);
    const nulBody = tarGz([
      { path: "repo-main/nul/SKILL.md", data: skillMd("nul", "nul skill", "body\0hidden") },
    ]);

    expect(() => installSkillFromArchive(absolute, "x", join(tmp, "installed"))).toThrow(/escapes destination|missing SKILL/);
    expect(() => installSkillFromArchive(prefixedTraversal, "x", join(tmp, "installed"))).toThrow(/escapes destination/);
    expect(() => installSkillFromArchive(nulBody, "x", join(tmp, "installed"))).toThrow(/NUL byte/);
  });

  it("trusts the highest-precedence matching skill and activation uses trusted body", () => {
    const workspaceSkill = join(tmp, "skills", "trusted-demo");
    const globalSkill = join(process.env.HOME!, ".seekcode", "skills", "trusted-demo");
    mkdirSync(workspaceSkill, { recursive: true });
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(join(workspaceSkill, "SKILL.md"), skillMd("trusted-demo", "workspace trusted", "workspace trusted body"));
    writeFileSync(join(globalSkill, "SKILL.md"), skillMd("trusted-demo", "global ignored", "global body"));

    const trusted = trustSkill("trusted-demo", { workspaceDir: tmp, skillsDir: join(process.env.HOME!, ".seekcode", "skills") });
    const activated = activateSkill("trusted-demo", { workspaceDir: tmp, skillsDir: join(process.env.HOME!, ".seekcode", "skills") });

    expect(trusted).toContain("Trusted skill");
    expect(existsSync(join(workspaceSkill, ".trusted"))).toBe(true);
    expect(existsSync(join(globalSkill, ".trusted"))).toBe(false);
    expect(activated.instruction).toContain("workspace trusted body");
    expect(activated.instruction).not.toContain("global body");
  });

  it("refuses skill updates whose downloaded archive changes the installed skill name", async () => {
    const skillsDir = join(tmp, "installed");
    const original = tarGz([
      { path: "repo-main/original/SKILL.md", data: skillMd("original", "original skill", "body v1") },
    ]);
    const renamed = tarGz([
      { path: "repo-main/renamed/SKILL.md", data: skillMd("renamed", "renamed skill", "body v2") },
    ]);
    const installed = installSkillFromArchive(original, "https://example.com/original.tar.gz", skillsDir);
    const originalBody = readFileSync(join(installed.path, "SKILL.md"), "utf-8");
    const fetchMock = async () => new Response(renamed, {
      status: 200,
      headers: { "content-length": String(renamed.byteLength) },
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    try {
      await expect(updateSkill("original", { skillsDir })).rejects.toThrow(/renamed|skill name/i);
    } finally {
      globalThis.fetch = oldFetch;
    }

    expect(existsSync(join(skillsDir, "original", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "renamed"))).toBe(false);
    expect(readFileSync(join(skillsDir, "original", "SKILL.md"), "utf-8")).toBe(originalBody);
  });

  it("rejects malformed installed skill markers instead of stringifying fake update metadata", async () => {
    const skillsDir = join(tmp, "installed");
    const original = tarGz([
      { path: "repo-main/original/SKILL.md", data: skillMd("original", "original skill", "body v1") },
    ]);
    const installed = installSkillFromArchive(original, "https://example.com/original.tar.gz", skillsDir);

    writeFileSync(join(installed.path, ".installed-from"), JSON.stringify({
      source: { nested: true },
      checksum: ["bad"],
    }, null, 2), "utf-8");

    await expect(updateSkill("original", { skillsDir })).rejects.toThrow(/was not installed by \/skill install/i);
  });

  it("filters malformed remote skill registry entries instead of stringifying objects into fake skill metadata", async () => {
    const registryBody = JSON.stringify({
      skills: [
        { name: "valid-skill", description: "works", source: "registry", spec: "valid-skill" },
        { name: { nested: true }, description: "bad name" },
        { name: "typed-skill", description: { nested: true }, source: ["bad"] },
      ],
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(registryBody, {
      status: 200,
      headers: { "content-length": String(registryBody.length) },
    })) as typeof globalThis.fetch;
    try {
      const listed = await fetchRegistrySkills("https://example.com/skills.json");

      expect(listed).toEqual([
        { name: "valid-skill", description: "works", source: "registry", spec: "valid-skill" },
        { name: "typed-skill", description: undefined, source: undefined, spec: undefined, url: undefined, repo: undefined },
      ]);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

describe("P1 tool system", () => {
  it("stores and reads artifacts through artifact tools", async () => {
    registerArtifactTools();

    const created = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "log", name: "run.log", content: "hello artifact" }));
    const listed = await getRegistry().lookup("artifact_list")!.execute({ kind: "log" });
    const read = await getRegistry().lookup("artifact_read")!.execute({ id: created.id });

    expect(listed).toContain(created.id);
    expect(read).toContain("hello artifact");
  });

  it("writes MCP server config and toggles enabled state", async () => {
    registerDiagnosticsTools();

    const added = await getRegistry().lookup("mcp_manager")!.execute({ action: "add", name: "demo", command: process.execPath, args: ["server.js"] });
    const disabled = await getRegistry().lookup("mcp_manager")!.execute({ action: "disable", name: "demo" });
    const enabled = await getRegistry().lookup("mcp_manager")!.execute({ action: "enable", name: "demo" });
    const config = readFileSync(join(process.env.HOME!, ".seekcode", "config.toml"), "utf-8");

    expect(added).toContain("demo");
    expect(disabled).toContain("\"enabled\": false");
    expect(enabled).toContain("\"enabled\": true");
    expect(config).toContain("mcp_servers");
    expect(config).toContain("demo");
  });

  it("rejects malformed mcp_manager add inputs instead of persisting stringified objects", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("mcp_manager")!;

    expect(await tool.validateInput?.(
      { action: "add", name: { nested: true } as any, command: process.execPath },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("name"),
    });

    const result = await tool.execute({
      action: "add",
      name: { nested: true } as any,
      command: process.execPath,
    });
    const listed = JSON.parse(await tool.execute({ action: "list" })) as Array<{ name: string }>;

    expect(result).toContain("name is required");
    expect(listed).toEqual([]);
  });

  it("rejects malformed mcp_manager env values instead of persisting stringified process environment", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("mcp_manager")!;

    expect(await tool.validateInput?.(
      {
        action: "add",
        name: "bad-env",
        command: process.execPath,
        env: { OK: "1", BAD: { nested: true } } as any,
      },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("env must be an object with string values"),
    });

    const result = await tool.execute({
      action: "add",
      name: "bad-env",
      command: process.execPath,
      env: { OK: "1", BAD: { nested: true } } as any,
    });
    const listed = JSON.parse(await tool.execute({ action: "list" })) as Array<{ name: string }>;

    expect(result).toContain("env must be an object with string values");
    expect(listed).toEqual([]);
  });

  it("rejects malformed mcp_manager transport and enabled flags instead of silently normalizing them", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("mcp_manager")!;

    expect(await tool.validateInput?.(
      { action: "add", name: "bad-transport", transport: { nested: true } as any, command: process.execPath },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("transport must be a string"),
    });
    expect(await tool.validateInput?.(
      { action: "add", name: "bad-transport", transport: "http", command: process.execPath },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("transport must be stdio or sse"),
    });
    expect(await tool.validateInput?.(
      { action: "add", name: "bad-enabled", command: process.execPath, enabled: "yes" as any },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("enabled must be a boolean"),
    });

    expect(await tool.execute({
      action: "add",
      name: "bad-transport",
      transport: "http",
      command: process.execPath,
    })).toContain("transport must be stdio or sse");
    expect(await tool.execute({
      action: "add",
      name: "bad-enabled",
      command: process.execPath,
      enabled: "yes" as any,
    })).toContain("enabled must be a boolean");
    expect(JSON.parse(await tool.execute({ action: "list" }))).toEqual([]);
  });

  it("rejects malformed mcp_manager name selectors instead of stringifying objects into fake targets", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("mcp_manager")!;

    expect(await tool.validateInput?.(
      { action: "enable", name: { nested: true } as any },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("name"),
    });

    expect(await tool.execute({ action: "enable", name: { nested: true } as any })).toContain("name is required");
    expect(await tool.execute({ action: "reconnect", name: { nested: true } as any })).toContain("name is required");
    expect(await tool.execute({ action: "health", name: { nested: true } as any })).toContain("name is required");
  });

  it("allows mcp_manager health validation without a name so callers can inspect all servers", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("mcp_manager")!;

    expect(await tool.validateInput?.(
      { action: "health" },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: true,
      args: { action: "health" },
    });

    expect(await tool.execute({ action: "health" })).toBe("{}");
  });

  it("filters malformed persisted MCP env values instead of reloading them into server config", async () => {
    registerDiagnosticsTools();
    writeUserConfigRaw({
      mcp_servers: [
        {
          name: "demo",
          transport: "stdio",
          command: process.execPath,
          env: {
            GOOD: "1",
            BAD_OBJ: { nested: true },
            BAD_NUM: 7,
          },
        },
      ],
    });

    const listed = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "list" })) as Array<{ name: string; env: Record<string, string> }>;

    expect(listed).toEqual([
      expect.objectContaining({
        name: "demo",
        env: { GOOD: "1" },
      }),
    ]);
  });

  it("skips malformed persisted MCP server rows instead of coercing them into fake configured servers", async () => {
    registerDiagnosticsTools();
    writeUserConfigRaw({
      mcp_servers: [
        {
          name: { nested: true },
          transport: "stdio",
          command: process.execPath,
        },
        {
          name: "demo",
          transport: { nested: true },
          command: { nested: true },
          args: ["--ok", { nested: true }, ""],
          url: { nested: true },
          env: { GOOD: "1", BAD: { nested: true } },
        },
      ],
    });

    const listed = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "list" })) as Array<{
      name: string;
      transport: string;
      command?: string;
      args: string[];
      url?: string;
      env: Record<string, string>;
    }>;

    expect(listed).toMatchObject([
      {
        name: "demo",
        transport: "stdio",
        args: ["--ok"],
        env: { GOOD: "1" },
      },
    ]);
  });

  it("rewrites persisted MCP config without malformed coerced fields after a manager update", async () => {
    registerDiagnosticsTools();
    writeUserConfigRaw({
      mcp_servers: [
        {
          name: "demo",
          transport: "stdio",
          command: process.execPath,
          args: ["--ok", { nested: true }],
          env: { GOOD: "1", BAD: { nested: true } },
        },
      ],
    });

    await getRegistry().lookup("mcp_manager")!.execute({ action: "disable", name: "demo" });
    const config = readFileSync(join(process.env.HOME!, ".seekcode", "config.toml"), "utf-8");

    expect(config).toContain('name = "demo"');
    expect(config).toContain('enabled = false');
    expect(config).toContain('"--ok"');
    expect(config).toContain('GOOD = "1"');
    expect(config).not.toContain("nested");
    expect(config).not.toContain("[object Object]");
  });

  it("reports MCP health failures with per-server log artifacts", async () => {
    registerDiagnosticsTools();
    await getRegistry().lookup("mcp_manager")!.execute({
      action: "add",
      name: "bad",
      command: process.execPath,
      args: ["-e", "console.error('mcp boom'); process.exit(1)"],
    });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" });

    const health = await getRegistry().lookup("mcp_manager")!.execute({ action: "health", name: "bad" });

    expect(health).toContain("failed");
    expect(health).toContain("log_artifact_id");
  });

  it("kills MCP stdio processes when startup fails before registration completes", async () => {
    registerDiagnosticsTools();
    const pidFile = join(tmp, "mcp-init-fail.pid");
    const serverFile = join(tmp, "mcp-init-fail.mjs");
    writeFileSync(serverFile, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), "utf-8");
function respondError(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message } }) + "\\n");
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      respondError(request.id, "init failed");
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`);

    await getRegistry().lookup("mcp_manager")!.execute({
      action: "add",
      name: "broken",
      command: process.execPath,
      args: [serverFile],
    });
    const reloaded = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" }));
    const broken = reloaded.servers.find((server: any) => server.name === "broken");
    await waitFor(() => existsSync(pidFile) ? true : null);
    const pid = Number(readFileSync(pidFile, "utf-8").trim());

    expect(broken.status).toBe("failed");
    await waitFor(() => !isPidAlive(pid), 2500);
  });

  it("connects MCP servers, hot-refreshes tools, and unregisters tools after crashes", async () => {
    registerDiagnosticsTools();
    const stateFile = join(tmp, "mcp-state.json");
    const serverFile = join(tmp, "mcp-server.mjs");
    writeFileSync(stateFile, JSON.stringify({ tools: ["alpha"] }));
    writeFileSync(serverFile, mcpServerScript(stateFile));

    await getRegistry().lookup("mcp_manager")!.execute({
      action: "add",
      name: "hot",
      command: process.execPath,
      args: [serverFile],
    });
    const reloaded = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" }));
    const alpha = getRegistry().lookup("mcp_hot_alpha");
    expect(reloaded.servers.find((server: any) => server.name === "hot")).toMatchObject({ status: "connected", tool_count: 1 });
    expect(alpha).toBeTruthy();
    expect(await alpha!.execute({ value: "one" })).toContain("alpha:{\"value\":\"one\"}");

    writeFileSync(stateFile, JSON.stringify({ tools: ["beta"] }));
    const manager = getMCPManager();
    const refreshed = await manager.refreshTools(manager.list().find(server => server.name === "hot")!);

    expect(refreshed).toBe(true);
    expect(getRegistry().lookup("mcp_hot_alpha")).toBeUndefined();
    expect(getRegistry().lookup("mcp_hot_beta")).toBeTruthy();
    expect(await getRegistry().lookup("mcp_hot_beta")!.execute({ value: "two" })).toContain("beta:{\"value\":\"two\"}");

    await getRegistry().lookup("mcp_hot_beta")!.execute({ crash: true });
    await waitFor(() => getRegistry().lookup("mcp_hot_beta") ? null : true);
    const health = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "health", name: "hot" }));

    expect(health.hot.status).toBe("failed");
    expect(health.hot.stderr_tail).toContain("mcp crash requested");
    expect(health.hot.log_artifact_id).toBeTruthy();
  });

  it("cancels stale MCP reconnect timers after a manual reconnect", async () => {
    registerDiagnosticsTools();
    const stateFile = join(tmp, "mcp-reconnect-state.json");
    const startsFile = join(tmp, "mcp-starts.log");
    const serverFile = join(tmp, "mcp-reconnect-server.mjs");
    const readStartCount = () => existsSync(startsFile)
      ? readFileSync(startsFile, "utf-8").split("\n").filter(Boolean).length
      : 0;
    writeFileSync(stateFile, JSON.stringify({ tools: ["ping"] }));
    writeFileSync(serverFile, `
import { appendFileSync, readFileSync } from "node:fs";
const stateFile = ${JSON.stringify(stateFile)};
const startsFile = ${JSON.stringify(startsFile)};
appendFileSync(startsFile, "start\\n", "utf-8");
function tools() {
  const state = JSON.parse(readFileSync(stateFile, "utf-8"));
  return (state.tools || []).map((name) => ({
    name,
    description: name + " tool",
    inputSchema: { type: "object", properties: { value: { type: "string" }, crash: { type: "boolean" } } },
  }));
}
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      respond(request.id, { protocolVersion: "2024-11-05", capabilities: {} });
    } else if (request.method === "tools/list") {
      respond(request.id, { tools: tools() });
    } else if (request.method === "tools/call") {
      const args = request.params?.arguments || {};
      if (args.crash) process.exit(42);
      respond(request.id, { content: [{ type: "text", text: request.params.name + ":" + JSON.stringify(args) }] });
    } else {
      respond(request.id, {});
    }
  }
});
`);

    await getRegistry().lookup("mcp_manager")!.execute({
      action: "add",
      name: "race",
      command: process.execPath,
      args: [serverFile],
    });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" });
    await waitFor(() => getRegistry().lookup("mcp_race_ping") || null);
    expect(readStartCount()).toBe(1);

    await getRegistry().lookup("mcp_race_ping")!.execute({ crash: true });
    await waitFor(() => getRegistry().lookup("mcp_race_ping") ? null : true);

    await getRegistry().lookup("mcp_manager")!.execute({ action: "reconnect", name: "race" });
    await waitFor(() => getRegistry().lookup("mcp_race_ping") || null);
    await waitFor(() => readStartCount() === 2 ? 2 : null);

    await new Promise(resolve => setTimeout(resolve, 1300));

    expect(readStartCount()).toBe(2);
    expect(await getRegistry().lookup("mcp_race_ping")!.execute({ value: "ok" })).toContain("ping:{\"value\":\"ok\"}");
  });

  it("does not reconnect disabled MCP servers or register their tools", async () => {
    registerDiagnosticsTools();
    const stateFile = join(tmp, "mcp-disabled-state.json");
    const startsFile = join(tmp, "mcp-disabled-starts.log");
    const serverFile = join(tmp, "mcp-disabled-server.mjs");
    const readStartCount = () => existsSync(startsFile)
      ? readFileSync(startsFile, "utf-8").split("\n").filter(Boolean).length
      : 0;
    writeFileSync(stateFile, JSON.stringify({ tools: ["noop"] }));
    writeFileSync(serverFile, `
import { appendFileSync, readFileSync } from "node:fs";
const stateFile = ${JSON.stringify(stateFile)};
const startsFile = ${JSON.stringify(startsFile)};
appendFileSync(startsFile, "start\\n", "utf-8");
function tools() {
  const state = JSON.parse(readFileSync(stateFile, "utf-8"));
  return (state.tools || []).map((name) => ({
    name,
    description: name + " tool",
    inputSchema: { type: "object", properties: {} },
  }));
}
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      respond(request.id, { protocolVersion: "2024-11-05", capabilities: {} });
    } else if (request.method === "tools/list") {
      respond(request.id, { tools: tools() });
    } else if (request.method === "tools/call") {
      respond(request.id, { content: [{ type: "text", text: request.params.name }] });
    } else {
      respond(request.id, {});
    }
  }
});
`);

    await getRegistry().lookup("mcp_manager")!.execute({ action: "add", name: "sleeping", command: process.execPath, args: [serverFile] });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "disable", name: "sleeping" });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" });

    const reconnect = await getRegistry().lookup("mcp_manager")!.execute({ action: "reconnect", name: "sleeping" });
    const listed = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "list" }));

    expect(reconnect).toContain("disabled");
    expect(readStartCount()).toBe(0);
    expect(getRegistry().lookup("mcp_sleeping_noop")).toBeUndefined();
    expect(listed.find((server: any) => server.name === "sleeping")).toMatchObject({ status: "disabled" });
  });

  it("persists MCP add/disable/enable/remove and applies enabled state after reload", async () => {
    registerDiagnosticsTools();
    const serverFile = join(tmp, "disabled-mcp.mjs");
    const stateFile = join(tmp, "disabled-state.json");
    writeFileSync(stateFile, JSON.stringify({ tools: ["noop"] }));
    writeFileSync(serverFile, mcpServerScript(stateFile));

    await getRegistry().lookup("mcp_manager")!.execute({ action: "add", name: "toggle", command: process.execPath, args: [serverFile] });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "disable", name: "toggle" });
    const disabled = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" }));
    await getRegistry().lookup("mcp_manager")!.execute({ action: "enable", name: "toggle" });
    const enabled = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" }));
    const noop = getRegistry().lookup("mcp_toggle_noop");
    const removed = await getRegistry().lookup("mcp_manager")!.execute({ action: "remove", name: "toggle" });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" });

    expect(disabled.servers.find((server: any) => server.name === "toggle")).toMatchObject({ status: "disabled" });
    expect(getRegistry().lookup("mcp_toggle_noop")).toBeUndefined();
    expect(enabled.servers.find((server: any) => server.name === "toggle")).toMatchObject({ status: "connected" });
    expect(noop).toBeTruthy();
    expect(removed).toContain("\"removed\": \"toggle\"");
    expect(getRegistry().lookup("mcp_toggle_noop")).toBeUndefined();
  });

  it("unregisters stale MCP tools when a health check fails after the server toolset becomes unreadable", async () => {
    registerDiagnosticsTools();
    const stateFile = join(tmp, "mcp-health-state.json");
    const serverFile = join(tmp, "mcp-health-server.mjs");
    writeFileSync(stateFile, JSON.stringify({ tools: ["alive"] }));
    writeFileSync(serverFile, `
import { readFileSync } from "node:fs";
const stateFile = ${JSON.stringify(stateFile)};
function readState() {
  return JSON.parse(readFileSync(stateFile, "utf-8"));
}
function tools() {
  const state = readState();
  return (state.tools || []).map((name) => ({
    name,
    description: name + " tool",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  }));
}
function respond(id, result, error) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }) + "\\n");
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      respond(request.id, { protocolVersion: "2024-11-05", capabilities: {} });
    } else if (request.method === "tools/list") {
      const state = readState();
      if (state.failToolsList) {
        respond(request.id, null, { code: -32001, message: "tools/list failed" });
      } else {
        respond(request.id, { tools: tools() });
      }
    } else if (request.method === "tools/call") {
      respond(request.id, { content: [{ type: "text", text: request.params.name + ":" + JSON.stringify(request.params?.arguments || {}) }] });
    } else {
      respond(request.id, {});
    }
  }
});
`);

    await getRegistry().lookup("mcp_manager")!.execute({
      action: "add",
      name: "fragile",
      command: process.execPath,
      args: [serverFile],
    });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" });

    expect(getRegistry().lookup("mcp_fragile_alive")).toBeTruthy();

    writeFileSync(stateFile, JSON.stringify({ failToolsList: true }));
    const health = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "health", name: "fragile" }));

    expect(health.fragile.status).toBe("failed");
    expect(getRegistry().lookup("mcp_fragile_alive")).toBeUndefined();
  });

  it("runs TypeScript diagnostics and archives output", async () => {
    registerDiagnosticsTools();
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5.8.0" } }));
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
    writeFileSync(join(tmp, "bad.ts"), "const x: number = 'bad';\n");

    const result = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({ workdir: tmp, language: "typescript" }));

    expect(result.language).toBe("typescript");
    expect(result.artifact_id).toBeTruthy();
    expect(String(result.output)).toContain("bad.ts");
  });

  it("parses and filters diagnostics across LSP-style output shapes", async () => {
    registerDiagnosticsTools();
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const fakePyright = join(bin, "pyright");
    writeFileSync(fakePyright, [
      "#!/usr/bin/env bash",
      "cat <<'JSON'",
      JSON.stringify({
        generalDiagnostics: [
          {
            file: join(tmp, "src", "keep.py"),
            severity: "error",
            message: "bad assignment",
            rule: "reportAssignmentType",
            range: { start: { line: 2, character: 4 } },
          },
          {
            file: join(tmp, "src", "skip.py"),
            severity: "information",
            message: "informational only",
            range: { start: { line: 4, character: 2 } },
          },
          {
            file: join(tmp, "src", "keep.py"),
            severity: "hint",
            message: "hint kept when all",
            range: { start: { line: 7, character: 1 } },
          },
        ],
      }),
      "JSON",
    ].join("\n"));
    await run(`chmod +x ${JSON.stringify(fakePyright)}`);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const errors = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({
        workdir: tmp,
        language: "python",
        files: ["src/keep.py"],
        min_severity: "error",
      }));
      const all = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({
        workdir: tmp,
        language: "python",
        files: ["src/keep.py"],
        min_severity: "all",
      }));

      expect(errors.summary).toEqual({ total: 1, by_severity: { error: 1 } });
      expect(errors.diagnostics[0]).toMatchObject({ file: join(tmp, "src", "keep.py"), line: 3, column: 5, severity: "error", code: "reportAssignmentType" });
      expect(all.summary).toEqual({ total: 2, by_severity: { error: 1, hint: 1 } });
      expect(all.diagnostics.map((diagnostic: any) => diagnostic.message)).toContain("hint kept when all");
      expect(all.diagnostics.map((diagnostic: any) => diagnostic.file)).not.toContain(join(tmp, "src", "skip.py"));
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("skips malformed Python diagnostic JSON entries instead of stringifying object fields into fake diagnostics", async () => {
    registerDiagnosticsTools();
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const fakePyright = join(bin, "pyright");
    writeFileSync(fakePyright, [
      "#!/usr/bin/env bash",
      "cat <<'JSON'",
      JSON.stringify({
        generalDiagnostics: [
          {
            file: { nested: true },
            severity: "error",
            message: "bad file field",
            rule: "badRule",
            range: { start: { line: 1, character: 1 } },
          },
          {
            file: join(tmp, "src", "bad-message.py"),
            severity: "warning",
            message: { nested: true },
            rule: "badMessage",
            range: { start: { line: 2, character: 2 } },
          },
          {
            file: join(tmp, "src", "bad-rule.py"),
            severity: "error",
            message: "bad rule field",
            rule: { nested: true },
            range: { start: { line: 3, character: 3 } },
          },
          {
            file: join(tmp, "src", "keep.py"),
            severity: "error",
            message: "real diagnostic",
            rule: "reportRealIssue",
            range: { start: { line: 4, character: 5 } },
          },
        ],
      }),
      "JSON",
    ].join("\n"));
    await run(`chmod +x ${JSON.stringify(fakePyright)}`);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const result = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({
        workdir: tmp,
        language: "python",
        min_severity: "all",
      }));

      expect(result.summary).toEqual({ total: 1, by_severity: { error: 1 } });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          file: join(tmp, "src", "keep.py"),
          line: 5,
          column: 6,
          severity: "error",
          code: "reportRealIssue",
          message: "real diagnostic",
        }),
      ]);
      expect(JSON.stringify(result.diagnostics)).not.toContain("[object Object]");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("parses TypeScript, Go, and Rust diagnostic text formats", async () => {
    registerDiagnosticsTools();
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tsc"), [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"src/app.ts(12,8): error TS2322: Type '\\\"x\\\"' is not assignable to type 'number'.\"",
      "printf '%s\\n' \"src/app.ts(13,1): warning TS6133: 'unused' is declared but its value is never read.\"",
    ].join("\n"));
    writeFileSync(join(bin, "gopls"), [
      "#!/usr/bin/env bash",
      "printf '%s\\n' 'main.go:3:5: error: undefined: nope'",
    ].join("\n"));
    writeFileSync(join(bin, "cargo"), [
      "#!/usr/bin/env bash",
      "printf '%s\\n' 'src/main.rs:4:9: warning: unused variable: `x`'",
    ].join("\n"));
    await run(`chmod +x ${JSON.stringify(join(bin, "tsc"))} ${JSON.stringify(join(bin, "gopls"))} ${JSON.stringify(join(bin, "cargo"))}`);
    writeFileSync(join(tmp, "package.json"), "{}");
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const ts = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({ workdir: tmp, language: "typescript", min_severity: "all" }));
      const go = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({ workdir: tmp, language: "go", min_severity: "all" }));
      const rust = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({ workdir: tmp, language: "rust", min_severity: "all" }));

      expect(ts.summary).toEqual({ total: 2, by_severity: { error: 1, warning: 1 } });
      expect(ts.diagnostics[0]).toMatchObject({ file: "src/app.ts", line: 12, column: 8, severity: "error", code: "TS2322" });
      expect(go.diagnostics[0]).toMatchObject({ file: "main.go", line: 3, column: 5, severity: "error", message: "undefined: nope" });
      expect(rust.diagnostics[0]).toMatchObject({ file: "src/main.rs", line: 4, column: 9, severity: "warning", message: "unused variable: `x`" });
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("blocks GitHub mutations on dirty worktrees and records evidence", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "dirty.txt"), "dirty\n");

    const result = await getRegistry().lookup("github_comment")!.execute({ number: "1", body: "hello", workdir: tmp });

    expect(result).toContain("dirty worktree guard");
    expect(result).toContain("Evidence artifact:");
  });

  it("normalizes GitHub comment aliases during validation", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("github_comment")!;
    const validation = await tool.validateInput?.(
      { number: "42", body: "hello", workdir: tmp },
      { tool_name: "github_comment", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        target: "42",
        body: "hello",
        workdir: tmp,
      },
    });
  });

  it("accepts the canonical GitHub comment target field during execution", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, ".gitignore"), "artifacts/\nhome/\ngh-calls.log\n");
    const bin = join(tmp, "bin");
    const calls = join(tmp, "gh-calls.log");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' \"$*\" >> ${JSON.stringify(calls)}`,
      "if [[ \"$1 $2\" == \"issue view\" ]]; then",
      "  printf '%s\\n' '{\"number\":42,\"title\":\"Canonical target\",\"state\":\"OPEN\",\"url\":\"https://example.invalid/42\"}'",
      "  exit 0",
      "fi",
      "if [[ \"$1 $2\" == \"issue comment\" ]]; then",
      "  printf '%s\\n' 'comment created'",
      "  exit 0",
      "fi",
      "exit 2",
    ].join("\n"));
    await run(`chmod +x ${JSON.stringify(join(bin, "gh"))}`);
    await run("git add .gitignore bin/gh && git commit -m fake-gh");
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const result = await getRegistry().lookup("github_comment")!.execute({
        target: " 42 ",
        body: " hello ",
        workdir: tmp,
      });

      expect(result).toContain("comment created");
      expect(readFileSync(calls, "utf-8")).toContain("issue comment 42 --body hello");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("rejects blank GitHub comment bodies during execution instead of posting whitespace-only comments", async () => {
    registerDiagnosticsTools();

    expect(await getRegistry().lookup("github_comment")!.execute({
      target: "42",
      body: "   ",
      workdir: tmp,
    })).toContain("target and body are required");
  });

  it("normalizes GitHub issue selectors during validation", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("github_issue_context")!;
    const validation = await tool.validateInput?.(
      { number: "77", workdir: tmp },
      { tool_name: "github_issue_context", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        issue: "77",
        workdir: tmp,
      },
    });
  });

  it("trims GitHub issue selectors during execution", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, ".gitignore"), "artifacts/\nhome/\ngh-calls.log\n");
    const bin = join(tmp, "bin");
    const calls = join(tmp, "gh-calls.log");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' \"$*\" >> ${JSON.stringify(calls)}`,
      "if [[ \"$1 $2\" == \"issue view\" ]]; then",
      "  printf '%s\\n' '{\"number\":77,\"title\":\"Issue title\",\"state\":\"OPEN\",\"url\":\"https://example.invalid/77\"}'",
      "  exit 0",
      "fi",
      "exit 2",
    ].join("\n"));
    await run(`chmod +x ${JSON.stringify(join(bin, "gh"))}`);
    await run("git add .gitignore bin/gh && git commit -m fake-gh");
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const result = await getRegistry().lookup("github_issue_context")!.execute({ issue: " 77 ", workdir: tmp });

      expect(result).toContain("Issue title");
      expect(readFileSync(calls, "utf-8")).toContain("issue view 77 --json");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("rejects non-string GitHub selectors during execution instead of stringifying objects into fake targets", async () => {
    registerDiagnosticsTools();

    expect(await getRegistry().lookup("github_issue_context")!.execute({ number: { nested: true } as any, workdir: tmp })).toContain("issue, number, or url is required");
    expect(await getRegistry().lookup("github_pr_context")!.execute({ number: { nested: true } as any, workdir: tmp })).toContain("pr, number, or url is required");
    expect(await getRegistry().lookup("github_comment")!.execute({ number: { nested: true } as any, body: "hello", workdir: tmp })).toContain("target and body are required");
    expect(await getRegistry().lookup("github_close_issue")!.execute({ number: { nested: true } as any, reason: "done", workdir: tmp })).toContain("issue and reason are required");
  });

  it("normalizes GitHub close selectors and reason during validation", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("github_close_issue")!;
    const validation = await tool.validateInput?.(
      { number: "88", reason: "done", workdir: tmp },
      { tool_name: "github_close_issue", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        issue: "88",
        reason: "done",
        workdir: tmp,
      },
    });
  });

  it("rejects blank GitHub close reasons during execution instead of posting whitespace-only close comments", async () => {
    registerDiagnosticsTools();

    expect(await getRegistry().lookup("github_close_issue")!.execute({
      issue: "88",
      reason: "   ",
      workdir: tmp,
    })).toContain("issue and reason are required");
  });

  it("does not misclassify verified GitHub targets whose title contains error-like words", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, ".gitignore"), "artifacts/\nhome/\ngh-calls.log\n");
    const bin = join(tmp, "bin");
    const calls = join(tmp, "gh-calls.log");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
      "if [[ \"$1 $2\" == \"issue view\" ]]; then",
      "  printf '%s\\n' '{\"number\":1,\"title\":\"Error page copy\",\"state\":\"OPEN\",\"url\":\"https://example.invalid/1\"}'",
      "  exit 0",
      "fi",
      "if [[ \"$1 $2\" == \"issue comment\" ]]; then",
      "  printf '%s\\n' 'comment created'",
      "  exit 0",
      "fi",
      "exit 2",
    ].join("\n"));
    await run(`chmod +x ${JSON.stringify(join(bin, "gh"))}`);
    await run("git add .gitignore bin/gh && git commit -m fake-gh");
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const result = await getRegistry().lookup("github_comment")!.execute({ number: "1", body: "hello", workdir: tmp });

      expect(result).toBe("comment created");
      expect(readFileSync(calls, "utf-8")).toContain("issue view");
      expect(readFileSync(calls, "utf-8")).toContain("issue comment");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("keeps PR attempt record faithful for empty diffs", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "file.txt"), "stable\n");
    await run("git add . && git commit -m init");

    const recorded = JSON.parse(await getRegistry().lookup("pr_attempt_record")!.execute({ workdir: tmp }));
    const patch = await getRegistry().lookup("pr_attempt_read")!.execute({ id: recorded.artifact_id });

    expect(recorded.bytes).toBe(0);
    expect(patch).not.toContain("(exit 0)");
  });

  it("archives PR attempt patches in the artifact store", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "file.txt"), "old\n");
    await run("git add . && git commit -m init");
    writeFileSync(join(tmp, "file.txt"), "new\n");

    const recorded = JSON.parse(await getRegistry().lookup("pr_attempt_record")!.execute({ workdir: tmp }));
    const listed = await getRegistry().lookup("pr_attempt_list")!.execute({});
    const read = await getRegistry().lookup("pr_attempt_read")!.execute({ id: recorded.artifact_id });

    expect(recorded.artifact_id).toBeTruthy();
    expect(listed).toContain(recorded.artifact_id);
    expect(read).toContain("+new");
  });

  it("normalizes pr_attempt_gate aliases during validation", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("pr_attempt_gate")!;
    const validation = await tool.validateInput?.(
      { gate: "test -f README.md", workdir: tmp },
      { tool_name: "pr_attempt_gate", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        command: "test -f README.md",
        workdir: tmp,
      },
    });
  });

  it("rejects non-string PR attempt gate commands during execution instead of stringifying objects", async () => {
    registerDiagnosticsTools();

    const tool = getRegistry().lookup("pr_attempt_gate")!;
    expect(await tool.validateInput?.(
      { gate: { nested: true } as any, workdir: tmp },
      { tool_name: "pr_attempt_gate", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("command is required"),
    });

    expect(await getRegistry().lookup("pr_attempt_gate")!.execute({
      gate: { nested: true } as any,
      workdir: tmp,
    })).toContain("command is required");
  });

  it("rejects blank PR attempt gate commands during execution instead of running empty gates", async () => {
    registerDiagnosticsTools();

    expect(await getRegistry().lookup("pr_attempt_gate")!.execute({
      command: "   ",
      workdir: tmp,
    })).toContain("command is required");
  });

  it("normalizes PR review selectors during validation", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("pr_attempt_review_sync")!;
    const validation = await tool.validateInput?.(
      { number: "91", workdir: tmp },
      { tool_name: "pr_attempt_review_sync", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        pr: "91",
        workdir: tmp,
      },
    });
  });

  it("trims PR review selectors during execution", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, ".gitignore"), "artifacts/\nhome/\ngh-calls.log\n");
    const bin = join(tmp, "bin");
    const calls = join(tmp, "gh-calls.log");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' \"$*\" >> ${JSON.stringify(calls)}`,
      "if [[ \"$1 $2\" == \"pr view\" ]]; then",
      "  printf '%s\\n' '{\"comments\":[],\"reviews\":[],\"reviewDecision\":\"\",\"url\":\"https://example.invalid/pr/91\"}'",
      "  exit 0",
      "fi",
      "exit 2",
    ].join("\n"));
    await run(`chmod +x ${JSON.stringify(join(bin, "gh"))}`);
    await run("git add .gitignore bin/gh && git commit -m fake-gh");
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const result = await getRegistry().lookup("pr_attempt_review_sync")!.execute({
        pr: " 91 ",
        workdir: tmp,
      });

      expect(result).toContain("artifact_id");
      expect(readFileSync(calls, "utf-8")).toContain("pr view 91 --json");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("rejects non-string PR review selectors during execution instead of stringifying objects into fake targets", async () => {
    registerDiagnosticsTools();

    expect(await getRegistry().lookup("pr_attempt_review_sync")!.execute({
      number: { nested: true } as any,
      workdir: tmp,
    })).toContain("pr, number, or url is required");
  });

  it("validates pr_attempt_read id requirements before dispatch", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("pr_attempt_read")!;
    const validation = await tool.validateInput?.(
      { id: "artifact_123" },
      { tool_name: "pr_attempt_read", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: { id: "artifact_123" },
    });
    expect(await tool.validateInput?.(
      {},
      { tool_name: "pr_attempt_read", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("id is required"),
    });
  });

  it("runs PR attempt gates and records rollback evidence", async () => {
    registerDiagnosticsTools();
    registerArtifactTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "file.txt"), "old\n");
    await run("git add . && git commit -m init");
    writeFileSync(join(tmp, "file.txt"), "new\n");

    const gate = JSON.parse(await getRegistry().lookup("pr_attempt_gate")!.execute({ workdir: tmp, command: "test -f file.txt" }));
    const failedGate = JSON.parse(await getRegistry().lookup("pr_attempt_gate")!.execute({ workdir: tmp, command: "test -f missing.txt" }));
    const rollback = JSON.parse(await getRegistry().lookup("pr_attempt_rollback")!.execute({ workdir: tmp, target: "HEAD" }));
    const rollbackLog = await getRegistry().lookup("artifact_read")!.execute({ id: rollback.artifact_id });

    expect(gate.passed).toBe(true);
    expect(failedGate.passed).toBe(false);
    expect(gate.artifact_id).toBeTruthy();
    expect(failedGate.artifact_id).toBeTruthy();
    expect(rollback.artifact_id).toBeTruthy();
    expect(readFileSync(join(tmp, "file.txt"), "utf-8")).toBe("old\n");
    expect(rollbackLog).toContain("[before]");
    expect(rollbackLog).toContain("[after]");
  });

  it("rejects non-string PR attempt branch and rollback targets instead of stringifying objects", async () => {
    registerDiagnosticsTools();

    expect(await getRegistry().lookup("pr_attempt_branch")!.execute({
      workdir: tmp,
      branch: { nested: true } as any,
    })).toContain("branch must be a string");

    expect(await getRegistry().lookup("pr_attempt_rollback")!.execute({
      workdir: tmp,
      branch: { nested: true } as any,
    })).toContain("branch must be a string");

    expect(await getRegistry().lookup("pr_attempt_rollback")!.execute({
      workdir: tmp,
      target: { nested: true } as any,
    })).toContain("target must be a string");
  });

  it("rejects blank PR attempt branch names instead of creating bogus '-' branches", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("pr_attempt_branch")!;

    expect(await tool.validateInput?.(
      { workdir: tmp, branch: "   " },
      { tool_name: "pr_attempt_branch", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("branch must be a non-empty string"),
    });
    expect(await tool.validateInput?.(
      { workdir: tmp, base: "   " },
      { tool_name: "pr_attempt_branch", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("base must be a non-empty string"),
    });

    expect(await tool.execute({
      workdir: tmp,
      branch: "   ",
    })).not.toContain('"branch":"-"');
  });

  it("rejects non-string PR draft metadata instead of stringifying objects into GitHub commands", async () => {
    registerDiagnosticsTools();
    const draftTool = getRegistry().lookup("pr_attempt_push_draft")!;
    const rollbackTool = getRegistry().lookup("pr_attempt_rollback")!;

    expect(await draftTool.validateInput?.(
      { workdir: tmp, title: { nested: true } as any },
      { tool_name: "pr_attempt_push_draft", workspace_path: tmp, tool_def: draftTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("title must be a string"),
    });
    expect(await draftTool.validateInput?.(
      { workdir: tmp, body: { nested: true } as any },
      { tool_name: "pr_attempt_push_draft", workspace_path: tmp, tool_def: draftTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("body must be a string"),
    });
    expect(await draftTool.validateInput?.(
      { workdir: tmp, branch: { nested: true } as any },
      { tool_name: "pr_attempt_push_draft", workspace_path: tmp, tool_def: draftTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("branch must be a string"),
    });
    expect(await rollbackTool.validateInput?.(
      { workdir: tmp, branch: { nested: true } as any },
      { tool_name: "pr_attempt_rollback", workspace_path: tmp, tool_def: rollbackTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("branch must be a string"),
    });
    expect(await rollbackTool.validateInput?.(
      { workdir: tmp, target: { nested: true } as any },
      { tool_name: "pr_attempt_rollback", workspace_path: tmp, tool_def: rollbackTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("target must be a string"),
    });

    expect(await getRegistry().lookup("pr_attempt_push_draft")!.execute({
      workdir: tmp,
      title: { nested: true } as any,
    })).toContain("title must be a string");

    expect(await getRegistry().lookup("pr_attempt_push_draft")!.execute({
      workdir: tmp,
      body: { nested: true } as any,
    })).toContain("body must be a string");
    expect(await getRegistry().lookup("pr_attempt_push_draft")!.execute({
      workdir: tmp,
      branch: { nested: true } as any,
    })).toContain("branch must be a string");
    expect(await getRegistry().lookup("pr_attempt_rollback")!.execute({
      workdir: tmp,
      branch: { nested: true } as any,
    })).toContain("branch must be a string");
    expect(await getRegistry().lookup("pr_attempt_rollback")!.execute({
      workdir: tmp,
      target: { nested: true } as any,
    })).toContain("target must be a string");
  });

  it("validates automation id requirements before dispatch", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("automation_run")!;
    const validation = await tool.validateInput?.(
      { id: "auto_123" },
      { tool_name: "automation_run", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: { id: "auto_123" },
    });
    expect(await tool.validateInput?.(
      {},
      { tool_name: "automation_run", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("id is required"),
    });
  });

  it("rejects non-string automation ids during validation instead of stringifying objects", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("automation_run")!;

    expect(await tool.validateInput?.(
      { id: { nested: true } as any },
      { tool_name: "automation_run", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("id is required"),
    });
  });

  it("rejects non-string automation ids during execution instead of looking up [object Object]", async () => {
    registerDiagnosticsTools();

    expect(await getRegistry().lookup("automation_run")!.execute({ id: { nested: true } as any })).toContain("id is required");
    expect(await getRegistry().lookup("automation_pause")!.execute({ id: { nested: true } as any })).toContain("id is required");
    expect(await getRegistry().lookup("automation_delete")!.execute({ id: { nested: true } as any })).toContain("id is required");
  });

  it("validates automation_create prompt requirements before dispatch", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("automation_create")!;
    const validation = await tool.validateInput?.(
      { prompt: "watch release branch" },
      { tool_name: "automation_create", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: { prompt: "watch release branch" },
    });
    expect(await tool.validateInput?.(
      { prompt: "   " },
      { tool_name: "automation_create", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("prompt is required"),
    });
  });

  it("rejects non-string automation prompts instead of persisting coerced values", async () => {
    registerDiagnosticsTools();
    const createTool = getRegistry().lookup("automation_create")!;

    expect(await createTool.validateInput?.(
      { prompt: { nested: true } as any },
      { tool_name: "automation_create", workspace_path: tmp, tool_def: createTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("prompt is required"),
    });

    const created = await createTool.execute({ prompt: { nested: true } as any });
    const listed = await getRegistry().lookup("automation_list")!.execute({});

    expect(created).toContain("prompt is required");
    expect(listed).toBe("[]");
  });

  it("rejects non-string automation schedules instead of persisting coerced scheduling metadata", async () => {
    registerDiagnosticsTools();
    const createTool = getRegistry().lookup("automation_create")!;

    expect(await createTool.validateInput?.(
      { prompt: "watch branch", schedule: { nested: true } as any },
      { tool_name: "automation_create", workspace_path: tmp, tool_def: createTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("schedule must be a string"),
    });

    expect(await createTool.execute({
      prompt: "watch branch",
      schedule: { nested: true } as any,
    })).toContain("schedule must be a string");
    expect(await getRegistry().lookup("automation_list")!.execute({})).toBe("[]");
  });

  it("rejects non-string automation updates instead of corrupting persisted automation state", async () => {
    registerDiagnosticsTools();
    const created = JSON.parse(await getRegistry().lookup("automation_create")!.execute({ prompt: "watch branch" })) as { id: string };
    const updateTool = getRegistry().lookup("automation_update")!;

    expect(await updateTool.validateInput?.(
      { id: created.id, schedule: { nested: true } as any },
      { tool_name: "automation_update", workspace_path: tmp, tool_def: updateTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("schedule must be a string"),
    });

    const updated = await getRegistry().lookup("automation_update")!.execute({
      id: created.id,
      prompt: { nested: true } as any,
    });
    const read = JSON.parse(await getRegistry().lookup("automation_read")!.execute({ id: created.id })) as { prompt: string };

    expect(updated).toContain("prompt is required");
    expect(read.prompt).toBe("watch branch");
  });

  it("rejects malformed lsp_diagnostics inputs instead of stringifying them into fake commands and artifact metadata", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("lsp_diagnostics")!;

    expect(await tool.validateInput?.(
      { workdir: tmp, language: { nested: true } as any },
      { tool_name: "lsp_diagnostics", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("language must be a string"),
    });
    expect(await tool.validateInput?.(
      { workdir: tmp, min_severity: { nested: true } as any },
      { tool_name: "lsp_diagnostics", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("min_severity must be a string"),
    });
    expect(await tool.validateInput?.(
      { workdir: tmp, min_severity: "verbose" },
      { tool_name: "lsp_diagnostics", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("min_severity must be one of"),
    });
    expect(await tool.validateInput?.(
      { workdir: tmp, files: [join(tmp, "a.ts"), 7] as any },
      { tool_name: "lsp_diagnostics", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("files must be a string or array of strings"),
    });

    expect(await tool.execute({ workdir: tmp, language: { nested: true } as any })).toContain("language must be a string");
    expect(await tool.execute({ workdir: tmp, min_severity: { nested: true } as any })).toContain("min_severity must be a string");
    expect(await tool.execute({ workdir: tmp, min_severity: "verbose" })).toContain("min_severity must be one of");
    expect(await tool.execute({ workdir: tmp, files: [join(tmp, "a.ts"), 7] as any })).toContain("files must be a string or array of strings");
  });

  it("normalizes LSP position arguments before reaching the language backend", async () => {
    registerDiagnosticsTools();
    const definitionTool = getRegistry().lookup("lsp_definition")!;
    const hoverTool = getRegistry().lookup("lsp_hover")!;

    expect(await definitionTool.validateInput?.(
      { symbol: "helper", file: "src/app.ts", line: "3", character: "7", workdir: tmp },
      { tool_name: "lsp_definition", workspace_path: tmp, tool_def: definitionTool },
    )).toMatchObject({
      ok: true,
      args: expect.objectContaining({ line: 3, character: 7 }),
    });
    expect(await hoverTool.validateInput?.(
      { file: "src/app.ts", line: "4", character: "2", workdir: tmp },
      { tool_name: "lsp_hover", workspace_path: tmp, tool_def: hoverTool },
    )).toMatchObject({
      ok: true,
      args: expect.objectContaining({ line: 4, character: 2 }),
    });

    expect(await definitionTool.execute({ symbol: "helper", line: { nested: true } as any, workdir: tmp })).toContain("line must be a positive number");
    expect(await hoverTool.execute({ file: "src/app.ts", line: 1, character: { nested: true } as any, workdir: tmp })).toContain("character must be a non-negative number");
  });

  it("exposes lightweight LSP symbols, definition, and hover tools", async () => {
    registerDiagnosticsTools();
    const file = join(tmp, "src", "sample.ts");
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(file, [
      "export class Sample {",
      "  run(): string {",
      "    return helper();",
      "  }",
      "}",
      "export function helper() { return 'ok'; }",
    ].join("\n"));

    const symbolsResult = JSON.parse(await getRegistry().lookup("lsp_symbols")!.execute({ file, workdir: tmp })) as { symbols: Array<{ name: string; kind: string }> };
    const definition = JSON.parse(await getRegistry().lookup("lsp_definition")!.execute({ symbol: "helper", workdir: tmp })) as { matches: Array<{ file: string; line: number }> };
    const hover = await getRegistry().lookup("lsp_hover")!.execute({ file, line: 2, workdir: tmp });

    expect(symbolsResult.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Sample", kind: "class" }),
      expect.objectContaining({ name: "run", kind: "method" }),
      expect.objectContaining({ name: "helper", kind: "function" }),
    ]));
    expect(definition.matches.some(item => item.file.endsWith("sample.ts") && item.line === 6)).toBe(true);
    expect(hover).toContain("> 2:");
    expect(hover).toContain("run(): string");
  });

  it("rejects LSP source files outside the requested workdir", async () => {
    registerDiagnosticsTools();
    const workspace = join(tmp, "workspace");
    const outsideDir = join(tmp, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "secret.ts");
    writeFileSync(outsideFile, "export function secret() { return 1; }\n");

    const symbols = await getRegistry().lookup("lsp_symbols")!.execute({ file: outsideFile, workdir: workspace });
    const definition = await getRegistry().lookup("lsp_definition")!.execute({ symbol: "secret", file: outsideFile, line: 1, workdir: workspace });
    const hover = await getRegistry().lookup("lsp_hover")!.execute({ file: outsideFile, line: 1, workdir: workspace });

    expect(symbols).toContain("outside workdir");
    expect(definition).toContain("outside workdir");
    expect(hover).toContain("outside workdir");
  });

  it("rejects LSP symlinks that escape the requested workdir", async () => {
    registerDiagnosticsTools();
    const workspace = join(tmp, "workspace");
    const outsideDir = join(tmp, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "escaped.ts");
    const link = join(workspace, "link.ts");
    writeFileSync(outsideFile, "export const escaped = 1;\n");
    symlinkSync(outsideFile, link);

    const symbols = await getRegistry().lookup("lsp_symbols")!.execute({ file: "link.ts", workdir: workspace });
    const hover = await getRegistry().lookup("lsp_hover")!.execute({ file: "link.ts", line: 1, workdir: workspace });

    expect(symbols).toContain("outside workdir");
    expect(hover).toContain("outside workdir");
  });

  it("rejects malformed diagnostics workdirs instead of passing object roots into subprocess helpers", async () => {
    registerDiagnosticsTools();
    const diagnosticsTool = getRegistry().lookup("diagnostics")!;
    const issueTool = getRegistry().lookup("github_issue_context")!;
    const recordTool = getRegistry().lookup("pr_attempt_record")!;
    const draftTool = getRegistry().lookup("pr_attempt_push_draft")!;
    const rollbackTool = getRegistry().lookup("pr_attempt_rollback")!;

    expect(await diagnosticsTool.validateInput?.(
      { workdir: { nested: true } as any },
      { tool_name: "diagnostics", workspace_path: tmp, tool_def: diagnosticsTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await issueTool.validateInput?.(
      { number: "1", workdir: { nested: true } as any },
      { tool_name: "github_issue_context", workspace_path: tmp, tool_def: issueTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await recordTool.validateInput?.(
      { cwd: { nested: true } as any },
      { tool_name: "pr_attempt_record", workspace_path: tmp, tool_def: recordTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await draftTool.validateInput?.(
      { workdir: { nested: true } as any },
      { tool_name: "pr_attempt_push_draft", workspace_path: tmp, tool_def: draftTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await rollbackTool.validateInput?.(
      { cwd: { nested: true } as any },
      { tool_name: "pr_attempt_rollback", workspace_path: tmp, tool_def: rollbackTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });

    expect(await diagnosticsTool.execute({ workdir: { nested: true } as any })).toContain("workdir must be a string");
    expect(await getRegistry().lookup("pr_attempt_record")!.execute({ cwd: { nested: true } as any })).toContain("workdir must be a string");
    expect(await getRegistry().lookup("pr_attempt_push_draft")!.execute({ workdir: { nested: true } as any })).toContain("workdir must be a string");
    expect(await getRegistry().lookup("pr_attempt_rollback")!.execute({ cwd: { nested: true } as any })).toContain("workdir must be a string");
  });

  it("normalizes web_search compatibility aliases during validation", async () => {
    registerWebTools();
    const tool = getRegistry().lookup("web_search")!;
    const validation = await tool.validateInput?.(
      {
        source: "bing",
        searchType: "deep",
        include_content: true,
        contextResults: 3,
        contextMaxCharacters: 900,
        search_query: [{ q: "deepseek api", max_results: 2, domains: ["example.com"] }],
      },
      { tool_name: "web_search", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        source: "bing",
        engine: "bing",
        searchType: "deep",
        type: "deep",
        include_content: true,
        fetch_results: true,
        contextResults: 3,
        context_results: 3,
        contextMaxCharacters: 900,
        context_max_characters: 900,
        search_query: [{ q: "deepseek api", max_results: 2, domains: ["example.com"] }],
        query: "deepseek api",
        max_results: 2,
        domains: ["example.com"],
      },
    });
  });

  it("rejects malformed web_search domain filters instead of stringifying objects into fake site filters", async () => {
    registerWebTools();
    const tool = getRegistry().lookup("web_search")!;

    expect(await tool.validateInput?.(
      { query: "deepseek", domains: [{ nested: true }] as any },
      { tool_name: "web_search", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("domains must be an array of strings"),
    });
    expect(await tool.validateInput?.(
      { search_query: [{ q: "deepseek", domains: [{ nested: true }] as any }] },
      { tool_name: "web_search", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("search_query domains must be an array of strings"),
    });
  });

  it("rejects malformed web_search query fields instead of deferring them to a generic missing-query error", async () => {
    registerWebTools();
    const tool = getRegistry().lookup("web_search")!;

    expect(await tool.validateInput?.(
      { query: { nested: true } as any },
      { tool_name: "web_search", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("query must be a string"),
    });
    expect(await tool.validateInput?.(
      { search_query: [{ q: { nested: true } as any }] },
      { tool_name: "web_search", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("search_query q must be a string"),
    });

    expect(await tool.execute({ query: { nested: true } as any })).toContain("query is required");
  });

  it("rejects malformed optional web_search and web_fetch inputs instead of silently coercing them to defaults", async () => {
    registerWebTools();
    const searchTool = getRegistry().lookup("web_search")!;
    const fetchTool = getRegistry().lookup("web_fetch")!;

    expect(await searchTool.validateInput?.(
      { query: "deepseek", max_results: { nested: true } as any },
      { tool_name: "web_search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_results must be a number"),
    });
    expect(await searchTool.validateInput?.(
      { query: "deepseek", json: { nested: true } as any },
      { tool_name: "web_search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("json must be a boolean"),
    });
    expect(await searchTool.validateInput?.(
      { search_query: [{ q: "deepseek", max_results: { nested: true } as any }] },
      { tool_name: "web_search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("search_query max_results must be a number"),
    });

    expect(await fetchTool.validateInput?.(
      { url: "https://example.com", max_bytes: { nested: true } as any },
      { tool_name: "web_fetch", workspace_path: tmp, tool_def: fetchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_bytes must be a number"),
    });
    expect(await fetchTool.validateInput?.(
      { url: "https://example.com", json: { nested: true } as any },
      { tool_name: "web_fetch", workspace_path: tmp, tool_def: fetchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("json must be a boolean"),
    });
    expect(await fetchTool.validateInput?.(
      { url: "https://example.com", format: { nested: true } as any },
      { tool_name: "web_fetch", workspace_path: tmp, tool_def: fetchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("format must be a string"),
    });
  });

  it("accepts refId aliases for web_fetch validation", async () => {
    registerWebTools();
    const tool = getRegistry().lookup("web_fetch")!;
    const validation = await tool.validateInput?.(
      { refId: "ref_123", format: "markdown" },
      { tool_name: "web_fetch", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        refId: "ref_123",
        ref_id: "ref_123",
        format: "markdown",
      },
    });
  });

  it("accepts refId aliases for fetch_url validation", async () => {
    registerWebTools();
    const tool = getRegistry().lookup("fetch_url")!;
    const validation = await tool.validateInput?.(
      { refId: "ref_456", json: true },
      { tool_name: "fetch_url", workspace_path: tmp, tool_def: tool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        refId: "ref_456",
        ref_id: "ref_456",
        json: true,
      },
    });
  });

  it("links artifacts to replay targets", async () => {
    registerArtifactTools();
    const created = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "evidence", name: "e.txt", content: "proof" }));
    await getRegistry().lookup("artifact_link")!.execute({ id: created.id, scope: "turn", target_id: "session1:1" });

    expect(listArtifactLinks({ scope: "turn", target_id: "session1:1" })[0].artifact_id).toBe(created.id);
    expect(await getRegistry().lookup("artifact_links")!.execute({ scope: "turn" })).toContain(created.id);
  });

  it("accepts artifact_link alias arguments during validation", async () => {
    registerArtifactTools();
    const created = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "evidence", name: "e.txt", content: "proof" }));
    const linkTool = getRegistry().lookup("artifact_link")!;
    const validation = await linkTool.validateInput?.(
      { artifact_id: created.id, scope: "turn", target: "session1:2" },
      { tool_name: "artifact_link", workspace_path: tmp, tool_def: linkTool },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        id: created.id,
        scope: "turn",
        target_id: "session1:2",
      },
    });
  });

  it("accepts artifact_links alias filters during validation and execution", async () => {
    registerArtifactTools();
    const created = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "evidence", name: "e.txt", content: "proof" }));
    await getRegistry().lookup("artifact_link")!.execute({ id: created.id, scope: "turn", target_id: "session1:aliases" });
    const linksTool = getRegistry().lookup("artifact_links")!;

    expect(await linksTool.validateInput?.(
      { artifact_id: created.id, target: "session1:aliases" },
      { tool_name: "artifact_links", workspace_path: tmp, tool_def: linksTool },
    )).toMatchObject({
      ok: true,
      args: {
        id: created.id,
        target_id: "session1:aliases",
      },
    });

    const result = await linksTool.execute({
      artifact_id: created.id,
      target: "session1:aliases",
    } as any);

    expect(result).toContain(created.id);
    expect(result).toContain("session1:aliases");
  });

  it("rejects invalid artifact link scopes instead of persisting malformed links", async () => {
    registerArtifactTools();
    const created = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "evidence", name: "e.txt", content: "proof" }));
    const linkTool = getRegistry().lookup("artifact_link")!;

    expect(await linkTool.validateInput?.(
      { id: created.id, scope: "weird", target_id: "session1:3" },
      { tool_name: "artifact_link", workspace_path: tmp, tool_def: linkTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("scope"),
    });

    const result = await linkTool.execute({ id: created.id, scope: "weird", target_id: "session1:3" });

    expect(result).toContain("scope must be one of");
    expect(listArtifactLinks({ target_id: "session1:3" })).toEqual([]);
  });

  it("rejects non-string artifact link ids and targets instead of stringifying objects into the link index", async () => {
    registerArtifactTools();
    const linkTool = getRegistry().lookup("artifact_link")!;

    expect(await linkTool.validateInput?.(
      { id: { nested: true } as any, scope: "turn", target_id: ["session1:4"] as any },
      { tool_name: "artifact_link", workspace_path: tmp, tool_def: linkTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("id and target_id"),
    });

    const result = await linkTool.execute({
      id: { nested: true } as any,
      scope: "turn",
      target_id: ["session1:4"] as any,
    });

    expect(result).toContain("id and target_id are required");
    expect(listArtifactLinks({ scope: "turn" })).toEqual([]);
  });

  it("keeps artifact index separate from artifact records and truncates large reads safely", async () => {
    registerArtifactTools();
    const first = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "log", name: "first.log", content: "a".repeat(32) }));
    const second = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "log", name: "second.log", content: "b".repeat(32) }));
    await getRegistry().lookup("artifact_link")!.execute({ id: first.id, scope: "session", target_id: "s1" });

    const listed = JSON.parse(await getRegistry().lookup("artifact_list")!.execute({ limit: 10 }));
    const read = await getRegistry().lookup("artifact_read")!.execute({ id: second.id, max_bytes: 5 });

    expect(listed.map((record: any) => record.id).sort()).toEqual([first.id, second.id].sort());
    expect(listed.every((record: any) => record.id && record.kind && record.path)).toBe(true);
    expect(read).toContain("\"truncated\": true");
    expect(read).toContain("\"total_bytes\": 32");
    expect(read.endsWith("bbbbb")).toBe(true);
  });

  it("rejects non-string artifact_create content instead of persisting coerced values", async () => {
    registerArtifactTools();

    const result = await getRegistry().lookup("artifact_create")!.execute({
      kind: "log",
      name: "bad.log",
      content: { nested: true } as any,
    });
    const listed = await getRegistry().lookup("artifact_list")!.execute({ kind: "log" });

    expect(result).toContain("content must be a string");
    expect(listed).toBe("No artifacts.");
  });

  it("rejects non-string artifact_create string fields instead of persisting coerced metadata", async () => {
    registerArtifactTools();

    expect(await getRegistry().lookup("artifact_create")!.execute({
      kind: { nested: true } as any,
      name: "bad.log",
      content: "hello",
    })).toContain("kind must be a string");
    expect(await getRegistry().lookup("artifact_create")!.execute({
      kind: "log",
      name: ["bad.log"] as any,
      content: "hello",
    })).toContain("name must be a string");
    expect(await getRegistry().lookup("artifact_create")!.execute({
      kind: "log",
      name: "bad.log",
      extension: 7 as any,
      content: "hello",
    })).toContain("extension must be a string");

    expect(await getRegistry().lookup("artifact_list")!.execute({ kind: "log" })).toBe("No artifacts.");
  });

  it("rejects blank artifact_create kind and name before the store throws", async () => {
    registerArtifactTools();
    const tool = getRegistry().lookup("artifact_create")!;

    expect(await tool.validateInput?.(
      { content: "body", kind: "   " },
      { tool_name: "artifact_create", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("kind must be a non-empty string"),
    });
    expect(await tool.validateInput?.(
      { content: "body", name: "   " },
      { tool_name: "artifact_create", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("name must be a non-empty string"),
    });

    expect(await tool.execute({ content: "body", kind: "   " })).toContain("kind must be a non-empty string");
    expect(await tool.execute({ content: "body", name: "   " })).toContain("name must be a non-empty string");
    expect(await getRegistry().lookup("artifact_list")!.execute({})).toBe("No artifacts.");
  });

  it("rejects malformed artifact metadata instead of reporting success for unreadable artifact state", async () => {
    registerArtifactTools();
    const createTool = getRegistry().lookup("artifact_create")!;
    const created = JSON.parse(await createTool.execute({
      kind: "evidence",
      name: "proof.txt",
      content: "proof",
    }));
    const linkTool = getRegistry().lookup("artifact_link")!;

    expect(await createTool.validateInput?.(
      { kind: "log", name: "bad.log", content: "hello", metadata: [] as any },
      { tool_name: "artifact_create", workspace_path: tmp, tool_def: createTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("metadata must be an object"),
    });
    expect(await linkTool.validateInput?.(
      { id: created.id, scope: "turn", target_id: "session1:meta", metadata: [] as any },
      { tool_name: "artifact_link", workspace_path: tmp, tool_def: linkTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("metadata must be an object"),
    });

    expect(await createTool.execute({
      kind: "log",
      name: "bad.log",
      content: "hello",
      metadata: [] as any,
    })).toContain("metadata must be an object");
    expect(await linkTool.execute({
      id: created.id,
      scope: "turn",
      target_id: "session1:meta",
      metadata: [] as any,
    })).toContain("metadata must be an object");
    expect(listArtifactLinks({ scope: "turn", target_id: "session1:meta" })).toEqual([]);
  });

  it("rejects non-string artifact list and link filters instead of stringifying objects into fake lookups", async () => {
    registerArtifactTools();
    const listTool = getRegistry().lookup("artifact_list")!;
    const linksTool = getRegistry().lookup("artifact_links")!;

    expect(await listTool.validateInput?.(
      { limit: "nope" },
      { tool_name: "artifact_list", workspace_path: tmp, tool_def: listTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("limit must be a number"),
    });
    expect(await getRegistry().lookup("artifact_list")!.execute({
      kind: { nested: true } as any,
    })).toContain("kind must be a string");
    expect(await getRegistry().lookup("artifact_list")!.execute({
      limit: { nested: true } as any,
    })).toContain("limit must be a number");
    expect(await getRegistry().lookup("artifact_list")!.execute({
      limit: "nope",
    })).toContain("limit must be a number");
    expect(await getRegistry().lookup("artifact_links")!.execute({
      scope: { nested: true } as any,
    })).toContain("scope must be a string");
    expect(await getRegistry().lookup("artifact_links")!.execute({
      target_id: { nested: true } as any,
    })).toContain("target_id must be a string");
    expect(await getRegistry().lookup("artifact_links")!.execute({
      id: { nested: true } as any,
    })).toContain("id must be a string");

    expect(await linksTool.validateInput?.(
      { scope: "" },
      { tool_name: "artifact_links", workspace_path: tmp, tool_def: linksTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("scope must be one of"),
    });
    expect(await linksTool.validateInput?.(
      { target_id: "   " },
      { tool_name: "artifact_links", workspace_path: tmp, tool_def: linksTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("target_id must be a non-empty string"),
    });
    expect(await linksTool.validateInput?.(
      { id: "   " },
      { tool_name: "artifact_links", workspace_path: tmp, tool_def: linksTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("id must be a non-empty string"),
    });

    expect(await linksTool.execute({ scope: "" })).toContain("scope must be one of");
    expect(await linksTool.execute({ target_id: "   " })).toContain("target_id must be a non-empty string");
    expect(await linksTool.execute({ id: "   " })).toContain("id must be a non-empty string");
  });

  it("treats whitespace-only artifact_list limits like omission instead of collapsing results to one record", async () => {
    registerArtifactTools();
    await getRegistry().lookup("artifact_create")!.execute({ kind: "log", name: "a.log", content: "a" });
    await getRegistry().lookup("artifact_create")!.execute({ kind: "log", name: "b.log", content: "b" });

    const listed = JSON.parse(await getRegistry().lookup("artifact_list")!.execute({
      limit: "   " as any,
    }));

    expect(listed).toHaveLength(2);
  });

  it("rejects non-string artifact_read ids instead of stringifying objects into fake lookups", async () => {
    registerArtifactTools();

    const result = await getRegistry().lookup("artifact_read")!.execute({ id: { nested: true } as any });

    expect(result).toContain("id is required");
  });

  it("rejects malformed artifact_read byte limits instead of coercing objects into numeric defaults", async () => {
    registerArtifactTools();
    const readTool = getRegistry().lookup("artifact_read")!;
    const created = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({
      kind: "log",
      name: "run.log",
      content: "abcdef",
    }));

    expect(await readTool.validateInput?.(
      { id: created.id, max_bytes: "nope" },
      { tool_name: "artifact_read", workspace_path: tmp, tool_def: readTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_bytes must be a number"),
    });
    const result = await getRegistry().lookup("artifact_read")!.execute({
      id: created.id,
      max_bytes: { nested: true } as any,
    });
    const stringResult = await getRegistry().lookup("artifact_read")!.execute({
      id: created.id,
      max_bytes: "nope",
    });

    expect(result).toContain("max_bytes must be a number");
    expect(stringResult).toContain("max_bytes must be a number");
  });
});

async function run(command: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  execSync(command, { cwd: tmp, stdio: "ignore" });
}

function tempPatchFiles(): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(tmpdir()).filter(name => name.startsWith("deepseek-patch-")).sort();
}

function testConfig(): Config {
  return {
    api_key: "",
    base_url: "http://localhost",
    model: "deepseek-v4-pro",
    flash_model: "deepseek-v4-flash",
    mode: "agent",
    max_tokens: 128,
    max_turns: 3,
    context_limit: 950_000,
    reasoning_effort: "off",
    rollback_enabled: false,
    cost_tracking: true,
    thinking_visible: true,
    tui_alternate_screen: "never",
    mcp_servers: [],
    skills_dir: join(tmp, "home", ".seekcode", "skills"),
    skills_registry_url: "https://example.com/skills.json",
    skills_max_install_size_bytes: 5 * 1024 * 1024,
    theme: "deepseek-dark",
    context_refresh_enabled: true,
    approval_policy: "on-request",
    sandbox_mode: "workspace-write",
    workspace_boundary: true,
    trusted_workspaces: [],
    lsp_auto_diagnostics: false,
    lsp_diagnostics_severity: "warning",
    tool_call_budget_per_turn: 80,
    tool_failure_degrade_threshold: 3,
    status_items: ["mode", "model", "workspace", "context", "cache", "tools", "elapsed", "cost", "hints"],
  };
}

function skillMd(name: string, description: string, body: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function tarGz(entries: Array<{ path: string; data: string; type?: string; linkname?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data, "utf-8");
    const type = entry.type || "0";
    const size = type === "0" ? data.length : 0;
    const header = Buffer.alloc(512, 0);
    writeTarString(header, 0, 100, entry.path);
    writeTarString(header, 100, 8, "0000644");
    writeTarString(header, 108, 8, "0000000");
    writeTarString(header, 116, 8, "0000000");
    writeTarString(header, 124, 12, size.toString(8).padStart(11, "0"));
    writeTarString(header, 136, 12, "00000000000");
    header.fill(0x20, 148, 156);
    writeTarString(header, 156, 1, type);
    if (entry.linkname) writeTarString(header, 157, 100, entry.linkname);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header);
    if (size > 0) {
      blocks.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value.slice(0, length), offset, Math.min(length, Buffer.byteLength(value)), "utf-8");
}

function tokenFlood(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index}`).join(" ");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T | PromiseLike<T>) => void } {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class FakeClient extends DeepSeekClient {
  private batches: StreamEvent[][];
  lastSignal?: AbortSignal;
  calls: Array<{ messages: any; tools: any; options?: { signal?: AbortSignal } }> = [];

  constructor(events: Array<StreamEvent | StreamEvent[]>) {
    super({ apiKey: "test", baseUrl: "http://localhost", model: "test" });
    this.batches = events.map(event => Array.isArray(event) ? event : [event]);
  }

  override async *send(messages?: any, tools?: any, options?: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
    this.lastSignal = options?.signal;
    this.calls.push({ messages, tools, options });
    const batch = this.batches.shift() ?? [];
    for (const event of batch) {
      if (options?.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      yield event;
    }
  }
}

class PromptTooLongThenOkClient extends DeepSeekClient {
  calls: Array<{ messages: any; tools: any; options?: { signal?: AbortSignal } }> = [];

  constructor() {
    super({ apiKey: "test", baseUrl: "http://localhost", model: "test" });
  }

  override async *send(messages?: any, tools?: any, options?: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
    this.calls.push({ messages, tools, options });
    if (this.calls.length === 1) {
      const error = new Error("maximum context length exceeded");
      (error as any).code = "context_length_exceeded";
      throw error;
    }
    yield { type: "done", finish_reason: "stop", usage: null, content: "recovered", reasoning_content: null, tool_calls: [] };
  }
}

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

function mcpServerScript(stateFile: string): string {
  return `
import { readFileSync } from "node:fs";
const stateFile = ${JSON.stringify(stateFile)};
function tools() {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    return (state.tools || []).map((name) => ({
      name,
      description: name + " tool",
      inputSchema: { type: "object", properties: { value: { type: "string" }, crash: { type: "boolean" } } },
    }));
  } catch {
    return [];
  }
}
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      respond(request.id, { protocolVersion: "2024-11-05", capabilities: {} });
    } else if (request.method === "tools/list") {
      respond(request.id, { tools: tools() });
    } else if (request.method === "tools/call") {
      const args = request.params?.arguments || {};
      if (args.crash) {
        console.error("mcp crash requested");
        process.exit(42);
      }
      respond(request.id, { content: [{ type: "text", text: request.params.name + ":" + JSON.stringify(args) }] });
    } else {
      respond(request.id, {});
    }
  }
});
`;
}
