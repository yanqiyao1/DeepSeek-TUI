import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveToolPermission } from "../src/tools/base.js";
import { checkCommand, setCustomRules } from "../src/tools/exec-policy.js";
import { getRegistry } from "../src/tools/registry.js";
import { registerShellTool } from "../src/tools/shell.js";
import { registerTaskTools } from "../src/tools/tasks.js";

beforeEach(() => {
  getRegistry().clear();
  setCustomRules([]);
});

afterEach(() => {
  getRegistry().clear();
  setCustomRules([]);
});

describe("shell exec policy branches", () => {
  it("allows empty commands", () => {
    expect(checkCommand("   ")).toMatchObject({ decision: "allow", justification: "empty command" });
  });

  it("allows environment-assignment-only commands", () => {
    expect(checkCommand("FOO=bar")).toMatchObject({ decision: "allow" });
  });

  it("requires approval for environment overrides attached to commands", () => {
    expect(checkCommand("FOO=bar cat README.md")).toMatchObject({
      decision: "ask",
      justification: "environment overrides on commands require approval",
    });
  });

  it("requires approval for unclosed shell quotes", () => {
    expect(checkCommand("cat 'README.md")).toMatchObject({ decision: "ask", justification: "unclosed shell quote requires approval" });
  });

  it("requires approval for trailing shell escapes", () => {
    expect(checkCommand("printf hello\\")).toMatchObject({ decision: "ask", justification: "trailing shell escape requires approval" });
  });

  it("requires approval for background execution operators", () => {
    expect(checkCommand("echo hi &")).toMatchObject({ decision: "ask" });
  });

  it("allows command lookup with command -v", () => {
    expect(checkCommand("command -v node")).toMatchObject({ decision: "allow" });
  });

  it("requires approval for command without lookup flags", () => {
    expect(checkCommand("command node")).toMatchObject({ decision: "ask", justification: "only command -v/-V is read-only" });
  });

  it("allows type lookup flags", () => {
    expect(checkCommand("type -p node")).toMatchObject({ decision: "allow" });
  });

  it("allows numeric short forms for head", () => {
    expect(checkCommand("head -20 README.md")).toMatchObject({ decision: "allow" });
  });

  it("allows read-only git branch query forms with positional names in list mode", () => {
    expect(checkCommand("git branch --show-current")).toMatchObject({ decision: "allow" });
    expect(checkCommand("git branch --list main")).toMatchObject({ decision: "allow" });
  });
});

describe("custom exec policy rules", () => {
  it("allows commands matched by custom allow rules", () => {
    setCustomRules([
      { type: "prefix", prefix: ["npm", "test"], decision: "allow", justification: "approved test command" },
    ]);

    expect(checkCommand("npm test -- --runInBand")).toMatchObject({ decision: "allow", justification: "approved test command" });
  });

  it("does not let custom allow rules bypass shell safety checks", () => {
    setCustomRules([
      { type: "prefix", prefix: ["cat"], decision: "allow", justification: "approved cat" },
      { type: "prefix", prefix: ["node"], decision: "allow", justification: "approved node" },
      { type: "prefix", prefix: ["FOO=bar", "cat"], decision: "allow", justification: "approved env cat" },
    ]);

    expect(checkCommand("cat README.md > out.txt")).toMatchObject({ decision: "ask" });
    expect(checkCommand("cat $(touch owned)")).toMatchObject({ decision: "ask" });
    expect(checkCommand("cat 'README.md")).toMatchObject({ decision: "ask" });
    expect(checkCommand("FOO=bar cat README.md")).toMatchObject({ decision: "ask" });
    expect(checkCommand("node -e console.log(1)")).toMatchObject({ decision: "allow", justification: "approved node" });
  });

  it("lets custom deny rules win over custom allow rules", () => {
    setCustomRules([
      { type: "prefix", prefix: ["npm"], decision: "allow", justification: "general npm allow" },
      { type: "prefix", prefix: ["npm", "publish"], decision: "deny", justification: "publishing blocked" },
    ]);

    expect(checkCommand("npm publish")).toMatchObject({ decision: "deny", justification: "publishing blocked" });
  });

  it("does not let custom allow rules override built-in destructive denies", () => {
    setCustomRules([
      { type: "prefix", prefix: ["rm", "-rf", "/"], decision: "allow", justification: "bad rule" },
    ]);

    expect(checkCommand("rm -rf /")).toMatchObject({ decision: "deny", justification: "recursive root deletion" });
  });

  it("ignores empty custom prefixes and malformed custom regexes", () => {
    setCustomRules([
      { type: "prefix", prefix: [], decision: "allow", justification: "empty prefix" },
      { type: "exact", command: "   ", decision: "allow", justification: "empty exact" },
      { type: "regex", pattern: "(", decision: "allow", justification: "bad regex" },
    ]);

    expect(checkCommand("npm publish")).toMatchObject({ decision: "ask" });
  });
});

