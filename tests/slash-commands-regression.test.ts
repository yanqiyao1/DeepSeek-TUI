import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearClaudeCommandCache, discoverClaudeCommands, expandClaudeCommand, findClaudeCommand } from "../src/commands/compat.js";
import { handleSlashCommand, isLiveReadonlyCommand, normalizedSlashInput, type SlashCommandRuntime } from "../src/commands/registry.js";
import { tasksCommand } from "../src/commands/tasks.js";
import type { Config } from "../src/config.js";
import { CostTracker } from "../src/cost/tracker.js";
import { ConversationHistory } from "../src/session/history.js";
import { saveSession } from "../src/session/store.js";
import { createSession, type Session } from "../src/session/types.js";
import { clearPersistentTaskStateForTests, getTaskManager } from "../src/engine/task-lifecycle.js";
import { clearJobManagerForTests } from "../src/tools/jobs.js";
import { commandCompletionProvider } from "../src/ui/input.js";

let tmpDataHome: string;
let oldXdgDataHome: string | undefined;
let oldSeekcodeSessionsDir: string | undefined;
let oldDeepseekSessionsDir: string | undefined;

beforeEach(() => {
  tmpDataHome = mkdtempSync(join(tmpdir(), "seek-code-slash-data-"));
  oldXdgDataHome = process.env.XDG_DATA_HOME;
  oldSeekcodeSessionsDir = process.env.SEEKCODE_SESSIONS_DIR;
  oldDeepseekSessionsDir = process.env.DEEPSEEK_SESSIONS_DIR;
  process.env.XDG_DATA_HOME = tmpDataHome;
  delete process.env.SEEKCODE_SESSIONS_DIR;
  delete process.env.DEEPSEEK_SESSIONS_DIR;
});

