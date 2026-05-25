import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CapacityController, formatCapacityDecision } from "../src/engine/capacity.js";
import { DEFAULT_TOOL_RESULT_MAX_CHARS, applyToolResultBudget } from "../src/engine/tool-result-budget.js";
import { homeDir, legacyDeepseekDataPath, seekcodeDataPath, xdgDataHome } from "../src/paths.js";
import { createSession, messageToApiDict, toolCallFromApi } from "../src/session/types.js";
import { deriveSessionTitle, refreshSessionTitle, summarizeForLabel } from "../src/session/title.js";
import { charWidth, fitAnsi, padAnsi, stripAnsi, truncateAnsi, visibleLength, wrapAnsi, wrapAnsiLine } from "../src/ui/ansi.js";
import { renderMarkdown, thinkingMarkdownStyle } from "../src/ui/markdown.js";
import { PACKAGE_INFO } from "../src/version.js";
import { safeJsonStringify, stableJsonStringify } from "../src/utils/json-safe.js";

let tmp: string;
let oldHome: string | undefined;
let oldXdgDataHome: string | undefined;
let oldCwd: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-helpers-"));
  oldHome = process.env.HOME;
  oldXdgDataHome = process.env.XDG_DATA_HOME;
  oldCwd = process.cwd();
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  delete process.env.XDG_DATA_HOME;
});

