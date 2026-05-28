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

  it("returns defensive denial history and lets later denials override approvals", () => {
    const cache = getApprovalCache();
    cache.rememberApproval("bash", "always");
    cache.rememberDenial("bash", DenialReason.USER_DENIED, { command: "npm test" });

    expect(checkApprovalCache("bash", "ask", { command: "npm test" })).toMatchObject({ decision: "denied" });
    const history = cache.getDenialHistory();
    history[0]!.toolName = "mutated";
    history[0]!.arguments = { command: "mutated" };

    expect(cache.getDenialHistory()[0]).toMatchObject({
      toolName: "bash",
      arguments: { command: "npm test" },
    });
  });

  it("preserves readable approval cache arguments when sibling getters throw", () => {
    const cache = getApprovalCache();
    const args: Record<string, unknown> = {
      path: "README.md",
      nested: { ok: true },
      list: ["keep", "drop", "tail"],
    };
    Object.defineProperty(args, "bad", {
      enumerable: true,
      get() {
        throw new Error("arg getter failed");
      },
    });
    Object.defineProperty(args.list as unknown[], "1", {
      enumerable: true,
      get() {
        throw new Error("array getter failed");
      },
    });

    expect(() => cache.rememberDenial("write", DenialReason.POLICY_DENY, args)).not.toThrow();
    expect(checkApprovalCache("write", "ask", {
      path: "README.md",
      nested: { ok: true },
      list: ["keep", "tail"],
    })).toMatchObject({ decision: "denied" });
    const history = cache.getDenialHistory();
    expect(history[0]?.arguments).toEqual({
      path: "README.md",
      nested: { ok: true },
      list: ["keep", "tail"],
    });
    expect(JSON.stringify(history)).not.toContain("getter failed");
  });

  it("clears approval cache entries by exact tool prefix only", () => {
    const cache = getApprovalCache();
    cache.rememberApproval("bash", "always");
    cache.rememberApproval("bash_extra", "always");
    cache.rememberDenial("bash_extra", DenialReason.USER_DENIED);

    cache.clearTool("bash");

    expect(checkApprovalCache("bash", "ask", {})).toMatchObject({ decision: "ask" });
    expect(checkApprovalCache("bash_extra", "ask", {})).toMatchObject({ decision: "denied" });
  });

  it("bounds approval cache keys, arguments, and history", () => {
    const cache = getApprovalCache();
    const family = "👨‍👩‍👧‍👦";
    const args = {
      boundary: `${"a".repeat(1_999)}${family}`,
      ...Object.fromEntries(
        Array.from({ length: 160 }, (_, index) => [`key_${index}`, `value\u0000${index}`]),
      ),
    };

    for (let index = 0; index < 300; index++) {
      cache.rememberDenial(`write\u0000${index}`, "bad" as any, args);
    }

    expect(cache.getDenialCount()).toBe(256);
    const last = cache.getDenialHistory().at(-1)!;
    expect(last.toolName).toBe("write");
    expect(last.reason).toBe(DenialReason.USER_DENIED);
    expect(last.key.length).toBeLessThanOrEqual(16_000);
    expect(last.key).not.toContain("\u0000");
    expect(Object.keys(last.arguments || {})).toHaveLength(128);
    expect(JSON.stringify(last.arguments)).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(JSON.stringify(last.arguments))).toBe(false);
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

  it("normalizes custom rules and ignores invalid custom permission rules", () => {
    addRule({ permission: " write ", pattern: " *.md ", action: "allow" });
    addRule({ permission: "write", pattern: "   ", action: "deny" });
    addRule({ permission: "write", pattern: "*.txt", action: "invalid" as any });

    expect(checkPermission({ toolName: " write ", patterns: ["docs/readme.md"] })).toMatchObject({
      action: "allow",
      matchedRule: "write:*.md",
    });
    expect(checkPermission({ toolName: "write", patterns: ["notes.txt"] }).action).toBe("ask");
    expect(removeRule(" write ", " *.md ")).toBe(true);
    expect(removeRule("write", "*.md")).toBe(false);
  });

  it("does not coerce object-valued permission arguments into matching strings", () => {
    addRule({ permission: "write", pattern: "*object*", action: "deny" });

    expect(checkPermission({ toolName: "write", toolArgs: { path: { nested: true } as any } }).action).toBe("ask");
    expect(checkPermission({ toolName: "write", toolArgs: { path: "object-file.txt" } }).action).toBe("deny");
  });

  it("does not turn malformed session permission memory into wildcard rules", () => {
    rememberAlwaysAllow("bash", { nested: { command: "npm test" } });
    rememberAlwaysDeny("write", []);

    expect(isAlwaysAllowed("bash")).toBe(false);
    expect(isAlwaysDenied("write")).toBe(false);
    expect(getSessionMemory()).toEqual({ allow: [], deny: [] });
    expect(checkPermission({ toolName: "bash", toolArgs: { command: "npm test" } })).toMatchObject({ action: "ask" });
  });

  it("normalizes permission requests and ignores malformed matchers", () => {
    addRule({ permission: "custom_shell", pattern: "semantic:install", action: "deny" });
    addRule({ permission: "write", pattern: "*.md", action: "allow" });

    expect(checkPermission({
      toolName: "custom_shell",
      patterns: ["npm test"],
      matchesPattern: "not a function" as any,
    })).toMatchObject({ action: "ask" });
    expect(checkPermission({
      toolName: "write",
      patterns: [" docs/readme.md ", { nested: true } as any, "docs/readme.md"],
      toolArgs: "bad args" as any,
    })).toMatchObject({ action: "allow", matchedRule: "write:*.md" });
  });

  it("trims session memory tool names and request patterns", () => {
    rememberAlwaysAllow(" write ", [" docs/readme.md ", "docs/readme.md"]);

    expect(isAlwaysAllowed("write", "docs/readme.md")).toBe(true);
    expect(getSessionMemory()).toEqual({ allow: ["write(docs/readme.md)"], deny: [] });

    forgetTool(" write ", " docs/readme.md ");
    expect(isAlwaysAllowed("write", "docs/readme.md")).toBe(false);
  });

  it("bounds and sanitizes permission rules, requests, and extracted patterns", () => {
    addRule({ permission: " write\nbad ", pattern: `docs/readme.md\u0000${"x".repeat(5_000)}`, action: "allow" });
    rememberAlwaysDeny("bash\u0000bad", Array.from({ length: 140 }, (_, index) => `cmd-${index}\u0000bad`));
    addRule({ permission: "write", pattern: `${"x".repeat(1999)}👨‍👩‍👧‍👦`, action: "deny" });

    expect(checkPermission({
      toolName: " write\tignored ",
      patterns: [`docs/readme.md ${"x".repeat(5_000)}`],
    })).toMatchObject({ action: "allow" });
    expect(getSessionMemory().deny).toHaveLength(128);
    expect(getSessionMemory().deny.join("\n")).not.toContain("\u0000");
    const rules = getSessionMemory().deny.join("\n") + JSON.stringify(checkPermission({
      toolName: "write",
      patterns: [`${"x".repeat(1999)}👨‍👩‍👧‍👦`],
    }));
    expect(rules).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(rules)).toBe(false);
    expect(checkPermission({
      toolName: "write",
      patterns: [`${"x".repeat(1999)}`],
    })).toMatchObject({ action: "deny" });
  });
});

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

  it("denies malformed workspace path arguments instead of ignoring them", () => {
    expect(checkSandboxPolicy(
      config({ workspace_boundary: true }),
      ctx(tool({ name: "write" }), "write", { path: { nested: true } as any }, "/tmp/workspace"),
    )).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("invalid workspace path values"),
    });
    expect(checkSandboxPolicy(
      config({ workspace_boundary: true }),
      ctx(tool({ name: "git_diff" }), "git_diff", { files: ["src/a.ts", { nested: true } as any] }, "/tmp/workspace"),
    )).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("invalid workspace path values"),
    });
  });

  it("denies shell option path values split from their flags", () => {
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

  it("uses q when query is blank during tool_search execution and validation", async () => {
    getRegistry().register(tool({
      name: "rare_shell_helper",
      description: "rare shell logs helper",
      searchHint: "shell logs",
      deferLoading: true,
    }));
    registerToolSearchTool();
    const toolSearch = getRegistry().lookup("tool_search")!;

    const validation = await toolSearch.validateInput?.(
      { query: "   ", q: "shell logs" },
      { tool_name: "tool_search", workspace_path: "/tmp/workspace", tool_def: toolSearch },
    );
    const result = await toolSearch.execute({ query: "   ", q: "shell logs" });

    expect(validation).toMatchObject({
      ok: true,
      args: { query: "shell logs" },
    });
    expect(result).toContain("rare_shell_helper");
    expect(getRegistry().listActive().map(item => item.name)).toContain("rare_shell_helper");
  });

  it("rejects non-string tool_search queries instead of stringifying objects into fake searches", async () => {
    registerToolSearchTool();

    expect(await getRegistry().lookup("tool_search")!.execute({ query: { nested: true } as any })).toBe("Error: query must be a string.");
    const toolSearch = getRegistry().lookup("tool_search")!;
    expect(await toolSearch.validateInput?.(
      { query: { nested: true } as any },
      { tool_name: "tool_search", workspace_path: "/tmp/workspace", tool_def: toolSearch },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("query must be a string"),
    });
  });

  it("handles hostile tool_search argument getters without throwing or spreading them", async () => {
    registerToolSearchTool();
    const toolSearch = getRegistry().lookup("tool_search")!;
    const hostileArgs: Record<string, unknown> = { q: "shell logs" };
    Object.defineProperty(hostileArgs, "query", {
      enumerable: true,
      get() {
        throw new Error("query getter failed");
      },
    });

    await expect(toolSearch.execute(hostileArgs)).resolves.toBe("Error: query must be a string.");
    await expect(Promise.resolve(toolSearch.validateInput?.(
      hostileArgs,
      { tool_name: "tool_search", workspace_path: "/tmp/workspace", tool_def: toolSearch },
    ))).resolves.toEqual({
      ok: false,
      message: "query must be a string.",
    });
  });

  it("rejects oversized or control-character tool_search queries", async () => {
    registerToolSearchTool();
    const toolSearch = getRegistry().lookup("tool_search")!;

    expect(await toolSearch.execute({ query: `logs\u0000now` })).toBe("Error: query contains unsupported control characters.");
    expect(await toolSearch.validateInput?.(
      { q: "x".repeat(501) },
      { tool_name: "tool_search", workspace_path: "/tmp/workspace", tool_def: toolSearch },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("q must be 500 characters or fewer"),
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
      message: expect.stringContaining("name must be a string"),
    });

    expect(await getRegistry().lookup("tool_enable")!.execute({ name: { nested: true } as any })).toBe("Error: name must be a string.");
  });

  it("handles hostile tool_enable name getters without throwing", async () => {
    registerToolSearchTool();
    const toolEnable = getRegistry().lookup("tool_enable")!;
    const hostileArgs: Record<string, unknown> = {};
    Object.defineProperty(hostileArgs, "name", {
      enumerable: true,
      get() {
        throw new Error("name getter failed");
      },
    });

    await expect(toolEnable.execute(hostileArgs)).resolves.toBe("Error: name must be a string.");
    await expect(Promise.resolve(toolEnable.validateInput?.(
      hostileArgs,
      { tool_name: "tool_enable", workspace_path: "/tmp/workspace", tool_def: toolEnable },
    ))).resolves.toEqual({
      ok: false,
      message: "name must be a string.",
    });
  });

  it("rejects oversized or control-character tool_enable names", async () => {
    registerToolSearchTool();
    const toolEnable = getRegistry().lookup("tool_enable")!;

    expect(await toolEnable.execute({ name: "bad\u0000name" })).toBe("Error: name contains unsupported control characters.");
    expect(await toolEnable.validateInput?.(
      { name: "x".repeat(65) },
      { tool_name: "tool_enable", workspace_path: "/tmp/workspace", tool_def: toolEnable },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("name must be 64 characters or fewer"),
    });
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
