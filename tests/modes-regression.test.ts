import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config.js";
import { explainConfig, loadConfig, migrateProjectConfig, validateConfig } from "../src/config.js";
import { getMode } from "../src/modes/base.js";
import { checkApprovalCache, clearApprovalCache, DenialReason, getApprovalCache } from "../src/tools/approval-cache.js";
import { PermissionLevel, type ApprovalContext, type ToolDef } from "../src/tools/base.js";
import { checkCommand } from "../src/tools/exec-policy.js";
import { checkSandboxPolicy, isTrustedWorkspace } from "../src/tools/sandbox.js";

let tmp: string;
let oldHome: string | undefined;
let oldCwd: string;
let oldEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-round7-"));
  oldHome = process.env.HOME;
  oldCwd = process.cwd();
  oldEnv = snapshotEnv([
    "DEEPSEEK_MODEL",
    "DEEPSEEK_MAX_TOKENS",
    "DEEPSEEK_WEB_SEARCH_ENGINE",
    "DEEPSEEK_WEB_ALLOWED_DOMAINS",
    "DEEPSEEK_WEB_BLOCKED_DOMAINS",
    "SEEKCODE_WEB_ALLOWED_DOMAINS",
    "SEEKCODE_WEB_BLOCKED_DOMAINS",
    "DEEPSEEK_WEB_GOOGLE_API_KEY",
    "DEEPSEEK_WEB_GOOGLE_CX",
    "DEEPSEEK_WEB_EXA_API_KEY",
    "DEEPSEEK_WEB_KAGI_API_KEY",
    "DEEPSEEK_WEB_BRAVE_API_KEY",
    "DEEPSEEK_WEB_TAVILY_API_KEY",
    "DEEPSEEK_WEB_SERPER_API_KEY",
    "DEEPSEEK_WEB_SEMANTIC_SCHOLAR_API_KEY",
    "DEEPSEEK_WEB_PUBMED_API_KEY",
    "DEEPSEEK_WEB_SEARXNG_URL",
    "DEEPSEEK_WEB_PROXY",
    "DEEPSEEK_APPROVAL_POLICY",
    "DEEPSEEK_SANDBOX_MODE",
    "DEEPSEEK_WORKSPACE_BOUNDARY",
    "DEEPSEEK_TRUSTED_WORKSPACES",
  ]);
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  clearApprovalCache();
});

afterEach(() => {
  clearApprovalCache();
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  restoreEnv(oldEnv);
  rmSync(tmp, { recursive: true, force: true });
});

function tool(
  name: string,
  permission: PermissionLevel,
  category = "test",
): ToolDef {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    permission,
    category,
    parallelOk: true,
    execute: async () => `${name} ran`,
  };
}

function ctx(
  toolDef: ToolDef,
  toolName = toolDef.name,
  args: Record<string, unknown> = {},
  workspacePath = "/tmp/workspace",
): ApprovalContext {
  return {
    tool_name: toolName,
    tool_args: args,
    tool_def: toolDef,
    workspace_path: workspacePath,
  };
}

