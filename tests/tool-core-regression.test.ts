import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PermissionLevel,
  getToolPermissionPatterns,
  getToolRenderMetadata,
  getToolUseRuntimeMetadata,
  isToolConcurrencySafe,
  isToolDestructive,
  isToolReadOnly,
  prepareToolPermissionMatcher,
  resolveToolPermission,
  toolToOpenAISchema,
  validateToolInput,
  type ApprovalContext,
  type ToolDef,
} from "../src/tools/base.js";
import { checkCommand, setCustomRules } from "../src/tools/exec-policy.js";
import { getRegistry } from "../src/tools/registry.js";
import { registerShellTool } from "../src/tools/shell.js";

function makeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "test_tool",
    description: "test tool",
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "test",
    parallelOk: true,
    ...overrides,
  };
}

function ctx(toolDef: ToolDef, args: Record<string, unknown> = {}): ApprovalContext {
  return {
    tool_name: toolDef.name,
    tool_args: args,
    tool_def: toolDef,
    workspace_path: "/tmp/workspace",
  };
}

beforeEach(() => {
  getRegistry().clear();
  setCustomRules([]);
});

afterEach(() => {
  getRegistry().clear();
  setCustomRules([]);
});

describe("tool base helpers", () => {
  it("converts tool definitions into OpenAI function schemas", () => {
    const tool = makeTool({
      name: "search_repo",
      description: "Search the repository",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    });

    expect(toolToOpenAISchema(tool)).toEqual({
      type: "function",
      function: {
        name: "search_repo",
        description: "Search the repository",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    });
  });

  it("keeps original args when a tool has no validator", async () => {
    const args = { path: "src/index.ts" };
    const result = await validateToolInput(makeTool(), args, {
      tool_name: "test_tool",
      workspace_path: "/tmp/workspace",
    });

    expect(result).toEqual({ ok: true, args });
  });

  it("lets validators rewrite tool arguments", async () => {
    const tool = makeTool({
      validateInput: (args) => ({
        ok: true,
        args: { ...args, normalized: true },
      }),
    });

    const result = await validateToolInput(tool, { query: "README" }, {
      tool_name: "test_tool",
      workspace_path: "/tmp/workspace",
    });

    expect(result).toEqual({ ok: true, args: { query: "README", normalized: true } });
  });

  it("uses custom permission checkers before default permission levels", async () => {
    const tool = makeTool({
      permission: PermissionLevel.DANGEROUS,
      checkPermissions: () => ({ decision: "deny", reason: "maintenance window" }),
    });

    await expect(resolveToolPermission(ctx(tool))).resolves.toEqual({
      decision: "deny",
      reason: "maintenance window",
    });
  });

  it("treats dangerous tools as approval-gated by default", async () => {
    await expect(resolveToolPermission(ctx(makeTool({ permission: PermissionLevel.DANGEROUS })))).resolves.toEqual({
      decision: "ask",
      reason: "dangerous tool",
    });
  });

  it("falls back cleanly when capability predicates throw", () => {
    const tool = makeTool({
      parallelOk: true,
      readOnly: () => { throw new Error("boom"); },
      destructive: () => { throw new Error("boom"); },
      concurrencySafe: () => { throw new Error("boom"); },
    });

    expect(isToolReadOnly(tool)).toBe(false);
    expect(isToolDestructive(tool)).toBe(false);
    expect(isToolConcurrencySafe(tool)).toBe(true);
  });

  it("builds optional runtime metadata without requiring every tool to implement it", () => {
    const tool = makeTool({
      resultKind: "json",
      renderMetadata: () => ({ userFacingName: "Audit", icon: "shield" }),
      getActivityDescription: (args) => `Auditing ${args.path}`,
      getToolUseSummary: (args) => `Audit ${args.path}`,
      toAutoClassifierInput: (args) => ({ audit: args.path }),
      getTranscriptSearchText: (result) => `visible:${result}`,
    });

    expect(getToolRenderMetadata(tool, { path: "src/index.ts" })).toEqual({
      userFacingName: "Audit",
      icon: "shield",
      resultKind: "json",
    });
    expect(getToolUseRuntimeMetadata(tool, { path: "src/index.ts" }, "ok")).toEqual({
      activity: "Auditing src/index.ts",
      summary: "Audit src/index.ts",
      classifierInput: { audit: "src/index.ts" },
      transcriptSearchText: "visible:ok",
      render: { userFacingName: "Audit", icon: "shield", resultKind: "json" },
    });
  });

  it("lets tools prepare permission patterns and matchers", async () => {
    const tool = makeTool({
      getPermissionPatterns: (args) => [`path:${args.path}`],
      preparePermissionMatcher: (args) => (pattern) => pattern === `path:${args.path}`,
    });

    expect(getToolPermissionPatterns(tool, { path: "src/index.ts" })).toEqual(["path:src/index.ts"]);
    const matcher = await prepareToolPermissionMatcher(tool, { path: "src/index.ts" });
    expect(matcher?.("path:src/index.ts")).toBe(true);
    expect(matcher?.("path:README.md")).toBe(false);
  });
});

describe("shell policy regressions", () => {
  it("blocks destructive find expressions even when -prune appears earlier", () => {
    expect(checkCommand("find . -prune -delete")).toMatchObject({ decision: "deny" });
  });

  it("treats duplicate git branch values after --sort as positional branch names", () => {
    expect(checkCommand("git branch --sort main main")).toMatchObject({ decision: "ask" });
  });

  it("requires approval for trailing shell operators instead of treating them as valid read-only pipelines", () => {
    expect(checkCommand("cat README.md |")).toMatchObject({
      decision: "ask",
      justification: "trailing shell operator requires approval",
    });
  });
});

describe("tool registry", () => {
  it("searches tools by alias and descriptive metadata", () => {
    const registry = getRegistry();
    registry.register(makeTool({
      name: "repo_audit",
      aliases: ["audit_repo"],
      description: "Inspect repository health and summarize risky files",
      searchHint: "repository audit",
      resultKind: "text",
    }));
    registry.register(makeTool({
      name: "format_patch",
      description: "Format generated patch output",
      searchHint: "patch format",
      resultKind: "diff",
    }));

    const results = registry.search("audit repo", 2);

    expect(results.map(result => result.tool.name)).toEqual(["repo_audit"]);
  });

  it("falls back to the default search limit when callers pass malformed limits", () => {
    const registry = getRegistry();
    for (let index = 0; index < 3; index++) {
      registry.register(makeTool({
        name: `repo_audit_${index}`,
        description: "Inspect repository health",
      }));
    }

    expect(registry.search("repository", Number.NaN).map(result => result.tool.name)).toHaveLength(3);
    expect(registry.search("repository", { nested: true } as any).map(result => result.tool.name)).toHaveLength(3);
    expect(registry.search("repository", 1.8).map(result => result.tool.name)).toHaveLength(1);
  });

  it("keeps tool call duration stats finite when callers pass malformed timings", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "repo_audit" }));

    registry.recordCall("repo_audit", true, Number.NaN);
    registry.recordCall("repo_audit", true, Number.POSITIVE_INFINITY);
    registry.recordCall("repo_audit", true, -10);

    expect(registry.toolStats().find(item => item.name === "repo_audit")).toMatchObject({
      calls: 3,
      total_ms: 0,
    });
  });

  it("drops stale aliases when a tool is re-registered", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "repo_audit", aliases: ["audit_repo"] }));
    registry.register(makeTool({ name: "repo_audit", aliases: ["inspect_repo"] }));

    expect(registry.lookup("audit_repo")).toBeUndefined();
    expect(registry.lookup("inspect_repo")?.name).toBe("repo_audit");
  });

  it("does not let an alias shadow an existing primary tool", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "read", description: "primary read" }));
    registry.register(makeTool({ name: "repo_audit", aliases: ["read"] }));

    expect(registry.lookup("read")?.description).toBe("primary read");
    expect(registry.search("repo audit", 2).map(result => result.tool.name)).toContain("repo_audit");
  });

  it("keeps the first alias owner when later tools try to reuse the same alias", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "repo_audit", aliases: ["inspect"] }));
    registry.register(makeTool({ name: "security_audit", aliases: ["inspect"] }));

    expect(registry.lookup("inspect")?.name).toBe("repo_audit");
    expect(registry.lookup("security_audit")?.name).toBe("security_audit");
  });

  it("disables unhealthy tools after repeated failures and can re-enable them", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "repo_audit" }));

    registry.recordCall("repo_audit", false, 10);
    registry.recordCall("repo_audit", false, 15);
    const reason = registry.degradeIfUnhealthy("repo_audit", 2);

    expect(reason).toContain("2 consecutive failures");
    expect(registry.toolStats().find(tool => tool.name === "repo_audit")).toMatchObject({
      active: false,
      disabled_reason: reason,
    });

    expect(registry.enableDegraded("repo_audit")).toBe(true);
    expect(registry.toolStats().find(tool => tool.name === "repo_audit")).toMatchObject({
      active: true,
      disabled_reason: undefined,
    });
  });

  it("keeps active-only schemas aligned with activation state", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "always_on" }));
    registry.register(makeTool({ name: "deferred_tool", deferLoading: true }));

    expect(registry.toOpenAISchemas({ activeOnly: true }).map(schema => (schema as any).function.name)).toEqual(["always_on"]);

    expect(registry.activate("deferred_tool")).toBe(true);
    expect(registry.toOpenAISchemas({ activeOnly: true }).map(schema => (schema as any).function.name).sort()).toEqual([
      "always_on",
      "deferred_tool",
    ]);

    expect(registry.deactivate("always_on")).toBe(true);
    expect(registry.toOpenAISchemas({ activeOnly: true }).map(schema => (schema as any).function.name)).toEqual(["deferred_tool"]);
  });
});

describe("shell tool metadata", () => {
  it("treats read-only background shell jobs as non-concurrent", () => {
    registerShellTool();
    const tool = getRegistry().lookup("bash")!;

    expect(isToolReadOnly(tool, { command: "cat README.md" })).toBe(true);
    expect(isToolConcurrencySafe(tool, { command: "cat README.md" })).toBe(true);
    expect(isToolConcurrencySafe(tool, { command: "cat README.md", background: true })).toBe(false);
  });
});
