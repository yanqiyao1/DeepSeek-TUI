import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CostTracker } from "../src/cost/tracker.js";
import { deleteSession, saveSession, loadSession, listSessions } from "../src/session/store.js";
import { createSession, messageToApiDict, normalizeToolCalls, safeSessionString } from "../src/session/types.js";
import { deriveSessionTitle, normalizeSessionTitle, summarizeForLabel } from "../src/session/title.js";

let tmp: string;
let oldXdg: string | undefined;
let oldSeekSessionsDir: string | undefined;
let oldSessionsDir: string | undefined;
let oldCwd: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-sessions-"));
  oldXdg = process.env.XDG_DATA_HOME;
  oldSeekSessionsDir = process.env.SEEKCODE_SESSIONS_DIR;
  oldSessionsDir = process.env.DEEPSEEK_SESSIONS_DIR;
  oldCwd = process.cwd();
  process.env.XDG_DATA_HOME = tmp;
  delete process.env.SEEKCODE_SESSIONS_DIR;
  delete process.env.DEEPSEEK_SESSIONS_DIR;
});

afterEach(() => {
  process.chdir(oldCwd);
  if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldXdg;
  if (oldSeekSessionsDir === undefined) delete process.env.SEEKCODE_SESSIONS_DIR;
  else process.env.SEEKCODE_SESSIONS_DIR = oldSeekSessionsDir;
  if (oldSessionsDir === undefined) delete process.env.DEEPSEEK_SESSIONS_DIR;
  else process.env.DEEPSEEK_SESSIONS_DIR = oldSessionsDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("session titles", () => {
  it("uses the first user message as a compact label", () => {
    expect(summarizeForLabel("  Fix load/save bugs\nwith details")).toBe("Fix load/save bugs");
    expect(normalizeSessionTitle("bad\u0000 title\twith   space")).toBe("bad title with space");

    const session = createSession();
    session.messages.push({ role: "system", content: "sys" });
    session.messages.push({ role: "user", content: "Add footer cwd display" });

    expect(deriveSessionTitle(session)).toBe("Add footer cwd display");
  });

  it("bounds loaded session titles before they reach session pickers", () => {
    const family = "👨‍👩‍👧‍👦";
    const title = normalizeSessionTitle(`${"x".repeat(118)}${family}tail`);

    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("...")).toBe(true);
    expect(title).not.toContain(family);
    expect(title).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(title)).toBe(false);
  });
});