describe("interaction modes", () => {
  it("falls back to agent mode for unknown mode names", () => {
    expect(getMode("unknown").name).toBe("agent");
  });

  it("keeps plan mode limited to read/planning tools", async () => {
    const mode = getMode("plan");
    const tools = [
      tool("read", PermissionLevel.ALWAYS_ALLOW, "file"),
      tool("update_plan", PermissionLevel.ALWAYS_ALLOW, "meta"),
      tool("write", PermissionLevel.ASK, "file"),
      tool("bash", PermissionLevel.ASK, "shell"),
      tool("apply_patch", PermissionLevel.ASK, "file"),
      tool("spawn_agent", PermissionLevel.ALWAYS_ALLOW, "meta"),
      tool("custom_read", PermissionLevel.ALWAYS_ALLOW, "file"),
      tool("danger", PermissionLevel.DANGEROUS, "test"),
      tool("deny_plan", PermissionLevel.DENY_IN_PLAN, "test"),
    ];

    expect(mode.filterTools(tools).map(t => t.name)).toEqual(["read", "update_plan"]);
    await expect(mode.checkPermission(ctx(tools[0]!))).resolves.toBe(true);
    await expect(mode.checkPermission(ctx(tools[1]!))).resolves.toBe(true);
    await expect(mode.checkPermission(ctx(tools[2]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[3]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[4]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[5]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[6]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[7]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[8]!))).resolves.toBe(false);
  });

  it("rejects mismatched plan tool definitions", async () => {
    const mode = getMode("plan");
    const readTool = tool("read", PermissionLevel.ALWAYS_ALLOW, "file");

    await expect(mode.checkPermission(ctx(readTool, "write"))).resolves.toBe(false);
  });

  it("asks in agent mode unless the tool is always allowed", async () => {
    const mode = getMode("agent");
    const safeTool = tool("read", PermissionLevel.ALWAYS_ALLOW, "file");
    const askTool = tool("write", PermissionLevel.ASK, "file");
    const requestApproval = vi.fn(async () => true);

    await expect(mode.checkPermission(ctx(safeTool))).resolves.toBe(true);
    await expect(mode.checkPermission(ctx(askTool))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(askTool), { requestApproval })).resolves.toBe(true);
    expect(requestApproval).toHaveBeenCalledWith("write", {}, expect.stringContaining("write tool"));
  });

  it("auto-approves yolo mode except dangerous tools", async () => {
    const mode = getMode("yolo");
    const askTool = tool("write", PermissionLevel.ASK, "file");
    const dangerousTool = tool("danger", PermissionLevel.DANGEROUS, "test");
    const requestApproval = vi.fn(async () => false);

    await expect(mode.checkPermission(ctx(askTool))).resolves.toBe(true);
    await expect(mode.checkPermission(ctx(dangerousTool))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(dangerousTool), { requestApproval })).resolves.toBe(false);
    expect(requestApproval).toHaveBeenCalledWith("danger", {}, expect.stringContaining("DANGEROUS"));
  });

  it("keeps plan mode restricted to explicit read-only tools", () => {
    const mode = getMode("plan");
    const tools = [
      tool("web_search", PermissionLevel.ALWAYS_ALLOW, "web"),
      tool("artifact_read", PermissionLevel.ALWAYS_ALLOW, "artifact"),
      tool("artifact_create", PermissionLevel.ALWAYS_ALLOW, "artifact"),
      tool("task_create", PermissionLevel.ALWAYS_ALLOW, "task"),
      tool("exec_shell_wait", PermissionLevel.ALWAYS_ALLOW, "shell"),
      tool("tool_enable", PermissionLevel.ALWAYS_ALLOW, "meta"),
      tool("tool_search", PermissionLevel.ALWAYS_ALLOW, "meta"),
    ];

    expect(mode.filterTools(tools).map(item => item.name)).toEqual(["web_search"]);
  });

  it("lets statically read-only tools participate in plan mode", async () => {
    const mode = getMode("plan");
    const customRead = {
      ...tool("custom_index", PermissionLevel.ALWAYS_ALLOW, "file"),
      readOnly: true,
      searchHint: "custom code index",
    };
    const dynamicRead = {
      ...tool("dynamic_index", PermissionLevel.ALWAYS_ALLOW, "file"),
      readOnly: () => true,
    };

    expect(mode.filterTools([customRead, dynamicRead]).map(item => item.name)).toEqual(["custom_index"]);
    await expect(mode.checkPermission(ctx(customRead))).resolves.toBe(true);
    await expect(mode.checkPermission(ctx(dynamicRead))).resolves.toBe(false);
  });

  it("ignores hostile tool metadata getters in plan mode filters", async () => {
    const mode = getMode("plan");
    const hostile = tool("read", PermissionLevel.ALWAYS_ALLOW, "file");
    Object.defineProperty(hostile, "category", {
      enumerable: true,
      get() {
        throw new Error("category getter failed");
      },
    });

    expect(() => mode.filterTools([hostile])).not.toThrow();
    expect(mode.filterTools([hostile])).toEqual([]);
    await expect(mode.checkPermission(ctx(hostile))).resolves.toBe(false);
  });

  it("honors tool-level permission checks in agent mode", async () => {
    const mode = getMode("agent");
    const readOnlyShell = {
      ...tool("bash", PermissionLevel.ASK, "shell"),
      checkPermissions: () => ({ decision: "allow" as const, description: "read-only shell command" }),
    };

    await expect(mode.checkPermission(ctx(readOnlyShell, "bash", { command: "cat README.md" }))).resolves.toBe(true);
  });

  it("normalizes approval prompts and arguments when getters throw in agent mode", async () => {
    const mode = getMode("agent");
    const askTool = tool("write", PermissionLevel.ASK, "file");
    Object.defineProperty(askTool, "description", {
      enumerable: true,
      get() {
        throw new Error("description getter failed");
      },
    });
    const args: Record<string, unknown> = { path: "README.md", bad: "drop" };
    Object.defineProperty(args, "bad", {
      enumerable: true,
      get() {
        throw new Error("arg getter failed");
      },
    });
    const requestApproval = vi.fn(async () => true);

    await expect(mode.checkPermission(ctx(askTool, "write", args), { requestApproval })).resolves.toBe(true);
    expect(requestApproval).toHaveBeenCalledWith(
      "write",
      { path: "README.md" },
      expect.stringContaining("Arguments:"),
    );
    expect(requestApproval.mock.calls[0]?.[2]).toContain("Tool approval requested.");
    expect(requestApproval.mock.calls[0]?.[2]).not.toContain("description getter failed");
  });

  it("normalizes dangerous yolo approval prompts when tool description getters throw", async () => {
    const mode = getMode("yolo");
    const dangerousTool = tool("danger", PermissionLevel.DANGEROUS, "test");
    Object.defineProperty(dangerousTool, "description", {
      enumerable: true,
      get() {
        throw new Error("description getter failed");
      },
    });
    const requestApproval = vi.fn(async () => false);

    await expect(mode.checkPermission(ctx(dangerousTool), { requestApproval })).resolves.toBe(false);
    expect(requestApproval.mock.calls[0]?.[2]).toContain("DANGEROUS: dangerous tool");
    expect(requestApproval.mock.calls[0]?.[2]).not.toContain("description getter failed");
  });
});

