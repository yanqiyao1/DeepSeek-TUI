import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { clearTaskManager } from "../src/engine/task-lifecycle.js";
import { checkApprovalCache, clearApprovalCache, DenialReason, getApprovalCache } from "../src/tools/approval-cache.js";
import { PermissionLevel, type ApprovalContext, type ToolDef } from "../src/tools/base.js";
import { addRule, checkPermission, clearAll as clearPermissionRules, forgetTool, getSessionMemory, isAlwaysAllowed, isAlwaysDenied, rememberAlwaysAllow, rememberAlwaysDeny, removeRule } from "../src/tools/permission-ruleset.js";
import { getRegistry } from "../src/tools/registry.js";
import { checkSandboxPolicy } from "../src/tools/sandbox.js";
import { registerShellTool } from "../src/tools/shell.js";
import { registerSubAgentTool } from "../src/tools/sub-agent.js";
import { registerTaskTools } from "../src/tools/tasks.js";
import { registerToolSearchTool } from "../src/tools/tool-search.js";

function tool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "test_tool",
    description: "test tool",
    parameters: { type: "object", properties: {} },
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "test",
    parallelOk: true,
    execute: async () => "ok",
    ...overrides,
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

function config(overrides: Partial<Config> = {}): Config {
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
    skills_dir: "/tmp/skills",
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
      max_results: 8,
      default_fetch_pages: false,
      fetch_timeout_ms: 10_000,
      allowed_domains: [],
      blocked_domains: [],
      google_api_key: "",
      google_cx: "",
      exa_api_key: "",
      kagi_api_key: "",
      brave_api_key: "",
      tavily_api_key: "",
      serper_api_key: "",
      semantic_scholar_api_key: "",
      pubmed_api_key: "",
      searxng_url: "",
      proxy: "",
      no_proxy: [],
      fetch_byte_limit: 1_000_000,
      cache_ttl_ms: 60_000,
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearApprovalCache();
  clearPermissionRules();
  clearTaskManager();
  getRegistry().clear();
});

afterEach(() => {
  clearApprovalCache();
  clearPermissionRules();
  clearTaskManager();
  getRegistry().clear();
});

describe("approval cache", () => {
  it("treats always-allow permissions as preapproved", () => {
    expect(checkApprovalCache("read", "always_allow", { path: "README.md" })).toEqual({ decision: "approved" });
  });

  it("normalizes argument key order for approvals and denials", () => {
    const cache = getApprovalCache();
    cache.rememberApproval("write", "once", { path: "a.txt", content: "hello" });
    expect(checkApprovalCache("write", "ask", { content: "hello", path: "a.txt" })).toMatchObject({ decision: "approved" });

    cache.rememberDenial("write", DenialReason.POLICY_DENY, { content: "bad", path: "b.txt" });
    expect(checkApprovalCache("write", "ask", { path: "b.txt", content: "bad" })).toMatchObject({ decision: "denied" });
  });

  it("tracks denial history and clears per-tool entries", () => {
    const cache = getApprovalCache();
    cache.rememberDenial("bash", DenialReason.TIMEOUT, { command: "sleep 30" });
    cache.rememberDenial("write", DenialReason.USER_DENIED, { path: "draft.txt" });

    expect(cache.getDenialCount()).toBe(2);
    expect(cache.getDenialHistory().map(item => item.toolName)).toEqual(["bash", "write"]);

    cache.clearTool("bash");
    expect(checkApprovalCache("bash", "ask", { command: "sleep 30" })).toMatchObject({ decision: "ask" });
    expect(checkApprovalCache("write", "ask", { path: "draft.txt" })).toMatchObject({ decision: "denied" });
  });
});

