import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { ContextCompactor, estimateMessagesTokens, estimateTextTokens, isCompactionMarker, projectMessagesForRequest } from "../src/engine/compact.js";
import { buildSystemPrompt, buildToolsDescription } from "../src/engine/context.js";
import { buildPinnedPrefix, loadPinnedPrefixContext } from "../src/engine/prefix-builder.js";
import { ImmutablePrefix, PrefixManager, stripPinnedPrefixMessages, systemMessage } from "../src/engine/prefix.js";
import { clearHooks, fireHooks, getHooks, registerHook } from "../src/engine/hooks.js";
import { injectAgentsMd, readAgentsMd } from "../src/engine/agents-md.js";
import { createSession } from "../src/session/types.js";
import { ConversationHistory } from "../src/session/history.js";
import { deleteSession, listSessions, loadSession, saveSession } from "../src/session/store.js";
import { getRegistry } from "../src/tools/registry.js";

let tmp: string;
let oldHome: string | undefined;
let oldSeekcodeSessionsDir: string | undefined;
let oldDeepseekSessionsDir: string | undefined;
let oldCwd: string;

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
    context_limit: 200,
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
    status_items: ["mode", "model", "workspace"],
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
  tmp = mkdtempSync(join(tmpdir(), "seek-code-engine-reg-"));
  oldHome = process.env.HOME;
  oldSeekcodeSessionsDir = process.env.SEEKCODE_SESSIONS_DIR;
  oldDeepseekSessionsDir = process.env.DEEPSEEK_SESSIONS_DIR;
  oldCwd = process.cwd();
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.SEEKCODE_SESSIONS_DIR = join(tmp, "sessions");
  delete process.env.DEEPSEEK_SESSIONS_DIR;
  getRegistry().clear();
  clearHooks();
});

afterEach(() => {
  clearHooks();
  getRegistry().clear();
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldSeekcodeSessionsDir === undefined) delete process.env.SEEKCODE_SESSIONS_DIR;
  else process.env.SEEKCODE_SESSIONS_DIR = oldSeekcodeSessionsDir;
  if (oldDeepseekSessionsDir === undefined) delete process.env.DEEPSEEK_SESSIONS_DIR;
  else process.env.DEEPSEEK_SESSIONS_DIR = oldDeepseekSessionsDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("session persistence matrix", () => {
  it("sanitizes session ids on save and load", () => {
    const session = createSession({ id: "../bad id?.json", messages: [] });
    const savedId = saveSession(session);

    expect(savedId).toBe("badid");
    expect(loadSession("../bad id?.json")?.id).toBe("badid");
  });

  it("round-trips and normalizes sparse session records", () => {
    const session = createSession({
      id: "abc",
      title: "",
      messages: [
        { role: "user", content: "hello", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      ],
    });
    saveSession(session);

    const loaded = loadSession("abc")!;
    expect(loaded.title).toBe("hello");
    expect(loaded.workspace_path).toBe(process.cwd());
  });

  it("writes append-only session event logs next to JSON snapshots", () => {
    const session = createSession({ id: "eventful", messages: [] });

    saveSession(session);
    session.messages.push({ role: "user", content: "next", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null });
    saveSession(session);

    const logPath = join(process.env.SEEKCODE_SESSIONS_DIR!, "eventful.jsonl");
    const events = readFileSync(logPath, "utf-8").trim().split("\n").map(line => JSON.parse(line)) as Array<{ event: string; session_id: string; message_count: number }>;

    expect(existsSync(join(process.env.SEEKCODE_SESSIONS_DIR!, "eventful.json"))).toBe(true);
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ event: "session.saved", session_id: "eventful", message_count: 1 });
  });

  it("returns null for invalid session ids", () => {
    expect(loadSession("../../../")).toBeNull();
  });

  it("lists sessions with newest updates first", () => {
    const older = createSession({ id: "older", updated_at: "2024-01-01T00:00:00.000Z", messages: [] });
    const newer = createSession({ id: "newer", updated_at: "2024-01-02T00:00:00.000Z", messages: [] });
    saveSession(older);
    saveSession(newer);

    expect(listSessions().map(session => session.id).slice(0, 2)).toEqual(["newer", "older"]);
  });

  it("deletes sessions from disk", () => {
    const session = createSession({ id: "delete-me", messages: [] });
    saveSession(session);

    expect(deleteSession("delete-me")).toBe(true);
    expect(loadSession("delete-me")).toBeNull();
  });
});

