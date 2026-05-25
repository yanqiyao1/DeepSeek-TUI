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

  it("falls back to an empty object schema for malformed tool parameters", () => {
    const tool = makeTool({ parameters: ["bad"] as any });

    expect(toolToOpenAISchema(tool)).toEqual({
      type: "function",
      function: {
        name: "test_tool",
        description: "test tool",
        parameters: { type: "object", properties: {} },
      },
    });
  });

  it("returns JSON-safe schema snapshots without leaking parameter references", () => {
    const parameters: Record<string, unknown> = {
      type: "object",
      properties: {
        count: { type: "integer", default: 1n },
        ignored: undefined,
      },
    };
    parameters.self = parameters;
    const schema = toolToOpenAISchema(makeTool({
      description: "Search\u0000 repository\nwith logs",
      parameters,
    }));

    parameters.properties = { mutated: true };

    expect(schema).toMatchObject({
      function: {
        description: "Search repository with logs",
        parameters: {
          type: "object",
          properties: {
            count: { type: "integer", default: "1" },
          },
          self: "[Circular]",
        },
      },
    });
  });

  it("normalizes invalid OpenAI schema tool names", () => {
    expect((toolToOpenAISchema(makeTool({ name: "bad name" })) as any).function.name).toBe("tool");
    expect((toolToOpenAISchema(makeTool({ name: "bad\u0000name" })) as any).function.name).toBe("tool");
    expect((toolToOpenAISchema(makeTool({ name: "x".repeat(80) })) as any).function.name).toBe("x".repeat(64));
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

  it("normalizes successful validator output and ignores unsafe args", async () => {
    const args = { query: "README" };
    const rewritten: Record<string, unknown> = { query: "README", ignored: undefined, count: 1n };
    rewritten.self = rewritten;
    const tool = makeTool({
      validateInput: () => ({
        ok: true,
        message: "normalized\u0000args",
        args: rewritten,
      }),
    });

    const result = await validateToolInput(tool, args, {
      tool_name: "test_tool",
      workspace_path: "/tmp/workspace",
    });

    expect(result).toEqual({
      ok: true,
      message: "normalized args",
      args: {
        query: "README",
        count: "1",
        self: "[Circular]",
      },
    });
  });

  it("fails validation when validators throw or return malformed results", async () => {
    const throwingTool = makeTool({
      validateInput: () => { throw new Error("boom"); },
    });
    const malformedTool = makeTool({
      validateInput: () => "ok" as any,
    });
    const nonBooleanTool = makeTool({
      validateInput: () => ({ ok: "true" as any, message: "not boolean" }),
    });

    await expect(validateToolInput(throwingTool, {}, {
      tool_name: "test_tool",
      workspace_path: "/tmp/workspace",
    })).resolves.toEqual({ ok: false, message: "tool validation failed" });
    await expect(validateToolInput(malformedTool, {}, {
      tool_name: "test_tool",
      workspace_path: "/tmp/workspace",
    })).resolves.toEqual({ ok: false, message: "tool validation failed" });
    await expect(validateToolInput(nonBooleanTool, {}, {
      tool_name: "test_tool",
      workspace_path: "/tmp/workspace",
    })).resolves.toEqual({ ok: false, message: "not boolean" });
  });

  it("keeps original args when validators return malformed success args", async () => {
    const args = { query: "README" };
    const tool = makeTool({
      validateInput: () => ({
        ok: true,
        args: "not an object" as any,
      }),
    });

    const result = await validateToolInput(tool, args, {
      tool_name: "test_tool",
      workspace_path: "/tmp/workspace",
    });

    expect(result).toEqual({ ok: true, args });
  });

  it("sanitizes validation failure messages", async () => {
    const tool = makeTool({
      validateInput: () => ({
        ok: false,
        message: `bad\u0000input\n${"x".repeat(3000)}`,
      }),
    });

    const result = await validateToolInput(tool, {}, {
      tool_name: "test_tool",
      workspace_path: "/tmp/workspace",
    });

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("\u0000");
    expect(result.message).toHaveLength(2000);
  });

  it("sanitizes repeated control characters in metadata without stateful regex leakage", async () => {
    const tool = makeTool({
      description: "desc\u0000one\u0007two",
      getActivityDescription: () => "activity\u0000one\u0007two",
      getToolUseSummary: () => "summary\u0000one\u0007two",
      getTranscriptSearchText: () => "transcript\u0000one\u0007two",
    });
    const schema = toolToOpenAISchema(tool) as any;
    const metadata = getToolUseRuntimeMetadata(tool, {}, "ok")!;

    expect(schema.function.description).toBe("desc one two");
    expect(metadata.activity).toBe("activity one two");
    expect(metadata.summary).toBe("summary one two");
    expect(metadata.transcriptSearchText).toBe("transcript one two");
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

  it("normalizes malformed permission checker results and reasons", async () => {
    const malformed = makeTool({
      permission: PermissionLevel.DANGEROUS,
      checkPermissions: () => ({ decision: "maybe", reason: "bad" } as any),
    });
    const throwingAllow = makeTool({
      permission: PermissionLevel.ALWAYS_ALLOW,
      checkPermissions: () => { throw new Error("boom"); },
    });
    const noisy = makeTool({
      checkPermissions: () => ({
        decision: "ask",
        reason: `needs\u0000review${"x".repeat(3000)}`,
        description: "Inspect\ncommand",
      }),
    });

    await expect(resolveToolPermission(ctx(malformed))).resolves.toEqual({
      decision: "ask",
      reason: "dangerous tool",
    });
    await expect(resolveToolPermission(ctx(throwingAllow))).resolves.toEqual({
      decision: "ask",
      reason: "permission check failed",
    });
    const result = await resolveToolPermission(ctx(noisy));
    expect(result.decision).toBe("ask");
    expect(result.description).toBe("Inspect command");
    expect(result.reason).not.toContain("\u0000");
    expect(result.reason).toHaveLength(2000);
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

  it("falls back when capability predicates return non-boolean values", () => {
    const tool = makeTool({
      parallelOk: false,
      readOnly: () => "yes" as any,
      destructive: () => 1 as any,
      concurrencySafe: () => true as any,
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

  it("sanitizes render metadata fields and ignores invalid result kinds", () => {
    const tool = makeTool({
      resultKind: "json",
      renderMetadata: () => ({
        userFacingName: `Audit\u0000${"x".repeat(3000)}`,
        icon: `shield\u0007${"i".repeat(200)}`,
        accent: `blue\n${"a".repeat(200)}`,
        resultKind: "html" as any,
        transparent: "yes" as any,
      }),
    });
    const rendered = getToolRenderMetadata(tool)!;

    expect(rendered.userFacingName).not.toContain("\u0000");
    expect(rendered.userFacingName).toHaveLength(2000);
    expect(rendered.icon).toHaveLength(100);
    expect(rendered.accent).toHaveLength(100);
    expect(rendered.resultKind).toBe("json");
    expect(rendered.transparent).toBeUndefined();
  });

  it("keeps runtime classifier metadata JSON-safe", () => {
    const classifierInput: Record<string, unknown> = { count: 1n, ignored: undefined };
    classifierInput.self = classifierInput;
    const tool = makeTool({
      toAutoClassifierInput: () => classifierInput,
    });

    expect(getToolUseRuntimeMetadata(tool, {}, "ok")).toEqual({
      classifierInput: {
        count: "1",
        self: "[Circular]",
      },
    });
  });

  it("bounds and sanitizes runtime metadata strings", () => {
    const tool = makeTool({
      getActivityDescription: () => `Running\u0000${"x".repeat(3000)}`,
      getToolUseSummary: () => `Summary\n${"y".repeat(3000)}`,
      getTranscriptSearchText: () => `Transcript\u0007${"z".repeat(30_000)}`,
    });
    const metadata = getToolUseRuntimeMetadata(tool, {}, "ok")!;

    expect(metadata.activity).not.toContain("\u0000");
    expect(metadata.summary).not.toContain("\n");
    expect(metadata.transcriptSearchText).not.toContain("\u0007");
    expect(metadata.activity).toHaveLength(2000);
    expect(metadata.summary).toHaveLength(2000);
    expect(metadata.transcriptSearchText).toHaveLength(20_000);
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

  it("ignores malformed prepared permission matchers", async () => {
    const tool = makeTool({
      preparePermissionMatcher: () => "matcher" as any,
    });

    await expect(prepareToolPermissionMatcher(tool, {})).resolves.toBeUndefined();
  });

  it("sanitizes permission pattern lists", () => {
    const tool = makeTool({
      getPermissionPatterns: () => [" keep ", "bad\u0000pattern", " keep ", { nested: true } as any, "x".repeat(1200)],
    });

    const patterns = getToolPermissionPatterns(tool, {});

    expect(patterns).toHaveLength(3);
    expect(patterns[0]).toBe("keep");
    expect(patterns[1]).toBe("bad pattern");
    expect(patterns[2]).toHaveLength(1000);
  });

  it("ignores non-array permission patterns and caps pattern fanout", () => {
    const malformed = makeTool({
      getPermissionPatterns: () => "path:*" as any,
    });
    const many = makeTool({
      getPermissionPatterns: () => Array.from({ length: 80 }, (_, index) => `pattern:${index}`),
    });

    expect(getToolPermissionPatterns(malformed, {})).toEqual([]);
    expect(getToolPermissionPatterns(many, {})).toHaveLength(64);
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

  it("normalizes malformed aliases and schemas when tools are registered", () => {
    const registry = getRegistry();
    registry.register(makeTool({
      name: "repo_audit",
      aliases: [" inspect ", "", "inspect", { nested: true }] as any,
      parameters: [] as any,
    }));

    expect(registry.lookup("inspect")?.name).toBe("repo_audit");
    expect(registry.toOpenAISchemas()).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({
          parameters: { type: "object", properties: {} },
        }),
      }),
    ]);
  });

  it("ignores non-object tool registrations", () => {
    const registry = getRegistry();

    expect(() => registry.register(null as any)).not.toThrow();
    expect(() => registry.register("bad_tool" as any)).not.toThrow();

    expect(registry.size).toBe(0);
    expect(registry.toOpenAISchemas()).toEqual([]);
  });

  it("skips invalid tool names and aliases instead of exposing invalid schemas", () => {
    const registry = getRegistry();
    registry.register(makeTool({
      name: "bad name",
      aliases: ["alias"],
    }));
    registry.register(makeTool({
      name: "good_tool",
      aliases: ["good_alias", "bad alias", "bad\u0000alias", "x".repeat(65)],
    }));

    expect(registry.lookup("bad name")).toBeUndefined();
    expect(registry.lookup("alias")).toBeUndefined();
    expect(registry.lookup("good_alias")?.name).toBe("good_tool");
    expect(registry.lookup("bad alias")).toBeUndefined();
    expect(registry.toOpenAISchemas().map((schema: any) => schema.function.name)).toEqual(["good_tool"]);
  });

  it("does not leak repeated control-character tool names or aliases through registry normalization", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "bad\u0000name", aliases: ["alias_one"] }));
    registry.register(makeTool({ name: "also\u0007bad", aliases: ["alias_two"] }));
    registry.register(makeTool({ name: "good_tool", aliases: ["bad\u0000alias", "also\u0007bad_alias", "good_alias"] }));

    expect(registry.lookup("alias_one")).toBeUndefined();
    expect(registry.lookup("alias_two")).toBeUndefined();
    expect(registry.lookup("bad\u0000alias")).toBeUndefined();
    expect(registry.lookup("also\u0007bad_alias")).toBeUndefined();
    expect(registry.lookup("good_alias")?.name).toBe("good_tool");
    expect(registry.toOpenAISchemas().map((schema: any) => schema.function.name)).toEqual(["good_tool"]);
  });

  it("returns defensive OpenAI schema copies from the registry cache", () => {
    const registry = getRegistry();
    const parameters: Record<string, unknown> = { type: "object", properties: { query: { type: "string" } } };
    registry.register(makeTool({ name: "schema_tool", parameters }));

    const first = registry.toOpenAISchemas();
    (first[0] as any).function.parameters.properties.query.type = "number";
    parameters.properties = { mutated: true };
    const second = registry.toOpenAISchemas();

    expect((second[0] as any).function.parameters.properties.query.type).toBe("string");
    expect((second[0] as any).function.parameters.properties.mutated).toBeUndefined();
  });

  it("returns defensive tool snapshots from lookups, lists, and search", () => {
    const registry = getRegistry();
    registry.register(makeTool({
      name: "repo_audit",
      aliases: ["audit_repo"],
      description: "Inspect repository health",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      renderMetadata: { userFacingName: "Repo Audit", icon: "shield" },
    }));

    const lookup = registry.lookup("repo_audit")!;
    lookup.description = "mutated lookup";
    lookup.aliases!.push("mutated_alias");
    (lookup.parameters as any).properties.query.type = "number";
    (lookup.renderMetadata as any).icon = "mutated";

    const listed = registry.listAll();
    listed[0]!.description = "mutated list";
    listed[0]!.aliases!.push("listed_alias");

    const active = registry.listActive();
    active[0]!.category = "mutated active";

    const searched = registry.search("repository", 1);
    searched[0]!.tool.description = "mutated search";
    searched[0]!.tool.aliases!.push("searched_alias");

    const stored = registry.lookup("repo_audit")!;
    expect(stored.description).toBe("Inspect repository health");
    expect(stored.category).toBe("test");
    expect(stored.aliases).toEqual(["audit_repo"]);
    expect((stored.parameters as any).properties.query.type).toBe("string");
    expect((stored.renderMetadata as any).icon).toBe("shield");
    expect(registry.lookup("mutated_alias")).toBeUndefined();
    expect(registry.lookup("listed_alias")).toBeUndefined();
    expect(registry.lookup("searched_alias")).toBeUndefined();
  });

  it("bounds registered alias fanout", () => {
    const registry = getRegistry();
    registry.register(makeTool({
      name: "repo_audit",
      aliases: Array.from({ length: 80 }, (_, index) => `audit_alias_${index}`),
    }));

    expect(registry.lookup("audit_alias_0")?.name).toBe("repo_audit");
    expect(registry.lookup("audit_alias_31")?.name).toBe("repo_audit");
    expect(registry.lookup("audit_alias_32")).toBeUndefined();
    expect(registry.lookup("audit_alias_79")).toBeUndefined();
  });

  it("bounds registry size and schema cache output", () => {
    const registry = getRegistry();
    const hugeSchema = { type: "object", properties: { text: { description: "x".repeat(80_000) } } };
    for (let index = 0; index < 1_010; index++) {
      registry.register(makeTool({
        name: `bulk_tool_${index}`,
        description: "bulk helper",
        parameters: hugeSchema,
      }));
    }

    expect(registry.size).toBe(1_000);
    expect(registry.lookup("bulk_tool_999")).toBeTruthy();
    expect(registry.lookup("bulk_tool_1000")).toBeUndefined();
    expect(JSON.stringify(registry.toOpenAISchemas()).length).toBeLessThanOrEqual(2_100_000);
  });

  it("keeps tool stats counters finite and clamps unhealthy thresholds", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "repo_audit" }));
    const stats = registry.recordCall("repo_audit", false, Number.MAX_SAFE_INTEGER);
    stats.calls = Number.MAX_SAFE_INTEGER;
    stats.failures = Number.MAX_SAFE_INTEGER;
    stats.consecutive_failures = Number.MAX_SAFE_INTEGER;
    stats.total_ms = 0;

    registry.recordCall("repo_audit", false, Number.MAX_SAFE_INTEGER);

    expect(registry.toolStats().find(item => item.name === "repo_audit")).toMatchObject({
      calls: 2,
      failures: 2,
      consecutive_failures: 2,
      total_ms: Number.MAX_SAFE_INTEGER,
    });
    expect(registry.degradeIfUnhealthy("repo_audit", 0)).toContain("disabled");
  });

  it("treats only boolean true as a successful tool call and returns defensive stats", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "repo_audit" }));

    const first = registry.recordCall("repo_audit", "false" as any, 10);
    first.calls = 99;
    first.failures = 99;
    first.consecutive_failures = 99;

    expect(registry.toolStats().find(item => item.name === "repo_audit")).toMatchObject({
      calls: 1,
      failures: 1,
      consecutive_failures: 1,
    });

    registry.recordCall("repo_audit", true, 10);

    expect(registry.toolStats().find(item => item.name === "repo_audit")).toMatchObject({
      calls: 2,
      failures: 1,
      consecutive_failures: 0,
    });
  });

  it("ignores invalid registry lookup and activation names", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "repo_audit" }));

    expect(registry.lookup("repo_audit\u0000")).toBeUndefined();
    expect(registry.activate("repo_audit\u0000")).toBe(false);
    expect(registry.deactivate("repo_audit\u0000")).toBe(false);
    expect(registry.enableDegraded("repo_audit\u0000")).toBe(false);
    expect(registry.degradeIfUnhealthy("repo_audit\u0000", 1)).toBeNull();
  });

  it("clears degraded state when a tool is re-registered", () => {
    const registry = getRegistry();
    registry.register(makeTool({ name: "repo_audit", description: "old helper" }));

    registry.recordCall("repo_audit", false, 10);
    expect(registry.degradeIfUnhealthy("repo_audit", 1)).toContain("disabled");
    expect(registry.toolStats().find(tool => tool.name === "repo_audit")).toMatchObject({
      active: false,
      disabled_reason: expect.stringContaining("disabled"),
      consecutive_failures: 1,
    });

    registry.register(makeTool({ name: "repo_audit", description: "new helper" }));

    expect(registry.lookup("repo_audit")?.description).toBe("new helper");
    expect(registry.toolStats().find(tool => tool.name === "repo_audit")).toMatchObject({
      active: true,
      disabled_reason: undefined,
      calls: 1,
      failures: 1,
      consecutive_failures: 0,
    });
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