describe("permission rules", () => {
  it("lets pattern-specific always-allow memory override custom deny rules until forgotten", () => {
    addRule({ permission: "bash", pattern: "npm *", action: "deny" });
    rememberAlwaysAllow("bash", { command: "npm test" });

    expect(checkPermission({ toolName: "bash", toolArgs: { command: "npm test" } })).toMatchObject({ action: "allow" });
    expect(checkPermission({ toolName: "bash", toolArgs: { command: "npm run build" } })).toMatchObject({ action: "deny" });

    forgetTool("bash", { command: "npm test" });
    expect(checkPermission({ toolName: "bash", toolArgs: { command: "npm test" } })).toMatchObject({
      action: "deny",
      matchedRule: "bash:npm *",
    });
  });

  it("matches wildcard rules against explicit request patterns", () => {
    addRule({ permission: "write", pattern: "*.md", action: "allow" });

    expect(checkPermission({
      toolName: "write",
      patterns: ["docs/README.md"],
      toolArgs: { path: "docs/README.md" },
    })).toMatchObject({
      action: "allow",
      matchedRule: "write:*.md",
    });
  });

  it("uses tool-prepared matchers before falling back to string patterns", () => {
    addRule({ permission: "custom_shell", pattern: "semantic:install", action: "deny" });

    expect(checkPermission({
      toolName: "custom_shell",
      patterns: ["npm test"],
      matchesPattern: (pattern) => pattern === "semantic:install",
    })).toMatchObject({
      action: "deny",
      matchedRule: "custom_shell:semantic:install",
    });
  });

  it("tracks session-level always allow and deny sets independently", () => {
    rememberAlwaysAllow("read", { path: "README.md" });
    rememberAlwaysDeny("bash", { command: "rm -rf build" });

    expect(isAlwaysAllowed("read")).toBe(false);
    expect(isAlwaysAllowed("read", { path: "README.md" })).toBe(true);
    expect(isAlwaysDenied("bash")).toBe(false);
    expect(isAlwaysDenied("bash", { command: "rm -rf build" })).toBe(true);
    expect(getSessionMemory()).toEqual({ allow: ["read(README.md)"], deny: ["bash(rm -rf build)"] });

    forgetTool("bash", { command: "rm -rf build" });
    expect(isAlwaysDenied("bash", { command: "rm -rf build" })).toBe(false);
  });

  it("replaces duplicate custom rules and removes them cleanly", () => {
    addRule({ permission: "write", pattern: "*.ts", action: "ask" });
    addRule({ permission: "write", pattern: "*.ts", action: "deny" });

    expect(checkPermission({ toolName: "write", toolArgs: { path: "src/index.ts" } })).toMatchObject({
      action: "deny",
      matchedRule: "write:*.ts",
    });
    expect(removeRule("write", "*.ts")).toBe(true);
    expect(checkPermission({ toolName: "write", toolArgs: { path: "src/index.ts" } }).action).toBe("ask");
  });
});

describe("agent profiles", () => {
  it("lists specialized profiles and rejects unknown spawn_agent profiles", async () => {
    registerSubAgentTool();
    const profiles = JSON.parse(await getRegistry().lookup("agent_profiles")!.execute({})) as Array<{ name: string; permissionPolicy: string }>;
    const spawn = getRegistry().lookup("spawn_agent")!;

    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "build", permissionPolicy: "build" }),
      expect.objectContaining({ name: "explore", permissionPolicy: "read-only" }),
      expect.objectContaining({ name: "scout", permissionPolicy: "read-only" }),
    ]));
    expect(await spawn.validateInput?.(
      { task: "inspect", profile: "missing" },
      { tool_name: "spawn_agent", workspace_path: "/tmp/workspace", tool_def: spawn },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("unknown profile"),
    });
  });
});