describe("conversation history", () => {
  it("adds system, user, assistant, and tool messages in order", () => {
    const history = new ConversationHistory();
    history.addSystem("sys");
    history.addUser("user");
    history.addAssistant("assistant", [{ id: "call-1", name: "read", arguments: { path: "a.ts" } }], "think");
    history.addToolResult({ tool_call_id: "call-1", name: "read", content: "ok", is_error: false });

    expect(history.getMessages().map(message => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(history.approximateTokenCount()).toBeGreaterThan(0);
  });

  it("normalizes live history messages before they reach API projection", () => {
    const history = new ConversationHistory();
    history.addUser("bad\0user");
    history.addAssistant("ok", [
      { id: "call_good", name: "read", arguments: { path: "ok.ts" } },
      { id: "bad id", name: "read", arguments: { path: "bad.ts" } },
      { id: "call_bad_args", name: "write", arguments: ["bad"] as any },
    ], "bad\0reasoning");
    history.addToolResult({ tool_call_id: "bad id", name: "read", content: "drop", is_error: true });
    history.addToolResult({ tool_call_id: " call_good ", name: " read ", content: "bad\0content", is_error: "yes" as any });

    const messages = history.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("bad user");
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "ok",
      reasoning_content: "bad reasoning",
      tool_calls: [
        { id: "call_good", name: "read", arguments: { path: "ok.ts" } },
        { id: "call_bad_args", name: "write", arguments: {} },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_good",
      name: "read",
      content: "bad content",
      is_error: false,
    });
    expect(history.approximateTokenCount()).toBeGreaterThan(0);
  });

  it("returns defensive snapshots from live conversation history", () => {
    const history = new ConversationHistory();
    history.addAssistant("answer", [{ id: "call_1", name: "read", arguments: { path: "a.ts" } }], "think");

    const [message] = history.getMessages();
    message!.content = "mutated";
    message!.tool_calls![0]!.arguments.path = "changed.ts";
    message!.tool_calls!.push({ id: "call_2", name: "read", arguments: {} });

    expect(history.session.messages[0]).toMatchObject({
      content: "answer",
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "a.ts" } }],
    });
    expect(history.getMessages()[0]?.tool_calls).toHaveLength(1);
  });

  it("normalizes createSession option overrides instead of sharing unsafe mutable inputs", () => {
    const messages = [{ role: "user" as const, content: "hello", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null }];
    const artifactIndex = { session: [" art-1 ", "art-1", "bad\0id"] };
    const session = createSession({
      id: "../bad id?.json",
      title: "\0",
      mode: "bad-mode",
      model: " bad\0model ",
      workspace_path: `${tmp}\0bad`,
      cumulative_tokens_in: -1,
      cumulative_tokens_out: 1.5,
      cumulative_cost: -0.2,
      messages,
      artifact_index: artifactIndex,
      prefix_hash: "ABCDEF1234567890",
    } as any);

    messages[0]!.content = "mutated";
    artifactIndex.session.push("late");

    expect(session).toMatchObject({
      id: "badid",
      title: "Untitled session",
      mode: "agent",
      model: "bad model",
      cumulative_tokens_in: 0,
      cumulative_tokens_out: 0,
      cumulative_cost: 0,
      prefix_hash: "abcdef1234567890",
    });
    expect(session.workspace_path).toBe(process.cwd());
    expect(session.messages[0]?.content).toBe("hello");
    expect(session.artifact_index).toEqual({ session: ["art-1"] });
  });

  it("clears history messages", () => {
    const history = new ConversationHistory();
    history.addUser("hello");
    history.clear();
    expect(history.getMessages()).toEqual([]);
  });
});