describe("session store", () => {
  it("saves, lists, and loads title and workspace metadata", () => {
    const session = createSession({ id: "abc123", workspace_path: "/tmp/project", model: "deepseek-v4-pro", mode: "yolo" });
    session.messages.push({ role: "system", content: "sys" });
    session.messages.push({ role: "user", content: "Restore this useful session" });
    session.cumulative_tokens_in = 10;
    session.cumulative_tokens_out = 5;
    session.cumulative_cost = 0.001;

    saveSession(session);
    const listed = listSessions();
    const loaded = loadSession("abc123");

    expect(listed[0]).toMatchObject({
      id: "abc123",
      title: "Restore this useful session",
      workspace_path: "/tmp/project",
      message_count: 1,
    });
    expect(loaded?.title).toBe("Restore this useful session");
    expect(loaded?.workspace_path).toBe("/tmp/project");
  });

  it("preserves explicit session titles while still deriving default titles", () => {
    const custom = createSession({ id: "custom-title", title: "Pinned investigation" });
    custom.messages.push({ role: "user", content: "This should not replace the title" });
    const automatic = createSession({ id: "auto-title", title: "Untitled session" });
    automatic.messages.push({ role: "user", content: "Use this automatic title" });

    saveSession(custom);
    saveSession(automatic);

    expect(loadSession("custom-title")?.title).toBe("Pinned investigation");
    expect(loadSession("auto-title")?.title).toBe("Use this automatic title");
  });

  it("loads the newest duplicate session across storage locations", () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    process.chdir(workspace);

    const primary = join(tmp, "seekcode", "sessions");
    const fallback = join(workspace, ".seekcode", "sessions");
    mkdirSync(primary, { recursive: true });
    mkdirSync(fallback, { recursive: true });
    writeFileSync(join(primary, "dup.json"), JSON.stringify(createSession({
      id: "dup",
      title: "Old title",
      updated_at: "2024-01-01T00:00:00.000Z",
      workspace_path: "/tmp/old",
    })));
    writeFileSync(join(fallback, "dup.json"), JSON.stringify(createSession({
      id: "dup",
      title: "New title",
      updated_at: "2026-01-01T00:00:00.000Z",
      workspace_path: "/tmp/new",
    })));

    expect(loadSession("dup")?.workspace_path).toBe("/tmp/new");
    expect(listSessions().find(session => session.id === "dup")?.workspace_path).toBe("/tmp/new");
  });

  it("uses file mtimes to choose duplicate sessions with invalid updated_at values", () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    process.chdir(workspace);

    const primary = join(tmp, "seekcode", "sessions");
    const fallback = join(workspace, ".seekcode", "sessions");
    mkdirSync(primary, { recursive: true });
    mkdirSync(fallback, { recursive: true });
    const oldFile = join(primary, "dup-invalid.json");
    const newFile = join(fallback, "dup-invalid.json");
    writeFileSync(oldFile, JSON.stringify(createSession({
      id: "dup-invalid",
      title: "Old invalid date",
      updated_at: "not-a-date",
      workspace_path: "/tmp/old-invalid",
    })));
    writeFileSync(newFile, JSON.stringify(createSession({
      id: "dup-invalid",
      title: "New invalid date",
      updated_at: "not-a-date",
      workspace_path: "/tmp/new-invalid",
    })));
    utimesSync(oldFile, new Date("2024-01-01T00:00:00.000Z"), new Date("2024-01-01T00:00:00.000Z"));
    utimesSync(newFile, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));

    expect(loadSession("dup-invalid")?.workspace_path).toBe("/tmp/new-invalid");
    expect(listSessions().find(session => session.id === "dup-invalid")?.workspace_path).toBe("/tmp/new-invalid");
  });

  it("loads legacy deepseek session directories as compatibility fallbacks", () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    process.chdir(workspace);

    const legacyPrimary = join(tmp, "deepseek", "sessions");
    const legacyFallback = join(workspace, ".deepseek", "sessions");
    mkdirSync(legacyPrimary, { recursive: true });
    mkdirSync(legacyFallback, { recursive: true });
    writeFileSync(join(legacyPrimary, "legacy-primary.json"), JSON.stringify(createSession({
      id: "legacy-primary",
      title: "Legacy primary",
      workspace_path: "/tmp/legacy-primary",
    })));
    writeFileSync(join(legacyFallback, "legacy-fallback.json"), JSON.stringify(createSession({
      id: "legacy-fallback",
      title: "Legacy fallback",
      workspace_path: "/tmp/legacy-fallback",
    })));

    expect(loadSession("legacy-primary")?.workspace_path).toBe("/tmp/legacy-primary");
    expect(loadSession("legacy-fallback")?.workspace_path).toBe("/tmp/legacy-fallback");
  });

  it("ignores blank session directory env values without disabling legacy compatibility", () => {
    process.env.SEEKCODE_SESSIONS_DIR = " ";
    const legacyPrimary = join(tmp, "deepseek", "sessions");
    mkdirSync(legacyPrimary, { recursive: true });
    writeFileSync(join(legacyPrimary, "blank-env-legacy.json"), JSON.stringify(createSession({
      id: "blank-env-legacy",
      title: "Legacy survives blank env",
      workspace_path: "/tmp/legacy-blank",
    })));

    expect(loadSession("blank-env-legacy")?.workspace_path).toBe("/tmp/legacy-blank");
  });

  it("trims configured session directory env values before writing snapshots", () => {
    const configured = join(tmp, "configured-sessions");
    process.env.SEEKCODE_SESSIONS_DIR = " ";
    process.env.DEEPSEEK_SESSIONS_DIR = ` ${configured} `;
    const session = createSession({ id: "trimmed-env" });
    session.messages.push({ role: "user", content: "Use trimmed env dir" });

    saveSession(session);

    expect(existsSync(join(configured, "trimmed-env.json"))).toBe(true);
    expect(loadSession("trimmed-env")?.title).toBe("Use trimmed env dir");
  });

  it("ignores unsafe configured session dirs and oversized persisted session files", () => {
    const fallback = join(tmp, "fallback-sessions");
    process.env.SEEKCODE_SESSIONS_DIR = `${tmp}\u0007bad`;
    process.env.DEEPSEEK_SESSIONS_DIR = ` ${fallback} `;
    const session = createSession({ id: "safe-dir" });
    session.messages.push({ role: "user", content: "Use safe fallback dir" });
    saveSession(session);

    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "too-large.json"), `${JSON.stringify(createSession({ id: "too-large" }))}${" ".repeat(20 * 1024 * 1024 + 1)}`);

    expect(existsSync(join(fallback, "safe-dir.json"))).toBe(true);
    expect(loadSession("too-large")).toBeNull();
    expect(listSessions().map(item => item.id)).not.toContain("too-large");
  });

  it("falls back to project-local storage when the primary dir cannot be written", () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    process.chdir(workspace);
    writeFileSync(join(tmp, "seekcode"), "not a directory");

    const session = createSession({ id: "fallback" });
    session.messages.push({ role: "user", content: "Save somewhere writable" });

    expect(saveSession(session)).toBe("fallback");
    expect(loadSession("fallback")?.title).toBe("Save somewhere writable");
  });

  it("sanitizes session ids for load and delete", () => {
    const session = createSession({ id: "safe-id" });
    session.messages.push({ role: "user", content: "Delete by sanitized id" });
    saveSession(session);

    expect(loadSession("../safe-id.json")?.title).toBe("Delete by sanitized id");
    expect(deleteSession("../safe-id.json")).toBe(true);
    expect(loadSession("safe-id")).toBeNull();
  });

  it("does not read or write through symlinked session snapshots or event logs", () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    process.chdir(workspace);
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const outsideSnapshot = join(tmp, "outside-session.json");
    const outsideEventLog = join(tmp, "outside-session.jsonl");
    writeFileSync(outsideSnapshot, JSON.stringify(createSession({
      id: "linked-session",
      messages: [{ role: "user", content: "outside secret" }],
    })));
    writeFileSync(outsideEventLog, "outside log\n");
    symlinkSync(outsideSnapshot, join(sessionsDir, "linked-session.json"));
    symlinkSync(outsideEventLog, join(sessionsDir, "event-linked.jsonl"));

    expect(loadSession("linked-session")).toBeNull();
    expect(listSessions().map(session => session.id)).not.toContain("linked-session");

    const eventSession = createSession({ id: "event-linked" });
    eventSession.messages.push({ role: "user", content: "Do not append through log link" });
    expect(saveSession(eventSession)).toBe("event-linked");
    expect(readFileSync(outsideEventLog, "utf-8")).toBe("outside log\n");

    const linkedSession = createSession({ id: "linked-session" });
    linkedSession.messages.push({ role: "user", content: "Fallback instead of write-through" });
    expect(saveSession(linkedSession)).toBe("linked-session");
    expect(readFileSync(outsideSnapshot, "utf-8")).toContain("outside secret");
    expect(loadSession("linked-session")?.title).toBe("Fallback instead of write-through");
  });

  it("fails closed for symlinked session directories and uses the project fallback", () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    process.chdir(workspace);
    const sessionsParent = join(tmp, "seekcode");
    const sessionsDir = join(sessionsParent, "sessions");
    const outside = join(tmp, "outside-session-dir");
    mkdirSync(sessionsParent, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const outsideSession = createSession({ id: "outside-dir-session" });
    writeFileSync(join(outside, "outside-dir-session.json"), JSON.stringify(outsideSession), "utf-8");
    symlinkSync(outside, sessionsDir, "dir");

    expect(loadSession("outside-dir-session")).toBeNull();
    expect(listSessions()).toEqual([]);

    const session = createSession({ id: "fallback-dir-session" });
    session.messages.push({ role: "user", content: "Use the safe fallback" });
    expect(saveSession(session)).toBe("fallback-dir-session");
    expect(readFileSync(join(outside, "outside-dir-session.json"), "utf-8")).toContain("outside-dir-session");
    expect(loadSession("fallback-dir-session")?.title).toBe("Use the safe fallback");
  });

  it("treats the session filename as authoritative when persisted payload ids disagree", () => {
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "file-id.json"), JSON.stringify(createSession({
      id: "payload-id",
      messages: [{ role: "user", content: "Use the file identity" }],
    })));

    const loaded = loadSession("file-id");
    const listed = listSessions();

    expect(loaded?.id).toBe("file-id");
    expect(listed.map(session => session.id)).toContain("file-id");
    expect(listed.map(session => session.id)).not.toContain("payload-id");
  });

  it("deletes companion session event logs with the sanitized session id", () => {
    const session = createSession({ id: "event-id" });
    session.messages.push({ role: "user", content: "Delete event log too" });
    saveSession(session);
    const eventLog = join(tmp, "seekcode", "sessions", "event-id.jsonl");

    expect(existsSync(eventLog)).toBe(true);
    expect(deleteSession("../event-id.json")).toBe(true);
    expect(existsSync(eventLog)).toBe(false);
  });

  it("sorts saved sessions by actual update time", () => {
    const oldSession = createSession({
      id: "old",
      title: "Older",
      updated_at: "2024-12-31T23:59:59.000Z",
    });
    const newSession = createSession({
      id: "new",
      title: "Newer",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const invalidDateSession = createSession({
      id: "invalid",
      title: "Invalid",
      updated_at: "not-a-date",
    });
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(join(sessionsDir, "old.json"), JSON.stringify(oldSession));
    writeFileSync(join(sessionsDir, "new.json"), JSON.stringify(newSession));
    writeFileSync(join(sessionsDir, "invalid.json"), JSON.stringify(invalidDateSession));

    expect(listSessions().map(session => session.id)).toEqual(["new", "old", "invalid"]);
  });

  it("writes session snapshots atomically without exposing temp files", () => {
    const session = createSession({ id: "atomic-save" });
    session.messages.push({ role: "user", content: "Atomic save survives" });

    saveSession(session);

    const sessionsDir = join(tmp, "seekcode", "sessions");
    const files = readdirSync(sessionsDir).sort();
    expect(files).toContain("atomic-save.json");
    expect(files.some(file => file.includes("atomic-save.json") && file.endsWith(".tmp"))).toBe(false);
    expect(loadSession("atomic-save")?.title).toBe("Atomic save survives");
  });

  it("ignores orphaned atomic temp snapshots while listing sessions", () => {
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, ".orphan.json.123.456.0.tmp"), JSON.stringify(createSession({
      id: "orphan",
      title: "Should not list",
    })), "utf-8");
    writeFileSync(join(sessionsDir, "visible.json"), JSON.stringify(createSession({
      id: "visible",
      title: "Visible session",
    })), "utf-8");

    expect(listSessions().map(session => session.id)).toEqual(["visible"]);
    expect(loadSession("orphan")).toBeNull();
  });

  it("does not let malformed session files hide later valid sessions from listings", () => {
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    for (let index = 0; index < 2_050; index++) {
      writeFileSync(join(sessionsDir, `bad-${String(index).padStart(4, "0")}.json`), "{not json", "utf-8");
    }
    writeFileSync(join(sessionsDir, "zz-valid.json"), JSON.stringify(createSession({
      id: "zz-valid",
      title: "Still visible",
      messages: [{ role: "user", content: "Load me after bad files" }],
    })), "utf-8");

    expect(listSessions().map(session => session.id)).toContain("zz-valid");
  });

  it("normalizes oversized persisted titles for load and list output", () => {
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "long-title.json"), JSON.stringify({
      ...createSession({ id: "long-title" }),
      title: `bad\u0000title ${"x".repeat(200)}`,
      messages: [],
    }), "utf-8");

    const loaded = loadSession("long-title")!;
    const listed = listSessions().find(session => session.id === "long-title")!;

    expect(loaded.title).toHaveLength(120);
    expect(loaded.title).toBe(listed.title);
    expect(loaded.title).toContain("bad title");
    expect(loaded.title).not.toContain("\u0000");
    expect(loaded.title.endsWith("...")).toBe(true);
  });

  it("round-trips thinking, tool calls, tool results, and artifact indexes", () => {
    const session = createSession({ id: "rich-session", title: "Untitled session" });
    session.messages.push({ role: "user", content: "Use the saved tool call" });
    session.messages.push({
      role: "assistant",
      content: "",
      reasoning_content: "cached reasoning",
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "a b/中文.txt" } }],
    });
    session.messages.push({
      role: "tool",
      content: "Error: missing",
      tool_call_id: "call_1",
      name: "read",
      is_error: true,
    });
    session.turns.push({
      index: 1,
      user_message: "Use the saved tool call",
      assistant_messages: [{
        role: "assistant",
        content: "",
        reasoning_content: "cached reasoning",
        tool_calls: [{ id: "call_1", name: "read", arguments: { path: "a b/中文.txt" } }],
      }],
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "a b/中文.txt" } }],
      tool_results: [{ tool_call_id: "call_1", name: "read", content: "Error: missing", is_error: true }],
      tokens_in: 12,
      tokens_out: 3,
      cost: 0.004,
      duration_s: 1.5,
      artifact_ids: ["log_m123456_deadbeef00"],
    });
    session.artifact_index = {
      session: ["log_m123456_deadbeef00"],
      "turn:1": ["log_m123456_deadbeef00"],
    };

    saveSession(session);
    const loaded = loadSession("rich-session");

    expect(loaded?.messages[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "cached reasoning",
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "a b/中文.txt" } }],
    });
    expect(loaded?.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      name: "read",
      is_error: true,
    });
    expect(loaded?.turns[0].assistant_messages[0].reasoning_content).toBe("cached reasoning");
    expect(loaded?.turns[0].tool_results[0]).toMatchObject({ is_error: true, content: "Error: missing" });
    expect(loaded?.turns[0].artifact_ids).toEqual(["log_m123456_deadbeef00"]);
    expect(loaded?.artifact_index["turn:1"]).toEqual(["log_m123456_deadbeef00"]);
  });

  it("normalizes missing legacy turn indexes to one-based values", () => {
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "turn-indexes.json"), JSON.stringify({
      ...createSession({ id: "turn-indexes" }),
      turns: [
        { user_message: "first" },
        { user_message: "second" },
      ],
    }));

    expect(loadSession("turn-indexes")?.turns.map(turn => turn.index)).toEqual([1, 2]);
  });

  it("normalizes legacy OpenAI-shaped tool calls during load", () => {
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "legacy-tools.json"), JSON.stringify({
      ...createSession({ id: "legacy-tools" }),
      messages: [{
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_legacy",
          type: "function",
          function: {
            name: "bash",
            arguments: "{\"command\":\"echo hi\"}",
          },
        }],
      }],
    }));

    expect(loadSession("legacy-tools")?.messages[0].tool_calls).toEqual([{
      id: "call_legacy",
      name: "bash",
      arguments: { command: "echo hi" },
    }]);
  });

  it("drops cross-role persisted tool-call fields before API replay", () => {
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "cross-role-tools.json"), JSON.stringify({
      ...createSession({ id: "cross-role-tools" }),
      messages: [
        { role: "user", content: "bad", tool_calls: [{ id: "call_user", name: "read", arguments: {} }] },
        { role: "system", content: "bad", tool_calls: [{ id: "call_system", name: "read", arguments: {} }] },
        { role: "tool", content: "ok", tool_call_id: "call_tool", name: "read", tool_calls: [{ id: "call_nested", name: "read", arguments: {} }] },
        { role: "assistant", content: "ok", tool_calls: [{ id: "call_assistant", name: "read", arguments: {} }] },
      ],
    }));

    const loaded = loadSession("cross-role-tools")!;

    expect(loaded.messages[0].tool_calls).toBeNull();
    expect(loaded.messages[1].tool_calls).toBeNull();
    expect(loaded.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_tool", name: "read", tool_calls: null });
    expect(loaded.messages[3].tool_calls).toEqual([{ id: "call_assistant", name: "read", arguments: {} }]);
  });

  it("skips malformed persisted session string fields instead of rehydrating [object Object] content and artifact ids", () => {
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "malformed-session.json"), JSON.stringify({
      ...createSession({ id: "ignored-by-fallback" }),
      id: { nested: true },
      title: "Malformed persisted session",
      messages: [
        { role: "user", content: { nested: true } },
        {
          role: "assistant",
          content: "kept",
          tool_calls: [{ id: "call_1", name: "read", arguments: { path: "ok.txt" } }],
        },
      ],
      turns: [
        {
          index: 1,
          user_message: "hi",
          assistant_messages: [{ role: "assistant", content: { nested: true } }],
          tool_calls: [],
          tool_results: [{ tool_call_id: "call_1", name: "read", content: { nested: true }, is_error: false }],
          artifact_ids: ["art-1", " art-2 ", "art-1", { nested: true }, ""],
        },
      ],
      artifact_index: {
        session: ["art-1", " art-2 ", "art-1", { nested: true }, ""],
        "turn:1": [{ nested: true }],
        "../bad": ["secret-art"],
      },
    }), "utf-8");

    const loaded = loadSession("malformed-session")!;

    expect(loaded.id).toBe("malformed-session");
    expect(loaded.messages).toEqual([
      { role: "user", content: null, tool_calls: null, tool_call_id: null, name: null, reasoning_content: null, is_error: null },
      expect.objectContaining({ role: "assistant", content: "kept" }),
    ]);
    expect(loaded.turns[0].assistant_messages[0].content).toBeNull();
    expect(loaded.turns[0].tool_results[0].content).toBe("");
    expect(loaded.turns[0].artifact_ids).toEqual(["art-1", "art-2"]);
    expect(loaded.artifact_index).toEqual({ session: ["art-1", "art-2"], "turn:1": [] });
    expect(JSON.stringify(loaded)).not.toContain("[object Object]");
  });

  it("sanitizes malformed persisted session metadata, tool calls, and counters", () => {
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "malformed-secure.json"), JSON.stringify({
      ...createSession({ id: "malformed-secure" }),
      title: "bad\0title",
      workspace_path: `${tmp}\0bad`,
      cumulative_tokens_in: -1,
      cumulative_tokens_out: 1.5,
      cumulative_cost: -0.5,
      prefix_hash: "ABCDEF1234567890",
      messages: [
        { role: "tool", tool_call_id: "bad id", name: "read", content: "drop me" },
        {
          role: "assistant",
          content: "kept",
          reasoning_content: "bad\0reasoning",
          tool_calls: [
            { id: "call_good", name: "read", arguments: { path: "ok.txt" } },
            { id: "call bad", name: "read", arguments: {} },
            { id: "call_missing_name", arguments: {} },
            { id: "call_legacy", type: "function", function: { name: "bash", arguments: "{\"command\":\"echo hi\"}" } },
            { id: "call_bad_args", name: "write", arguments: "[" },
          ],
        },
        { role: "tool", tool_call_id: "call_good", name: "read", content: "ok", is_error: false },
      ],
      turns: [
        {
          index: 1.5,
          user_message: "bad\0user",
          assistant_messages: [{ role: "assistant", content: "ok" }],
          tool_calls: [
            { id: "call_good", name: "read", arguments: { path: "ok.txt" } },
            { id: "bad id", name: "read", arguments: {} },
          ],
          tool_results: [
            { tool_call_id: "call_good", name: "read", content: "ok", is_error: "yes" },
            { tool_call_id: "bad id", name: "read", content: "bad" },
          ],
          tokens_in: -5,
          tokens_out: 1.5,
          cost: -0.1,
          duration_s: 2.25,
          artifact_ids: [" ok ", "bad\0id", "x".repeat(257), "ok"],
        },
      ],
      artifact_index: {
        "bad\0key": ["ok"],
        session: [" ok ", "bad\0id", "ok"],
        "turn:1": ["a"],
      },
    }), "utf-8");

    const loaded = loadSession("malformed-secure")!;

    expect(loaded.workspace_path).toBe(process.cwd());
    expect(loaded.cumulative_tokens_in).toBe(0);
    expect(loaded.cumulative_tokens_out).toBe(0);
    expect(loaded.cumulative_cost).toBe(0);
    expect(loaded.prefix_hash).toBe("abcdef1234567890");
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].tool_calls?.map(toolCall => toolCall.id)).toEqual(["call_good", "call_legacy", "call_bad_args"]);
    expect(loaded.messages[0].tool_calls?.[2].arguments).toEqual({});
    expect(loaded.messages[0].reasoning_content).toBe("bad reasoning");
    expect(loaded.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call_good", name: "read", content: "ok" });
    expect(loaded.turns[0]).toMatchObject({
      index: 1,
      user_message: "bad user",
      tokens_in: 0,
      tokens_out: 0,
      cost: 0,
      duration_s: 2.25,
    });
    expect(loaded.turns[0].tool_calls.map(toolCall => toolCall.id)).toEqual(["call_good"]);
    expect(loaded.turns[0].tool_results).toEqual([{ tool_call_id: "call_good", name: "read", content: "ok", is_error: false }]);
    expect(loaded.turns[0].artifact_ids).toEqual(["ok"]);
    expect(loaded.artifact_index).toEqual({ session: ["ok"], "turn:1": ["a"] });
    expect(JSON.stringify(loaded)).not.toContain("\\u0000");
  });

  it("normalizes live sessions before writing snapshots and event logs", () => {
    const session = createSession({ id: "live-normalize" });
    session.workspace_path = `${tmp}\0bad`;
    session.cumulative_tokens_in = -10;
    session.cumulative_tokens_out = 1.25;
    session.cumulative_cost = -1;
    session.prefix_hash = "not-a-hash";
    session.messages.push({
      role: "assistant",
      content: "ok",
      tool_calls: [
        { id: "call_good", name: "read", arguments: { path: "ok.txt" } },
        { id: "bad id", name: "read", arguments: { path: "bad.txt" } },
      ],
    });
    session.turns.push({
      index: 0,
      user_message: "bad\0turn",
      assistant_messages: [],
      tool_calls: [{ id: "bad id", name: "read", arguments: {} }],
      tool_results: [],
      tokens_in: -1,
      tokens_out: 2.5,
      cost: -0.2,
      duration_s: 1.25,
      artifact_ids: [" ok ", "bad\0id"],
    });

    saveSession(session);
    const loaded = loadSession("live-normalize")!;
    const eventLogPath = join(tmp, "seekcode", "sessions", "live-normalize.jsonl");
    const eventLog = readFileSync(eventLogPath, "utf-8").trim();
    const eventLogMode = statSync(eventLogPath).mode & 0o777;
    const event = JSON.parse(eventLog);

    expect(loaded.workspace_path).toBe(process.cwd());
    expect(loaded.cumulative_tokens_in).toBe(0);
    expect(loaded.cumulative_tokens_out).toBe(0);
    expect(loaded.cumulative_cost).toBe(0);
    expect(loaded.prefix_hash).toBeUndefined();
    expect(loaded.messages[0].tool_calls?.map(toolCall => toolCall.id)).toEqual(["call_good"]);
    expect(loaded.turns[0]).toMatchObject({ index: 1, user_message: "bad turn", tokens_in: 0, tokens_out: 0, cost: 0, duration_s: 1.25 });
    expect(loaded.turns[0].artifact_ids).toEqual(["ok"]);
    expect(event).toMatchObject({
      event: "session.saved",
      session_id: "live-normalize",
      cumulative_tokens_in: 0,
      cumulative_tokens_out: 0,
    });
    expect(eventLogMode).toBe(0o600);
  });

  it("trims oversized session event logs before appending new events", () => {
    const session = createSession({ id: "event-trim" });
    session.messages.push({ role: "user", content: "Trim event log" });
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const logPath = join(sessionsDir, "event-trim.jsonl");
    writeFileSync(logPath, `${"x".repeat(2 * 1024 * 1024 + 100)}\n`);

    saveSession(session);
    const text = readFileSync(logPath, "utf-8");
    const last = JSON.parse(text.trim().split("\n").at(-1)!);

    expect(statSync(logPath).size).toBeLessThan(2 * 1024 * 1024);
    expect(last).toMatchObject({ event: "session.saved", session_id: "event-trim" });
    expect(readdirSync(sessionsDir).some(file => file.includes("event-trim.jsonl") && file.endsWith(".tmp"))).toBe(false);
  });

  it("trims session event logs from UTF-8 boundaries before appending", () => {
    const session = createSession({ id: "event-trim-utf8" });
    session.messages.push({ role: "user", content: "Trim UTF-8 event log" });
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const logPath = join(sessionsDir, "event-trim-utf8.jsonl");
    const prefixBytes = 2 * 1024 * 1024 + 100 - Buffer.byteLength("👨\n", "utf-8");
    writeFileSync(logPath, Buffer.concat([
      Buffer.alloc(prefixBytes, "x"),
      Buffer.from("👨\n", "utf-8"),
    ]));

    saveSession(session);
    const text = readFileSync(logPath, "utf-8");
    const last = JSON.parse(text.trim().split("\n").at(-1)!);

    expect(text).not.toContain("\ufffd");
    expect(hasUnpairedSurrogate(text)).toBe(false);
    expect(last).toMatchObject({ event: "session.saved", session_id: "event-trim-utf8" });
  });

  it("sanitizes session strings instead of dropping recoverable control-character text", () => {
    expect(safeSessionString("hello\u0000world\u0007again")).toBe("hello world again");
    expect(messageToApiDict({
      role: "assistant",
      content: "ok",
      reasoning_content: "why\u0000now",
    })).toMatchObject({
      reasoning_content: "why now",
    });
  });

  it("bounds session strings on full grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const content = safeSessionString(`${"x".repeat(999_995)}${family}`)!;
    const apiMessage = messageToApiDict({
      role: "assistant",
      content: "ok",
      reasoning_content: `${"r".repeat(999_999)}${family}`,
    });

    expect(content.length).toBeLessThanOrEqual(1_000_000);
    expect(content).not.toContain(family);
    expect(content).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(content)).toBe(false);
    expect(String(apiMessage.reasoning_content)).not.toContain(family);
    expect(String(apiMessage.reasoning_content)).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(String(apiMessage.reasoning_content))).toBe(false);
  });

  it("bounds normalized tool calls and oversized arguments", () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      id: `call_${index}`,
      name: "read",
      arguments: index === 0 ? { body: "x".repeat(1_100_000) } : { path: `${index}.txt` },
    }));

    const normalized = normalizeToolCalls(many);

    expect(normalized).toHaveLength(100);
    expect(normalized[0].arguments).toEqual({});
    expect(normalized[1].arguments).toEqual({ path: "1.txt" });
  });

  it("deduplicates tool calls by id and fails closed when argument objects throw", () => {
    const throwingArgs = {};
    Object.defineProperty(throwingArgs, "path", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });

    const normalized = normalizeToolCalls([
      { id: "call_dup", name: "read", arguments: { path: "first.txt" } },
      { id: "call_dup", name: "read", arguments: { path: "second.txt" } },
      { id: "call_throw", name: "read", arguments: throwingArgs },
    ]);
    const apiMessage = messageToApiDict({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_throw", name: "read", arguments: throwingArgs as Record<string, unknown> }],
    });

    expect(normalized).toEqual([
      { id: "call_dup", name: "read", arguments: { path: "first.txt" } },
      { id: "call_throw", name: "read", arguments: {} },
    ]);
    expect((apiMessage.tool_calls as any[])[0].function.arguments).toBe("{}");
  });

  it("normalizes tool calls with hostile top-level and function getters", () => {
    const hostileFunction: Record<string, unknown> = { id: "call_fn" };
    Object.defineProperty(hostileFunction, "function", {
      enumerable: true,
      get() {
        throw new Error("function getter failed");
      },
    });
    const fallbackName: Record<string, unknown> = { id: "call_fallback", type: "function" };
    Object.defineProperty(fallbackName, "function", {
      enumerable: true,
      value: { name: "read", arguments: "{\"path\":\"ok.txt\"}" },
    });
    const hostileArray: any[] = [
      hostileFunction,
      fallbackName,
      { id: "call_later", name: "read", arguments: { path: "later.txt" } },
    ];
    Object.defineProperty(hostileArray, "1", {
      enumerable: true,
      get() {
        throw new Error("tool call getter failed");
      },
    });

    expect(() => normalizeToolCalls(hostileArray)).not.toThrow();
    expect(normalizeToolCalls(hostileArray)).toEqual([
      { id: "call_later", name: "read", arguments: { path: "later.txt" } },
    ]);
  });

  it("normalizes artifact ids and indexes with hostile getters while keeping readable entries", () => {
    const artifactIds = ["bad\0id", "art-ok", "art-later"];
    Object.defineProperty(artifactIds, "1", {
      enumerable: true,
      get() {
        throw new Error("artifact getter failed");
      },
    });
    const artifactIndex: Record<string, unknown> = {
      session: artifactIds,
      "turn:1": ["turn-art"],
    };
    Object.defineProperty(artifactIndex, "session", {
      enumerable: true,
      get() {
        throw new Error("index getter failed");
      },
    });

    const session = createSession({
      turns: [{ index: 1, user_message: "hi", artifact_ids: artifactIds } as any],
      artifact_index: artifactIndex as any,
    });

    expect(session.turns[0].artifact_ids).toEqual(["art-later"]);
    expect(session.artifact_index).toEqual({ session: [], "turn:1": ["turn-art"] });
  });

  it("creates sessions from hostile messages and turns without throwing", () => {
    const message: Record<string, unknown> = { role: "user" };
    Object.defineProperty(message, "content", {
      enumerable: true,
      get() {
        throw new Error("content getter failed");
      },
    });
    const turn: Record<string, unknown> = { index: 1, user_message: "kept" };
    Object.defineProperty(turn, "tool_results", {
      enumerable: true,
      get() {
        throw new Error("tool results getter failed");
      },
    });

    expect(() => createSession({ messages: [message as any], turns: [turn as any] })).not.toThrow();
    const session = createSession({ messages: [message as any], turns: [turn as any] });

    expect(session.messages).toEqual([
      { role: "user", content: null, tool_calls: null, tool_call_id: null, name: null, reasoning_content: null, is_error: null },
    ]);
    expect(session.turns[0]).toMatchObject({ index: 1, user_message: "kept", tool_results: [] });
  });

  it("does not let repeated control-character tool ids or names leak through stateful regex checks", () => {
    const normalized = normalizeToolCalls([
      { id: "bad\u0000id", name: "read", arguments: { path: "bad-1.txt" } },
      { id: "also\u0000bad", name: "read", arguments: { path: "bad-2.txt" } },
      { id: "call_ok", name: "bad\u0000name", arguments: { path: "bad-3.txt" } },
      { id: "call_ok_2", name: "read", arguments: { path: "ok.txt" } },
    ]);

    expect(normalized).toEqual([
      { id: "call_ok_2", name: "read", arguments: { path: "ok.txt" } },
    ]);
  });

  it("bounds persisted session messages, turns, tool calls, tool results, artifact ids, and artifact index keys", () => {
    const sessionsDir = join(tmp, "seekcode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "bounded-session.json"), JSON.stringify({
      ...createSession({ id: "bounded-session" }),
      messages: Array.from({ length: 10_050 }, (_, index) => ({
        role: "user",
        content: `message-${index}`,
      })),
      turns: Array.from({ length: 5_050 }, (_, index) => ({
        index: index + 1,
        user_message: `turn-${index}`,
        assistant_messages: index === 50
          ? Array.from({ length: 10_050 }, (_, messageIndex) => ({
              role: "assistant",
              content: `assistant-${messageIndex}`,
            }))
          : [],
        tool_calls: index === 50
          ? Array.from({ length: 120 }, (_, toolIndex) => ({
              id: `call_${index}_${toolIndex}`,
              name: "read",
              arguments: { path: `${toolIndex}.txt` },
            }))
          : [],
        tool_results: index === 50
          ? Array.from({ length: 120 }, (_, toolIndex) => ({
              tool_call_id: `call_${index}_${toolIndex}`,
              name: "read",
              content: `result-${toolIndex}`,
            }))
          : [],
        artifact_ids: index === 50
          ? Array.from({ length: 600 }, (_, artifactIndex) => `art-${artifactIndex}`)
          : [],
      })),
      artifact_index: Object.fromEntries(Array.from({ length: 1_050 }, (_, index) => [`turn:${index}`, [`art-${index}`]])),
    }));

    const loaded = loadSession("bounded-session")!;

    expect(loaded.messages).toHaveLength(10_000);
    expect(loaded.messages[0].content).toBe("message-50");
    expect(loaded.turns).toHaveLength(5_000);
    expect(loaded.turns[0].user_message).toBe("turn-50");
    expect(loaded.turns[0].assistant_messages).toHaveLength(10_000);
    expect(loaded.turns[0].tool_calls).toHaveLength(100);
    expect(loaded.turns[0].tool_results).toHaveLength(100);
    expect(loaded.turns[0].artifact_ids).toHaveLength(500);
    expect(Object.keys(loaded.artifact_index)).toHaveLength(1_000);
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

