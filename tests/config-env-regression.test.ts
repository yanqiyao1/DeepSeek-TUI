import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { explainConfig, loadConfig, validateConfig } from "../src/config.js";

let tmp: string;
let oldHome: string | undefined;
let oldCwd: string;
let oldEnv: Record<string, string | undefined>;
let polluted: unknown;

const ENV_KEYS = [
  "DEEPSEEK_MAX_TOKENS",
  "DEEPSEEK_MAX_TURNS",
  "DEEPSEEK_CONTEXT_LIMIT",
  "DEEPSEEK_THEME",
  "DEEPSEEK_CONTEXT_REFRESH_ENABLED",
  "DEEPSEEK_WORKSPACE_BOUNDARY",
  "DEEPSEEK_LSP_AUTO_DIAGNOSTICS",
  "DEEPSEEK_ROLLBACK_ENABLED",
  "DEEPSEEK_COST_TRACKING",
  "DEEPSEEK_THINKING_VISIBLE",
  "DEEPSEEK_STATUS_ITEMS",
  "DEEPSEEK_WEB_ENABLED",
  "DEEPSEEK_WEB_SEARCH_TIMEOUT_MS",
  "DEEPSEEK_WEB_FETCH_TIMEOUT_MS",
  "DEEPSEEK_WEB_MAX_BYTES",
  "DEEPSEEK_WEB_SEARCH_ENGINE",
  "SEEKCODE_MAX_TURNS",
  "SEEKCODE_WEB_SEARCH_ENGINE",
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-config-env-"));
  oldHome = process.env.HOME;
  oldCwd = process.cwd();
  oldEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  polluted = ({} as Record<string, unknown>).polluted;
  process.env.HOME = join(tmp, "home");
  mkdirSync(join(process.env.HOME, ".seekcode"), { recursive: true });
  process.chdir(tmp);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  for (const key of ENV_KEYS) {
    const value = oldEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (polluted === undefined) delete (Object.prototype as Record<string, unknown>).polluted;
  else (Object.prototype as Record<string, unknown>).polluted = polluted;
  rmSync(tmp, { recursive: true, force: true });
});