describe("sandbox policy", () => {
  it("expands home-relative trusted workspaces", () => {
    const oldHome = process.env.HOME;
    process.env.HOME = "/tmp/home-user";
    try {
      const result = checkSandboxPolicy(
        config({ approval_policy: "untrusted", trusted_workspaces: ["~/trusted"] }),
        ctx(tool({ name: "write", destructive: true }), "write", { path: "a.txt" }, "/tmp/home-user/trusted/project"),
      );

      expect(result).toMatchObject({ decision: "allow" });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it("denies shell commands whose option values resolve outside the workspace", () => {
    const result = checkSandboxPolicy(
      config({ workspace_boundary: true }),
      ctx(tool({ name: "bash", category: "shell" }), "bash", {
        command: "rg --glob ../../secret/*.ts needle src",
        workdir: "/tmp/workspace/src",
      }, "/tmp/workspace"),
    );

    expect(result).toMatchObject({ decision: "deny" });
    expect(result.reason).toContain("shell command escapes workspace boundary");
  });

  it("permits shell commands whose option values stay inside the workspace", () => {
    const result = checkSandboxPolicy(
      config({ workspace_boundary: true }),
      ctx(tool({ name: "bash", category: "shell" }), "bash", {
        command: "rg --glob ./src/*.ts needle ./src",
        workdir: "/tmp/workspace",
      }, "/tmp/workspace"),
    );

    expect(result).toMatchObject({ decision: "allow" });
  });

  it("asks for read-only shell commands in untrusted workspaces only when command policy asks", () => {
    const result = checkSandboxPolicy(
      config({ approval_policy: "untrusted", trusted_workspaces: [] }),
      ctx(tool({ name: "bash", category: "shell" }), "bash", {
        command: "npm test",
        workdir: "/tmp/workspace",
      }, "/tmp/workspace"),
    );

    expect(result).toMatchObject({ decision: "ask" });
    expect(result.reason).toContain("shell command requires approval");
  });
});

describe("tool search tools", () => {
  it("returns a clear error for blank search queries", async () => {
    registerToolSearchTool();
    expect(await getRegistry().lookup("tool_search")!.execute({ query: "   " })).toBe("Error: query is required.");
  });

  it("normalizes q aliases for tool_search validation", async () => {
    registerToolSearchTool();
    const toolSearch = getRegistry().lookup("tool_search")!;
    const validation = await toolSearch.validateInput?.(
      { q: "shell logs" },
      { tool_name: "tool_search", workspace_path: "/tmp/workspace", tool_def: toolSearch },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: { query: "shell logs" },
    });
  });

  it("rejects non-string tool_search queries instead of stringifying objects into fake searches", async () => {
    registerToolSearchTool();

    expect(await getRegistry().lookup("tool_search")!.execute({ query: { nested: true } as any })).toBe("Error: query is required.");
    const toolSearch = getRegistry().lookup("tool_search")!;
    expect(await toolSearch.validateInput?.(
      { query: { nested: true } as any },
      { tool_name: "tool_search", workspace_path: "/tmp/workspace", tool_def: toolSearch },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("query is required"),
    });
  });

  it("renders tool stats as json including inactive deferred tools", async () => {
    registerToolSearchTool();
    registerShellTool();

    const stats = JSON.parse(await getRegistry().lookup("tool_stats")!.execute({})) as Array<Record<string, unknown>>;
    const bash = stats.find(item => item.name === "bash");

    expect(bash).toMatchObject({
      name: "bash",
      active: true,
      read_only: false,
    });
  });

  it("fails cleanly when trying to re-enable an unknown tool", async () => {
    registerToolSearchTool();
    expect(await getRegistry().lookup("tool_enable")!.execute({ name: "missing_tool" })).toBe("Error: tool not found: missing_tool");
  });

  it("marks tool_enable as mutating and non-concurrent in tool stats", async () => {
    registerToolSearchTool();

    const stats = JSON.parse(await getRegistry().lookup("tool_stats")!.execute({})) as Array<Record<string, unknown>>;
    const toolEnable = stats.find(item => item.name === "tool_enable");

    expect(toolEnable).toMatchObject({
      read_only: false,
      concurrency_safe: false,
    });
  });

  it("rejects non-string tool_enable names instead of stringifying objects into fake tool ids", async () => {
    registerToolSearchTool();
    const toolEnable = getRegistry().lookup("tool_enable")!;

    expect(await toolEnable.validateInput?.(
      { name: { nested: true } as any },
      { tool_name: "tool_enable", workspace_path: "/tmp/workspace", tool_def: toolEnable },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("name is required"),
    });

    expect(await getRegistry().lookup("tool_enable")!.execute({ name: { nested: true } as any })).toBe("Error: name is required.");
  });
});

describe("task tool guards", () => {
  it("rejects empty task gate commands during validation", async () => {
    registerTaskTools();
    const toolDef = getRegistry().lookup("task_gate_run")!;

    expect(await toolDef.validateInput?.({ command: "   " }, {
      tool_name: "task_gate_run",
      workspace_path: "/tmp/workspace",
      tool_def: toolDef,
    })).toEqual({ ok: false, message: "command must be a non-empty string" });
  });
});