describe("prompt and prefix helpers", () => {
  it.each([
    ["plan", "PLAN mode"],
    ["agent", "AGENT mode"],
    ["yolo", "YOLO mode"],
  ])("builds system prompts with mode context for %s", (mode, marker) => {
    const prompt = buildSystemPrompt(config({ mode: mode as any }), "/tmp/workspace", "- read");
    expect(prompt).toContain(marker);
    expect(prompt).toContain("/tmp/workspace");
    expect(prompt).toContain("Available Tools");
  });

  it("renders tool descriptions from tool defs", () => {
    const description = buildToolsDescription([
      { name: "read", description: "Read files", parameters: {}, execute: async () => "", permission: "always_allow" as any, category: "file", parallelOk: true },
      { name: "write", description: "Write files", parameters: {}, execute: async () => "", permission: "ask" as any, category: "file", parallelOk: false },
    ] as any);

    expect(description).toContain("**read**");
    expect(description).toContain("Write files");
  });

  it("tracks immutable prefix hashes, metadata, and tool names", () => {
    const prefix = new ImmutablePrefix({
      systemPrompt: "sys",
      toolSchemas: [{ function: { name: "read" } }, { function: { name: "write" } }] as any,
      fewShotMessages: [systemMessage("few")],
      memoryIndex: "extra",
    });

    expect(prefix.hash).toHaveLength(16);
    expect(prefix.metadata.tool_count).toBe(2);
    expect(prefix.hasTool("read")).toBe(true);
    expect(prefix.toolNames()).toEqual(new Set(["read", "write"]));
    expect(prefix.toMessages()).toHaveLength(2);
    expect(ImmutablePrefix.fromJSON(prefix.toJSON()).hash).toBe(prefix.hash);
  });

  it("normalizes non-JSON schema values without crashing prefix hashing or cloning", () => {
    const circular: any = { function: { name: "odd", extra: 12n }, skipped: undefined };
    circular.self = circular;
    const prefix = new ImmutablePrefix({
      systemPrompt: "sys",
      toolSchemas: [circular],
      fewShotMessages: [{ ...systemMessage("few"), tool_calls: null, metadata: { fn: () => "ignored" } } as any],
    });

    const schema = prefix.toolSchemas()[0] as any;
    const message = prefix.toMessages()[1] as any;

    expect(prefix.hash).toHaveLength(16);
    expect(prefix.hasTool("odd")).toBe(true);
    expect(schema.function.extra).toBe("12");
    expect(schema.skipped).toBeNull();
    expect(schema.self).toBe("[Circular]");
    expect(message.metadata.fn).toBeNull();
    expect(ImmutablePrefix.fromJSON(prefix.toJSON()).hash).toBe(prefix.hash);
  });

  it("does not mark shared sibling objects as circular during prefix normalization", () => {
    const shared = { value: "kept" };
    const prefix = new ImmutablePrefix({
      systemPrompt: "sys",
      toolSchemas: [{ function: { name: "odd", a: shared, b: shared } }],
      fewShotMessages: [],
    });

    const schema = prefix.toolSchemas()[0] as any;

    expect(schema.function.a).toEqual({ value: "kept" });
    expect(schema.function.b).toEqual({ value: "kept" });
  });

  it("replaces managed prefixes and strips only the pinned system message", () => {
    const first = new ImmutablePrefix({ systemPrompt: "sys-1" });
    const second = new ImmutablePrefix({ systemPrompt: "sys-2" });
    const manager = new PrefixManager(first);
    manager.replace(second);

    expect(manager.prefixHash).toBe(second.hash);
    expect(stripPinnedPrefixMessages([
      systemMessage("sys-2"),
      systemMessage("other"),
      { role: "user", content: "hello", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
    ], second).map(message => message.content)).toEqual(["other", "hello"]);
  });
});

describe("AGENTS.md and pinned prefix building", () => {
  it("reads hierarchical AGENTS.md content and injects it into prompts", () => {
    const root = join(tmp, "repo");
    const child = join(root, "packages", "app");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root rules\n");
    writeFileSync(join(child, "AGENTS.md"), "child rules\n");

    const result = readAgentsMd(child);
    expect(result.content).toContain("root rules");
    expect(result.content).toContain("child rules");
    expect(injectAgentsMd("base", child)).toContain("Project Context (AGENTS.md)");
  });

  it("loads Claude-compatible project instruction files as migration context", () => {
    const root = join(tmp, "claude-repo");
    const child = join(root, "pkg");
    mkdirSync(join(child, ".claude"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "root claude rules\n");
    writeFileSync(join(child, ".claude", "CLAUDE.md"), "child dot-claude rules\n");

    const result = readAgentsMd(child);
    expect(result.content).toContain("Claude Compatibility Context");
    expect(result.content).toContain("root claude rules");
    expect(result.content).toContain("child dot-claude rules");
    expect(injectAgentsMd("base", child)).toContain("Claude-compatible project instructions");
  });

  it("builds pinned prefixes with tool schemas and AGENTS.md-derived memory index", () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "workspace rules\n");
    getRegistry().register({
      name: "read",
      description: "Read files",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
      permission: "always_allow" as any,
      category: "file",
      parallelOk: true,
    });

    const prefix = buildPinnedPrefix(config(), workspace, getRegistry());
    expect(prefix.toolSchemas()).toHaveLength(1);
    expect(prefix.memoryIndex).toContain("Project Context");
    expect(prefix.systemPrompt).toContain("workspace rules");
  });

  it("keeps deferred tool schemas in the pinned prefix while hiding them from visible descriptions", () => {
    const workspace = join(tmp, "workspace-deferred");
    mkdirSync(workspace, { recursive: true });
    getRegistry().register({
      name: "deferred_reader",
      description: "Deferred reader",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
      permission: "always_allow" as any,
      category: "file",
      parallelOk: true,
      readOnly: true,
      deferLoading: true,
      searchHint: "deferred schema",
    });

    const prefix = buildPinnedPrefix(config(), workspace, getRegistry());
    const schemaNames = prefix.toolSchemas().map((schema: any) => schema.function.name);

    expect(schemaNames).toContain("deferred_reader");
    expect(prefix.hasTool("deferred_reader")).toBe(true);
    expect(prefix.systemPrompt).not.toContain("**deferred_reader**");
  });

  it("bounds visible tool descriptions and sanitizes workspace text in system prompts", () => {
    const prompt = buildSystemPrompt(
      config(),
      `/tmp/workspace\u0007/${"x".repeat(5000)}`,
      Array.from({ length: 400 }, (_, index) => `- **tool_${index}**: ${"d".repeat(1000)}`).join("\n"),
    );

    expect(prompt.length).toBeLessThanOrEqual(200_000);
    expect(prompt).not.toContain("\u0007");
    expect(prompt).toContain("tool_0");
    expect(prompt).not.toContain("tool_350");
  });

  it("sanitizes repeated controls across prompt, prefix, and projected context text", () => {
    const prompt = buildSystemPrompt(
      config(),
      "/tmp/workspace\u0000A\u0001B",
      "- **dirty_tool**: first\u0002second\u0003third",
    );
    const prefix = new ImmutablePrefix({
      systemPrompt: "sys\u0004a\u0005b",
      memoryIndex: "mem\u0006a\u0007b",
      toolSchemas: [{
        type: "function",
        function: {
          name: "dirty_tool",
          description: "desc\u0008a\u000Bb",
          parameters: { type: "object", properties: {} },
        },
      }],
      fewShotMessages: [{
        role: "assistant",
        content: "content\u000Ca\u000Eb",
        reasoning_content: "reason\u000Fa\u0010b",
        tool_calls: null,
        tool_call_id: null,
        name: null,
      }],
    });
    const projected = projectMessagesForRequest([{
      role: "tool",
      content: "tool\u0011a\u0012b",
      is_error: false,
      tool_calls: null,
      tool_call_id: "call",
      name: "dirty_tool",
      reasoning_content: null,
    } as any]);

    expect(prompt).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    expect(prefix.systemPrompt).toBe("sys a b");
    expect(prefix.memoryIndex).toBe("mem a b");
    expect(prefix.toMessages()[1]?.content).toBe("content a b");
    expect(prefix.toMessages()[1]?.reasoning_content).toBe("reason a b");
    expect(projected[0]?.content).toBe("tool a b");
  });

  it("bounds immutable prefix schemas, few-shot messages, and memory index", () => {
    const prefix = new ImmutablePrefix({
      systemPrompt: "sys\u0007" + "s".repeat(250_000),
      memoryIndex: "m".repeat(100_000),
      toolSchemas: Array.from({ length: 600 }, (_, index) => ({
        type: "function",
        function: {
          name: `tool_${index}`,
          description: "d".repeat(40_000),
          parameters: { type: "object", properties: { huge: { description: "x".repeat(40_000) } } },
        },
      })),
      fewShotMessages: Array.from({ length: 60 }, (_, index) => ({
        role: "user" as const,
        content: `few-${index}\u0001${"x".repeat(100_000)}`,
        tool_calls: null,
        tool_call_id: null,
        name: null,
        reasoning_content: null,
      })),
    });

    expect(prefix.systemPrompt.length).toBeLessThanOrEqual(200_000);
    expect(prefix.systemPrompt).not.toContain("\u0007");
    expect(prefix.memoryIndex?.length).toBe(80_000);
    expect(prefix.toolSchemas()).toHaveLength(512);
    expect(prefix.toolSchemas()[0]).toMatchObject({ function: { parameters: { type: "object", properties: {} } } });
    expect(prefix.toMessages()).toHaveLength(51);
    expect(prefix.toMessages()[1]?.content?.length).toBeLessThanOrEqual(80_000);
    expect(prefix.toMessages()[1]?.content).not.toContain("\u0001");
  });

  it("reuses prefetched AGENTS.md and skills context when building pinned prefixes", () => {
    const workspace = join(tmp, "workspace-prefetch");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "prefetched workspace rules\n");
    const cfg = config();
    getRegistry().register({
      name: "read",
      description: "Read files",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
      permission: "always_allow" as any,
      category: "file",
      parallelOk: true,
    });

    const prefetched = loadPinnedPrefixContext(cfg, workspace);
    const direct = buildPinnedPrefix(cfg, workspace, getRegistry());
    const eager = buildPinnedPrefix(cfg, workspace, getRegistry(), prefetched);

    expect(eager.hash).toBe(direct.hash);
    expect(eager.systemPrompt).toContain("prefetched workspace rules");
  });

  it("limits pinned prefixes to plan-safe tools in plan mode", () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace, { recursive: true });
    getRegistry().register({
      name: "read",
      description: "Read files",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
      permission: "always_allow" as any,
      category: "file",
      parallelOk: true,
      readOnly: true,
    });
    getRegistry().register({
      name: "write",
      description: "Write files",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
      permission: "ask" as any,
      category: "file",
      parallelOk: false,
      destructive: true,
    });
    getRegistry().register({
      name: "bash",
      description: "Shell",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
      permission: "ask" as any,
      category: "shell",
      parallelOk: false,
    });
    getRegistry().register({
      name: "tool_enable",
      description: "Enable tool",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
      permission: "always_allow" as any,
      category: "meta",
      parallelOk: true,
    });

    const prefix = buildPinnedPrefix(config({ mode: "plan" as any }), workspace, getRegistry());
    const names = prefix.toolSchemas().map((schema: any) => schema.function.name);

    expect(names).toContain("read");
    expect(names).not.toContain("write");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("tool_enable");
    expect(prefix.systemPrompt).not.toContain("**write**");
    expect(prefix.systemPrompt).not.toContain("**bash**");
    expect(prefix.systemPrompt).not.toContain("**tool_enable**");
  });
});

