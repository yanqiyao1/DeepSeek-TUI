import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { DeepSeekClient } from "../src/client/deepseek.js";
import type { StreamEvent } from "../src/client/base.js";
import type { Config } from "../src/config.js";
import { explainConfig, loadConfig, migrateProjectConfig, migrateUserConfig, validateConfig } from "../src/config.js";
import { calculateCost, getPricing, PRICING } from "../src/cost/pricing.js";
import { CostTracker } from "../src/cost/tracker.js";
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
import { applyPatch as applyAdvancedPatch, formatPatchResult } from "../src/tools/patch-advanced.js";
import { writeTextFileAtomic } from "../src/tools/atomic-write.js";
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
import { activateSkill, applySkillToUserInput, buildSkillsContext, fetchRegistrySkills, installSkill, installSkillFromArchive, scanSkills, trustSkill, uninstallSkill, updateSkill } from "../src/engine/skills.js";
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

  it("uses injected workspace paths as the default root during direct execution", async () => {
    registerFileTools();
    const workspace = join(tmp, "workspace");
    const wrongCwd = join(tmp, "wrong-cwd");
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(wrongCwd, { recursive: true });
    writeFileSync(join(workspace, "src", "note.txt"), "needle\n");
    const oldCwd = process.cwd();
    process.chdir(wrongCwd);
    try {
      const injected = { __workspace_path: workspace };
      const read = await getRegistry().lookup("read")!.execute({ ...injected, path: "src/note.txt" });
      const list = await getRegistry().lookup("ls")!.execute({ ...injected, path: "src" });
      const search = await getRegistry().lookup("search")!.execute({ ...injected, path: ".", pattern: "needle" });
      const glob = await getRegistry().lookup("glob")!.execute({ ...injected, path: ".", pattern: "src/*.txt" });
      const write = await getRegistry().lookup("write")!.execute({ ...injected, path: "src/out.txt", content: "written" });

      expect(read).toBe("needle\n");
      expect(list).toContain("note.txt");
      expect(search).toContain("src/note.txt");
      expect(glob).toContain("src/note.txt");
      expect(write).toContain("Successfully wrote");
      expect(readFileSync(join(workspace, "src", "out.txt"), "utf-8")).toBe("written");
      expect(existsSync(join(wrongCwd, "src", "out.txt"))).toBe(false);
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

  it("reports UTF-8 byte counts when writing file content", async () => {
    registerFileTools();
    const file = join(tmp, "utf8.txt");

    const write = await getRegistry().lookup("write")!.execute({ path: file, content: "你🙂\n", root: tmp });

    expect(write).toContain("Successfully wrote 8 bytes");
    expect(readFileSync(file, "utf-8")).toBe("你🙂\n");
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
    for (const [key, value] of [
      ["offset", "1.5"],
      ["offset", "1abc"],
      ["offset", "0x10"],
      ["limit", "2.5"],
      ["limit", "2abc"],
      ["limit", ""],
    ] as const) {
      expect(await readTool.validateInput?.(
        { path: file, [key]: value },
        { tool_name: "read", workspace_path: tmp, tool_def: readTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining(`${key} must be a number`),
      });
      expect(await readTool.execute({ path: file, [key]: value })).toContain(`${key} must be a number`);
    }
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

  it("rejects control characters and oversized file tool text before filesystem work", async () => {
    registerFileTools();
    const file = join(tmp, "control.txt");
    writeFileSync(file, "alpha\n");
    const readTool = getRegistry().lookup("read")!;
    const writeTool = getRegistry().lookup("write")!;
    const searchTool = getRegistry().lookup("search")!;
    const globTool = getRegistry().lookup("glob")!;

    expect(await readTool.execute({ path: `${file}\u0000`, root: tmp })).toContain("path contains unsupported control characters");
    expect(await writeTool.execute({ path: file, root: `${tmp}\u0007`, content: "x" })).toContain("root contains unsupported control characters");
    expect(await searchTool.execute({ path: tmp, pattern: "alpha\u0001" })).toContain("pattern contains unsupported control characters");
    expect(await searchTool.execute({ path: tmp, pattern: "alpha", include: "*.txt\u0002" })).toContain("include contains unsupported control characters");
    expect(await globTool.execute({ path: tmp, pattern: `${"a".repeat(2_001)}.txt` })).toContain("pattern must be 2000 characters or fewer");
    expect(await writeTool.validateInput?.(
      { path: file, content: "x".repeat(5 * 1024 * 1024 + 1) },
      { tool_name: "write", workspace_path: tmp, tool_def: writeTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("content must be 5242880 characters or fewer"),
    });
    expect(await getRegistry().lookup("edit")!.execute({
      path: file,
      old_string: "alpha\u0001",
      new_string: "beta",
      root: tmp,
    })).toContain("old_string contains unsupported control characters");
    expect(await getRegistry().lookup("edit")!.execute({
      path: file,
      old_string: "alpha",
      new_string: "x".repeat(5 * 1024 * 1024 + 1),
      root: tmp,
    })).toContain("new_string must be 5242880 characters or fewer");
    expect(readFileSync(file, "utf-8")).toBe("alpha\n");
  });

  it("bounds large file reads and edits without loading or diffing huge files", async () => {
    registerFileTools();
    const file = join(tmp, "large.txt");
    writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));

    const read = await getRegistry().lookup("read")!.execute({ path: file, root: tmp });
    const edit = await getRegistry().lookup("edit")!.execute({ path: file, old_string: "x", new_string: "y", root: tmp });
    const write = await getRegistry().lookup("write")!.execute({ path: file, content: "small", root: tmp });

    expect(read).toContain("file exceeds 5242880 bytes");
    expect(edit).toContain("file exceeds 5242880 bytes");
    expect(write).toContain("existing file exceeds 5242880 bytes");
    expect(readFileSync(file, "utf-8").length).toBe(5 * 1024 * 1024 + 1);
  });

  it("sanitizes file result paths and clamps read output windows", async () => {
    registerFileTools();
    const controlName = `bad${String.fromCharCode(7)}name.txt`;
    const file = join(tmp, controlName);
    const bigFile = join(tmp, "big.txt");
    writeFileSync(file, "needle\n");
    writeFileSync(bigFile, "x\n".repeat(25_000));

    const list = await getRegistry().lookup("ls")!.execute({ path: tmp });
    const read = await getRegistry().lookup("read")!.execute({ path: bigFile, root: tmp, limit: 100_000 });
    const search = await getRegistry().lookup("search")!.execute({ path: tmp, pattern: "needle" });
    const glob = await getRegistry().lookup("glob")!.execute({ path: tmp, pattern: "*.txt" });

    expect(list).toContain("bad name.txt");
    expect(list).not.toContain("\u0007");
    expect(read.split("\n").length).toBe(20_000);
    expect(read.length).toBeLessThanOrEqual(80_000);
    expect(search).not.toContain("\u0007");
    expect(glob).not.toContain("\u0007");
  });

  it("keeps bounded file output on grapheme boundaries", async () => {
    registerFileTools();
    const family = "👨‍👩‍👧‍👦";
    const nested = join(tmp, "bounded-output");
    mkdirSync(nested);
    for (let index = 0; index < 220; index++) {
      writeFileSync(join(nested, `file-${String(index).padStart(3, "0")}-${"x".repeat(180)}${family}.txt`), "needle\n");
    }

    const oldPath = process.env.PATH;
    process.env.PATH = join(tmp, "empty-bin-boundary");
    mkdirSync(process.env.PATH, { recursive: true });
    try {
      const glob = await getRegistry().lookup("glob")!.execute({ path: nested, pattern: "*.txt" });

      expect(glob).toContain("[truncated]");
      expect(glob).not.toContain("\u200d\n[truncated]");
      expect(hasUnpairedSurrogate(glob)).toBe(false);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("bounds JavaScript glob fallback directory scans when ripgrep is unavailable", async () => {
    registerFileTools();
    const oldPath = process.env.PATH;
    process.env.PATH = join(tmp, "empty-bin");
    mkdirSync(process.env.PATH, { recursive: true });
    try {
      for (let index = 0; index < 240; index++) {
        writeFileSync(join(tmp, `match-${String(index).padStart(3, "0")}.txt`), "x");
      }

      const result = await getRegistry().lookup("glob")!.execute({ path: tmp, pattern: "*.txt" });

      expect(result.split("\n").filter(line => line.includes("match-"))).toHaveLength(200);
      expect(result).not.toContain("match-239.txt");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
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

  it("writes through in-root symlinks only after resolving the target inside root", async () => {
    registerFileTools();
    const root = join(tmp, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "target.txt"), "old\n");
    symlinkSync(join(root, "target.txt"), join(root, "link.txt"));

    const write = await getRegistry().lookup("write")!.execute({ path: join(root, "link.txt"), content: "新\n", root });

    expect(write).toContain("Successfully wrote 4 bytes");
    expect(readFileSync(join(root, "target.txt"), "utf-8")).toBe("新\n");
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
    for (const value of ["2.5", "2abc", "0x10", ""]) {
      expect(await gitLog.validateInput?.(
        { n: value },
        { tool_name: "git_log", workspace_path: tmp, tool_def: gitLog },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("n must be a positive integer"),
      });
      expect(await gitLog.execute({ workdir: tmp, n: value })).toContain("n must be a positive integer");
    }

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

  it("rejects unsafe git text and bounds git outputs", async () => {
    registerGitTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "tracked.txt"), "old\n");
    await run("git add . && git commit -m init");
    writeFileSync(join(tmp, "tracked.txt"), `new${String.fromCharCode(7)}value\n${"x".repeat(3998)}😀tail\n${"z".repeat(250_000)}\n`);
    const gitDiff = getRegistry().lookup("git_diff")!;
    const gitStatus = getRegistry().lookup("git_status")!;
    const gitLog = getRegistry().lookup("git_log")!;

    expect(await gitStatus.validateInput?.(
      { workdir: `${tmp}\u0000` },
      { tool_name: "git_status", workspace_path: tmp, tool_def: gitStatus },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir contains unsupported control characters"),
    });
    expect(await gitDiff.validateInput?.(
      { workdir: tmp, files: "tracked.txt\u0001" },
      { tool_name: "git_diff", workspace_path: tmp, tool_def: gitDiff },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("files contains unsupported control characters"),
    });
    expect(await gitDiff.validateInput?.(
      { workdir: tmp, files: Array.from({ length: 129 }, (_, index) => `file-${index}.txt`) },
      { tool_name: "git_diff", workspace_path: tmp, tool_def: gitDiff },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("files must contain 128 entries or fewer"),
    });
    expect(await gitLog.validateInput?.(
      { workdir: tmp, n: 10_000 },
      { tool_name: "git_log", workspace_path: tmp, tool_def: gitLog },
    )).toMatchObject({
      ok: true,
      args: expect.objectContaining({ n: 200 }),
    });

    const result = await gitDiff.execute({ workdir: tmp });

    expect(result).not.toContain("\u0007");
    expect(result.length).toBeLessThanOrEqual(200_020);
    expect(result).toContain("[truncated]");
    expect(hasUnpairedSurrogate(result)).toBe(false);
    expect(result).not.toContain("\uFFFD");
  });

  it("apply_patch cleans up temp files after a failed patch", async () => {
    registerPatchTool();
    const before = tempPatchFiles();

    const result = await getRegistry().lookup("apply_patch")!.execute({ patch: "not a patch" });

    expect(result).toMatch(/Patch failed/i);
    expect(tempPatchFiles()).toEqual(before);
  });

  it("atomic text writes refuse symlink targets instead of following them", () => {
    const outside = join(tmp, "outside.txt");
    const link = join(tmp, "linked.txt");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, link);

    expect(() => writeTextFileAtomic(link, "owned\n")).toThrow(/symlink/i);
    expect(readFileSync(outside, "utf-8")).toBe("outside\n");
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

  it("rejects oversized or control-character apply_patch inputs before parsing", async () => {
    registerPatchTool();
    const tool = getRegistry().lookup("apply_patch")!;

    expect(await tool.validateInput?.(
      { patch: `diff --git a/a.txt b/a.txt\n\u0000`, workdir: tmp },
      { tool_name: "apply_patch", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("patch contains unsupported control characters"),
    });
    expect(await tool.validateInput?.(
      { patch: "x".repeat(1_000_001), workdir: tmp },
      { tool_name: "apply_patch", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("patch must be 1000000 characters or fewer"),
    });
    expect(await tool.validateInput?.(
      { patch: "diff --git a/a.txt b/a.txt\n", workdir: `${tmp}\u0001` },
      { tool_name: "apply_patch", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir contains unsupported control characters"),
    });

    expect(await tool.execute({ patch: `diff --git a/a.txt b/a.txt\n\u0002`, workdir: tmp })).toContain("patch contains unsupported control characters");
  });

  it("bounds advanced patch hunks, paths, and existing add targets", () => {
    writeFileSync(join(tmp, "exists.txt"), "old\n");
    const tooMany = Array.from({ length: 201 }, (_, index) => [
      `diff --git a/new-${index}.txt b/new-${index}.txt`,
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      `+++ b/new-${index}.txt`,
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n")).join("\n");
    const controlPath = [
      `diff --git a/bad${String.fromCharCode(7)}.txt b/bad${String.fromCharCode(7)}.txt`,
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      `+++ b/bad${String.fromCharCode(7)}.txt`,
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");
    const existing = [
      "diff --git a/exists.txt b/exists.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/exists.txt",
      "@@ -0,0 +1 @@",
      "+new",
      "",
    ].join("\n");

    expect(applyAdvancedPatch(tooMany, { workdir: tmp })[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("200 file hunks or fewer"),
    });
    expect(applyAdvancedPatch(controlPath, { workdir: tmp })[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("unsupported control characters"),
    });
    expect(applyAdvancedPatch(existing, { workdir: tmp })[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("File already exists"),
    });
    expect(readFileSync(join(tmp, "exists.txt"), "utf-8")).toBe("old\n");
  });

  it("formats patch results with sanitized bounded output", () => {
    const family = "👨‍👩‍👧‍👦";
    const formatted = formatPatchResult(Array.from({ length: 250 }, (_, index) => ({
      type: "add" as const,
      path: `bad${String.fromCharCode(7)}-${index}.txt`,
      message: `created${String.fromCharCode(7)} ${"x".repeat(599)}${family}`,
      newContent: `line-${index}\n${"y".repeat(10_000)}`,
    })));

    expect(formatted).not.toContain("\u0007");
    expect(formatted).toContain("[truncated 50 patch result(s)]");
    expect(formatted.length).toBeLessThanOrEqual(100_020);
    expect(formatted).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(formatted)).toBe(false);
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

  it("renders non-JSON custom tool results safely", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "unsafe.cjs"), [
      "module.exports = tool({",
      "  name: 'unsafe_result',",
      "  description: 'Return unusual data',",
      "  run() { const out = { count: 1n, missing: undefined, fn() {} }; out.self = out; return out; }",
      "});",
    ].join("\n"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const result = await getRegistry().lookup("unsafe_result")!.execute({});

    expect(JSON.parse(result)).toMatchObject({
      count: "1",
      missing: null,
      fn: null,
      self: "[Circular]",
    });
  });

  it("continues loading sibling custom tools after a malformed definition", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "mixed.cjs"), [
      "const bad = tool({ name: 'bad_custom', run() { return 'bad'; } });",
      "Object.defineProperty(bad, 'name', { enumerable: true, get() { throw new Error('bad name'); } });",
      "module.exports = [",
      "  bad,",
      "  tool({ name: 'good_custom', description: 'good sibling', run() { return 'good'; } })",
      "];",
    ].join("\n"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const listed = JSON.parse(await getRegistry().lookup("custom_tools")!.execute({})) as { tools: Array<{ name: string }>; errors: Array<{ error: string }> };

    expect(getRegistry().lookup("bad_custom")).toBeUndefined();
    expect(await getRegistry().lookup("good_custom")!.execute({})).toBe("good");
    expect(listed.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "good_custom" })]));
    expect(listed.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ error: expect.stringContaining("missing name") }),
    ]));
    expect(listed.errors.some(error => error.error.includes("bad name"))).toBe(false);
  });

  it("preserves readable custom validation and result fields when sibling getters throw", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "getter-result.cjs"), [
      "module.exports = tool({",
      "  name: 'getter_result',",
      "  validate() {",
      "    const args = { ok: true };",
      "    Object.defineProperty(args, 'bad', { enumerable: true, get() { throw new Error('arg getter failed'); } });",
      "    return { ok: true, args };",
      "  },",
      "  run() {",
      "    const out = { ok: true };",
      "    Object.defineProperty(out, 'bad', { enumerable: true, get() { throw new Error('result getter failed'); } });",
      "    return out;",
      "  }",
      "});",
    ].join("\n"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const tool = getRegistry().lookup("getter_result")!;
    const validation = await tool.validateInput?.({}, { tool_name: "getter_result", workspace_path: tmp, tool_def: tool });
    const result = await tool.execute({});

    expect(validation).toEqual({ ok: true, args: { ok: true, bad: "[Unreadable]" } });
    expect(JSON.parse(result)).toEqual({ ok: true, bad: "[Unreadable]" });
    expect(result).not.toContain("result getter failed");
  });

  it("bounds and sanitizes workspace-local custom tool loading", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "safe.cjs"), [
      "module.exports = tool({",
      "  name: 'safe_tool',",
      "  description: 'Safe\\u0000 description',",
      "  aliases: [' ok_alias ', 'bad alias'],",
      "  resultKind: 'html',",
      "  maxResultSizeChars: 9999999,",
      "  parameters: (() => { const schema = { type: 'object', properties: { x: { default: 1n } } }; schema.self = schema; return schema; })(),",
      "  validate() { return { ok: false, message: 'bad\\u0000 input\\n' + 'x'.repeat(3000) }; },",
      "  run() { throw new Error('boom\\u0000 failure\\n' + 'y'.repeat(3000)); }",
      "});",
    ].join("\n"));
    writeFileSync(join(tmp, ".seekcode", "tools", "large.cjs"), " ".repeat(256 * 1024 + 1));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const listed = JSON.parse(await getRegistry().lookup("custom_tools")!.execute({})) as { errors: Array<{ file: string; error: string }> };
    const tool = getRegistry().lookup("safe_tool")!;

    expect(getRegistry().lookup("ok_alias")?.name).toBe("safe_tool");
    expect(getRegistry().lookup("bad alias")).toBeUndefined();
    expect(tool.description).toBe("Safe description");
    expect(tool.resultKind).toBe("text");
    expect(tool.maxResultSizeChars).toBe(120_000);
    expect((tool.parameters.properties as any).x.default).toBe("1");
    expect(tool.parameters.self).toBe("[Circular]");
    const validation = await tool.validateInput?.({}, { tool_name: "safe_tool", workspace_path: tmp, tool_def: tool });
    expect(validation?.message).not.toContain("\u0000");
    expect(validation?.message).toHaveLength(2000);
    const result = await tool.execute({});
    expect(result).toContain("boom failure");
    expect(result).not.toContain("\u0000");
    expect(listed.errors.some(error => error.file.endsWith("large.cjs") && error.error.includes("exceeds"))).toBe(true);
  });

  it("rejects symlinked custom tool directories", async () => {
    const outside = join(tmp, "outside-tools");
    mkdirSync(join(tmp, ".seekcode"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "unsafe.cjs"), "module.exports = tool({ name: 'unsafe_tool', run() { return 'no'; } });");
    symlinkSync(outside, join(tmp, ".seekcode", "tools"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const listed = JSON.parse(await getRegistry().lookup("custom_tools")!.execute({})) as { errors: Array<{ file: string; error: string }> };

    expect(getRegistry().lookup("unsafe_tool")).toBeUndefined();
    expect(listed.errors).toEqual([
      expect.objectContaining({
        file: ".seekcode/tools",
        error: expect.stringContaining("regular directory"),
      }),
    ]);
  });

  it("fails custom validation closed when validators throw or return malformed values", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "validators.cjs"), [
      "module.exports = [",
      "  tool({ name: 'throws_validator', validate() { throw new Error('bad\\u0000 validator'); }, run() { return 'no'; } }),",
      "  tool({ name: 'malformed_validator', validate() { return { ok: 'true', args: { unsafe: true } }; }, run() { return 'no'; } })",
      "];",
    ].join("\n"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const throwsTool = getRegistry().lookup("throws_validator")!;
    const malformedTool = getRegistry().lookup("malformed_validator")!;

    const thrown = await throwsTool.validateInput?.({}, { tool_name: "throws_validator", workspace_path: tmp, tool_def: throwsTool });
    const malformed = await malformedTool.validateInput?.({}, { tool_name: "malformed_validator", workspace_path: tmp, tool_def: malformedTool });

    expect(thrown).toMatchObject({ ok: false });
    expect(thrown?.message).toContain("custom tool validation failed");
    expect(thrown?.message).not.toContain("\u0000");
    expect(malformed).toEqual({ ok: false, message: "custom tool validation failed" });
  });

  it("keeps custom aliases valid after skipping malformed entries", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "aliases.cjs"), [
      "module.exports = tool({",
      "  name: 'alias_sparse',",
      "  aliases: Array.from({ length: 40 }, (_, index) => index % 2 === 0 ? `bad alias ${index}` : `good_alias_${index}`),",
      "  run() { return 'ok'; }",
      "});",
    ].join("\n"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });

    expect(getRegistry().lookup("bad alias 0")).toBeUndefined();
    expect(getRegistry().lookup("good_alias_1")?.name).toBe("alias_sparse");
    expect(getRegistry().lookup("good_alias_39")?.name).toBe("alias_sparse");
  });

  it("treats destructive custom tools as mutating and non-concurrent", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "danger.cjs"), [
      "module.exports = tool({",
      "  name: 'danger_custom',",
      "  readOnly: true,",
      "  destructive: true,",
      "  parallelOk: true,",
      "  run() { return 'ok'; }",
      "});",
    ].join("\n"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const tool = getRegistry().lookup("danger_custom")!;

    expect(tool.readOnly).toBe(false);
    expect(tool.destructive).toBe(true);
    expect(tool.parallelOk).toBe(false);
  });

  it("bounds custom tool result shapes and sanitizes listed path text", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "shape.cjs"), [
      "module.exports = tool({",
      "  name: 'shape_tool',",
      "  parameters: { type: 'object', properties: { v: { description: 'x'.repeat(200000) } } },",
      "  validate() {",
      "    const args = {};",
      "    for (let i = 0; i < 300; i++) args['k' + i + '\\u0000'] = 'v\\u0000' + i;",
      "    return { ok: true, args };",
      "  },",
      "  run() {",
      "    const out = { text: 'a\\u0000'.repeat(90000), values: Array.from({ length: 300 }, (_, i) => i) };",
      "    let cursor = out;",
      "    for (let i = 0; i < 20; i++) { cursor.next = {}; cursor = cursor.next; }",
      "    return out;",
      "  }",
      "});",
    ].join("\n"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const listed = JSON.parse(await getRegistry().lookup("custom_tools")!.execute({})) as { tools: Array<{ file: string }> };
    const tool = getRegistry().lookup("shape_tool")!;
    const validation = await tool.validateInput?.({}, { tool_name: "shape_tool", workspace_path: tmp, tool_def: tool });
    const result = await tool.execute({});

    expect(listed.tools[0]!.file).toBe(".seekcode/tools/shape.cjs");
    expect(Object.keys(validation!.args!)).toHaveLength(257);
    expect(JSON.stringify(validation!.args)).not.toContain("\u0000");
    expect(result).toContain("[Truncated]");
    expect(result).not.toContain("\u0000");
    expect(result.length).toBeLessThanOrEqual(200_000);
  });

  it("bounds custom tool text fields on full grapheme boundaries", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "emoji.cjs"), [
      "module.exports = tool({",
      "  name: 'emoji_custom',",
      "  description: 'd'.repeat(1999) + '👨‍👩‍👧‍👦',",
      "  validate() { return { ok: false, message: 'v'.repeat(1999) + '👨‍👩‍👧‍👦' }; },",
      "  run() { return 'r'.repeat(199999) + '👨‍👩‍👧‍👦'; }",
      "});",
    ].join("\n"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const tool = getRegistry().lookup("emoji_custom")!;
    const validation = await tool.validateInput?.({}, { tool_name: "emoji_custom", workspace_path: tmp, tool_def: tool });
    const result = await tool.execute({});

    for (const text of [tool.description, validation?.message || "", result]) {
      expect(text).not.toContain("👨‍👩‍👧‍👦");
      expect(text).not.toContain("\u200d");
      expect(hasUnpairedSurrogate(text)).toBe(false);
    }
    expect(tool.description.length).toBeLessThanOrEqual(2000);
    expect(validation?.message?.length).toBeLessThanOrEqual(2000);
    expect(result.length).toBeLessThanOrEqual(200_000);
  });

  it("bounds custom tool arrays, schemas, aliases, and validator success payloads", async () => {
    mkdirSync(join(tmp, ".seekcode", "tools"), { recursive: true });
    writeFileSync(join(tmp, ".seekcode", "tools", "many.cjs"), [
      "module.exports = Array.from({ length: 120 }, (_, index) => tool({",
      "  name: `array_tool_${index}`,",
      "  aliases: Array.from({ length: 80 }, (_, alias) => `array_tool_${index}_alias_${alias}`),",
      "  parameters: { type: 'object', properties: { huge: { description: 'x'.repeat(90000) } } },",
      "  validate() {",
      "    const clean = { safe: true, skip: undefined };",
      "    clean.self = clean;",
      "    return { ok: true, args: clean, message: 'ignored\\u0000 success', extra: 'x'.repeat(5000) };",
      "  },",
      "  run() { return 'ok'; }",
      "}));",
    ].join("\n"));

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const listed = JSON.parse(await getRegistry().lookup("custom_tools")!.execute({})) as { tools: Array<{ name: string }> };
    const first = getRegistry().lookup("array_tool_0")!;
    const validation = await first.validateInput?.({}, { tool_name: "array_tool_0", workspace_path: tmp, tool_def: first });

    expect(listed.tools).toHaveLength(100);
    expect(getRegistry().lookup("array_tool_99")).toBeTruthy();
    expect(getRegistry().lookup("array_tool_100")).toBeUndefined();
    expect(first.parameters).toEqual({ type: "object", properties: {} });
    expect(getRegistry().lookup("array_tool_0_alias_31")?.name).toBe("array_tool_0");
    expect(getRegistry().lookup("array_tool_0_alias_32")).toBeUndefined();
    expect(validation).toEqual({
      ok: true,
      args: { safe: true, self: "[Circular]" },
    });
  });

  it("skips symlinked custom tools and stops after the custom tool limit", async () => {
    const toolsDir = join(tmp, ".seekcode", "tools");
    mkdirSync(toolsDir, { recursive: true });
    const outside = join(tmp, "outside.cjs");
    writeFileSync(outside, "module.exports = tool({ name: 'outside_tool', run() { return 'no'; } });");
    symlinkSync(outside, join(toolsDir, "linked.cjs"));
    for (let index = 0; index < 101; index++) {
      writeFileSync(join(toolsDir, `tool_${String(index).padStart(3, "0")}.cjs`), `module.exports = tool({ name: 'bulk_${index}', run() { return 'ok'; } });`);
    }

    registerBuiltInTools({ ...testConfig(), permissions: {} }, { clear: true, workspacePath: tmp });
    const listed = JSON.parse(await getRegistry().lookup("custom_tools")!.execute({})) as { tools: Array<{ name: string }>; errors: Array<{ file: string; error: string }> };

    expect(getRegistry().lookup("outside_tool")).toBeUndefined();
    expect(listed.errors.some(error => error.file.endsWith("linked.cjs") && error.error.includes("regular file"))).toBe(true);
    expect(listed.tools.length).toBeLessThanOrEqual(50);
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

  it("searches tools with non-JSON schemas without throwing", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { count: 1n, missing: undefined, fn: () => "ignored" },
    };
    schema.self = schema;
    getRegistry().register({
      name: "odd_schema",
      description: "Schema with unusual values",
      parameters: schema,
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => "ok",
    });

    expect(getRegistry().search("odd_schema")).toHaveLength(1);
  });

  it("keeps tool registry search text on grapheme boundaries", async () => {
    getRegistry().register({
      name: "emoji_tool",
      description: `${"d".repeat(1999)}👨‍👩‍👧‍👦 boundary helper`,
      searchHint: `${"h".repeat(1999)}👨‍👩‍👧‍👦 notebook`,
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      deferLoading: true,
      execute: async () => "ok",
    });
    registerToolSearchTool();

    const result = await getRegistry().lookup("tool_search")!.execute({ query: "emoji_tool" });

    expect(result).toContain("emoji_tool");
    expect(hasUnpairedSurrogate(result)).toBe(false);
    expect(result).not.toContain("\u200d");
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

  it("does not claim already-active or degraded tools were newly activated", async () => {
    getRegistry().register({
      name: "active_reader",
      description: "notebook active helper",
      searchHint: "notebook active",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => "ok",
    });
    getRegistry().register({
      name: "degraded_reader",
      description: "notebook degraded helper",
      searchHint: "notebook degraded",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      deferLoading: true,
      execute: async () => "ok",
    });
    getRegistry().recordCall("degraded_reader", false, 1);
    getRegistry().degradeIfUnhealthy("degraded_reader", 1);
    registerToolSearchTool();

    const result = await getRegistry().lookup("tool_search")!.execute({ query: "notebook" });

    expect(result).toContain("No inactive tools matched");
    expect(result).not.toContain("active_reader");
    expect(result).not.toContain("degraded_reader");
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
  it("sanitizes hostile client stream events before mutating conversation state", async () => {
    const contentEvent: Record<string, unknown> = { type: "content", text: "hel\u0000lo" };
    Object.defineProperty(contentEvent, "ignored", {
      enumerable: true,
      get() {
        throw new Error("content sibling getter failed");
      },
    });
    const badTextEvent: Record<string, unknown> = { type: "content" };
    Object.defineProperty(badTextEvent, "text", {
      enumerable: true,
      get() {
        throw new Error("text getter failed");
      },
    });
    const doneEvent: Record<string, unknown> = {
      type: "done",
      finish_reason: "weird",
      usage: { total_tokens: 2, prompt_tokens_details: { cached_tokens: 1 }, bad_array: [1] },
      content: "fallback",
      reasoning_content: "think\u0007",
      tool_calls: [
        { id: "bad id", name: "bad name", arguments: { path: "bad" } },
        { id: "call_1", name: "read", arguments: { path: "ok.ts" } },
      ],
    };
    Object.defineProperty(doneEvent.usage as Record<string, unknown>, "bad", {
      enumerable: true,
      get() {
        throw new Error("usage getter failed");
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      [badTextEvent as any, contentEvent as any, doneEvent as any],
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const events: EngineRuntimeEvent[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), { onRuntimeEvent: async event => { events.push(event); } });

    expect(events.filter(event => event.type === "content_delta").map(event => (event.data as any).text)).toEqual(["hel lo"]);
    expect(result.usage).toEqual({ total_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } });
    expect(result.tool_calls).toEqual([{ id: "call_1", name: "read", arguments: { path: "ok.ts" } }]);
    const assistant = session.messages.find(message => message.role === "assistant" && message.tool_calls?.length);
    expect(assistant).toMatchObject({
      content: "hel lo",
      reasoning_content: "think ",
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "ok.ts" } }],
    });
  });

  it("bounds engine stream fallback text and tool argument deltas on client event boundaries", async () => {
    const huge = "x".repeat(2_000_020);
    const hugeArgs = "a".repeat(1_000_020);
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([[
      { type: "content", text: huge } as any,
      { type: "thinking", text: `r\u0007${huge}` } as any,
      { type: "tool_call_args", index: 0, tool_call_id: "call_1", name: "read", arguments: hugeArgs } as any,
      { type: "done", finish_reason: "stop", usage: null, content: huge, reasoning_content: `r\u0007${huge}`, tool_calls: [] },
    ]]);
    const events: EngineRuntimeEvent[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), { onRuntimeEvent: async event => { events.push(event); } });

    const content = events.find(event => event.type === "content_delta")!;
    const thinking = events.find(event => event.type === "thinking_delta")!;
    const args = events.find(event => event.type === "tool_call_args")!;
    expect((content.data as any).text).toHaveLength(2_000_000);
    expect((thinking.data as any).text).toHaveLength(2_000_000);
    expect((thinking.data as any).text).not.toContain("\u0007");
    expect((args.data as any).arguments).toHaveLength(1_000_000);
  });

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

  it("keeps immutable prefix bounded text on grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const prefix = new ImmutablePrefix({
      systemPrompt: `${"s".repeat(199_999)}${family}`,
      memoryIndex: `${"m".repeat(79_999)}${family}`,
      fewShotMessages: [{
        role: "assistant",
        content: `${"c".repeat(79_999)}${family}`,
        reasoning_content: `${"r".repeat(79_999)}${family}`,
      }],
      toolSchemas: [{
        type: "function",
        function: {
          name: `${"n".repeat(63)}${family}`,
          description: `${"d".repeat(999)}${family}`,
          parameters: { type: "object", properties: { huge: { const: "p".repeat(33_000) } } },
        },
      }],
    });
    const serialized = JSON.stringify(prefix.toJSON());

    expect(serialized).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(serialized)).toBe(false);
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
    const family = "👨‍👩‍👧‍👦";
    getRegistry().register({
      name: "event_tool",
      description: "returns ok",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => { throw new Error(`${"e".repeat(199)}${family}`); },
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
    const toolResult = events.find(event => event.type === "tool_result");
    expect(toolResult).toMatchObject({
      type: "tool_result",
      data: { name: "event_tool", is_error: true },
    });
    expect(String(toolResult?.preview ?? "")).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(String(toolResult?.preview ?? ""))).toBe(false);
    expect(legacy).toEqual(expect.arrayContaining([
      "thinking:think",
      "content:call tool",
      "tool_call:event_tool",
    ]));
    const legacyPreview = legacy.find(item => item.startsWith("tool_result:event_tool:")) ?? "";
    expect(legacyPreview).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(legacyPreview)).toBe(false);
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

  it("filters unsafe artifact ids extracted from tool output before runtime replay", async () => {
    const validArtifact = "log_m123456_deadbeef00";
    getRegistry().register({
      name: "artifact_echo",
      description: "returns artifact markers",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => JSON.stringify({
        artifact_id: ` ${validArtifact} `,
        nested: { artifactId: "../secret" },
        text: "also log_m123456_deadbeef00 and bad_m123456_nothexzz",
      }),
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "artifact_echo", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const runtimeArtifactIds: string[][] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      onRuntimeItem: async (item) => {
        if (item.type === "tool_result") runtimeArtifactIds.push(item.artifact_ids || []);
      },
    });

    expect(result.artifact_ids).toEqual([validArtifact]);
    expect(runtimeArtifactIds[0]).toEqual([validArtifact]);
  });

  it("continues artifact id extraction through large JSON siblings", async () => {
    const validArtifact = "log_m123456_deadbeef00";
    getRegistry().register({
      name: "artifact_echo",
      description: "returns artifact markers",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => JSON.stringify({
        nested: { artifactId: validArtifact },
        siblings: Array.from({ length: 600 }, (_, index) => ({ ignored: index })),
      }),
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "artifact_echo", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.artifact_ids).toEqual([validArtifact]);
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

  it("filters hostile engine tool arguments before approval and hook mutation", async () => {
    let approvalArgs: Record<string, unknown> | null = null;
    let executedArgs: Record<string, unknown> | null = null;
    getRegistry().register({
      name: "ask_tool",
      description: "ask tool",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ASK,
      category: "test",
      parallelOk: false,
      validateInput: (args) => ({ ok: true, args }),
      execute: async (args) => {
        executedArgs = args;
        return "ok";
      },
    });
    const hostileArgs: Record<string, unknown> = { visible: "yes", __secret: "drop" };
    Object.defineProperty(hostileArgs, "bad", {
      enumerable: true,
      get() {
        throw new Error("tool arg getter failed");
      },
    });
    Object.defineProperty(hostileArgs, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    registerHook({
      event: "PreToolUse",
      matcher: "ask_tool",
      command: `${process.execPath} -e ${JSON.stringify(`console.log(${JSON.stringify(JSON.stringify({ decision: "approve", modified_input: { patched: "ok", __private: "drop" } }))})`)}`,
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "ask_tool", arguments: hostileArgs }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async (_toolName, args) => {
        approvalArgs = args;
        return true;
      },
    });

    expect(result.tool_results[0]).toMatchObject({ is_error: false });
    expect(approvalArgs).toEqual({ visible: "yes", patched: "ok" });
    expect(executedArgs).toMatchObject({ visible: "yes", patched: "ok", __workspace_path: tmp });
    expect(executedArgs).not.toHaveProperty("bad");
    expect(executedArgs).not.toHaveProperty("__secret");
    expect(executedArgs).not.toHaveProperty("__private");
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

  it("keeps post-edit diagnostics stable when tool args expose hostile getters", async () => {
    registerDiagnosticsTools();
    let executedArgs: Record<string, unknown> | null = null;
    getRegistry().register({
      name: "write",
      description: "write",
      parameters: { type: "object", properties: { path: {}, content: {} } },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "file",
      parallelOk: false,
      execute: async (args) => {
        executedArgs = args;
        return "write ok";
      },
    });
    const hostileArgs: Record<string, unknown> = { path: "ok.ts", content: "x" };
    Object.defineProperty(hostileArgs, "target_file", {
      enumerable: true,
      get() {
        throw new Error("target getter failed");
      },
    });
    Object.defineProperty(hostileArgs, "patch", {
      enumerable: true,
      get() {
        throw new Error("patch getter failed");
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "write", arguments: hostileArgs }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine({ ...testConfig(), lsp_auto_diagnostics: true }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results[0]).toMatchObject({ is_error: false });
    expect(result.tool_results[0].content).toContain("write ok");
    expect(executedArgs).toMatchObject({ path: "ok.ts", content: "x", __workspace_path: tmp });
    expect(executedArgs).not.toHaveProperty("target_file");
    expect(executedArgs).not.toHaveProperty("patch");
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
        { id: "call_3", name: "ok_tool", arguments: {} },
      ] },
      { type: "done", finish_reason: "stop", usage: null, content: "should not be called", reasoning_content: null, tool_calls: [] },
    ]);
    const runtimeItems: string[] = [];
    const engine = new Engine({ ...testConfig(), tool_call_budget_per_turn: 1 }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      onRuntimeItem: async (item) => { runtimeItems.push(item.type); },
    });

    expect(result.tool_calls.map(call => call.id)).toEqual(["call_1", "call_2", "call_3"]);
    expect(result.tool_results).toHaveLength(3);
    expect(result.tool_results[1]).toMatchObject({ tool_call_id: "call_2", is_error: true });
    expect(result.tool_results[1].content).toContain("tool call budget exceeded");
    expect(result.tool_results[2]).toMatchObject({ tool_call_id: "call_3", is_error: true });
    expect(result.tool_results[2].content).toContain("tool call budget exceeded");
    expect(result.tool_results[2].content).not.toContain("interrupted before tool");
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

  it("requests approval for non-JSON arguments without throwing", async () => {
    getRegistry().register({
      name: "strange_write",
      description: "strange write",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ASK,
      category: "file",
      parallelOk: false,
      execute: async () => "ok",
    });
    const args: Record<string, unknown> = { path: "inside.txt", count: 1n, fn: () => "ignored" };
    args.self = args;
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "strange_write", arguments: args }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    let approvalDescription = "";
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async (_tool, _args, description) => {
        approvalDescription = description;
        return false;
      },
    });

    expect(result.tool_results[0].is_error).toBe(true);
    expect(approvalDescription).toContain("\"count\":\"1\"");
    expect(approvalDescription).toContain("\"self\":\"[Circular]\"");
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

  it("does not produce NaN costs for non-finite or fractional token counts", () => {
    expect(calculateCost("deepseek-v4-pro", Number.NaN, 1.5, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("normalizes provider-specific model prefixes before pricing", () => {
    expect(calculateCost("accounts/fireworks/models/deepseek-v4-flash", 1_000_000, 1_000_000)).toBeCloseTo(
      calculateCost("deepseek-v4-flash", 1_000_000, 1_000_000),
      6,
    );
    expect(calculateCost("deepseek/deepseek-v4-pro", 1_000_000, 1_000_000)).toBeCloseTo(
      calculateCost("deepseek-v4-pro", 1_000_000, 1_000_000),
      6,
    );
  });

  it("normalizes noisy model ids before pricing", () => {
    const noisy = `${"x".repeat(600)}/accounts/fireworks/models/deepseek-v4-flash\u0000ignored`;
    expect(calculateCost(noisy, 1_000_000, 1_000_000)).toBeCloseTo(
      calculateCost("deepseek-v4-flash", 1_000_000, 1_000_000),
      6,
    );
    const boundaryNoisy = `${"x".repeat(506)}👨‍👩‍👧‍👦/deepseek-v4-flash`;
    expect(calculateCost(boundaryNoisy, 1_000_000, 1_000_000)).toBeCloseTo(
      calculateCost("deepseek-v4-flash", 1_000_000, 1_000_000),
      6,
    );
  });

  it("keeps cost tracker model labels on grapheme boundaries", () => {
    const tracker = new CostTracker(`${"m".repeat(5)}👨‍👩‍👧‍👦${"t".repeat(506)}`);

    expect(tracker.model).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(tracker.model)).toBe(false);
  });

  it("returns defensive pricing snapshots", () => {
    const first = getPricing("deepseek-v4-flash");
    first.inputPer1M = 999;

    expect(getPricing("deepseek-v4-flash").inputPer1M).toBe(0.07);
    expect(() => ((PRICING as any)["deepseek-v4-flash"] = { inputPer1M: 999, outputPer1M: 999 })).toThrow();
    expect(calculateCost("deepseek-v4-flash", 1_000_000, 0)).toBeCloseTo(0.07, 6);
  });

  it("bounds extreme pricing token counts and output cost", () => {
    expect(calculateCost("deepseek-v4-pro", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0)).toBeLessThanOrEqual(1_000_000_000);
    expect(calculateCost("deepseek-v4-pro", 0, 0, 0)).toBe(0);
    expect(calculateCost("deepseek-v4-pro", -1, 10, 0)).toBeCloseTo(calculateCost("deepseek-v4-pro", 0, 10, 0), 6);
  });

  it("falls back for non-string or hostile pricing model input", () => {
    const hostile = {
      toString() {
        throw new Error("model stringify failed");
      },
    };

    expect(getPricing(hostile as any)).toEqual(getPricing("deepseek-v4-pro"));
    expect(calculateCost(hostile as any, 1_000_000, 0)).toBeCloseTo(calculateCost("deepseek-v4-pro", 1_000_000, 0), 6);
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

  it("does not trust or uninstall skills through symlinked marker files", () => {
    const skillDir = join(tmp, "skills", "linked");
    const outsideTrust = join(tmp, "outside-trust.txt");
    const outsideInstall = join(tmp, "outside-install.txt");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skillMd("linked", "linked skill", "body"));
    writeFileSync(outsideTrust, "keep-trust");
    writeFileSync(outsideInstall, "{}");
    symlinkSync(outsideTrust, join(skillDir, ".trusted"));
    symlinkSync(outsideInstall, join(skillDir, ".installed-from"));

    expect(() => trustSkill("linked", { workspaceDir: tmp, skillsDir: join(tmp, "skills") })).toThrow(/non-file|replace non-file|symbolic/i);
    expect(() => uninstallSkill("linked", { skillsDir: join(tmp, "skills") })).toThrow(/missing \.installed-from/);
    expect(readFileSync(outsideTrust, "utf-8")).toBe("keep-trust");
    expect(readFileSync(outsideInstall, "utf-8")).toBe("{}");
    expect(existsSync(skillDir)).toBe(true);
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
    expect(() => installSkillFromArchive(nulBody, "x", join(tmp, "installed"))).toThrow(/control characters/);
  });

  it("rejects reserved installed marker files from skill archives", () => {
    const trusted = tarGz([
      { path: "repo-main/good/SKILL.md", data: skillMd("good", "safe skill", "body") },
      { path: "repo-main/good/.trusted", data: "trusted" },
    ]);
    const marker = tarGz([
      { path: "repo-main/good/SKILL.md", data: skillMd("good", "safe skill", "body") },
      { path: "repo-main/good/.installed-from", data: "{}" },
    ]);

    expect(() => installSkillFromArchive(trusted, "x", join(tmp, "installed"))).toThrow(/reserved skill metadata/);
    expect(() => installSkillFromArchive(marker, "x", join(tmp, "installed"))).toThrow(/reserved skill metadata/);
    expect(existsSync(join(tmp, "installed", "good"))).toBe(false);
  });

  it("bounds skill scanning, context rendering, and oversized SKILL.md files", () => {
    const skillsRoot = join(tmp, "many-skills");
    mkdirSync(skillsRoot, { recursive: true });
    for (let index = 0; index < 205; index++) {
      const dir = join(skillsRoot, `skill-${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), skillMd(`skill-${index}`, `description ${index}`, `body ${index}`));
    }
    const oversized = join(tmp, "skills", "oversized");
    mkdirSync(oversized, { recursive: true });
    writeFileSync(join(oversized, "SKILL.md"), skillMd("oversized", "too large", "x".repeat(300_000)));

    const scanned = scanSkills(tmp, process.env.HOME!, { skillsDir: skillsRoot, includeSystem: false });
    const context = scanned.skills.length ? activateSkill("skill-0", { workspaceDir: tmp, skillsDir: skillsRoot }).instruction! : "";
    const oversizeScan = scanSkills(tmp, process.env.HOME!, { skillsDir: join(tmp, "skills"), includeSystem: false });

    expect(scanned.skills).toHaveLength(200);
    expect(context).toContain("body 0");
    expect(context.length).toBeLessThan(125_000);
    expect(oversizeScan.skills.find(skill => skill.name === "oversized")).toBeUndefined();
    expect(oversizeScan.errors.some(error => error.includes("too large") || error.includes("exceeds"))).toBe(true);
  });

  it("keeps skill metadata context on grapheme boundaries", () => {
    const context = buildSkillsContext([{
      name: "emoji",
      description: `${"d".repeat(999)}👨‍👩‍👧‍👦 helper`,
      location: `${"l".repeat(4095)}👨‍👩‍👧‍👦/SKILL.md`,
      directory: tmp,
      content: "body",
      body: "body",
      enabled: true,
      scope: "workspace",
      source: "test",
      installed: false,
      trusted: false,
      system: false,
    }]);

    expect(context).toContain("emoji");
    expect(context).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(context)).toBe(false);
  });

  it("bounds skill archive entry counts and path lengths", () => {
    const tooManyEntries = tarGz([
      { path: "repo-main/good/SKILL.md", data: skillMd("good", "safe skill", "body") },
      ...Array.from({ length: 2_001 }, (_, index) => ({
        path: `repo-main/good/references/file-${index}.txt`,
        data: "x",
      })),
    ]);
    const longPath = tarGz([
      { path: "repo-main/good/SKILL.md", data: skillMd("good", "safe skill", "body") },
      { path: `${"p".repeat(155)}/${"n".repeat(100)}`, data: "x" },
    ]);

    expect(() => installSkillFromArchive(tooManyEntries, "x", join(tmp, "installed"))).toThrow(/too many entries/);
    expect(() => installSkillFromArchive(longPath, "x", join(tmp, "installed"))).toThrow(/path is too long/);
    expect(existsSync(join(tmp, "installed", "good"))).toBe(false);
  });

  it("rejects invalid skill operation names and NUL install paths", async () => {
    const archive = tarGz([
      { path: "repo-main/good/SKILL.md", data: skillMd("good", "safe skill", "body") },
    ]);

    expect(() => installSkillFromArchive(archive, "x", `${join(tmp, "installed")}\u0000bad`)).toThrow(/control characters/);
    expect(() => uninstallSkill("../good", { skillsDir: join(tmp, "installed") })).toThrow(/invalid skill name/);
    expect(() => trustSkill("../good", { workspaceDir: tmp, skillsDir: join(tmp, "installed") })).toThrow(/invalid skill name/);
    expect(() => installSkillFromArchive(archive, "x", join(tmp, "installed"), 1024, { expectedName: "../good" })).toThrow(/invalid skill name/);
    await expect(updateSkill("bad\u0000name", { skillsDir: join(tmp, "installed") })).rejects.toThrow(/invalid skill name/);
  });

  it("rejects unsafe install sources before fetching", async () => {
    const oldFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 500 });
    }) as typeof globalThis.fetch;
    try {
      await expect(installSkill("github:owner/../repo", { skillsDir: join(tmp, "installed") })).rejects.toThrow(/github source/);
      await expect(installSkill("https://user:pass@example.com/skill.tgz", { skillsDir: join(tmp, "installed") })).rejects.toThrow(/credentials/);
      await expect(installSkill("bad/name", { skillsDir: join(tmp, "installed") })).rejects.toThrow(/invalid registry skill/);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = oldFetch;
    }
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

  it("rejects installed skill markers with invalid checksum strings", async () => {
    const skillsDir = join(tmp, "installed");
    const original = tarGz([
      { path: "repo-main/original/SKILL.md", data: skillMd("original", "original skill", "body v1") },
    ]);
    const installed = installSkillFromArchive(original, "https://example.com/original.tar.gz", skillsDir);

    writeFileSync(join(installed.path, ".installed-from"), JSON.stringify({
      source: "https://example.com/original.tar.gz",
      checksum: "not-a-sha",
    }, null, 2), "utf-8");

    await expect(updateSkill("original", { skillsDir })).rejects.toThrow(/was not installed by \/skill install/i);
  });

  it("rejects oversized installed skill markers and invalid activation names", async () => {
    const skillsDir = join(tmp, "installed");
    const original = tarGz([
      { path: "repo-main/original/SKILL.md", data: skillMd("original", "original skill", "body v1") },
    ]);
    const installed = installSkillFromArchive(original, "https://example.com/original.tar.gz", skillsDir);

    writeFileSync(join(installed.path, ".installed-from"), "x".repeat(70_000), "utf-8");

    await expect(updateSkill("original", { skillsDir })).rejects.toThrow(/was not installed by \/skill install/i);
    expect(activateSkill("../bad", { workspaceDir: tmp, skillsDir }).ok).toBe(false);
  });

  it("filters malformed remote skill registry entries instead of stringifying objects into fake skill metadata", async () => {
    const registryBody = JSON.stringify({
      skills: [
        { name: "valid-skill", description: "works", source: "registry", spec: "valid-skill" },
        { name: { nested: true }, description: "bad name" },
        { name: "typed-skill", description: { nested: true }, source: ["bad"] },
        { name: "bad-source", description: "bad source", source: "bad/name", spec: "https://user:pass@example.com/archive.tgz", url: "file:///tmp/archive.tgz", repo: "../repo" },
        { name: "bad/name", description: "bad" },
        { name: "bad\u0000name", description: "bad" },
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
        { name: "bad-source", description: "bad source", source: undefined, spec: undefined, url: undefined, repo: undefined },
      ]);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("rejects malformed remote registry JSON and ignores invalid top-level object values", async () => {
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("{ nope", {
        status: 200,
        headers: { "content-length": "6" },
      })) as typeof globalThis.fetch;
      await expect(fetchRegistrySkills("https://example.com/skills.json")).rejects.toThrow(/valid JSON/);

      const registryBody = JSON.stringify({
        valid: { description: "object form", source: "github:owner/repo" },
        badArray: [{ source: "github:owner/repo" }],
        badString: "github:owner/repo",
      });
      globalThis.fetch = (async () => new Response(registryBody, {
        status: 200,
        headers: { "content-length": String(registryBody.length) },
      })) as typeof globalThis.fetch;

      expect(await fetchRegistrySkills("https://example.com/skills.json")).toEqual([
        { name: "valid", description: "object form", source: "github:owner/repo", spec: undefined, url: undefined, repo: undefined },
      ]);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("rejects unsafe registry URLs and invalid registry content lengths", async () => {
    const oldFetch = globalThis.fetch;
    try {
      await expect(fetchRegistrySkills("file:///tmp/skills.json")).rejects.toThrow(/registry URL/);
      await expect(fetchRegistrySkills("https://user:pass@example.com/skills.json")).rejects.toThrow(/credentials/);

      globalThis.fetch = (async () => new Response("{}", {
        status: 200,
        headers: { "content-length": "12.5" },
      })) as typeof globalThis.fetch;
      await expect(fetchRegistrySkills("https://example.com/skills.json")).rejects.toThrow(/content-length/);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("bounds remote skill registry entries and field lengths", async () => {
    const registryBody = JSON.stringify({
      skills: [
        { name: "valid", description: "x".repeat(2_001), source: "https://example.com/valid.tgz" },
        ...Array.from({ length: 520 }, (_, index) => ({
          name: `remote-${index}`,
          description: `remote ${index}`,
          source: `https://example.com/${index}.tgz`,
        })),
      ],
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(registryBody, {
      status: 200,
      headers: { "content-length": String(registryBody.length) },
    })) as typeof globalThis.fetch;
    try {
      const listed = await fetchRegistrySkills("https://example.com/skills.json", registryBody.length + 100);

      expect(listed).toHaveLength(500);
      expect(listed[0]).toEqual({
        name: "valid",
        description: undefined,
        source: "https://example.com/valid.tgz",
        spec: undefined,
        url: undefined,
        repo: undefined,
      });
      expect(listed.at(-1)?.name).toBe("remote-498");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("rejects invalid skill download size limits instead of silently using defaults", async () => {
    await expect(fetchRegistrySkills("https://example.com/skills.json", 0)).rejects.toThrow(/positive integer/);
    await expect(fetchRegistrySkills("https://example.com/skills.json", 512 * 1024 * 1024 + 1)).rejects.toThrow(/at most/);
    await expect(installSkill("valid", { skillsDir: join(tmp, "installed"), maxSizeBytes: -1 })).rejects.toThrow(/positive integer/);
    await expect(updateSkill("valid", { skillsDir: join(tmp, "installed"), maxSizeBytes: Number.NaN })).rejects.toThrow(/positive integer/);
  });

  it("times out stalled skill downloads with a clear error", async () => {
    vi.useFakeTimers();
    const oldFetch = globalThis.fetch;
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof globalThis.fetch;
    try {
      const pending = fetchRegistrySkills("https://example.com/skills.json");
      const expectation = expect(pending).rejects.toThrow(/download timed out after 30000ms/);
      await vi.advanceTimersByTimeAsync(30_001);
      await expectation;
    } finally {
      globalThis.fetch = oldFetch;
      vi.useRealTimers();
    }
  });

  it("rejects recursively resolving registry skill sources", async () => {
    const registryBody = JSON.stringify({
      skills: [
        { name: "loop", source: "loop" },
      ],
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(registryBody, {
      status: 200,
      headers: { "content-length": String(registryBody.length) },
    })) as typeof globalThis.fetch;
    try {
      await expect(installSkill("loop", {
        skillsDir: join(tmp, "installed"),
        registryUrl: "https://example.com/skills.json",
      })).rejects.toThrow(/recursively/);
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

  it("rejects MCP names that collapse into ambiguous local tool prefixes", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("mcp_manager")!;

    for (const name of ["bad/name", "bad.name", "1bad", "_bad", "bad name"]) {
      expect(await tool.validateInput?.(
        { action: "add", name, command: process.execPath },
        { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("name"),
      });
      expect(await tool.execute({ action: "add", name, command: process.execPath })).toContain("name is required");
    }

    const added = await tool.execute({ action: "add", name: "good-name_1", command: process.execPath });
    const listed = JSON.parse(await tool.execute({ action: "list" })) as Array<{ name: string }>;
    expect(added).toContain("good-name_1");
    expect(listed.map(item => item.name)).toEqual(["good-name_1"]);
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

  it("rejects overlong mcp_manager fields and bounds persisted server lists", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("mcp_manager")!;

    expect(await tool.validateInput?.(
      { action: "add", name: "x".repeat(90), command: process.execPath },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("name"),
    });
    expect(await tool.validateInput?.(
      { action: "add", name: "bad-env-key", command: process.execPath, env: { "BAD-NAME": "1" } },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("env contains invalid"),
    });
    expect(await tool.validateInput?.(
      { action: "add", name: "too-many-args", command: process.execPath, args: Array.from({ length: 129 }, (_, index) => `arg-${index}`) },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("args must contain"),
    });

    expect(await tool.execute({ action: "add", name: "x".repeat(90), command: process.execPath })).toContain("name is required");
    for (let index = 0; index < 70; index++) {
      await tool.execute({ action: "add", name: `srv-${index}`, command: process.execPath });
    }
    const listed = JSON.parse(await tool.execute({ action: "list" })) as Array<{ name: string }>;

    expect(listed).toHaveLength(64);
    expect(listed[0]?.name).toBe("srv-6");
    expect(listed.at(-1)?.name).toBe("srv-69");
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

  it("rejects overlong mcp_manager selectors consistently", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("mcp_manager")!;

    expect(await tool.validateInput?.(
      { action: "enable", name: "x".repeat(90) },
      { tool_name: "mcp_manager", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("name"),
    });
    expect(await tool.execute({ action: "remove", name: "x".repeat(90) })).toContain("name is required");
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

  it("filters repeated control-character MCP persisted fields without stateful regex leakage", async () => {
    registerDiagnosticsTools();
    writeUserConfigRaw({
      mcp_servers: [
        {
          name: "bad\u0000name",
          transport: "stdio",
          command: process.execPath,
        },
        {
          name: "also\u0007bad",
          transport: "stdio",
          command: process.execPath,
        },
        {
          name: "demo",
          transport: "stdio",
          command: `bad\u0000command`,
          args: ["ok", "bad\u0007arg", "also-ok"],
          env: {
            GOOD: "1",
            BAD_ONE: "bad\u0000env",
            BAD_TWO: "bad\u0007env",
          },
        },
      ],
    });

    const listed = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "list" })) as Array<{
      name: string;
      command?: string;
      args: string[];
      env: Record<string, string>;
    }>;

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "demo",
      args: ["ok", "also-ok"],
      env: { GOOD: "1" },
    });
    expect(listed[0].command).toBeUndefined();
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
    const family = "👨‍👩‍👧‍👦";
    const stderrText = `${"e".repeat(7_999)}${family}`;
    const serverFile = join(tmp, "mcp-health-fail.mjs");
    writeFileSync(serverFile, `process.stderr.write(${JSON.stringify(stderrText)}); process.exit(1);\n`);
    await getRegistry().lookup("mcp_manager")!.execute({
      action: "add",
      name: "bad",
      command: process.execPath,
      args: [serverFile],
    });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" });

    const health = await getRegistry().lookup("mcp_manager")!.execute({ action: "health", name: "bad" });
    const parsed = JSON.parse(health) as { bad?: { stderr_tail?: string } };

    expect(health).toContain("failed");
    expect(health).toContain("log_artifact_id");
    expect(parsed.bad?.stderr_tail).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(parsed.bad?.stderr_tail ?? "")).toBe(false);
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

  it("filters malformed MCP tool descriptors and content rows from stdio servers", async () => {
    registerDiagnosticsTools();
    const serverFile = join(tmp, "mcp-malformed-tools.mjs");
    writeFileSync(serverFile, `
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
      respond(request.id, {
        tools: [
          { name: "bad-name", description: "drop", inputSchema: { type: "object" } },
          { name: "kept", description: { nested: true }, inputSchema: ["bad"] },
          { nested: true }
        ]
      });
    } else if (request.method === "tools/call") {
      respond(request.id, { content: [{ type: "text", text: "ok" }, { type: "image", data: "encoded" }] });
    } else {
      respond(request.id, {});
    }
  }
});
`);

    await getRegistry().lookup("mcp_manager")!.execute({
      action: "add",
      name: "rough",
      command: process.execPath,
      args: [serverFile],
    });
    const reloaded = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" }));
    const tool = getRegistry().lookup("mcp_rough_kept");

    expect(reloaded.servers.find((server: any) => server.name === "rough")).toMatchObject({ status: "connected", tool_count: 2 });
    expect(getRegistry().lookup("mcp_rough_bad-name")).toBeUndefined();
    expect(tool).toBeTruthy();
    expect(tool!.description).toBe("[MCP:rough] kept");
    expect(tool!.parameters).toEqual({ type: "object", properties: {} });
    await expect(tool!.execute({ value: "ok" })).resolves.toBe("ok\n{\"type\":\"image\",\"data\":\"encoded\"}");
  });

  it("normalizes hostile in-memory MCP server config records before reconnecting", async () => {
    registerDiagnosticsTools();
    const serverFile = join(tmp, "mcp-hostile-config.mjs");
    writeFileSync(serverFile, mcpServerScript(join(tmp, "missing-state.json")));
    const goodArgs: any[] = ["--version", "drop"];
    Object.defineProperty(goodArgs, "1", {
      enumerable: true,
      get() {
        throw new Error("arg getter failed");
      },
    });
    const env: Record<string, unknown> = { GOOD: "value" };
    Object.defineProperty(env, "BAD", {
      enumerable: true,
      get() {
        throw new Error("env getter failed");
      },
    });
    const record: Record<string, unknown> = {
      name: "hostile",
      transport: "stdio",
      command: process.execPath,
      args: goodArgs,
      env,
      enabled: true,
    };
    Object.defineProperty(record, "url", {
      enumerable: true,
      get() {
        throw new Error("url getter failed");
      },
    });

    const manager = getMCPManager({
      model: "x",
      provider: "deepseek",
      mcp_servers: [record as any],
    } as any);

    expect(manager.list()).toEqual([
      expect.objectContaining({ name: "hostile", args: ["--version"], env: { GOOD: "value" }, status: "configured" }),
    ]);
    await expect(manager.connectOne(record as any)).resolves.toContain("failed:");
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

  it("quotes GitHub shell arguments without allowing command substitution", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, ".gitignore"), "artifacts/\nhome/\ngh-calls.log\n");
    const bin = join(tmp, "bin");
    const calls = join(tmp, "gh-calls.log");
    const marker = join(tmp, "SHOULD_NOT_EXIST");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
      "if [[ \"$1 $2\" == \"issue view\" ]]; then",
      "  printf '%s\\n' '{\"number\":42,\"title\":\"Quoted target\",\"state\":\"OPEN\",\"url\":\"https://example.invalid/42\"}'",
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
        target: `42$(touch ${marker})`,
        body: `hello$(touch ${marker})`,
        workdir: tmp,
      });

      expect(result).toContain("comment created");
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(calls, "utf-8")).toContain(`42$(touch ${marker})`);
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

  it("rejects non-string GitHub mutation text before shell command construction", async () => {
    registerDiagnosticsTools();
    const commentTool = getRegistry().lookup("github_comment")!;
    const closeTool = getRegistry().lookup("github_close_issue")!;

    expect(await commentTool.validateInput?.(
      { target: "42", body: { nested: true } as any, workdir: tmp },
      { tool_name: "github_comment", workspace_path: tmp, tool_def: commentTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("body must be a string"),
    });
    expect(await closeTool.validateInput?.(
      { issue: "42", reason: { nested: true } as any, workdir: tmp },
      { tool_name: "github_close_issue", workspace_path: tmp, tool_def: closeTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("reason must be a string"),
    });

    expect(await commentTool.execute({ target: "42", body: { nested: true } as any, workdir: tmp })).toContain("body must be a string");
    expect(await closeTool.execute({ issue: "42", reason: { nested: true } as any, workdir: tmp })).toContain("reason must be a string");
  });

  it("rejects unsafe GitHub and PR attempt scalar arguments", async () => {
    registerDiagnosticsTools();
    const issueTool = getRegistry().lookup("github_issue_context")!;
    const prTool = getRegistry().lookup("github_pr_context")!;
    const commentTool = getRegistry().lookup("github_comment")!;
    const closeTool = getRegistry().lookup("github_close_issue")!;
    const gateTool = getRegistry().lookup("pr_attempt_gate")!;
    const readTool = getRegistry().lookup("pr_attempt_read")!;
    const draftTool = getRegistry().lookup("pr_attempt_push_draft")!;

    expect(await issueTool.validateInput?.(
      { issue: "77\u0000", workdir: tmp },
      { tool_name: "github_issue_context", workspace_path: tmp, tool_def: issueTool },
    )).toMatchObject({ ok: false, message: expect.stringContaining("issue, number, or url is required") });
    expect(await prTool.validateInput?.(
      { pr: "91", diff: "yes" as any, workdir: tmp },
      { tool_name: "github_pr_context", workspace_path: tmp, tool_def: prTool },
    )).toMatchObject({ ok: false, message: expect.stringContaining("diff must be a boolean") });
    expect(await commentTool.validateInput?.(
      { target: "42", body: "hello", allow_dirty: "yes" as any, workdir: tmp },
      { tool_name: "github_comment", workspace_path: tmp, tool_def: commentTool },
    )).toMatchObject({ ok: false, message: expect.stringContaining("allow_dirty must be a boolean") });
    expect(await closeTool.validateInput?.(
      { issue: "42", reason: "done", allow_dirty: "yes" as any, workdir: tmp },
      { tool_name: "github_close_issue", workspace_path: tmp, tool_def: closeTool },
    )).toMatchObject({ ok: false, message: expect.stringContaining("allow_dirty must be a boolean") });
    expect(await gateTool.validateInput?.(
      { command: `echo ${"x".repeat(20_001)}`, workdir: tmp },
      { tool_name: "pr_attempt_gate", workspace_path: tmp, tool_def: gateTool },
    )).toMatchObject({ ok: false, message: expect.stringContaining("command must be 20000 characters or fewer") });
    expect(await readTool.validateInput?.(
      { id: "../secret" },
      { tool_name: "pr_attempt_read", workspace_path: tmp, tool_def: readTool },
    )).toMatchObject({ ok: false, message: expect.stringContaining("id is required") });
    expect(await draftTool.validateInput?.(
      { branch: `feature/${"x".repeat(300)}`, workdir: tmp },
      { tool_name: "pr_attempt_push_draft", workspace_path: tmp, tool_def: draftTool },
    )).toMatchObject({ ok: false, message: expect.stringContaining("branch must be 256 characters or fewer") });
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
      message: expect.stringContaining("command must be a string"),
    });

    expect(await getRegistry().lookup("pr_attempt_gate")!.execute({
      gate: { nested: true } as any,
      workdir: tmp,
    })).toContain("command must be a string");
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
    expect(await draftTool.validateInput?.(
      { workdir: tmp, title: "   " },
      { tool_name: "pr_attempt_push_draft", workspace_path: tmp, tool_def: draftTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("title must be a non-empty string"),
    });
    expect(await draftTool.validateInput?.(
      { workdir: tmp, body: "   " },
      { tool_name: "pr_attempt_push_draft", workspace_path: tmp, tool_def: draftTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("body must be a non-empty string"),
    });
    expect(await draftTool.validateInput?.(
      { workdir: tmp, branch: "   " },
      { tool_name: "pr_attempt_push_draft", workspace_path: tmp, tool_def: draftTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("branch must be a non-empty string"),
    });
    expect(await rollbackTool.validateInput?.(
      { workdir: tmp, target: "   " },
      { tool_name: "pr_attempt_rollback", workspace_path: tmp, tool_def: rollbackTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("target must be a non-empty string"),
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
    expect(await getRegistry().lookup("pr_attempt_push_draft")!.execute({
      workdir: tmp,
      title: "   ",
    })).toContain("title must be a non-empty string");
    expect(await getRegistry().lookup("pr_attempt_push_draft")!.execute({
      workdir: tmp,
      body: "   ",
    })).toContain("body must be a non-empty string");
    expect(await getRegistry().lookup("pr_attempt_push_draft")!.execute({
      workdir: tmp,
      branch: "   ",
    })).toContain("branch must be a non-empty string");
    expect(await getRegistry().lookup("pr_attempt_rollback")!.execute({
      workdir: tmp,
      target: "   ",
    })).toContain("target must be a non-empty string");
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
    expect(await getRegistry().lookup("automation_read")!.execute({ id: { nested: true } as any })).toContain("id is required");
    expect(await getRegistry().lookup("automation_update")!.execute({ id: { nested: true } as any, prompt: "next" })).toContain("id is required");
    expect(await getRegistry().lookup("automation_run")!.execute({ id: "auto_1\u0000" })).toContain("id is required");
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

  it("bounds and sanitizes automation text before persisting records or creating tasks", async () => {
    registerDiagnosticsTools();
    const createTool = getRegistry().lookup("automation_create")!;
    const updateTool = getRegistry().lookup("automation_update")!;

    expect(await createTool.validateInput?.(
      { prompt: "bad\u0000prompt" },
      { tool_name: "automation_create", workspace_path: tmp, tool_def: createTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("prompt contains unsupported control characters"),
    });
    expect(await createTool.validateInput?.(
      { prompt: "watch branch", schedule: "daily\u0007" },
      { tool_name: "automation_create", workspace_path: tmp, tool_def: createTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("schedule contains unsupported control characters"),
    });
    expect(await createTool.validateInput?.(
      { prompt: "x".repeat(1_981) },
      { tool_name: "automation_create", workspace_path: tmp, tool_def: createTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("prompt must be 1980 characters or fewer"),
    });
    expect(await createTool.validateInput?.(
      { prompt: "watch branch", schedule: "x".repeat(1_001) },
      { tool_name: "automation_create", workspace_path: tmp, tool_def: createTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("schedule must be 1000 characters or fewer"),
    });
    expect(await createTool.execute({ prompt: "bad\u0000prompt" })).toContain("prompt contains unsupported control characters");
    expect(await createTool.execute({ prompt: "watch branch", schedule: "   " })).toContain("schedule must be a non-empty string");
    expect(await getRegistry().lookup("automation_list")!.execute({})).toBe("[]");

    const created = JSON.parse(await createTool.execute({
      prompt: "  watch release branch  ",
      schedule: "  daily  ",
    })) as { id: string; prompt: string; schedule: string };
    expect(created.prompt).toBe("watch release branch");
    expect(created.schedule).toBe("daily");

    expect(await updateTool.validateInput?.(
      { id: created.id, prompt: "bad\u0000next" },
      { tool_name: "automation_update", workspace_path: tmp, tool_def: updateTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("prompt contains unsupported control characters"),
    });
    expect(await updateTool.execute({ id: created.id, schedule: "   " })).toContain("schedule must be a non-empty string");
    expect(await updateTool.execute({ id: created.id, prompt: "x".repeat(1_981) })).toContain("prompt must be 1980 characters or fewer");

    const runResult = JSON.parse(await getRegistry().lookup("automation_run")!.execute({ id: created.id })) as { task_id: string };
    expect(runResult.task_id).toBeTruthy();
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

  it("normalizes lsp_diagnostics severity, language, and file lists before execution", async () => {
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
      const validation = await getRegistry().lookup("lsp_diagnostics")!.validateInput?.(
        { workdir: tmp, language: " Python ", min_severity: " ERROR ", files: " src/keep.py, " },
        { tool_name: "lsp_diagnostics", workspace_path: tmp, tool_def: getRegistry().lookup("lsp_diagnostics")! },
      );
      const result = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({
        workdir: tmp,
        language: " Python ",
        min_severity: " ERROR ",
        files: " src/keep.py, ",
      }));

      expect(validation).toMatchObject({ ok: true, args: { language: "python", min_severity: "error" } });
      expect(result.language).toBe("python");
      expect(result.summary).toEqual({ total: 1, by_severity: { error: 1 } });
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("bounds and sanitizes lsp_diagnostics output and parsed diagnostic fields", async () => {
    registerDiagnosticsTools();
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const fakeTsc = join(bin, "tsc");
    const family = "👨‍👩‍👧‍👦";
    const longMessage = `${"m".repeat(999)}${family}`;
    writeFileSync(fakeTsc, [
      "#!/usr/bin/env bash",
      `long_msg=${JSON.stringify(longMessage)}`,
      "long_code=$(printf '9%.0s' {1..200})",
      "for i in $(seq 1 700); do",
      "  printf 'src/keep-%s.ts(%s,%s): error TS%s: %s\\000bad\\n' \"$i\" \"$i\" \"$i\" \"$long_code\" \"$long_msg\"",
      "done",
    ].join("\n"));
    writeFileSync(join(tmp, "package.json"), "{}");
    await run(`chmod +x ${JSON.stringify(fakeTsc)}`);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const result = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({
        workdir: tmp,
        language: "typescript",
        min_severity: "all",
      }));

      expect(result.diagnostics).toHaveLength(500);
      expect(result.summary.total).toBe(500);
      expect(result.output.length).toBeLessThanOrEqual(100_000);
      expect(result.diagnostics.every((diagnostic: any) => !JSON.stringify(diagnostic).includes("\u0000"))).toBe(true);
      expect(result.diagnostics.every((diagnostic: any) => diagnostic.message.length <= 1000)).toBe(true);
      expect(result.diagnostics.every((diagnostic: any) => diagnostic.code.length <= 120)).toBe(true);
      expect(JSON.stringify(result.diagnostics)).not.toContain("\u200d");
      expect(hasUnpairedSurrogate(JSON.stringify(result))).toBe(false);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("rejects unsupported lsp_diagnostics languages during validation", async () => {
    registerDiagnosticsTools();
    const tool = getRegistry().lookup("lsp_diagnostics")!;

    expect(await tool.validateInput?.(
      { workdir: tmp, language: "ruby" },
      { tool_name: "lsp_diagnostics", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("language must be one of"),
    });
    expect(await tool.execute({ workdir: tmp, language: "ruby" })).toContain("language must be one of");
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
    expect(await getRegistry().lookup("lsp_symbols")!.execute({ file: { nested: true } as any, workdir: tmp })).toContain("file must be a string");
    expect(await getRegistry().lookup("lsp_symbols")!.execute({ path: { nested: true } as any, workdir: tmp })).toContain("path must be a string");
    expect(await definitionTool.execute({ symbol: "helper", file: { nested: true } as any, workdir: tmp })).toContain("file must be a string");
    expect(await definitionTool.execute({ symbol: "helper", path: { nested: true } as any, workdir: tmp })).toContain("path must be a string");
    expect(await hoverTool.execute({ file: { nested: true } as any, line: 1, workdir: tmp })).toContain("file must be a string");
    expect(await hoverTool.execute({ path: { nested: true } as any, line: 1, workdir: tmp })).toContain("path must be a string");
    for (const value of ["1.5", "1x", "0x10", ""]) {
      expect(await definitionTool.validateInput?.(
        { symbol: "helper", file: "src/app.ts", line: value, workdir: tmp },
        { tool_name: "lsp_definition", workspace_path: tmp, tool_def: definitionTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("line must be a positive number"),
      });
      expect(await hoverTool.validateInput?.(
        { file: "src/app.ts", line: value, workdir: tmp },
        { tool_name: "lsp_hover", workspace_path: tmp, tool_def: hoverTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("line must be a positive number"),
      });
      expect(await definitionTool.execute({ symbol: "helper", file: "src/app.ts", line: value, workdir: tmp })).toContain("line must be a positive number");
      expect(await hoverTool.execute({ file: "src/app.ts", line: value, workdir: tmp })).toContain("line must be a positive number");
    }
    for (const value of ["1.5", "1x", "0x10", "-1", ""]) {
      expect(await definitionTool.validateInput?.(
        { symbol: "helper", file: "src/app.ts", line: 1, character: value, workdir: tmp },
        { tool_name: "lsp_definition", workspace_path: tmp, tool_def: definitionTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("character must be a non-negative number"),
      });
      expect(await hoverTool.validateInput?.(
        { file: "src/app.ts", line: 1, character: value, workdir: tmp },
        { tool_name: "lsp_hover", workspace_path: tmp, tool_def: hoverTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("character must be a non-negative number"),
      });
      expect(await definitionTool.execute({ symbol: "helper", file: "src/app.ts", line: 1, character: value, workdir: tmp })).toContain("character must be a non-negative number");
      expect(await hoverTool.execute({ file: "src/app.ts", line: 1, character: value, workdir: tmp })).toContain("character must be a non-negative number");
    }
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

  it("ignores .git and node_modules in LSP fallback definitions", async () => {
    registerDiagnosticsTools();
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, ".git"), { recursive: true });
    mkdirSync(join(tmp, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(tmp, "src", "sample.ts"), "export function helper() { return 'ok'; }\n");
    writeFileSync(join(tmp, ".git", "shadow.ts"), "export function helper() { return 'git'; }\n");
    writeFileSync(join(tmp, "node_modules", "pkg", "shadow.ts"), "export function helper() { return 'pkg'; }\n");

    const definition = JSON.parse(await getRegistry().lookup("lsp_definition")!.execute({ symbol: "helper", workdir: tmp })) as { matches: Array<{ file: string }> };

    expect(definition.matches.map(item => item.file)).toEqual([join(tmp, "src", "sample.ts")]);
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

    expect(await tool.execute({ query: { nested: true } as any })).toContain("query must be a string");
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
    expect(await searchTool.validateInput?.(
      { query: "deepseek", max_results: "2abc" },
      { tool_name: "web_search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_results must be a number"),
    });
    expect(await searchTool.validateInput?.(
      { query: "deepseek", json: "maybe" },
      { tool_name: "web_search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("json must be a boolean"),
    });
    expect(await searchTool.validateInput?.(
      { search_query: [{ q: "deepseek", include_content: "maybe" }] },
      { tool_name: "web_search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("search_query include_content must be a boolean"),
    });
    expect(await searchTool.validateInput?.(
      { q: "bad\u0000query" },
      { tool_name: "web_search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("q contains unsupported control characters"),
    });
    expect(await searchTool.validateInput?.(
      { query: "deepseek", max_results: 0 },
      { tool_name: "web_search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_results must be a positive integer"),
    });
    expect(await searchTool.validateInput?.(
      { query: "deepseek", engine: "unknown" },
      { tool_name: "web_search", workspace_path: tmp, tool_def: searchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("engine must be a supported search engine"),
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
    expect(await fetchTool.validateInput?.(
      { url: "https://example.com", max_bytes: "128kb" },
      { tool_name: "web_fetch", workspace_path: tmp, tool_def: fetchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_bytes must be a number"),
    });
    expect(await fetchTool.validateInput?.(
      { url: "https://example.com", extract_text: "maybe" },
      { tool_name: "web_fetch", workspace_path: tmp, tool_def: fetchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("extract_text must be a boolean"),
    });
    expect(await fetchTool.validateInput?.(
      { url: { nested: true } as any },
      { tool_name: "web_fetch", workspace_path: tmp, tool_def: fetchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("url must be a string"),
    });
    expect(await fetchTool.validateInput?.(
      { url: "https://example.com", format: "pdf" },
      { tool_name: "web_fetch", workspace_path: tmp, tool_def: fetchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("format must be markdown, text, or raw"),
    });
    expect(await fetchTool.validateInput?.(
      { refId: "bad\u0000ref" },
      { tool_name: "web_fetch", workspace_path: tmp, tool_def: fetchTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("refId contains unsupported control characters"),
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

  it("rejects unsafe artifact ids and targets before link or lookup side effects", async () => {
    registerArtifactTools();
    const created = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "evidence", name: "e.txt", content: "proof" }));
    const linkTool = getRegistry().lookup("artifact_link")!;
    const readTool = getRegistry().lookup("artifact_read")!;
    const linksTool = getRegistry().lookup("artifact_links")!;

    expect(await linkTool.validateInput?.(
      { id: `../${created.id}`, scope: "turn", target_id: "session1:unsafe" },
      { tool_name: "artifact_link", workspace_path: tmp, tool_def: linkTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("id contains invalid characters"),
    });
    expect(await linkTool.validateInput?.(
      { id: created.id, scope: "turn", target_id: "bad\u0000target" },
      { tool_name: "artifact_link", workspace_path: tmp, tool_def: linkTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("target_id contains unsupported control characters"),
    });
    expect(await linkTool.validateInput?.(
      { id: created.id, scope: "turn", target_id: "x".repeat(257) },
      { tool_name: "artifact_link", workspace_path: tmp, tool_def: linkTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("target_id must be 256 characters or fewer"),
    });
    expect(await readTool.validateInput?.(
      { id: `../${created.id}` },
      { tool_name: "artifact_read", workspace_path: tmp, tool_def: readTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("id contains invalid characters"),
    });
    expect(await linksTool.validateInput?.(
      { artifact_id: `../${created.id}` },
      { tool_name: "artifact_links", workspace_path: tmp, tool_def: linksTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("id contains invalid characters"),
    });

    expect(await linkTool.execute({ id: `../${created.id}`, scope: "turn", target_id: "session1:unsafe" })).toContain("id contains invalid characters");
    expect(await linkTool.execute({ id: created.id, scope: "turn", target_id: "bad\u0000target" })).toContain("target_id contains unsupported control characters");
    expect(await readTool.execute({ id: `../${created.id}` })).toContain("id contains invalid characters");
    expect(await linksTool.execute({ artifact_id: `../${created.id}` })).toContain("id contains invalid characters");
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

  it("rejects unsafe artifact_create text before writing records", async () => {
    registerArtifactTools();
    const tool = getRegistry().lookup("artifact_create")!;

    expect(await tool.validateInput?.(
      { content: "body", kind: "bad\u0000kind" },
      { tool_name: "artifact_create", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("kind contains unsupported control characters"),
    });
    expect(await tool.validateInput?.(
      { content: "body", name: "bad\u0007name.txt" },
      { tool_name: "artifact_create", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("name contains unsupported control characters"),
    });
    expect(await tool.validateInput?.(
      { content: "body", extension: "bad\u0007ext" },
      { tool_name: "artifact_create", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("extension contains unsupported control characters"),
    });
    expect(await tool.validateInput?.(
      { content: "body", kind: "k".repeat(101) },
      { tool_name: "artifact_create", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("kind must be 100 characters or fewer"),
    });
    expect(await tool.validateInput?.(
      { content: "body", name: "n".repeat(256) },
      { tool_name: "artifact_create", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("name must be 255 characters or fewer"),
    });
    expect(await tool.validateInput?.(
      { content: "body", extension: "x".repeat(17) },
      { tool_name: "artifact_create", workspace_path: tmp, tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("extension must be 16 characters or fewer"),
    });

    expect(await tool.execute({ content: "body", kind: "bad\u0000kind" })).toContain("kind contains unsupported control characters");
    expect(await tool.execute({ content: "body", name: "bad\u0007name.txt" })).toContain("name contains unsupported control characters");
    expect(await tool.execute({ content: "body", extension: "bad\u0007ext" })).toContain("extension contains unsupported control characters");
    expect(await tool.execute({ content: "body", kind: "k".repeat(101) })).toContain("kind must be 100 characters or fewer");
    expect(await tool.execute({ content: "body", name: "n".repeat(256) })).toContain("name must be 255 characters or fewer");
    expect(await tool.execute({ content: "body", extension: "x".repeat(17) })).toContain("extension must be 16 characters or fewer");
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
    expect(await listTool.validateInput?.(
      { kind: "bad\u0000kind" },
      { tool_name: "artifact_list", workspace_path: tmp, tool_def: listTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("kind contains unsupported control characters"),
    });
    expect(await listTool.validateInput?.(
      { kind: "k".repeat(101) },
      { tool_name: "artifact_list", workspace_path: tmp, tool_def: listTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("kind must be 100 characters or fewer"),
    });
    expect(await getRegistry().lookup("artifact_list")!.execute({
      kind: "bad\u0000kind",
    })).toContain("kind contains unsupported control characters");
    for (const value of ["2.5", "2abc", "0x10"]) {
      expect(await listTool.validateInput?.(
        { limit: value },
        { tool_name: "artifact_list", workspace_path: tmp, tool_def: listTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("limit must be a number"),
      });
      expect(await getRegistry().lookup("artifact_list")!.execute({ limit: value })).toContain("limit must be a number");
    }
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
    for (const value of ["3.5", "3kb", "0x10", ""]) {
      expect(await readTool.validateInput?.(
        { id: created.id, max_bytes: value },
        { tool_name: "artifact_read", workspace_path: tmp, tool_def: readTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("max_bytes must be a number"),
      });
      expect(await getRegistry().lookup("artifact_read")!.execute({
        id: created.id,
        max_bytes: value,
      })).toContain("max_bytes must be a number");
    }
    expect(await readTool.validateInput?.(
      { id: created.id, max_bytes: -1 },
      { tool_name: "artifact_read", workspace_path: tmp, tool_def: readTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_bytes must be non-negative"),
    });
    expect(await getRegistry().lookup("artifact_read")!.execute({
      id: created.id,
      max_bytes: -1,
    })).toContain("max_bytes must be non-negative");
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
    const split = splitTarPath(entry.path);
    const header = Buffer.alloc(512, 0);
    writeTarString(header, 0, 100, split.name);
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
    if (split.prefix) writeTarString(header, 345, 155, split.prefix);
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

function splitTarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const index = path.lastIndexOf("/");
  if (index <= 0) return { name: path, prefix: "" };
  return { name: path.slice(index + 1), prefix: path.slice(0, index) };
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
