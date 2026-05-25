import { describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { PermissionLevel, type ApprovalContext, type ToolDef } from "../src/tools/base.js";
import { checkSandboxPolicy } from "../src/tools/sandbox.js";
import {
  approvalPrompt,
  commandOutput,
  footerConfigured,
  footerDivider,
  promptSymbol,
  statusBarFromItems,
  toolDiffPreview,
  toolResultSummary,
} from "../src/ui/renderer.js";
import { stripAnsi, visibleLength } from "../src/ui/ansi.js";

function tool(
  name: string,
  permission: PermissionLevel,
  category = "test",
  overrides: Partial<ToolDef> = {},
): ToolDef {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    permission,
    category,
    parallelOk: true,
    execute: async () => `${name} ran`,
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

describe("sandbox policy matrix", () => {
  const bashTool = tool("bash", PermissionLevel.ASK, "shell");
  const writeTool = tool("write", PermissionLevel.ASK, "file", { destructive: true });
  const readTool = tool("read", PermissionLevel.ALWAYS_ALLOW, "file", { readOnly: true });

  it.each([
    [
      "allows in-workspace file paths and shell reads",
      ctx(bashTool, "bash", { command: "cat ./README.md", workdir: "/tmp/workspace" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "allow",
    ],
    [
      "denies write tools in read-only sandbox",
      ctx(writeTool, "write", { path: "notes.txt" }),
      config({ sandbox_mode: "read-only" }),
      "deny",
    ],
    [
      "allows read-only custom tools in read-only sandbox",
      ctx(readTool, "read", { path: "notes.txt" }),
      config({ sandbox_mode: "read-only" }),
      "allow",
    ],
    [
      "denies shell commands escaping workdir with dot segments",
      ctx(bashTool, "bash", { command: "cat ../../../etc/passwd", workdir: "/tmp/workspace/src/pkg" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "deny",
    ],
    [
      "denies file URI shell paths outside the workspace",
      ctx(bashTool, "bash", { command: "cat file:///etc/passwd", workdir: "/tmp/workspace" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "deny",
    ],
    [
      "denies tilde-expanded shell paths outside the workspace",
      ctx(bashTool, "bash", { command: "cat ~/secret.txt", workdir: "/tmp/workspace" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "deny",
    ],
    [
      "allows option values that stay inside the workspace",
      ctx(bashTool, "bash", { command: "rg --glob=./src/*.ts needle src", workdir: "/tmp/workspace" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "allow",
    ],
    [
      "denies option values that escape the workspace",
      ctx(bashTool, "bash", { command: "rg --glob=../../secret/*.ts needle src", workdir: "/tmp/workspace/pkg" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "deny",
    ],
    [
      "denies attached short option values that escape the workspace",
      ctx(bashTool, "bash", { command: "rg -g../../secret/*.ts needle src", workdir: "/tmp/workspace/pkg" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "deny",
    ],
    [
      "allows attached short option values inside the workspace",
      ctx(bashTool, "bash", { command: "rg -g./src/*.ts needle src", workdir: "/tmp/workspace" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "allow",
    ],
    [
      "denies brace-expanded shell paths outside the workspace",
      ctx(bashTool, "bash", { command: "cat {/etc/passwd,README.md}", workdir: "/tmp/workspace" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "deny",
    ],
    [
      "allows brace-expanded shell paths inside the workspace",
      ctx(bashTool, "bash", { command: "cat {src,docs}/README.md", workdir: "/tmp/workspace" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "allow",
    ],
    [
      "asks when shell policy asks in workspace-write mode",
      ctx(bashTool, "bash", { command: "npm test", workdir: "/tmp/workspace" }),
      config({ trusted_workspaces: ["/tmp/workspace"] }),
      "ask",
    ],
    [
      "asks for mutations in untrusted workspaces",
      ctx(writeTool, "write", { path: "draft.txt" }),
      config({ approval_policy: "untrusted", trusted_workspaces: [] }),
      "ask",
    ],
    [
      "allows trusted mutations when approval policy is untrusted",
      ctx(writeTool, "write", { path: "draft.txt" }, "/tmp/workspace"),
      config({ approval_policy: "untrusted", trusted_workspaces: ["/tmp/workspace"] }),
      "allow",
    ],
    [
      "allows everything only in never plus danger-full-access mode",
      ctx(bashTool, "bash", { command: "rm -rf /", workdir: "/tmp/workspace" }),
      config({ approval_policy: "never", sandbox_mode: "danger-full-access" }),
      "allow",
    ],
    [
      "still denies policy-blocked shell commands in never workspace-write mode",
      ctx(bashTool, "bash", { command: "rm -rf /", workdir: "/tmp/workspace" }),
      config({ approval_policy: "never", sandbox_mode: "workspace-write" }),
      "deny",
    ],
  ])("%s", (_label, approvalCtx, cfg, expected) => {
    expect(checkSandboxPolicy(cfg, approvalCtx).decision).toBe(expected);
  });
});

describe("renderer matrix", () => {
  it.each([
    ["one line", "one line", "one line"],
    ["two lines", "a\nb", "a\nb"],
    ["three lines", "a\nb\nc", "a\nb\nc"],
    ["four lines", "a\nb\nc\nd", "a\nb\nc\n  ... (1 more lines)"],
    ["preserves short trailing newline", "a\nb\n", "a\nb\n"],
  ])("summarizes tool results for %s", (_label, input, expected) => {
    expect(stripAnsi(toolResultSummary(input))).toBe(expected);
  });

  it.each([
    ["plain output", "hello\n", "hello"],
    ["whitespace only", "  \n\t", "(no output)"],
    ["ansi only", "\x1b[31m\x1b[0m", "(no output)"],
    ["ansi text", "\x1b[31mhello\x1b[0m\n", "hello"],
  ])("normalizes command output for %s", (_label, input, expected) => {
    expect(stripAnsi(commandOutput(input))).toBe(expected);
  });

  it.each([
    [
      "extracts a short diff block",
      ["ok", "", "[diff]", "--- a.ts", "+++ a.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
      14,
      ["--- a.ts", "+++ a.ts", "@@ -1 +1 @@", "-old", "+new"],
    ],
    [
      "truncates long diff blocks",
      ["ok", "", "[diff]", ...Array.from({ length: 8 }, (_, index) => `+line-${index}`)].join("\n"),
      3,
      ["+line-0", "+line-1", "+line-2", "... (5 more diff lines)"],
    ],
  ])("%s", (_label, input, maxLines, expectedParts) => {
    const rendered = stripAnsi(toolDiffPreview(input, maxLines));
    for (const part of expectedParts) {
      expect(rendered).toContain(part);
    }
  });

  it("returns an empty diff preview when no diff block is present", () => {
    expect(toolDiffPreview("plain result")).toBe("");
  });

  it.each([
    ["plan", "◉ "],
    ["agent", "● "],
    ["yolo", "▲ "],
    ["other", "> "],
  ])("renders the prompt symbol for %s mode", (mode, expected) => {
    expect(stripAnsi(promptSymbol(mode))).toBe(expected);
  });

  it("keeps footer and status rendering within the terminal width budget", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 38;
    try {
      const divider = footerDivider("session-123");
      const status = statusBarFromItems(["mode", "model", "workspace", "hints"], {
        mode: "agent",
        model: "deepseek-v4-pro",
        workspace: "/tmp/workspace",
        keyHints: "esc interrupt",
      });
      const full = footerConfigured("session-123", ["mode", "model", "workspace", "hints"], {
        mode: "agent",
        model: "deepseek-v4-pro",
        workspace: "/tmp/workspace",
        keyHints: "esc interrupt",
      });

      expect(visibleLength(divider)).toBe(38);
      expect(visibleLength(status)).toBe(38);
      expect(full.split("\n")).toHaveLength(2);
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("renders approval prompts with flattened argument values", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 56;
    try {
      const rendered = stripAnsi(approvalPrompt("bash", {
        command: "npm test -- --reporter=dot",
        workdir: "/tmp/workspace",
      }));

      expect(rendered).toContain("Approval required: bash");
      expect(rendered).toContain("command=npm test -- --reporter=dot");
      expect(rendered).toContain("workdir=/tm");
      expect(rendered).toContain("always allow");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });
});