describe("config env overrides", () => {
  it.each([
    ["max tokens", "DEEPSEEK_MAX_TOKENS", "1234", (cfg: ReturnType<typeof loadConfig>) => cfg.max_tokens, 1234],
    ["max turns", "DEEPSEEK_MAX_TURNS", "7", (cfg: ReturnType<typeof loadConfig>) => cfg.max_turns, 7],
    ["context limit", "DEEPSEEK_CONTEXT_LIMIT", "65536", (cfg: ReturnType<typeof loadConfig>) => cfg.context_limit, 65536],
    ["theme", "DEEPSEEK_THEME", "sunrise", (cfg: ReturnType<typeof loadConfig>) => cfg.theme, "sunrise"],
    ["rollback false", "DEEPSEEK_ROLLBACK_ENABLED", "false", (cfg: ReturnType<typeof loadConfig>) => cfg.rollback_enabled, false],
    ["rollback true", "DEEPSEEK_ROLLBACK_ENABLED", "true", (cfg: ReturnType<typeof loadConfig>) => cfg.rollback_enabled, true],
    ["cost tracking false", "DEEPSEEK_COST_TRACKING", "0", (cfg: ReturnType<typeof loadConfig>) => cfg.cost_tracking, false],
    ["cost tracking true", "DEEPSEEK_COST_TRACKING", "yes", (cfg: ReturnType<typeof loadConfig>) => cfg.cost_tracking, true],
    ["thinking visible false", "DEEPSEEK_THINKING_VISIBLE", "off", (cfg: ReturnType<typeof loadConfig>) => cfg.thinking_visible, false],
    ["thinking visible true", "DEEPSEEK_THINKING_VISIBLE", "on", (cfg: ReturnType<typeof loadConfig>) => cfg.thinking_visible, true],
  ])("loads %s from env", (_label, key, value, pick, expected) => {
    process.env[key] = value;

    const cfg = loadConfig();

    expect(pick(cfg)).toBe(expected);
  });

  it("parses comma-separated status items from env", () => {
    process.env.DEEPSEEK_STATUS_ITEMS = "mode, model ,workspace,hints";

    const cfg = loadConfig();

    expect(cfg.status_items).toEqual(["mode", "model", "workspace", "hints"]);
  });

  it("prefers canonical SEEKCODE env vars over legacy DEEPSEEK env vars", () => {
    process.env.DEEPSEEK_MAX_TURNS = "7";
    process.env.SEEKCODE_MAX_TURNS = "9";
    process.env.DEEPSEEK_WEB_SEARCH_ENGINE = "bing";
    process.env.SEEKCODE_WEB_SEARCH_ENGINE = "duckduckgo";

    const cfg = loadConfig();

    expect(cfg.max_turns).toBe(9);
    expect(cfg.web.search_engine).toBe("duckduckgo");
  });

  it("ignores invalid numeric env values and falls back to defaults", () => {
    process.env.DEEPSEEK_MAX_TURNS = "nope";
    process.env.DEEPSEEK_CONTEXT_LIMIT = "bad";

    const cfg = loadConfig();

    expect(cfg.max_turns).toBe(50);
    expect(cfg.context_limit).toBe(1_000_000);
  });

  it.each([
    ["max turns decimal", "DEEPSEEK_MAX_TURNS", "7.5", (cfg: ReturnType<typeof loadConfig>) => cfg.max_turns, 50],
    ["max turns suffix", "DEEPSEEK_MAX_TURNS", "7abc", (cfg: ReturnType<typeof loadConfig>) => cfg.max_turns, 50],
    ["context limit suffix", "DEEPSEEK_CONTEXT_LIMIT", "65536extra", (cfg: ReturnType<typeof loadConfig>) => cfg.context_limit, 1_000_000],
    ["web search timeout decimal", "DEEPSEEK_WEB_SEARCH_TIMEOUT_MS", "2500.5", (cfg: ReturnType<typeof loadConfig>) => cfg.web.search_timeout_ms, 15_000],
    ["web fetch timeout suffix", "DEEPSEEK_WEB_FETCH_TIMEOUT_MS", "3200ms", (cfg: ReturnType<typeof loadConfig>) => cfg.web.fetch_timeout_ms, 15_000],
    ["web max bytes unsafe integer", "DEEPSEEK_WEB_MAX_BYTES", "9007199254740993", (cfg: ReturnType<typeof loadConfig>) => cfg.web.max_bytes, 1_000_000],
  ])("rejects partially parsed numeric env values for %s", (_label, key, value, pick, expected) => {
    process.env[key] = value;

    const cfg = loadConfig();

    expect(pick(cfg)).toBe(expected);
  });

  it.each([
    ["context refresh", "DEEPSEEK_CONTEXT_REFRESH_ENABLED", (cfg: ReturnType<typeof loadConfig>) => cfg.context_refresh_enabled],
    ["workspace boundary", "DEEPSEEK_WORKSPACE_BOUNDARY", (cfg: ReturnType<typeof loadConfig>) => cfg.workspace_boundary],
    ["lsp auto diagnostics", "DEEPSEEK_LSP_AUTO_DIAGNOSTICS", (cfg: ReturnType<typeof loadConfig>) => cfg.lsp_auto_diagnostics],
    ["rollback", "DEEPSEEK_ROLLBACK_ENABLED", (cfg: ReturnType<typeof loadConfig>) => cfg.rollback_enabled],
    ["cost tracking", "DEEPSEEK_COST_TRACKING", (cfg: ReturnType<typeof loadConfig>) => cfg.cost_tracking],
    ["thinking visible", "DEEPSEEK_THINKING_VISIBLE", (cfg: ReturnType<typeof loadConfig>) => cfg.thinking_visible],
    ["web enabled", "DEEPSEEK_WEB_ENABLED", (cfg: ReturnType<typeof loadConfig>) => cfg.web.enabled],
  ])("rejects invalid boolean env values for %s instead of silently treating them as false", (_label, key, pick) => {
    process.env[key] = "maybe";

    const validation = validateConfig();

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.source === "env" && issue.message.includes("Expected boolean"))).toBe(true);
    expect(() => loadConfig()).toThrow(/Expected boolean/);
    delete process.env[key];
    expect(pick(loadConfig())).toBe(true);
  });

  it("ignores unsafe nested CLI override keys instead of polluting prototypes", () => {
    const cfg = loadConfig({ "__proto__.polluted": "yes", "web.__proto__.polluted": "yes", theme: "plain" });

    expect(cfg.theme).toBe("plain");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reports env conflicts in explainConfig when cli overrides win", () => {
    process.env.DEEPSEEK_THEME = "ocean";
    process.env.DEEPSEEK_MAX_TURNS = "11";

    const explain = explainConfig({ theme: "forest", max_turns: 3 });

    expect(explain.conflicts.some(conflict => conflict.key === "theme" && conflict.winner === "cli")).toBe(true);
    expect(explain.conflicts.some(conflict => conflict.key === "max_turns" && conflict.winner === "cli")).toBe(true);
  });

  it("reports nested config conflicts such as web.search_engine", () => {
    process.env.DEEPSEEK_WEB_SEARCH_ENGINE = "bing";

    const explain = explainConfig({ web: { search_engine: "duckduckgo" } });

    expect(explain.conflicts.some(conflict => conflict.key === "web.search_engine" && conflict.winner === "cli")).toBe(true);
  });

  it("keeps config validation green for the added env-backed keys", () => {
    process.env.DEEPSEEK_MAX_TURNS = "4";
    process.env.DEEPSEEK_CONTEXT_LIMIT = "32768";
    process.env.DEEPSEEK_THEME = "paper";
    process.env.DEEPSEEK_ROLLBACK_ENABLED = "1";
    process.env.DEEPSEEK_COST_TRACKING = "1";
    process.env.DEEPSEEK_THINKING_VISIBLE = "0";

    const validation = validateConfig();

    expect(validation.ok).toBe(true);
    expect(validation.resolved).toMatchObject({
      max_turns: 4,
      context_limit: 32768,
      theme: "paper",
      rollback_enabled: true,
      cost_tracking: true,
      thinking_visible: false,
    });
  });
});
