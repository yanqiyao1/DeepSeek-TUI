import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CostTracker } from "../src/cost/tracker.js";
import { deleteSession, saveSession, loadSession, listSessions } from "../src/session/store.js";
import { createSession, messageToApiDict } from "../src/session/types.js";
import { deriveSessionTitle, summarizeForLabel } from "../src/session/title.js";

let tmp: string;
let oldXdg: string | undefined;
let oldSessionsDir: string | undefined;
let oldCwd: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-sessions-"));
  oldXdg = process.env.XDG_DATA_HOME;
  oldSessionsDir = process.env.DEEPSEEK_SESSIONS_DIR;
  oldCwd = process.cwd();
  process.env.XDG_DATA_HOME = tmp;
  delete process.env.DEEPSEEK_SESSIONS_DIR;
});

afterEach(() => {
  process.chdir(oldCwd);
  if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldXdg;
  if (oldSessionsDir === undefined) delete process.env.DEEPSEEK_SESSIONS_DIR;
  else process.env.DEEPSEEK_SESSIONS_DIR = oldSessionsDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("session titles", () => {
  it("uses the first user message as a compact label", () => {
    expect(summarizeForLabel("  Fix load/save bugs\nwith details")).toBe("Fix load/save bugs");

    const session = createSession();
    session.messages.push({ role: "system", content: "sys" });
    session.messages.push({ role: "user", content: "Add footer cwd display" });

    expect(deriveSessionTitle(session)).toBe("Add footer cwd display");
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
          artifact_ids: ["art-1", { nested: true }, ""],
        },
      ],
      artifact_index: {
        session: ["art-1", { nested: true }, ""],
        "turn:1": [{ nested: true }],
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
    expect(loaded.turns[0].artifact_ids).toEqual(["art-1"]);
    expect(loaded.artifact_index).toEqual({ session: ["art-1"], "turn:1": [] });
    expect(JSON.stringify(loaded)).not.toContain("[object Object]");
  });
});

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
});