afterEach(() => {
  if (oldXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldXdgDataHome;
  if (oldSeekcodeSessionsDir === undefined) delete process.env.SEEKCODE_SESSIONS_DIR;
  else process.env.SEEKCODE_SESSIONS_DIR = oldSeekcodeSessionsDir;
  if (oldDeepseekSessionsDir === undefined) delete process.env.DEEPSEEK_SESSIONS_DIR;
  else process.env.DEEPSEEK_SESSIONS_DIR = oldDeepseekSessionsDir;
  rmSync(tmpDataHome, { recursive: true, force: true });
});

describe("slash command registry", () => {
  it("identifies commands that are safe while a turn is running", () => {
    expect(isLiveReadonlyCommand("/tokens")).toBe(true);
    expect(isLiveReadonlyCommand("  /tokens  ")).toBe(true);
    expect(isLiveReadonlyCommand("/model")).toBe(false);
    expect(isLiveReadonlyCommand("plain request")).toBe(false);
  });

  it("normalizes slash commands without changing plain prompts", () => {
    expect(normalizedSlashInput("  /model deepseek-v4-flash  ")).toBe("/model deepseek-v4-flash");
    expect(normalizedSlashInput("  explain /model literally  ")).toBeNull();
    expect(normalizedSlashInput(`/model bad${String.fromCharCode(0)}`)).toBeNull();
    expect(normalizedSlashInput(`/model bad${String.fromCharCode(7)}`)).toBeNull();
    expect(normalizedSlashInput(`/${"x".repeat(4097)}`)).toBeNull();
  });

  it("dispatches mode and model commands through extracted handlers", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);

    await expect(handleSlashCommand("  /plan  ", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(true);
    expect(cfg.mode).toBe("plan");
    expect(session.mode).toBe("plan");
    expect(runtime.rebuilds).toEqual({ runtime: 1, system: 1 });

    await expect(handleSlashCommand("/model deepseek-v4-flash", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    expect(cfg.model).toBe("deepseek-v4-flash");
    expect(session.model).toBe("deepseek-v4-flash");
    expect(runtime.rebuilds).toEqual({ runtime: 2, system: 2 });
    expect(writes.join("\n")).toContain("Model: deepseek-v4-flash");
  });

  it("shows config and mcp commands in help output", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);

    await expect(handleSlashCommand("/help", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("/mcp           Manage MCP servers");
    expect(output).toContain("/config        Validate, migrate, or explain configuration");
  });

  it("rejects unknown providers and unsafe model names without mutating runtime state", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);
    const costTracker = new CostTracker(cfg.model);

    await expect(handleSlashCommand("/provider typo-provider", cfg, session, history, costTracker, runtime)).resolves.toBe(false);
    await expect(handleSlashCommand(`/model deepseek-v4-pro${String.fromCharCode(0)}`, cfg, session, history, costTracker, runtime)).resolves.toBe(false);

    expect(cfg.provider).toBe("deepseek");
    expect(cfg.model).toBe("deepseek-v4-pro");
    expect(session.model).toBe("deepseek-v4-pro");
    expect(costTracker.model).toBe("deepseek-v4-pro");
    expect(runtime.rebuilds).toEqual({ runtime: 0, system: 0 });
    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("Unknown provider: typo-provider");
    expect(output).toContain("Usage: /provider");
    expect(output).toContain("Invalid slash command input");
  });

  it("applies provider capabilities to model, context, max tokens, and base URL", async () => {
    const cfg = testConfig();
    cfg.max_tokens = 999_999;
    cfg.context_limit = 1234;
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);
    const costTracker = new CostTracker(cfg.model);

    await expect(handleSlashCommand("/provider openrouter deepseek-v4-flash", cfg, session, history, costTracker, runtime)).resolves.toBe(false);

    expect(cfg.provider).toBe("openrouter");
    expect(cfg.base_url).toBe("https://openrouter.ai/api/v1");
    expect(cfg.model).toBe("deepseek/deepseek-v4-flash");
    expect(session.model).toBe("deepseek/deepseek-v4-flash");
    expect(costTracker.model).toBe("deepseek/deepseek-v4-flash");
    expect(cfg.context_limit).toBe(1_000_000);
    expect(cfg.max_tokens).toBe(262_144);
    expect(runtime.rebuilds).toEqual({ runtime: 1, system: 1 });

    await expect(handleSlashCommand("/provider deepseek", cfg, session, history, costTracker, runtime)).resolves.toBe(false);
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.base_url).toBe("https://api.deepseek.com");
    expect(cfg.model).toBe("deepseek-v4-flash");
    expect(session.model).toBe("deepseek-v4-flash");
    expect(costTracker.model).toBe("deepseek-v4-flash");
    expect(runtime.rebuilds).toEqual({ runtime: 2, system: 2 });
  });

  it("rejects control-character slash commands before terminal-facing output", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);

    await expect(handleSlashCommand(`/unknown${String.fromCharCode(7)}`, cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand(`/provider bad${String.fromCharCode(27)}name`, cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), runtime)).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("Invalid slash command input");
    expect(output).not.toContain(String.fromCharCode(7));
    expect(output).not.toContain(String.fromCharCode(27));
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.model).toBe("deepseek-v4-pro");
    expect(runtime.rebuilds).toEqual({ runtime: 0, system: 0 });
  });

  it("keeps cost tracking model and token output sane after model changes and over-limit contexts", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);
    const costTracker = new CostTracker(cfg.model);

    await expect(handleSlashCommand("/model deepseek-v4-flash", cfg, session, history, costTracker, runtime)).resolves.toBe(false);
    expect(costTracker.model).toBe("deepseek-v4-flash");

    cfg.context_limit = 100;
    runtime.getRequestTokenCount = () => 250;
    await expect(handleSlashCommand("/tokens", cfg, session, history, costTracker, runtime)).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("250 / 100 tokens (250%)");
    expect(output).toContain("[████████████████████]");
    expect(output).not.toContain("NaN");
    expect(output).not.toContain("Infinity");
  });

  it("hides detailed cost output when cost tracking is disabled", async () => {
    const cfg = testConfig();
    cfg.cost_tracking = false;
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);
    const costTracker = new CostTracker(cfg.model);
    costTracker.recordTurn(10, 5, 0, 1);

    await expect(handleSlashCommand("/cost", cfg, session, history, costTracker, runtime)).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("Cost tracking is disabled.");
    expect(output).not.toContain("Turn |");
    expect(output).not.toContain("$");
  });

  it("gates mutating commands in live readonly mode before dispatch", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);
    runtime.liveReadonly = true;

    await expect(handleSlashCommand("/model deepseek-v4-flash", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), runtime)).resolves.toBe(false);

    expect(cfg.model).toBe("deepseek-v4-pro");
    expect(writes.join("\n")).toContain("not available while the agent is running");
  });

  it("allows read-only config and mcp subcommands in live readonly mode", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);
    runtime.liveReadonly = true;
    const costTracker = new CostTracker(cfg.model);

    await expect(handleSlashCommand("/config explain", cfg, session, history, costTracker, runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/config validate", cfg, session, history, costTracker, runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/mcp list", cfg, session, history, costTracker, runtime)).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("\"precedence\"");
    expect(output).toContain("\"resolved\"");
    expect(output).not.toContain("not available while the agent is running");
  });

  it("cycles reasoning only through effective request tiers", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);

    await expect(handleSlashCommand("/reasoning", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    expect(cfg.reasoning_effort).toBe("max");

    await expect(handleSlashCommand("/reasoning", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    expect(cfg.reasoning_effort).toBe("off");

    await expect(handleSlashCommand("/reasoning", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    expect(cfg.reasoning_effort).toBe("high");

    cfg.reasoning_effort = "medium";
    await expect(handleSlashCommand("/reasoning", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    expect(cfg.reasoning_effort).toBe("max");

    cfg.reasoning_effort = "xhigh";
    await expect(handleSlashCommand("/reasoning", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    expect(cfg.reasoning_effort).toBe("off");
    expect(stripAnsi(writes.join("\n"))).not.toContain("Reasoning effort: low");
    expect(stripAnsi(writes.join("\n"))).not.toContain("Reasoning effort: medium");
    expect(stripAnsi(writes.join("\n"))).not.toContain("Reasoning effort: xhigh");
  });

  it("rejects extra no-argument command arguments before mutating state", async () => {
    const cfg = testConfig();
    cfg.reasoning_effort = "off";
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    session.messages.push({ role: "user", content: "Keep this" });
    session.turns.push({
      index: 1,
      user_message: "Keep this",
      assistant_messages: [],
      tool_calls: [],
      tool_results: [],
      tokens_in: 4,
      tokens_out: 2,
      cost: 0.1,
    });
    session.cumulative_tokens_in = 4;
    session.cumulative_tokens_out = 2;
    session.cumulative_cost = 0.1;
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);

    await expect(handleSlashCommand("/plan unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/agent unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/yolo unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/reasoning unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/clear unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/tokens unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/cost unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/permissions unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/version unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/capabilities unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/help unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    for (const usage of [
      "Usage: /plan",
      "Usage: /agent",
      "Usage: /yolo",
      "Usage: /reasoning",
      "Usage: /clear",
      "Usage: /tokens",
      "Usage: /cost",
      "Usage: /permissions",
      "Usage: /version",
      "Usage: /capabilities",
      "Usage: /help",
    ]) {
      expect(output).toContain(usage);
    }
    expect(cfg.mode).toBe("agent");
    expect(cfg.reasoning_effort).toBe("off");
    expect(session.mode).toBe("agent");
    expect(session.messages).toHaveLength(1);
    expect(session.turns).toHaveLength(1);
    expect(session.cumulative_tokens_in).toBe(4);
    expect(runtime.rebuilds).toEqual({ runtime: 0, system: 0 });
  });

  it("rejects extra model, provider, and restore arguments before dispatching", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);
    const costTracker = new CostTracker(cfg.model);

    await expect(handleSlashCommand("/model deepseek-v4-flash extra", cfg, session, history, costTracker, runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/provider openrouter deepseek/deepseek-v4-flash extra", cfg, session, history, costTracker, runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/restore revert extra", cfg, session, history, costTracker, runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/restore unknown", cfg, session, history, costTracker, runtime)).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("Usage: /model [name]");
    expect(output).toContain("Usage: /provider");
    expect(output).toContain("Usage: /restore [revert]");
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.model).toBe("deepseek-v4-pro");
    expect(session.model).toBe("deepseek-v4-pro");
    expect(costTracker.model).toBe("deepseek-v4-pro");
    expect(runtime.rebuilds).toEqual({ runtime: 0, system: 0 });
  });

  it("reports unknown commands without mutating state", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];

    await expect(handleSlashCommand("/does-not-exist", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);

    expect(writes.join("\n")).toContain("Unknown command: /does-not-exist");
    expect(cfg.mode).toBe("agent");
  });

  it("rejects unsafe slash command input before dispatch", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];

    await expect(handleSlashCommand(`/model bad${String.fromCharCode(0)}`, cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);
    await expect(handleSlashCommand(`/${"x".repeat(4097)}`, cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);

    expect(cfg.model).toBe("deepseek-v4-pro");
    expect(stripAnsi(writes.join("\n"))).toContain("Invalid slash command input");
  });

  it("rejects extra session command arguments before save, load, list, delete, or exit side effects", async () => {
    const cfg = testConfig();
    const session = createSession({ id: "current-session", mode: cfg.mode, model: cfg.model });
    const stored = createSession({ id: "saved-session", mode: cfg.mode, model: cfg.model });
    stored.messages.push({ role: "user", content: "Loaded target" });
    saveSession(stored);
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);

    await expect(handleSlashCommand("/save unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/load saved-session extra", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/sessions unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/delete saved-session extra", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/exit now", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("Usage: /save");
    expect(output).toContain("Usage: /load <id>");
    expect(output).toContain("Usage: /sessions");
    expect(output).toContain("Usage: /delete [id]");
    expect(output).toContain("Usage: /exit");
    expect(session.id).toBe("current-session");
    expect(existsSync(join(tmpDataHome, "seekcode", "sessions", "current-session.json"))).toBe(false);
    expect(existsSync(join(tmpDataHome, "seekcode", "sessions", "saved-session.json"))).toBe(true);
  });

  it("rejects unsafe session command ids before sanitized lookup or delete", async () => {
    const cfg = testConfig();
    const session = createSession({ id: "current-session", mode: cfg.mode, model: cfg.model });
    const stored = createSession({ id: "saved-session", mode: cfg.mode, model: cfg.model });
    stored.messages.push({ role: "user", content: "Keep this session" });
    saveSession(stored);
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);

    await expect(handleSlashCommand("/load ../saved-session.json", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/delete ../saved-session.json", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/load bad.id", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/delete bad.id", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("Usage: /load <id>");
    expect(output).toContain("Usage: /delete [id]");
    expect(session.id).toBe("current-session");
    expect(existsSync(join(tmpDataHome, "seekcode", "sessions", "saved-session.json"))).toBe(true);
  });

  it("bounds session list output from oversized persisted metadata", async () => {
    const cfg = testConfig();
    const session = createSession({ id: "current-session", mode: cfg.mode, model: cfg.model });
    const stored = createSession({
      id: "long-session",
      title: `${"t".repeat(200)}`,
      workspace_path: `/tmp/${"workspace-".repeat(40)}`,
      mode: "agent",
      model: cfg.model,
    });
    saveSession(stored);
    const writes: string[] = [];

    await expect(handleSlashCommand("/sessions", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    const line = output.split("\n").find(item => item.includes("long-session")) ?? "";
    expect(line.length).toBeLessThan(280);
    expect(line).toContain("long-session");
    expect(line).not.toContain("workspace-".repeat(20));
  });

  it("validates /tasks arguments and displays active task ids", async () => {
    clearPersistentTaskStateForTests();
    try {
      const cfg = testConfig();
      const session = createSession({ mode: cfg.mode, model: cfg.model });
      const history = new ConversationHistory(session);
      const writes: string[] = [];
      const runtime = testRuntime(session, writes);
      const task = getTaskManager().createTask("background", "Investigate slash task");
      getTaskManager().startTask(task.id);

      await expect(handleSlashCommand("/tasks", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
      await expect(handleSlashCommand("/tasks read bad.id", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
      await expect(handleSlashCommand("/tasks complete bad.id done", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
      await expect(handleSlashCommand(`/tasks complete ${task.id} done`, cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);

      const output = stripAnsi(writes.join("\n"));
      expect(output).toContain(`[${task.id}] [background] Investigate slash task`);
      expect(output).toContain("Usage: /tasks read <task-id>");
      expect(output).toContain("Usage: /tasks complete <task-id> [output]");
      expect(output).toContain(`Completed task ${task.id}`);
      expect(getTaskManager().getHistory().find(item => item.id === task.id)?.output).toBe("done");
    } finally {
      clearPersistentTaskStateForTests();
    }
  });

  it("keeps direct /tasks completion output tails on grapheme boundaries", () => {
    clearPersistentTaskStateForTests();
    try {
      const session = createSession({ mode: "agent", model: "deepseek-v4-pro" });
      const writes: string[] = [];
      const task = getTaskManager().createTask("background", "Boundary slash task");
      getTaskManager().startTask(task.id);

      tasksCommand({
        parts: ["/tasks", "complete", task.id, `${"x".repeat(5)}👨‍👩‍👧‍👦${"y".repeat(199_999)}`],
        cmd: "/tasks",
        cfg: testConfig(),
        session,
        history: new ConversationHistory(session),
        costTracker: new CostTracker("deepseek-v4-pro"),
        runtime: testRuntime(session, writes),
        write: (message: unknown) => writes.push(typeof message === "string" ? message : JSON.stringify(message)),
      });

      const taskOutput = getTaskManager().getHistory().find(item => item.id === task.id)?.output ?? "";
      expect(stripAnsi(writes.join("\n"))).toContain(`Completed task ${task.id}`);
      expect(taskOutput).not.toContain("\u200d");
      expect(hasUnpairedSurrogate(taskOutput)).toBe(false);
    } finally {
      clearPersistentTaskStateForTests();
    }
  });

  it("validates /jobs ids and subcommands before dispatching", async () => {
    clearJobManagerForTests();
    try {
      const cfg = testConfig();
      const session = createSession({ mode: cfg.mode, model: cfg.model });
      const history = new ConversationHistory(session);
      const writes: string[] = [];
      const runtime = testRuntime(session, writes);

      await expect(handleSlashCommand("/jobs show bad.id", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
      await expect(handleSlashCommand("/jobs cancel not_a_job", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
      await expect(handleSlashCommand("/jobs prune extra", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
      await expect(handleSlashCommand("/jobs unknown", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);

      const output = stripAnsi(writes.join("\n"));
      expect(output).toContain("Usage: /jobs show <job-id>");
      expect(output).toContain("Usage: /jobs cancel <job-id>");
      expect(output).toContain("Usage: /jobs prune");
      expect(output).toContain("Usage: /jobs [list|show <job-id>|cancel <job-id>|prune]");
    } finally {
      clearJobManagerForTests();
    }
  });

  it("rejects unknown /config migrate targets instead of silently migrating user config", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];

    await expect(handleSlashCommand("/config migrate workspace --dry-run", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);
    await expect(handleSlashCommand("/config migrate user project --dry-run", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);
    await expect(handleSlashCommand("/config migrate --force", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);

    expect(stripAnsi(writes.join("\n"))).toContain("Usage: /config migrate [user|project] [--dry-run]");
  });

  it("accepts /config migrate dry-run flags before or after the optional target", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];

    await expect(handleSlashCommand("/config migrate --dry-run", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);
    await expect(handleSlashCommand("/config migrate --dry-run project", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain('"changed": false');
    expect(output).toContain('"path"');
    expect(output).not.toContain("Usage: /config migrate");
  });

  it("rejects extra /config explain arguments", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];

    await expect(handleSlashCommand("/config explain unexpected", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);

    expect(stripAnsi(writes.join("\n"))).toContain("Usage: /config explain");
  });

  it("validates /mcp add input before persisting malformed server config", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];

    await expect(handleSlashCommand(`/mcp add ${"x".repeat(90)} node`, cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);
    await expect(handleSlashCommand("/mcp add bad/name node", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);
    await expect(handleSlashCommand("/mcp add 1bad node", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);
    await expect(handleSlashCommand("/mcp add demo node good good", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("Usage: /mcp add <name> <command> [args...]");
    expect(output).toContain("Added MCP server demo");
  });

  it("rejects too many /mcp add arguments", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];

    await expect(handleSlashCommand(`/mcp add demo node ${Array.from({ length: 129 }, (_, index) => `a${index}`).join(" ")}`, cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);

    expect(stripAnsi(writes.join("\n"))).toContain("Usage: /mcp add <name> <command> [args...]");
  });

  it("rejects extra /mcp selector arguments", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];

    await expect(handleSlashCommand("/mcp remove demo extra", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);

    expect(stripAnsi(writes.join("\n"))).toContain("Usage: /mcp remove <name>");
  });

  it("validates /skills and /skill arguments before dispatching", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);

    await expect(handleSlashCommand("/skills unexpected", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/skill", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/skill update name extra", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/skill uninstall name extra", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/skill trust name extra", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand("/skill install", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    await expect(handleSlashCommand(`/skill install ${"x".repeat(4097)}`, cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);

    const output = stripAnsi(writes.join("\n"));
    expect(output).toContain("Usage: /skills [--remote]");
    expect(output).toContain("Usage: /skill <name|new|install <spec>|update <name>|uninstall <name>|trust <name>>");
    expect(output).toContain("Usage: /skill update <name>");
    expect(output).toContain("Usage: /skill uninstall <name>");
    expect(output).toContain("Usage: /skill trust <name>");
    expect(output).toContain("Usage: /skill install <github:owner/repo|https://...|registry-name>");
    expect(output).toContain("Invalid slash command input");
    expect(runtime.rebuilds).toEqual({ runtime: 0, system: 0 });
  });

  it("expands Claude-compatible markdown slash commands into prompts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "seek-code-claude-command-"));
    try {
      mkdirSync(join(tmp, ".claude", "commands", "review"), { recursive: true });
      writeFileSync(join(tmp, ".claude", "commands", "review", "security.md"), [
        "---",
        "description: Security review a target",
        "arguments: target",
        "---",
        "Review $target for security issues.",
        "Raw args: $ARGUMENTS",
      ].join("\n"));
      const cfg = testConfig();
      const session = createSession({ mode: cfg.mode, model: cfg.model, workspace_path: tmp });
      const result = await handleSlashCommand(
        "/project:review:security src/auth.ts",
        cfg,
        session,
        new ConversationHistory(session),
        new CostTracker(cfg.model),
        testRuntime(session, []),
      );

      expect(result).toMatchObject({ type: "prompt", label: "/project:review:security" });
      expect(typeof result === "object" && result.input).toContain("Review src/auth.ts for security issues.");
      expect(typeof result === "object" && result.input).toContain("Source:");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bounds Claude-compatible command discovery and skips oversized command files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seek-code-claude-bounds-"));
    try {
      const root = join(tmp, ".claude", "commands");
      mkdirSync(root, { recursive: true });
      for (let index = 0; index < 230; index++) {
        writeFileSync(join(root, `cmd-${String(index).padStart(3, "0")}.md`), [
          "---",
          `description: ${"desc ".repeat(80)}\u0007`,
          "---",
          `# Command ${index}`,
          "Body",
        ].join("\n"));
      }
      writeFileSync(join(root, "too-large.md"), "x".repeat(300 * 1024));
      clearClaudeCommandCache();

      const commands = discoverClaudeCommands(tmp, join(tmp, "home"));

      expect(commands).toHaveLength(200);
      expect(commands.some(command => command.name.includes("too-large"))).toBe(false);
      expect(commands.every(command => command.description.length <= 240)).toBe(true);
      expect(commands.every(command => !command.description.includes("\u0007"))).toBe(true);
    } finally {
      clearClaudeCommandCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns defensive Claude-compatible command discovery results", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seek-code-claude-cache-"));
    try {
      mkdirSync(join(tmp, ".claude", "commands"), { recursive: true });
      writeFileSync(join(tmp, ".claude", "commands", "audit.md"), [
        "---",
        "arguments: target",
        "---",
        "Audit $target.",
      ].join("\n"));
      clearClaudeCommandCache();

      const first = discoverClaudeCommands(tmp, join(tmp, "home"));
      first[0]!.name = "project:mutated";
      first[0]!.argumentNames.push("extra");
      const second = discoverClaudeCommands(tmp, join(tmp, "home"));

      expect(second.map(command => command.name)).toEqual(["project:audit"]);
      expect(second[0]!.argumentNames).toEqual(["target"]);
    } finally {
      clearClaudeCommandCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bounds expanded Claude-compatible command prompts and arguments", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "seek-code-claude-expand-"));
    try {
      mkdirSync(join(tmp, ".claude", "commands"), { recursive: true });
      writeFileSync(join(tmp, ".claude", "commands", "huge.md"), [
        "---",
        "arguments: target",
        "---",
        "Review $target $ARGUMENTS",
        "x".repeat(90_000),
      ].join("\n"));
      clearClaudeCommandCache();
      const command = discoverClaudeCommands(tmp, join(tmp, "home")).find(item => item.name === "project:huge")!;
      const expanded = expandClaudeCommand(command, `"${"a".repeat(50_000)}"\u0001`);

      expect(expanded.length).toBeLessThanOrEqual(80_000);
      expect(expanded).not.toContain("\u0001");
      expect(expanded).toContain("a".repeat(2_000));
      expect(expanded).not.toContain("a".repeat(20_000));
    } finally {
      clearClaudeCommandCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps expanded Claude-compatible command prompts on grapheme boundaries", () => {
    const expanded = expandClaudeCommand({
      name: "project:emoji",
      description: "ignored",
      body: `${"x".repeat(63_999)}👨‍👩‍👧‍👦 $ARGUMENTS`,
      sourceFile: "/tmp/source.md",
      scope: "project",
      argumentNames: [],
    }, `${"a".repeat(16_000)}👨‍👩‍👧‍👦`);

    expect(expanded.length).toBeLessThanOrEqual(80_000);
    expect(expanded).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(expanded)).toBe(false);
  });

  it("sanitizes manually expanded Claude command objects", () => {
    const expanded = expandClaudeCommand({
      name: "project:unsafe\u0000name",
      description: "ignored",
      body: "Run $bad\u0007name and $ARGUMENTS\u0001",
      sourceFile: "/tmp/source\u0000.md",
      scope: "project",
      argumentNames: ["bad\u0007name", "extra"],
    }, "value\u0002");

    expect(expanded).toContain("/project:unsafe-name");
    expect(expanded).toContain("value");
    expect(expanded).not.toContain("\u0000");
    expect(expanded).not.toContain("\u0001");
    expect(expanded).not.toContain("\u0002");
    expect(expanded).not.toContain("\u0007");
  });

  it("rejects repeated control-character Claude-compatible command invocations", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seek-code-claude-control-"));
    try {
      mkdirSync(join(tmp, ".claude", "commands"), { recursive: true });
      writeFileSync(join(tmp, ".claude", "commands", "clean.md"), "Clean command");
      clearClaudeCommandCache();

      expect(findClaudeCommand("/project:clean\u0000 one", tmp)).toBeNull();
      expect(findClaudeCommand("/project:clean\u0007 two", tmp)).toBeNull();
      expect(findClaudeCommand("/project:clean ok", tmp)?.command.name).toBe("project:clean");
    } finally {
      clearClaudeCommandCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes Claude-compatible commands in slash completion", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seek-code-claude-complete-"));
    try {
      mkdirSync(join(tmp, ".claude", "commands"), { recursive: true });
      writeFileSync(join(tmp, ".claude", "commands", "verify.md"), [
        "---",
        "description: Run project verification",
        "---",
        "Run verification for $ARGUMENTS",
      ].join("\n"));

      const completions = commandCompletionProvider("/project:v", tmp);

      expect(completions.some(item => item.completeText === "/project:verify")).toBe(true);
      expect(completions.map(item => item.display).join("\n")).toContain("Run project verification");
    } finally {
      clearClaudeCommandCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("limits command completions for very large Claude command sets", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seek-code-claude-complete-limit-"));
    try {
      const root = join(tmp, ".claude", "commands");
      mkdirSync(root, { recursive: true });
      for (let index = 0; index < 120; index++) {
        writeFileSync(join(root, `task-${index}.md`), [
          "---",
          `description: ${"long ".repeat(100)}`,
          "---",
          "Run task",
        ].join("\n"));
      }
      clearClaudeCommandCache();

      const completions = commandCompletionProvider("/project:t", tmp);

      expect(completions).toHaveLength(80);
      expect(completions.every(item => (item.display || "").length < 400)).toBe(true);
      expect(commandCompletionProvider(`/${"x".repeat(300)}`, tmp)).toEqual([]);
    } finally {
      clearClaudeCommandCache();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function testRuntime(session: Session, writes: string[]): SlashCommandRuntime & { rebuilds: { runtime: number; system: number } } {
  const rebuilds = { runtime: 0, system: 0 };
  return {
    rebuilds,
    write(message: unknown) {
      writes.push(typeof message === "string" ? message : JSON.stringify(message));
    },
    applyLoadedSession(loaded) {
      Object.assign(session, loaded);
    },
    rebuildRuntime() {
      rebuilds.runtime++;
    },
    rebuildSystemPrompt() {
      rebuilds.system++;
    },
    renderLoadedSession() {},
  };
}

function testConfig(): Config {
  return {
    api_key: "test-key",
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
    skills_dir: "/tmp/seekcode-skills",
    skills_registry_url: "https://example.invalid/skills.json",
    skills_max_install_size_bytes: 1024,
    theme: "deepseek-dark",
    context_refresh_enabled: true,
    approval_policy: "on-request",
    sandbox_mode: "workspace-write",
    workspace_boundary: true,
    trusted_workspaces: [],
    lsp_auto_diagnostics: false,
    lsp_diagnostics_severity: "warning",
    tool_call_budget_per_turn: 80,
    tool_failure_degrade_threshold: 3,
    status_items: ["mode", "model", "workspace"],
    web: {
      enabled: true,
      mode: "live",
      search_engine: "auto",
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
      search_timeout_ms: 15_000,
      fetch_timeout_ms: 15_000,
      max_bytes: 1_000_000,
    },
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

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