describe("context compaction and projection", () => {
  it("uses tokenizer-backed exact text token estimation", () => {
    expect(estimateTextTokens("hello")).toBe(1);
    expect(estimateMessagesTokens([
      { role: "user", content: "hello", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
    ])).toBeGreaterThan(1);
  });

  it("estimates tokens from content, reasoning, and tool calls", () => {
    const tokens = estimateMessagesTokens([
      {
        role: "assistant",
        content: "abcd",
        tool_calls: [{ id: "call", name: "read", arguments: { path: "a.ts" } }],
        tool_call_id: null,
        name: null,
        reasoning_content: "efgh",
      },
    ]);

    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates tokens for non-JSON tool arguments without throwing", () => {
    const args: Record<string, unknown> = { count: 1n, missing: undefined, fn: () => "ignored" };
    args.self = args;

    expect(estimateMessagesTokens([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call", name: "write", arguments: args }],
        tool_call_id: null,
        name: null,
        reasoning_content: null,
      },
    ])).toBeGreaterThan(0);
  });

  it("does not compact when there are too few non-system messages", () => {
    const history = new ConversationHistory(createSession({
      messages: [
        systemMessage("sys"),
        { role: "user", content: "one", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
        { role: "assistant", content: "two", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      ],
    }));
    const compactor = new ContextCompactor(config({ context_limit: 1 }));

    const result = compactor.compact(history);
    expect(result.prefix_invalidated).toBe(false);
    expect(result.removed_messages).toBe(0);
  });

  it("opens a circuit breaker after repeated compaction failures", () => {
    const history = new ConversationHistory(createSession({
      messages: [
        systemMessage("sys"),
        { role: "user", content: "one", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
        { role: "assistant", content: "two", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      ],
    }));
    const compactor = new ContextCompactor(config({ context_limit: 1 }));

    const first = compactor.compact(history);
    const second = compactor.compact(history);
    const third = compactor.compact(history);

    expect(first.status).toBe("failed");
    expect(second.status).toBe("failed");
    expect(second.circuit_open).toBe(true);
    expect(third.status).toBe("skipped");
    expect(third.circuit_open).toBe(true);
    expect(history.session.messages.some(isCompactionMarker)).toBe(false);
  });

  it("creates compaction boundaries and summary markers under pressure", () => {
    const messages = [systemMessage("sys")];
    for (let index = 0; index < 16; index++) {
      messages.push({ role: "user", content: `user-${index} ` + "x".repeat(40), tool_calls: null, tool_call_id: null, name: null, reasoning_content: null });
      messages.push({
        role: "assistant",
        content: `assistant-${index}`,
        tool_calls: [{ id: `call-${index}`, name: "read", arguments: { path: `file-${index}.ts` } }],
        tool_call_id: null,
        name: null,
        reasoning_content: "reason".repeat(10),
      });
      messages.push({ role: "tool", content: "tool-result ".repeat(40), tool_calls: null, tool_call_id: `call-${index}`, name: "read", reasoning_content: null, is_error: false });
    }
    const history = new ConversationHistory(createSession({ messages }));
    const compactor = new ContextCompactor(config({ context_limit: 100 }));

    const result = compactor.compact(history);
    expect(result.prefix_invalidated).toBe(true);
    expect(result.boundary_id).toMatch(/^compact_/);
    expect(history.session.messages.some(message => message.name === "context_compaction_boundary")).toBe(true);
    expect(history.session.messages.some(message => message.name === "context_summary")).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it("projects only the latest compaction boundary forward into requests", () => {
    const messages = [
      systemMessage("sys"),
      {
        role: "system",
        name: "context_compaction_boundary",
        content: "boundary_id: old\npreserve_from_index: 1",
        tool_calls: null,
        tool_call_id: null,
        reasoning_content: null,
      },
      {
        role: "system",
        name: "context_summary",
        content: "old summary",
        tool_calls: null,
        tool_call_id: null,
        reasoning_content: null,
      },
      { role: "user", content: "middle", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      {
        role: "system",
        name: "context_compaction_boundary",
        content: "boundary_id: latest\npreserve_from_index: 3",
        tool_calls: null,
        tool_call_id: null,
        reasoning_content: null,
      },
      {
        role: "system",
        name: "context_summary",
        content: "latest summary",
        tool_calls: null,
        tool_call_id: null,
        reasoning_content: null,
      },
      { role: "assistant", content: "tail", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
    ];

    const projected = projectMessagesForRequest(messages);
    expect(projected[0]?.content).toContain("boundary_id: latest");
    expect(projected[1]?.content).toBe("latest summary");
    expect(projected.some(isCompactionMarker)).toBe(true);
    expect(projected.some(message => message.content === "old summary")).toBe(false);
  });

  it("bounds request projections without mutating the stored transcript", () => {
    const messages = Array.from({ length: 260 }, (_, index) => ({
      role: "user" as const,
      content: `msg-${index}\u0007${"x".repeat(130_000)}`,
      tool_calls: null,
      tool_call_id: null,
      name: null,
      reasoning_content: null,
    }));

    const projected = projectMessagesForRequest(messages);

    expect(projected).toHaveLength(200);
    expect(projected[0]?.content).toContain("msg-60");
    expect(projected[0]?.content?.length).toBeLessThanOrEqual(120_000);
    expect(projected[0]?.content).not.toContain("\u0007");
    expect(messages[60]?.content?.length).toBeGreaterThan(120_000);
  });

  it("bounds projected request text on full grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const projected = projectMessagesForRequest([
      {
        role: "user",
        content: `${"x".repeat(119_995)}${family}tail`,
        tool_calls: null,
        tool_call_id: null,
        name: null,
        reasoning_content: null,
      },
      {
        role: "assistant",
        content: "ok",
        reasoning_content: `${"r".repeat(19_995)}${family}tail`,
        tool_calls: null,
        tool_call_id: null,
        name: null,
      },
    ]);

    expect(projected[0]?.content).not.toContain(family);
    expect(projected[0]?.content).not.toContain("\u200d");
    expect(projected[1]?.reasoning_content).not.toContain(family);
    expect(projected[1]?.reasoning_content).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(projected[0]?.content || "")).toBe(false);
    expect(hasUnpairedSurrogate(projected[1]?.reasoning_content || "")).toBe(false);
  });

  it("bounds projected reasoning blocks and tool calls", () => {
    const projected = projectMessagesForRequest([
      {
        role: "assistant",
        content: "ok",
        reasoning_content: "r".repeat(30_000),
        tool_calls: Array.from({ length: 80 }, (_, index) => ({ id: `call_${index}`, name: "read", arguments: { path: `f${index}.ts` } })),
        tool_call_id: null,
        name: null,
      },
    ]);

    expect(projected[0]?.reasoning_content?.length).toBe(20_000);
    expect(projected[0]?.tool_calls).toHaveLength(50);
  });

  it("bounds tool descriptions on full grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const description = buildToolsDescription([
      {
        name: `${"x".repeat(75)}${family}tail`,
        description: `${"d".repeat(1_995)}${family}tail`,
        parameters: { type: "object", properties: {} },
        execute: async () => "ok",
      },
    ]);

    expect(description).not.toContain(family);
    expect(description).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(description)).toBe(false);
  });

  it("keeps token estimation finite for huge or control-heavy values", () => {
    const tokens = estimateMessagesTokens([
      {
        role: "user",
        content: "\u0001" + "x".repeat(3_000_000),
        tool_calls: null,
        tool_call_id: null,
        name: null,
        reasoning_content: null,
      },
    ]);

    expect(Number.isSafeInteger(tokens)).toBe(true);
    expect(tokens).toBeGreaterThan(0);
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

describe("hooks", () => {
  it("matches wildcard hook tool patterns", async () => {
    registerHook({
      event: "PreToolUse",
      matcher: "read*",
      command: `${process.execPath} -e "console.log(JSON.stringify({decision:'approve'}))"`,
    });

    const result = await fireHooks("PreToolUse", { tool_name: "read_file", tool_input: { path: "a.ts" } });
    expect(result).toMatchObject({ decision: "approve", fired: 1 });
  });

  it("does not fire matched hooks when the event has no valid tool name", async () => {
    registerHook({
      event: "PreToolUse",
      matcher: "bash",
      command: `${process.execPath} -e "console.log(JSON.stringify({decision:'deny', message:'blocked'}))"`,
    });

    await expect(fireHooks("PreToolUse", { tool_input: { command: "pwd" } })).resolves.toMatchObject({
      decision: "continue",
      fired: 0,
    });
    await expect(fireHooks("PreToolUse", { tool_name: "\u0000", tool_input: { command: "pwd" } })).resolves.toMatchObject({
      decision: "continue",
      fired: 0,
    });
  });

  it("escapes hook matcher metacharacters and ignores malformed hook controls", async () => {
    registerHook({
      event: "PreToolUse",
      matcher: "read.*",
      command: `${process.execPath} -e "console.log(JSON.stringify({decision:'deny', message:'escaped'}))"`,
    });
    registerHook({
      event: "Stop",
      command: "" as any,
    });
    registerHook({
      event: "Stop",
      command: `${process.execPath} -e "console.log(JSON.stringify({message:'kept'}))"`,
      timeout: -1,
    });

    await expect(fireHooks("PreToolUse", { tool_name: "read_file", tool_input: { path: "a.ts" } })).resolves.toMatchObject({
      decision: "continue",
      fired: 0,
    });
    await expect(fireHooks("PreToolUse", { tool_name: "read.any", tool_input: { path: "a.ts" } })).resolves.toMatchObject({
      decision: "deny",
      message: "escaped",
      fired: 1,
    });
    await expect(fireHooks("Stop")).resolves.toMatchObject({
      decision: "continue",
      message: "kept",
      fired: 1,
    });
  });

  it("returns plain-text hook output as a message when JSON parsing fails", async () => {
    registerHook({
      event: "Stop",
      command: `${process.execPath} -e "console.log('plain output')"`,
    });

    const result = await fireHooks("Stop");
    expect(result).toMatchObject({ decision: "continue", message: "plain output", fired: 1 });
  });

  it("passes the canonical SEEKCODE hook event environment variable", async () => {
    registerHook({
      event: "Stop",
      command: `${process.execPath} -e "console.log(JSON.stringify({message: process.env.SEEKCODE_HOOK_EVENT + '/' + process.env.DEEPSEEK_HOOK_EVENT}))"`,
    });

    const result = await fireHooks("Stop");

    expect(result).toMatchObject({ decision: "continue", message: "Stop/Stop", fired: 1 });
  });

  it("reports hook execution failures and timeouts as continue", async () => {
    registerHook({
      event: "Stop",
      command: `${process.execPath} -e "process.exit(2)"`,
    });
    registerHook({
      event: "Stop",
      command: `${process.execPath} -e "setTimeout(()=>{}, 50)"`,
      timeout: 1,
    });

    const result = await fireHooks("Stop");
    expect(result.decision).toBe("continue");
    expect(result.message).toMatch(/Hook exited with code|Hook timed out/);
    expect(result.fired).toBe(2);
  });

  it("bounds and sanitizes hook registration, output, and modified inputs", async () => {
    const family = "👨‍👩‍👧‍👦";
    const hookFile = join(tmp, "hook-boundary.mjs");
    writeFileSync(hookFile, `process.stdout.write("plain\\\\u0000" + "x".repeat(1990) + ${JSON.stringify(family)});\n`);
    registerHook({
      event: "PreToolUse",
      matcher: "read\u0000*",
      command: `${process.execPath} ${JSON.stringify(hookFile)}`,
    });
    registerHook({
      event: "PreToolUse",
      matcher: "read\u0000*",
      command: `${process.execPath} -e "console.log(JSON.stringify({decision:'deny-now', message:'ignored', modified_input:{path:'x'}}))"`,
    });
    registerHook({
      event: "PreToolUse",
      command: "x".repeat(5000),
    });

    const noMatch = await fireHooks("PreToolUse", { tool_name: "read_file" });
    expect(noMatch.fired).toBe(0);

    const result = await fireHooks("PreToolUse", { tool_name: "read *" });
    expect(result.fired).toBe(2);
    expect(result.decision).toBe("continue");
    expect(result.message).not.toContain("\u0000");
    expect(result.message).not.toContain("\u200d");
    expect(result.message!.length).toBeLessThanOrEqual(2000);
    expect(hasUnpairedSurrogate(result.message || "")).toBe(false);
    expect(result.modified_input).toEqual({ path: "x" });
  });

  it("bounds hook payloads and ignores unsafe hook config values", async () => {
    registerHook({
      event: "PostToolUse",
      command: `${process.execPath} -e "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => console.log(JSON.stringify({message: String(JSON.parse(s).tool_input.__truncated === true)})));"`,
    });

    const largeInput: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 160 }, (_, index) => [`key_${index}`, "x".repeat(4_000)]),
    );
    const result = await fireHooks("PostToolUse", {
      tool_name: "bash",
      tool_input: largeInput,
      tool_result: "y".repeat(100_000),
      session_id: "session\u0000id",
    });

    expect(result).toMatchObject({ decision: "continue", message: "true", fired: 1 });

    clearHooks();
    registerHook({
      event: "NotARealHook" as any,
      command: `${process.execPath} -e "console.log(JSON.stringify({message:'bad'}))"`,
    });
    for (let index = 0; index < 140; index++) {
      registerHook({
        event: "PostToolUse",
        command: `${process.execPath} -e "console.log(JSON.stringify({message:'ok'}))"`,
      });
    }

    expect(getHooks()).toHaveLength(128);
  });

  it("returns defensive hook config snapshots", () => {
    registerHook({
      event: "Stop",
      command: `${process.execPath} -e "console.log(JSON.stringify({message:'kept'}))"`,
    });

    const snapshot = getHooks();
    snapshot[0]!.command = "mutated";
    snapshot[0]!.event = "PreToolUse";

    expect(getHooks()[0]).toMatchObject({
      event: "Stop",
      command: expect.stringContaining("console.log"),
    });
  });
});