describe("tool registry activation", () => {
  it("activates deferred tools from context text", () => {
    getRegistry().register({
      name: "schema_reader",
      description: "inspect schema migrations",
      searchHint: "database schema reader",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      deferLoading: true,
      execute: async () => "ok",
    });

    expect(getRegistry().activateForContext("please inspect the schema before editing")).toEqual(["schema_reader"]);
    expect(getRegistry().listActive().map(tool => tool.name)).toContain("schema_reader");
  });

  it("caps context-triggered activation at eight tools", () => {
    for (let index = 0; index < 10; index++) {
      getRegistry().register({
        name: `schema_tool_${index}`,
        description: `schema helper ${index}`,
        searchHint: "schema helper",
        parameters: { type: "object", properties: {} },
        permission: "always_allow" as any,
        category: "test",
        parallelOk: true,
        deferLoading: true,
        execute: async () => "ok",
      });
    }

    const activated = getRegistry().activateForContext("schema work");

    expect(activated).toHaveLength(8);
  });

  it("skips degraded tools during context-triggered activation", () => {
    getRegistry().register({
      name: "schema_reader",
      description: "inspect schema migrations",
      searchHint: "database schema reader",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      deferLoading: true,
      execute: async () => "ok",
    });
    getRegistry().recordCall("schema_reader", false, 1);
    getRegistry().degradeIfUnhealthy("schema_reader", 1);

    expect(getRegistry().activateForContext("inspect schema")).toEqual([]);
  });
});

describe("shell and task tool permissions", () => {
  it("rejects blank bash commands during validation", async () => {
    registerShellTool();
    const tool = getRegistry().lookup("bash")!;

    expect(await tool.validateInput?.({ command: "   " }, {
      tool_name: "bash",
      workspace_path: "/tmp/workspace",
      tool_def: tool,
    })).toEqual({ ok: false, message: "command must be a non-empty string" });
  });

  it("maps bash permission checks onto policy allow and deny decisions", async () => {
    registerShellTool();
    const tool = getRegistry().lookup("bash")!;

    await expect(resolveToolPermission({
      tool_name: "bash",
      tool_args: { command: "cat README.md" },
      tool_def: tool,
      workspace_path: "/tmp/workspace",
    })).resolves.toMatchObject({ decision: "allow" });

    await expect(resolveToolPermission({
      tool_name: "bash",
      tool_args: { command: "rm -rf /" },
      tool_def: tool,
      workspace_path: "/tmp/workspace",
    })).resolves.toMatchObject({ decision: "deny" });
  });

  it("maps task gate permissions onto shell policy decisions", async () => {
    registerTaskTools();
    const tool = getRegistry().lookup("task_gate_run")!;

    await expect(resolveToolPermission({
      tool_name: "task_gate_run",
      tool_args: { command: "cat README.md" },
      tool_def: tool,
      workspace_path: "/tmp/workspace",
    })).resolves.toMatchObject({ decision: "allow" });

    await expect(resolveToolPermission({
      tool_name: "task_gate_run",
      tool_args: { command: "npm test" },
      tool_def: tool,
      workspace_path: "/tmp/workspace",
    })).resolves.toMatchObject({ decision: "ask" });

    await expect(resolveToolPermission({
      tool_name: "task_gate_run",
      tool_args: { command: "rm -rf /" },
      tool_def: tool,
      workspace_path: "/tmp/workspace",
    })).resolves.toMatchObject({ decision: "deny" });
  });
});