describe("config precedence and migration", () => {
  it("deep-merges user, project, env, and CLI config layers", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    const projectDir = join(tmp, ".seekcode");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(userDir, "config.toml"), [
      'model = "deepseek-v4-flash"',
      "[web]",
      'search_engine = "duckduckgo"',
      'allowed_domains = ["user.example"]',
      'proxy = "http://user.proxy:8080"',
      "",
    ].join("\n"));
    writeFileSync(join(projectDir, "config.toml"), [
      'model = "deepseek-v4-pro"',
      "[web]",
      'blocked_domains = ["project-block.example"]',
      "fetch_timeout_ms = 2200",
      "",
    ].join("\n"));
    process.env.DEEPSEEK_WEB_ALLOWED_DOMAINS = "env.example";
    process.env.DEEPSEEK_WEB_GOOGLE_API_KEY = "env-google";
    process.env.DEEPSEEK_WEB_GOOGLE_CX = "env-cx";
    process.env.DEEPSEEK_WEB_EXA_API_KEY = "env-exa";
    process.env.DEEPSEEK_WEB_KAGI_API_KEY = "env-kagi";
    process.env.DEEPSEEK_WEB_BRAVE_API_KEY = "env-brave";
    process.env.DEEPSEEK_WEB_SEMANTIC_SCHOLAR_API_KEY = "env-s2";
    process.env.DEEPSEEK_WEB_PUBMED_API_KEY = "env-pubmed";
    process.env.DEEPSEEK_WEB_SEARXNG_URL = "https://env-search.example";
    process.env.DEEPSEEK_MAX_TOKENS = "999999";
    process.chdir(tmp);

    const cfg = loadConfig({ web: { search_engine: "bing" }, baseUrl: "http://cli.local/v1" });
    const explain = explainConfig({ model: "deepseek-v4-flash" });

    expect(cfg.base_url).toBe("http://cli.local/v1");
    expect(cfg.web.search_engine).toBe("bing");
    expect(cfg.web.allowed_domains).toEqual(["env.example"]);
    expect(cfg.web.blocked_domains).toEqual(["project-block.example"]);
    expect(cfg.web.google_api_key).toBe("env-google");
    expect(cfg.web.google_cx).toBe("env-cx");
    expect(cfg.web.exa_api_key).toBe("env-exa");
    expect(cfg.web.kagi_api_key).toBe("env-kagi");
    expect(cfg.web.brave_api_key).toBe("env-brave");
    expect(cfg.web.semantic_scholar_api_key).toBe("env-s2");
    expect(cfg.web.pubmed_api_key).toBe("env-pubmed");
    expect(cfg.web.searxng_url).toBe("https://env-search.example");
    expect(cfg.web.proxy).toBe("http://user.proxy:8080");
    expect(cfg.web.fetch_timeout_ms).toBe(2200);
    expect(cfg.max_tokens).toBe(262_144);
    expect(explain.conflicts.some(conflict => conflict.key === "model" && conflict.winner === "cli")).toBe(true);
  });

  it("prefers canonical SEEKCODE web env vars over legacy DEEPSEEK vars", () => {
    process.env.DEEPSEEK_WEB_ALLOWED_DOMAINS = "legacy.example";
    process.env.SEEKCODE_WEB_ALLOWED_DOMAINS = "canonical.example";
    process.env.DEEPSEEK_WEB_BLOCKED_DOMAINS = "legacy-block.example";
    process.env.SEEKCODE_WEB_BLOCKED_DOMAINS = "canonical-block.example";

    const cfg = loadConfig();

    expect(cfg.web.allowed_domains).toEqual(["canonical.example"]);
    expect(cfg.web.blocked_domains).toEqual(["canonical-block.example"]);
  });

  it("migrates sandbox and web config keys and validates invalid policies", () => {
    const projectDir = join(tmp, ".seekcode");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "config.toml"), [
      'approvalPolicy = "never"',
      'sandboxMode = "danger-full-access"',
      "workspaceBoundary = false",
      'trustedWorkspaces = ["/tmp/trusted"]',
      "[web]",
      'searchEngine = "duckduckgo"',
      "noProxy = [\"localhost\"]",
      "",
    ].join("\n"));
    process.chdir(tmp);

    const dryRun = migrateProjectConfig({ dryRun: true });
    const report = migrateProjectConfig();
    const cfg = loadConfig();

    expect(dryRun.changed).toBe(true);
    expect(report.actions.join("\n")).toContain("approvalPolicy");
    expect(report.actions.join("\n")).toContain("web.searchEngine");
    expect(cfg.approval_policy).toBe("never");
    expect(cfg.sandbox_mode).toBe("danger-full-access");
    expect(cfg.workspace_boundary).toBe(false);
    expect(cfg.trusted_workspaces).toEqual(["/tmp/trusted"]);
    expect(cfg.web.no_proxy).toEqual(["localhost"]);

    writeFileSync(join(projectDir, "config.toml"), 'approval_policy = "maybe"\n');
    expect(validateConfig().ok).toBe(false);
    expect(validateConfig().issues.some(issue => issue.key === "approval_policy")).toBe(true);
  });
});