afterEach(() => {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldXdgDataHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("ANSI helper matrix", () => {
  it.each([
    ["a", 1],
    ["你", 2],
    ["🙂", 2],
    ["\u0301", 0],
    ["\u0007", 0],
  ])("measures char width for %j", (char, expected) => {
    expect(charWidth(char)).toBe(expected);
  });

  it.each([
    ["plain", "plain"],
    ["\x1b[31mred\x1b[0m", "red"],
    ["\x1b[1m\x1b[32mbold green\x1b[0m", "bold green"],
  ])("strips ANSI for %j", (input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });

  it.each([
    ["abc", 3],
    ["你a", 3],
    ["\x1b[31m你\x1b[0m🙂", 4],
    ["a\u0301", 1],
  ])("computes visible length for %j", (input, expected) => {
    expect(visibleLength(input)).toBe(expected);
  });

  it.each([
    ["abc", 5, "abc  "],
    ["你", 4, "你  "],
    ["\x1b[31mab\x1b[0m", 4, "\x1b[31mab\x1b[0m  "],
  ])("pads ANSI-aware text for %j", (input, width, expected) => {
    expect(padAnsi(input, width)).toBe(expected);
  });

  it.each([
    ["abcdef", 4, "", "abcd"],
    ["abcdef", 4, "...", "a..."],
    ["\x1b[31mabcdef\x1b[0m", 3, "", "\x1b[31mabc\x1b[0m"],
  ])("truncates ANSI-aware text for %j", (input, width, suffix, expected) => {
    expect(truncateAnsi(input, width, suffix)).toBe(expected);
  });

  it.each([
    ["abc", 5, "abc  "],
    ["abcdef", 4, "abcd"],
    ["\x1b[31mab\x1b[0m", 4, "\x1b[31mab\x1b[0m  "],
  ])("fits ANSI-aware text to width for %j", (input, width, expected) => {
    expect(fitAnsi(input, width)).toBe(expected);
  });

  it.each([
    ["abcdef", 3, ["abc", "def"]],
    ["你好吗", 4, ["你好", "吗"]],
    ["", 4, [""]],
  ])("wraps a single ANSI line for %j", (input, width, expected) => {
    expect(wrapAnsiLine(input, width)).toEqual(expected);
  });

  it.each([
    ["a\nb", 4, ["a", "b"]],
    ["abcdef", 2, ["ab", "cd", "ef"]],
    ["a\r\nb\r\nc", 10, ["a", "b", "c"]],
  ])("wraps multi-line ANSI text for %j", (input, width, expected) => {
    expect(wrapAnsi(input, width)).toEqual(expected);
  });
});

describe("JSON safe helpers", () => {
  it("serializes objects and arrays with throwing getters without throwing", () => {
    const hostile: Record<string, unknown> = { ok: true };
    Object.defineProperty(hostile, "bad", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });
    const hostileArray: unknown[] = ["first"];
    Object.defineProperty(hostileArray, "1", {
      enumerable: true,
      get() {
        throw new Error("array getter failed");
      },
    });

    expect(() => safeJsonStringify({ hostile, hostileArray })).not.toThrow();
    expect(safeJsonStringify({ hostile })).toContain("\"truncated\":true");
    expect(stableJsonStringify({ hostileArray })).toContain("\"truncated\":true");
  });
});

describe("markdown rendering matrix", () => {
  it.each([
    ["plain text", "plain text"],
    ["# Title", "Title"],
    ["> quote", "│ quote"],
    ["1. first", "• first"],
    ["- item", "• item"],
    ["inline `code`", "inline code"],
    ["**bold**", "bold"],
    ["*italic*", "italic"],
    ["unfinished *italic", "unfinished *italic"],
  ])("renders markdown %j", (input, expected) => {
    expect(stripAnsi(renderMarkdown(input))).toBe(expected);
  });

  it("renders fenced code blocks and thinking styles", () => {
    const rendered = renderMarkdown("```ts\nconst x = 1;\n```", { style: thinkingMarkdownStyle });
    expect(stripAnsi(rendered)).toContain("│ ts");
    expect(stripAnsi(rendered)).toContain("│ const x = 1;");
  });
});

describe("session title helpers", () => {
  it.each([
    ["hello", 120, "hello"],
    ["", 120, "Untitled session"],
    ["line one\nline two", 120, "line one"],
    ["🙂🙂🙂🙂", 3, "..."],
    ["abcdef", 5, "ab..."],
  ])("summarizes labels from %j", (text, maxLen, expected) => {
    expect(summarizeForLabel(text, maxLen)).toBe(expected);
  });

  it("derives and refreshes session titles from the first non-empty user message", () => {
    const session = createSession({
      title: "",
      messages: [
        { role: "system", content: "sys", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
        { role: "user", content: "   ", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
        { role: "user", content: "Real title", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      ],
    });

    expect(deriveSessionTitle(session)).toBe("Real title");
    expect(refreshSessionTitle(session)).toBe("Real title");
    expect(session.title).toBe("Real title");
  });
});

describe("path helpers", () => {
  it("prefers HOME and XDG_DATA_HOME environment overrides", () => {
    process.env.HOME = "/tmp/home-paths";
    process.env.XDG_DATA_HOME = "/tmp/xdg-data";

    expect(homeDir()).toBe("/tmp/home-paths");
    expect(xdgDataHome()).toBe("/tmp/xdg-data");
    expect(seekcodeDataPath("sessions")).toBe("/tmp/xdg-data/seekcode/sessions");
    expect(legacyDeepseekDataPath("sessions")).toBe("/tmp/xdg-data/deepseek/sessions");
  });

  it("falls back to HOME/.local/share when XDG_DATA_HOME is unset", () => {
    process.env.HOME = "/tmp/fallback-home";
    delete process.env.XDG_DATA_HOME;

    expect(xdgDataHome()).toBe("/tmp/fallback-home/.local/share");
  });
});

describe("session type helpers", () => {
  it("serializes messages for the API including tool calls and reasoning content", () => {
    expect(messageToApiDict({
      role: "assistant",
      content: "hello",
      tool_calls: [{ id: "call-1", name: "read", arguments: { path: "a.ts" } }],
      tool_call_id: null,
      name: null,
      reasoning_content: "think",
    })).toEqual({
      role: "assistant",
      content: "hello",
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: {
          name: "read",
          arguments: JSON.stringify({ path: "a.ts" }),
        },
      }],
      reasoning_content: "think",
    });
  });

  it.each([
    [{ id: "call-1", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }, { id: "call-1", name: "read", arguments: { path: "a.ts" } }],
    [{ id: "call-2", function: { name: "read", arguments: "{bad" } }, { id: "call-2", name: "read", arguments: {} }],
    [{ id: "call-3", function: { name: "read", arguments: { path: "b.ts" } } }, { id: "call-3", name: "read", arguments: { path: "b.ts" } }],
  ])("parses API tool calls from %j", (input, expected) => {
    expect(toolCallFromApi(input as any)).toEqual(expected);
  });

  it("skips malformed API tool call fields instead of coercing objects into live tool-call state", () => {
    expect(toolCallFromApi({
      id: { nested: true } as any,
      function: {
        name: { nested: true } as any,
        arguments: ["bad"] as any,
      },
    } as any)).toEqual({
      id: "",
      name: "",
      arguments: {},
    });
  });

  it("filters unsafe API message tool metadata instead of serializing invalid tool calls", () => {
    const apiMessage = messageToApiDict({
      role: "assistant",
      content: "bad\0content",
      reasoning_content: "bad\0reasoning",
      tool_calls: [
        { id: "call_good", name: "read", arguments: { path: "ok.ts" } },
        { id: "bad id", name: "read", arguments: { path: "bad.ts" } },
        { id: "call_missing_name", name: "", arguments: { path: "bad.ts" } },
        { id: "call_bad_args", name: "write", arguments: ["not-object"] as any },
      ],
      tool_call_id: "bad id",
      name: "bad name",
    });

    expect(apiMessage).toEqual({
      role: "assistant",
      content: "bad content",
      reasoning_content: "bad reasoning",
      tool_calls: [
        {
          id: "call_good",
          type: "function",
          function: { name: "read", arguments: "{\"path\":\"ok.ts\"}" },
        },
        {
          id: "call_bad_args",
          type: "function",
          function: { name: "write", arguments: "{}" },
        },
      ],
    });
  });

  it("normalizes direct and OpenAI-shaped API tool calls with safe ids and names only", () => {
    expect(toolCallFromApi({
      id: " call_direct ",
      name: "write",
      arguments: { path: "ok.ts" },
    } as any)).toEqual({
      id: "call_direct",
      name: "write",
      arguments: { path: "ok.ts" },
    });
    expect(toolCallFromApi({
      id: "call bad",
      name: "bad name",
      arguments: { path: "bad.ts" },
    } as any)).toEqual({
      id: "",
      name: "",
      arguments: { path: "bad.ts" },
    });
  });
});

describe("capacity helpers", () => {
  it.each([
    [10, 100, "low", "no_intervention"],
    [60, 100, "medium", "verify_with_tool_replay"],
    [80, 100, "high", "targeted_context_refresh"],
    [95, 100, "high", "verify_and_replan"],
    [-5, 100, "low", "no_intervention"],
    [Number.NaN, Number.POSITIVE_INFINITY, "low", "no_intervention"],
  ])("classifies capacity for used=%i limit=%i", (used, limit, risk, action) => {
    const decision = new CapacityController().observe(used, limit);
    expect(decision.risk).toBe(risk);
    expect(decision.action).toBe(action);
    expect(decision.used_tokens).toBeGreaterThanOrEqual(0);
    expect(decision.context_limit).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(decision.used_ratio)).toBe(true);
  });

  it("formats capacity decisions into readable summaries", () => {
    const text = formatCapacityDecision(new CapacityController().observe(72, 100));
    expect(text).toContain("risk:");
    expect(text).toContain("action:");
    expect(text).toContain("context:");
    expect(text).toContain("reason:");
  });

  it("formats malformed capacity decisions without leaking NaN", () => {
    const text = formatCapacityDecision({
      used_tokens: Number.NaN,
      context_limit: Number.POSITIVE_INFINITY,
      used_ratio: Number.NaN,
      risk: "bad" as any,
      action: "bad" as any,
      reason: "bad\u0000telemetry" + "x".repeat(500),
    });

    expect(text).toContain("0 / 1");
    expect(text).toContain("risk: low");
    expect(text).toContain("action: no_intervention");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("\u0000");
  });

  it("normalizes malformed capacity threshold configuration", () => {
    const decision = new CapacityController({
      lowRiskMax: Number.NaN,
      mediumRiskMax: -1,
      severeMinSlack: 2,
    }).observe(60, 100);

    expect(decision.risk).toBe("medium");
    expect(decision.action).toBe("verify_with_tool_replay");
  });
});

describe("tool result budgeting", () => {
  it("keeps small results inline and exposes the default budget constant", () => {
    const result = applyToolResultBudget({
      toolName: "read",
      toolCallId: "call-1",
      content: "small output",
      isError: false,
    });

    expect(DEFAULT_TOOL_RESULT_MAX_CHARS).toBe(50_000);
    expect(result).toMatchObject({
      content: "small output",
      artifactIds: [],
      replaced: false,
    });
  });

  it("stores oversized results as artifacts with a preview", () => {
    const result = applyToolResultBudget({
      toolName: "read/file",
      toolCallId: "call 1",
      content: "x".repeat(6000),
      isError: false,
      maxChars: 100,
      sessionId: "session-1",
    });

    expect(result.replaced).toBe(true);
    expect(result.artifactIds).toHaveLength(1);
    expect(result.content).toContain("[Tool result stored as artifact]");
    expect(result.content).toContain("tool: read/file");
    expect(result.content).toContain("tool_call_id: call 1");
    expect(result.content).toContain("[preview]");
    expect(result.originalChars).toBe(6000);
    expect(result.originalBytes).toBe(6000);
  });

  it("omits preview content when the preview budget is zero", () => {
    const result = applyToolResultBudget({
      toolName: "read",
      toolCallId: "call-1",
      content: "x".repeat(100),
      isError: false,
      maxChars: 0,
    });

    expect(result.replaced).toBe(true);
    expect(result.content).toContain("[preview omitted by tool result budget]");
  });
});

describe("package info", () => {
  it("reads package metadata with non-empty name and version", () => {
    expect(PACKAGE_INFO.name).toBe("seekcode");
    expect(PACKAGE_INFO.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