describe("API serialization", () => {
  it("passes stored thinking content back for DeepSeek reasoning mode", () => {
    const apiMessage = messageToApiDict({
      role: "assistant",
      content: "answer",
      reasoning_content: "private thinking",
    });

    expect(apiMessage).toEqual({
      role: "assistant",
      content: "answer",
      reasoning_content: "private thinking",
    });
  });

  it("serializes non-JSON tool arguments without throwing", () => {
    const args: Record<string, unknown> = { count: 1n, skipped: undefined, fn: () => "ignored" };
    args.self = args;

    const apiMessage = messageToApiDict({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", name: "write", arguments: args }],
    });

    expect(apiMessage).toMatchObject({
      tool_calls: [{
        function: {
          arguments: "{\"count\":\"1\",\"skipped\":null,\"fn\":null,\"self\":\"[Circular]\"}",
        },
      }],
    });
  });
});

describe("CostTracker", () => {
  it("hydrates cumulative session totals after load", () => {
    const tracker = new CostTracker("deepseek-chat");
    tracker.hydrateFromSession(createSession({
      model: "deepseek-v4-pro",
      cumulative_tokens_in: 12,
      cumulative_tokens_out: 8,
      cumulative_cost: 0.25,
    }));

    expect(tracker.model).toBe("deepseek-v4-pro");
    expect(tracker.totalTokensIn).toBe(12);
    expect(tracker.totalTokensOut).toBe(8);
    expect(tracker.totalCost).toBe(0.25);
  });

  it("normalizes invalid live and persisted cost counters", () => {
    const tracker = new CostTracker(" bad\0model ");
    const recorded = tracker.recordTurn(-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN);

    expect(recorded).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      cachedTokensIn: 0,
      cost: 0,
      durationS: 0,
    });

    tracker.hydrateFromSession(createSession({
      model: " deepseek-v4-flash ",
      turns: [
        {
          index: 1,
          user_message: "",
          assistant_messages: [],
          tool_calls: [],
          tool_results: [],
          tokens_in: -1,
          tokens_out: 2.5,
          cost: -0.1,
          duration_s: Number.NaN,
        },
        {
          index: 2,
          user_message: "",
          assistant_messages: [],
          tool_calls: [],
          tool_results: [],
          tokens_in: 3,
          tokens_out: 4,
          cost: 0.01,
          duration_s: 1.5,
        },
      ],
    }));

    expect(tracker.model).toBe("deepseek-v4-flash");
    expect(tracker.turns).toEqual([
      { tokensIn: 0, tokensOut: 0, cachedTokensIn: 0, cost: 0, durationS: 0 },
      { tokensIn: 3, tokensOut: 4, cachedTokensIn: 0, cost: 0.01, durationS: 1.5 },
    ]);
    expect(tracker.formatSummary()).not.toContain("NaN");
    expect(tracker.formatDetailed()).not.toContain("NaN");
  });

  it("bounds live cost history and totals after noisy telemetry", () => {
    const tracker = new CostTracker("deepseek-v4-pro");

    for (let index = 0; index < 5_010; index++) {
      tracker.recordTurn(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY);
    }

    expect(tracker.turnCount).toBe(5_010);
    expect(tracker.turns[0].cachedTokensIn).toBeLessThanOrEqual(tracker.turns[0].tokensIn);
    expect(tracker.totalTokensIn).toBe(Number.MAX_SAFE_INTEGER);
    expect(tracker.totalTokensOut).toBe(Number.MAX_SAFE_INTEGER);
    expect(tracker.totalCost).toBeLessThanOrEqual(1_000_000_000);
    expect(tracker.formatDetailed()).not.toContain("Infinity");
  });

  it("sanitizes model labels and keeps detailed cost output bounded", () => {
    const tracker = new CostTracker(` custom\u0007model `);
    expect(tracker.model).toBe("custom model");

    for (let index = 0; index < 5_010; index++) {
      tracker.recordTurn(1, 1, 0, 0.01);
    }

    const detail = tracker.formatDetailed();
    expect(detail).not.toContain("\u0007");
    expect(detail.split("\n").length).toBeLessThanOrEqual(5_005);
    expect(detail).toContain("10 older turns omitted");
    expect(detail).toContain("Total");
  });

  it("keeps cumulative totals after the bounded detail window rolls over", () => {
    const tracker = new CostTracker("deepseek-v4-pro");

    for (let index = 0; index < 5_010; index++) tracker.recordTurn(1, 2);

    expect(tracker.turns).toHaveLength(5_000);
    expect(tracker.turnCount).toBe(5_010);
    expect(tracker.totalTokensIn).toBe(5_010);
    expect(tracker.totalTokensOut).toBe(10_020);
  });

  it("uses persisted cumulative totals when retained turn details are incomplete", () => {
    const tracker = new CostTracker("deepseek-v4-pro");
    const turn = {
      index: 1,
      user_message: "",
      assistant_messages: [],
      tool_calls: [],
      tool_results: [],
      tokens_in: 3,
      tokens_out: 2,
      cost: 0.01,
      duration_s: 1,
    };

    tracker.hydrateFromSession(createSession({
      turns: [turn],
      cumulative_tokens_in: 30,
      cumulative_tokens_out: 20,
      cumulative_cost: 0.1,
    }));

    expect(tracker.turns).toHaveLength(1);
    expect(tracker.totalTokensIn).toBe(30);
    expect(tracker.totalTokensOut).toBe(20);
    expect(tracker.totalCost).toBe(0.1);
  });

  it("defensively snapshots public turn history", () => {
    const tracker = new CostTracker("deepseek-v4-pro");
    tracker.recordTurn(10, 5, 3, 1);
    const snapshot = tracker.turns;
    snapshot[0]!.tokensIn = Number.MAX_SAFE_INTEGER;
    snapshot.push({ tokensIn: 100, tokensOut: 100, cachedTokensIn: 100, cost: 100, durationS: 100 });

    expect(tracker.turnCount).toBe(1);
    expect(tracker.totalTokensIn).toBe(10);
    expect(tracker.turns[0]).toMatchObject({ tokensIn: 10, tokensOut: 5, cachedTokensIn: 3, durationS: 1 });
  });

  it("sanitizes externally assigned turn history and throwing turn fields", () => {
    const tracker = new CostTracker("deepseek-v4-pro");
    const hostile: Record<string, unknown> = {
      tokensIn: 12,
      tokensOut: 4,
      cachedTokensIn: 20,
      cost: 0.01,
      durationS: 2,
    };
    Object.defineProperty(hostile, "tokensOut", {
      enumerable: true,
      get() {
        throw new Error("tokens out getter failed");
      },
    });

    tracker.turns = [
      hostile as any,
      { tokensIn: -1, tokensOut: Number.POSITIVE_INFINITY, cachedTokensIn: 1, cost: Number.NaN, durationS: -2 },
    ];

    expect(tracker.turns).toEqual([
      { tokensIn: 12, tokensOut: 0, cachedTokensIn: 12, cost: 0.01, durationS: 2 },
      { tokensIn: 0, tokensOut: 0, cachedTokensIn: 0, cost: 0, durationS: 0 },
    ]);
    expect(tracker.formatDetailed()).not.toContain("getter failed");
  });

  it("hydrates sessions with hostile getters without throwing", () => {
    const tracker = new CostTracker("deepseek-v4-pro");
    const turn: Record<string, unknown> = {
      tokens_in: 9,
      tokens_out: 3,
      cost: 0.02,
      duration_s: 1,
    };
    Object.defineProperty(turn, "tokens_out", {
      enumerable: true,
      get() {
        throw new Error("turn getter failed");
      },
    });
    const session = createSession({ model: "deepseek-v4-flash" });
    Object.defineProperty(session, "turns", { value: [turn], configurable: true });
    Object.defineProperty(session, "model", {
      enumerable: true,
      get() {
        throw new Error("model getter failed");
      },
    });

    expect(() => tracker.hydrateFromSession(session)).not.toThrow();
    expect(tracker.model).toBe("deepseek-v4-pro");
    expect(tracker.turns).toEqual([
      { tokensIn: 9, tokensOut: 0, cachedTokensIn: 0, cost: 0.02, durationS: 1 },
    ]);
  });
});