describe("sandbox and approval policy", () => {
  it("classifies shell commands conservatively with read-only allowlist and flag checks", () => {
    expect(checkCommand("cat file | grep foo")).toMatchObject({ decision: "allow" });
    expect(checkCommand("ls -la src")).toMatchObject({ decision: "allow" });
    expect(checkCommand("git branch --list feature/*")).toMatchObject({ decision: "allow" });
    expect(checkCommand("node --version")).toMatchObject({ decision: "allow" });

    expect(checkCommand("node -e \"require('fs').writeFileSync('x','y')\"")).toMatchObject({ decision: "ask" });
    expect(checkCommand("python -c 'print(1)'")).toMatchObject({ decision: "ask" });
    expect(checkCommand("npm test")).toMatchObject({ decision: "ask" });
    expect(checkCommand("cat file > out.txt")).toMatchObject({ decision: "ask" });
    expect(checkCommand("cat $(touch owned)")).toMatchObject({ decision: "ask" });
    expect(checkCommand("find . -exec rm {} ;")).toMatchObject({ decision: "ask" });
    expect(checkCommand("git branch feature")).toMatchObject({ decision: "ask" });

    expect(checkCommand("find . -delete")).toMatchObject({ decision: "deny" });
    expect(checkCommand("rm -rf /")).toMatchObject({ decision: "deny" });
  });

  it("keeps shell policy stable across read-only, ask, and deny edge cases", () => {
    const allowCases = [
      "find src -name '*.ts' -print",
      "git diff --stat README.md",
      "tail -n 20 logs/app.log",
    ];
    const askCases = [
      "FOO=bar cat file.txt",
      "tail -f logs/app.log",
      "source ~/.bashrc",
      "git status --output=out.txt",
      "bash script.sh",
    ];
    const denyCases = [
      "chmod 777 script.sh",
      "dd if=/dev/zero of=/dev/sda",
    ];

    for (const command of allowCases) {
      expect(checkCommand(command)).toMatchObject({ decision: "allow" });
    }
    for (const command of askCases) {
      expect(checkCommand(command)).toMatchObject({ decision: "ask" });
    }
    for (const command of denyCases) {
      expect(checkCommand(command)).toMatchObject({ decision: "deny" });
    }
  });

  it("enforces workspace boundaries across root, cwd, workdir, files, and shell paths", () => {
    const config = testConfig({ workspace_boundary: true, trusted_workspaces: [tmp] });
    const writeTool = tool("write", PermissionLevel.ASK, "file");
    const bashTool = tool("bash", PermissionLevel.ASK, "shell");
    const gitTool = tool("git_diff", PermissionLevel.ALWAYS_ALLOW, "git");

    expect(checkSandboxPolicy(config, ctx(writeTool, "write", { path: "ok.txt", root: tmp }, tmp))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(config, ctx(writeTool, "write", { path: "ok.txt", root: "/tmp" }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(config, ctx(gitTool, "git_diff", { files: ["src/a.ts", "/etc/passwd"], workdir: tmp }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(config, ctx(bashTool, "bash", { command: "cat /etc/passwd", workdir: tmp }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(config, ctx(bashTool, "bash", { command: `cat ${join(tmp, "README.md")}`, workdir: tmp }, tmp))).toMatchObject({ decision: "allow" });
  });

  it("handles hostile sandbox path argument getters conservatively", () => {
    const config = testConfig({ workspace_boundary: true, trusted_workspaces: [tmp] });
    const writeTool = tool("write", PermissionLevel.ASK, "file");
    const pathArgs: Record<string, unknown> = {};
    Object.defineProperty(pathArgs, "path", {
      enumerable: true,
      get() {
        throw new Error("path getter failed");
      },
    });
    const files = ["safe.txt", "escape.txt"];
    Object.defineProperty(files, "1", {
      enumerable: true,
      get() {
        throw new Error("files getter failed");
      },
    });

    expect(() => checkSandboxPolicy(config, ctx(writeTool, "write", pathArgs, tmp))).not.toThrow();
    expect(checkSandboxPolicy(config, ctx(writeTool, "write", pathArgs, tmp))).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("invalid workspace path values"),
    });
    expect(checkSandboxPolicy(config, ctx(writeTool, "write", { files }, tmp))).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("invalid workspace path values"),
    });
  });

  it("handles hostile sandbox shell argument getters without throwing", () => {
    const config = testConfig({ workspace_boundary: true, trusted_workspaces: [tmp] });
    const bashTool = tool("bash", PermissionLevel.ASK, "shell");
    const args: Record<string, unknown> = {};
    Object.defineProperty(args, "command", {
      enumerable: true,
      get() {
        throw new Error("command getter failed");
      },
    });

    expect(() => checkSandboxPolicy(config, ctx(bashTool, "bash", args, tmp))).not.toThrow();
    expect(checkSandboxPolicy(config, ctx(bashTool, "bash", args, tmp))).toMatchObject({
      decision: "allow",
    });
  });

  it("evaluates shell relative paths against the command workdir before enforcing workspace boundary", () => {
    const workspace = join(tmp, "workspace");
    const subdir = join(workspace, "pkg", "src");
    mkdirSync(subdir, { recursive: true });
    const config = testConfig({ workspace_boundary: true, trusted_workspaces: [workspace] });
    const bashTool = tool("bash", PermissionLevel.ASK, "shell");

    expect(checkSandboxPolicy(config, ctx(
      bashTool,
      "bash",
      { command: "cat ../README.md", workdir: subdir },
      workspace,
    ))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(config, ctx(
      bashTool,
      "bash",
      { command: "cat ../../../escape.txt", workdir: subdir },
      workspace,
    ))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(config, ctx(
      bashTool,
      "bash",
      { command: "cat ../README.md", workdir: "pkg/src" },
      workspace,
    ))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(config, ctx(
      bashTool,
      "bash",
      { command: "cat ../../../escape.txt", workdir: "pkg/src" },
      workspace,
    ))).toMatchObject({ decision: "deny" });
  });

  it("allows explicit absolute workspace aliases and symlinked workspace paths without false escape denials", () => {
    const canonical = join(tmp, "canonical-workspace");
    const aliasParent = join(tmp, "aliases");
    const alias = join(aliasParent, "workspace-link");
    const nested = join(canonical, "pkg");
    mkdirSync(nested, { recursive: true });
    mkdirSync(aliasParent, { recursive: true });
    symlinkSync(canonical, alias, "dir");
    const config = testConfig({ workspace_boundary: true, trusted_workspaces: [canonical] });
    const bashTool = tool("bash", PermissionLevel.ASK, "shell");
    const writeTool = tool("write", PermissionLevel.ASK, "file");

    expect(checkSandboxPolicy(config, ctx(
      bashTool,
      "bash",
      { command: "pwd", workdir: canonical },
      alias,
    ))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(config, ctx(
      bashTool,
      "bash",
      { command: "pwd", workdir: alias },
      canonical,
    ))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(config, ctx(
      writeTool,
      "write",
      { path: join(alias, "nested", "note.md") },
      canonical,
    ))).toMatchObject({ decision: "allow" });
  });

  it("applies approval policy, sandbox mode, and trust boundary consistently", () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    const writeTool = tool("write", PermissionLevel.ASK, "file");
    const bashTool = tool("bash", PermissionLevel.ASK, "shell");

    expect(isTrustedWorkspace(testConfig({ trusted_workspaces: ["~/trusted"] }), join(process.env.HOME!, "trusted", "repo"))).toBe(true);
    expect(checkSandboxPolicy(testConfig({ sandbox_mode: "read-only" }), ctx(writeTool, "write", { path: "x" }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(testConfig({ sandbox_mode: "read-only" }), ctx(bashTool, "bash", { command: "cat file", workdir: tmp }, tmp))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(testConfig({ sandbox_mode: "read-only" }), ctx(bashTool, "bash", { command: "cat file; rm file", workdir: tmp }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(testConfig({ sandbox_mode: "read-only" }), ctx(bashTool, "bash", { command: "node -e 'console.log(1)'", workdir: tmp }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(testConfig(), ctx(bashTool, "bash", { command: "node -e 'console.log(1)'", workdir: tmp }, tmp))).toMatchObject({ decision: "ask" });
    expect(checkSandboxPolicy(testConfig(), ctx(tool("task_create", PermissionLevel.ALWAYS_ALLOW, "task"), "task_create", { description: "run", command: "npm test", workdir: tmp }, tmp))).toMatchObject({ decision: "ask" });
    expect(checkSandboxPolicy(testConfig({ approval_policy: "untrusted", trusted_workspaces: [] }), ctx(writeTool, "write", { path: "x" }, tmp))).toMatchObject({ decision: "ask" });
    expect(checkSandboxPolicy(testConfig({ approval_policy: "untrusted", trusted_workspaces: [tmp] }), ctx(writeTool, "write", { path: "x" }, tmp))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(testConfig({ approval_policy: "never", sandbox_mode: "danger-full-access" }), ctx(bashTool, "bash", { command: "rm -rf /" }, tmp))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(testConfig({ approval_policy: "never", sandbox_mode: "workspace-write" }), ctx(bashTool, "bash", { command: "rm -rf /", workdir: tmp }, tmp))).toMatchObject({ decision: "deny" });
  });

  it("uses tool capability flags when classifying sandbox mutations", () => {
    const customWrite = {
      ...tool("custom_overwrite", PermissionLevel.ALWAYS_ALLOW, "custom"),
      destructive: true,
    };
    const customRead = {
      ...tool("custom_reader", PermissionLevel.ALWAYS_ALLOW, "custom"),
      readOnly: true,
    };

    expect(checkSandboxPolicy(testConfig({ sandbox_mode: "read-only" }), ctx(customWrite, "custom_overwrite", {}, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(testConfig({ sandbox_mode: "read-only" }), ctx(customRead, "custom_reader", {}, tmp))).toMatchObject({ decision: "allow" });
  });

  it("scopes one-shot approval cache entries by arguments, including always approvals", () => {
    const cache = getApprovalCache();

    cache.rememberApproval("write", "once", { path: "a.txt" });
    expect(checkApprovalCache("write", "ask", { path: "a.txt" })).toMatchObject({ decision: "approved" });
    expect(checkApprovalCache("write", "ask", { path: "a.txt" })).toMatchObject({ decision: "ask" });
    expect(checkApprovalCache("write", "ask", { path: "b.txt" })).toMatchObject({ decision: "ask" });

    cache.rememberDenial("write", DenialReason.USER_DENIED, { path: "danger.txt" });
    expect(checkApprovalCache("write", "ask", { path: "danger.txt" })).toMatchObject({ decision: "denied" });
    expect(checkApprovalCache("write", "ask", { path: "safe.txt" })).toMatchObject({ decision: "ask" });

    cache.rememberApproval("bash", "always", { command: "npm test" });
    expect(checkApprovalCache("bash", "ask", { command: "npm test" })).toMatchObject({ decision: "approved" });
    expect(checkApprovalCache("bash", "ask", { command: "npm run build" })).toMatchObject({ decision: "ask" });
    cache.clearTool("bash");
    expect(checkApprovalCache("bash", "ask", { command: "npm run build" })).toMatchObject({ decision: "ask" });
  });
});

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    api_key: "",
    provider: "deepseek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    flash_model: "deepseek-v4-flash",
    mode: "agent",
    max_tokens: 8192,
    max_turns: 50,
    context_limit: 1_000_000,
    reasoning_effort: "high",
    rollback_enabled: true,
    cost_tracking: true,
    thinking_visible: true,
    tui_alternate_screen: "never",
    mcp_servers: [],
    skills_dir: join(tmp, "skills"),
    skills_registry_url: "https://example.com/skills.json",
    skills_max_install_size_bytes: 5 * 1024 * 1024,
    theme: "deepseek-dark",
    context_refresh_enabled: true,
    approval_policy: "on-request",
    sandbox_mode: "workspace-write",
    workspace_boundary: true,
    trusted_workspaces: [],
    lsp_auto_diagnostics: true,
    lsp_diagnostics_severity: "warning",
    tool_call_budget_per_turn: 80,
    tool_failure_degrade_threshold: 3,
    status_items: ["mode", "model", "workspace", "context", "cache", "tools", "elapsed", "cost", "hints"],
    web: {
      enabled: true,
      mode: "live",
      search_engine: "auto",
      allowed_domains: [],
      blocked_domains: [],
      proxy: "",
      no_proxy: [],
      search_timeout_ms: 15_000,
      fetch_timeout_ms: 15_000,
      max_bytes: 1_000_000,
    },
    ...overrides,
  };
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const key of keys) {
    values[key] = process.env[key];
    delete process.env[key];
  }
  return values;
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
