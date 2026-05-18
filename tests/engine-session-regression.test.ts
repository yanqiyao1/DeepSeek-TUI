import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { ContextCompactor, estimateMessagesTokens, estimateTextTokens, isCompactionMarker, projectMessagesForRequest } from "../src/engine/compact.js";
import { buildSystemPrompt, buildToolsDescription } from "../src/engine/context.js";
import { buildPinnedPrefix, loadPinnedPrefixContext } from "../src/engine/prefix-builder.js";
import { ImmutablePrefix, PrefixManager, stripPinnedPrefixMessages, systemMessage } from "../src/engine/prefix.js";
import { clearHooks, fireHooks, registerHook } from "../src/engine/hooks.js";
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
});

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
});
