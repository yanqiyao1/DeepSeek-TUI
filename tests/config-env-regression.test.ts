import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  explainConfig,
  loadConfig,
  migrateConfigFile,
  userConfigPath,
  validateConfig,
  writeUserApiKey,
  writeUserConfigRaw,
} from "../src/config.js";

let tmp: string;
let oldHome: string | undefined;
let oldCwd: string;
let oldEnv: Record<string, string | undefined>;
let polluted: unknown;

const ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "SEEKCODE_API_KEY",
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
  "DEEPSEEK_WEB_BRAVE_API_KEY",
  "SEEKCODE_MAX_TURNS",
  "SEEKCODE_STATUS_ITEMS",
  "SEEKCODE_TRUSTED_WORKSPACES",
  "SEEKCODE_WEB_SEARCH_ENGINE",
  "SEEKCODE_WEB_BRAVE_API_KEY",
  "BRAVE_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "DEEPSEEK_BASE_URL",
  "SEEKCODE_WEB_PROXY",
  "SEEKCODE_WEB_NO_PROXY",
  "SEEKCODE_BASE_URL",
  "SEEKCODE_THEME",
  "SEEKCODE_WEB_ALLOWED_DOMAINS",
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

  it("ignores blank canonical env vars instead of masking legacy fallbacks", () => {
    process.env.SEEKCODE_MAX_TURNS = "   ";
    process.env.DEEPSEEK_MAX_TURNS = "12";
    process.env.SEEKCODE_API_KEY = " ";
    process.env.DEEPSEEK_API_KEY = "legacy-key";

    const cfg = loadConfig();

    expect(cfg.max_turns).toBe(12);
    expect(cfg.api_key).toBe("legacy-key");
  });

  it("trims direct API key env fallbacks and accepts BRAVE_API_KEY", () => {
    process.env.BRAVE_SEARCH_API_KEY = " ";
    process.env.BRAVE_API_KEY = " brave-key ";

    const cfg = loadConfig();

    expect(cfg.web.brave_api_key).toBe("brave-key");
  });

  it("ignores NUL-containing env values instead of persisting invisible config bytes", () => {
    process.env.DEEPSEEK_API_KEY = String.fromCharCode(0);
    process.env.DEEPSEEK_BASE_URL = String.fromCharCode(0);
    process.env.SEEKCODE_WEB_PROXY = String.fromCharCode(0);
    process.env.SEEKCODE_WEB_NO_PROXY = ` localhost , ${String.fromCharCode(0)} , example.com `;

    const cfg = loadConfig();

    expect(cfg.api_key).toBe("");
    expect(cfg.base_url).toBe("https://api.deepseek.com");
    expect(cfg.web.proxy).toBe("");
    expect(cfg.web.no_proxy).toEqual(["localhost"]);
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

  it("deduplicates and trims list-like env values", () => {
    process.env.SEEKCODE_STATUS_ITEMS = "mode, model,mode,,workspace ";
    process.env.SEEKCODE_TRUSTED_WORKSPACES = `${join(tmp, "a")}::${join(tmp, "a")}:${join(tmp, "b")}`;

    const cfg = loadConfig();

    expect(cfg.status_items).toEqual(["mode", "model", "workspace"]);
    expect(cfg.trusted_workspaces).toEqual([join(tmp, "a"), join(tmp, "b")]);
  });

  it("bounds list-like env values and drops overlong entries before schema validation", () => {
    process.env.SEEKCODE_STATUS_ITEMS = Array.from({ length: 50 }, () => "mode").join(",");
    process.env.SEEKCODE_WEB_ALLOWED_DOMAINS = [
      "example.com",
      "x".repeat(600),
      ...Array.from({ length: 250 }, (_, index) => `site${index}.example`),
    ].join(",");
    process.env.SEEKCODE_TRUSTED_WORKSPACES = [
      join(tmp, "root"),
      "x".repeat(5000),
      ...Array.from({ length: 250 }, (_, index) => `/w${index}`),
    ].join(":");

    const cfg = loadConfig();

    expect(cfg.status_items).toEqual(["mode"]);
    expect(cfg.web.allowed_domains).toHaveLength(200);
    expect(cfg.web.allowed_domains).toContain("example.com");
    expect(cfg.web.allowed_domains.some(item => item.length > 512)).toBe(false);
    expect(cfg.trusted_workspaces).toHaveLength(200);
    expect(cfg.trusted_workspaces).toContain(join(tmp, "root"));
    expect(cfg.trusted_workspaces.some(item => item.length > 4096)).toBe(false);
  });

  it("ignores over-limit numeric env values before they can inflate runtime budgets", () => {
    process.env.DEEPSEEK_MAX_TURNS = "10001";
    process.env.DEEPSEEK_CONTEXT_LIMIT = "10000001";
    process.env.DEEPSEEK_WEB_FETCH_TIMEOUT_MS = "60001";
    process.env.DEEPSEEK_WEB_MAX_BYTES = "10485761";

    const cfg = loadConfig();

    expect(cfg.max_turns).toBe(50);
    expect(cfg.context_limit).toBe(1_000_000);
    expect(cfg.web.fetch_timeout_ms).toBe(15_000);
    expect(cfg.web.max_bytes).toBe(1_000_000);
  });

  it("ignores overlong or control-character env strings before config parsing", () => {
    process.env.SEEKCODE_API_KEY = "x".repeat(20_000);
    process.env.SEEKCODE_BASE_URL = "https://bad.example/v1\u0001";
    process.env.SEEKCODE_THEME = "paper\u0007";

    const cfg = loadConfig();

    expect(cfg.api_key).toBe("");
    expect(cfg.base_url).toBe("https://api.deepseek.com");
    expect(cfg.theme).toBe("deepseek-dark");
  });

  it("preserves an explicitly configured default base URL when changing provider", () => {
    writeFileSync(
      join(process.env.HOME!, ".seekcode", "config.toml"),
      'provider = "openrouter"\nbase_url = "https://api.deepseek.com"\n',
      "utf-8",
    );

    const cfg = loadConfig();

    expect(cfg.provider).toBe("openrouter");
    expect(cfg.base_url).toBe("https://api.deepseek.com");
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

  it("trims CLI string overrides before validation", () => {
    const cfg = loadConfig({
      theme: " paper ",
      "web.search_engine": " bing ",
      "web.proxy": " https://proxy.example:8080 ",
    });

    expect(cfg.theme).toBe("paper");
    expect(cfg.web.search_engine).toBe("bing");
    expect(cfg.web.proxy).toBe("https://proxy.example:8080");
  });

  it("normalizes migrated MCP server records without preserving unsafe fields", () => {
    const cfg = loadConfig({
      mcp_servers: [
        {
          name: " local ",
          transport: " SSE ",
          command: " node ",
          url: " https://events.example/sse ",
          args: [" script.js ", "", " --flag ", "bad\u0000arg"],
          env: { GOOD_KEY: " yes ", "BAD-NAME": "no", "1BAD": "no", BAD_NUL: "bad\u0000value" },
        },
      ],
    });

    expect(cfg.mcp_servers[0]).toMatchObject({
      name: "local",
      transport: "sse",
      command: "node",
      args: ["script.js", "--flag"],
      url: "https://events.example/sse",
      env: { GOOD_KEY: " yes " },
    });
    expect(cfg.mcp_servers[0]?.env).not.toHaveProperty("BAD-NAME");
    expect(cfg.mcp_servers[0]?.env).not.toHaveProperty("1BAD");
    expect(cfg.mcp_servers[0]?.env).not.toHaveProperty("BAD_NUL");
  });

  it("bounds migrated MCP server arrays, args, and env records", () => {
    const cfg = loadConfig({
      mcp_servers: Array.from({ length: 70 }, (_, index) => ({
        name: `srv${index}`,
        command: "node",
        args: [
          "serve",
          "serve",
          "x".repeat(5000),
          ...Array.from({ length: 140 }, (_, argIndex) => `arg-${argIndex}`),
        ],
        env: Object.fromEntries([
          ["GOOD", "value"],
          ["TOO_LONG", "x".repeat(9000)],
          ...Array.from({ length: 150 }, (_, envIndex) => [`KEY_${envIndex}`, `value-${envIndex}`]),
        ]),
      })),
    });

    expect(cfg.mcp_servers).toHaveLength(64);
    expect(cfg.mcp_servers[0]?.args.length).toBeLessThanOrEqual(128);
    expect(cfg.mcp_servers[0]?.args).toContain("serve");
    expect(cfg.mcp_servers[0]?.args.filter(arg => arg === "serve")).toHaveLength(1);
    expect(cfg.mcp_servers[0]?.args.some(arg => arg.length > 4096)).toBe(false);
    expect(Object.keys(cfg.mcp_servers[0]?.env ?? {})).toHaveLength(128);
    expect(cfg.mcp_servers[0]?.env.GOOD).toBe("value");
    expect(cfg.mcp_servers[0]?.env).not.toHaveProperty("TOO_LONG");
  });

  it("rejects direct MCP config records with overlong schema fields", () => {
    const validation = validateConfig({
      mcp_servers: [
        {
          name: "srv",
          command: "node",
          args: Array.from({ length: 129 }, (_, index) => `arg-${index}`),
          env: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`KEY_${index}`, "value"])),
        },
      ],
    });

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.key === "mcp_servers.0.args" || issue.key === "mcp_servers.0.env")).toBe(true);
  });

  it("drops migrated MCP servers with unsafe names and strips unsafe command/url fields", () => {
    const cfg = loadConfig({
      mcp_servers: [
        { name: "bad\u0000server", command: "node" },
        { name: "bad/name", command: "node" },
        { name: "1bad", command: "node" },
        { name: "safe", command: "node\u0000bad", url: "https://events.example/sse\u0000", args: ["ok"] },
        { name: "working", command: "node", args: ["ok"] },
      ],
    });

    expect(cfg.mcp_servers).toHaveLength(2);
    expect(cfg.mcp_servers[0]).toMatchObject({ name: "safe", transport: "stdio", args: ["ok"] });
    expect(cfg.mcp_servers[0]?.command).toBeUndefined();
    expect(cfg.mcp_servers[0]?.url).toBeUndefined();
    expect(cfg.mcp_servers[1]).toMatchObject({ name: "working", transport: "stdio", command: "node", args: ["ok"] });
  });

  it("reports direct MCP config records with ambiguous local-tool names", () => {
    const validation = validateConfig({
      mcp_servers: [
        { name: "bad/name", command: "node" },
        { name: "_bad", command: "node" },
        { name: "good-name_1", command: "node" },
      ],
    });

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.key === "mcp_servers.0.name")).toBe(true);
    expect(validation.issues.some(issue => issue.key === "mcp_servers.1.name")).toBe(true);
    expect(validation.resolved?.mcp_servers.map(server => server.name)).toEqual(["good-name_1"]);
  });

  it("normalizes migrated permissions by trimming safe keys and dropping invalid actions", () => {
    const cfg = loadConfig({
      permission: {
        " bash ": "allow",
        "bad\u0000pattern": "deny",
        write: "maybe",
        read: "ask",
      },
    });

    expect(cfg.permissions).toEqual({ bash: "allow", read: "ask" });
  });

  it("reports credentialed URL config values as validation errors", () => {
    const validation = validateConfig({
      base_url: "https://user:pass@example.com",
      skills_registry_url: "file:///tmp/skills.json",
      web: {
        proxy: "https://user:pass@proxy.example:8080",
        searxng_url: "file:///tmp/search",
      },
      mcp_servers: [
        { name: "events", transport: "sse", url: "https://user:pass@example.com/sse" },
      ],
    });

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.key === "base_url" && issue.message.includes("without credentials"))).toBe(true);
    expect(validation.issues.some(issue => issue.key === "skills_registry_url" && issue.message.includes("http:// or https://"))).toBe(true);
    expect(validation.issues.some(issue => issue.key === "web.proxy" && issue.message.includes("without credentials"))).toBe(true);
    expect(validation.issues.some(issue => issue.key === "web.searxng_url" && issue.message.includes("http:// or https://"))).toBe(true);
    expect(validation.issues.some(issue => issue.key === "mcp_servers.0.url" && issue.message.includes("without credentials"))).toBe(true);
    expect(() => loadConfig({ base_url: "https://user:pass@example.com" })).toThrow(/base_url.*without credentials/);
    expect(() => loadConfig({ skills_registry_url: "file:///tmp/skills.json" })).toThrow(/skills_registry_url.*http:\/\/ or https:\/\//);
  });

  it("treats oversized config files as source errors instead of parsing unbounded TOML", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "config.toml"), `theme = "${"x".repeat(1024 * 1024 + 1)}"\n`, "utf-8");

    const validation = validateConfig({ theme: "paper" });
    const explain = explainConfig({ theme: "paper" });
    const cfg = loadConfig({ theme: "paper" });

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.source === "user" && issue.message.includes("exceeds"))).toBe(true);
    expect(explain.sources.find(source => source.source === "user")?.exists).toBe(true);
    expect(explain.conflicts.some(conflict => conflict.key === "theme")).toBe(false);
    expect(cfg.theme).toBe("paper");
  });

  it("reports directories used as config files as validation errors", () => {
    mkdirSync(join(process.env.HOME!, ".seekcode", "config.toml"), { recursive: true });

    const validation = validateConfig();

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.source === "user" && issue.message.includes("not a file"))).toBe(true);
  });

  it("does not read or write config files through symlinks", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    const outside = join(tmp, "outside-config.toml");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(outside, 'theme = "outside-secret"\n', "utf-8");
    rmSync(join(userDir, "config.toml"), { force: true });
    symlinkSync(outside, join(userDir, "config.toml"));

    const validation = validateConfig({ theme: "paper" });
    const cfg = loadConfig({ theme: "paper" });

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.source === "user" && /symlink/i.test(issue.message))).toBe(true);
    expect(cfg.theme).toBe("paper");
    expect(() => writeUserConfigRaw({ theme: "new-theme" })).toThrow(/symlink/i);
    expect(() => writeUserApiKey("new-key")).toThrow(/symlink/i);
    expect(migrateConfigFile(join(userDir, "config.toml")).warnings.join("\n")).toMatch(/symlink/i);
    expect(readFileSync(outside, "utf-8")).toContain("outside-secret");
  });

  it("does not read or write config files through symlinked config directories", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    const outsideDir = join(tmp, "outside-config-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "config.toml"), 'theme = "outside-secret"\n', "utf-8");
    rmSync(userDir, { recursive: true, force: true });
    symlinkSync(outsideDir, userDir, "dir");

    const validation = validateConfig({ theme: "paper" });
    const cfg = loadConfig({ theme: "paper" });

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.source === "user" && /parent directory|symlink/i.test(issue.message))).toBe(true);
    expect(cfg.theme).toBe("paper");
    expect(() => writeUserConfigRaw({ theme: "new-theme" })).toThrow(/parent directory|symlink/i);
    expect(() => writeUserApiKey("new-key")).toThrow(/parent directory|symlink/i);
    expect(migrateConfigFile(userConfigPath()).warnings.join("\n")).toMatch(/parent directory|symlink/i);
    expect(readFileSync(join(outsideDir, "config.toml"), "utf-8")).toContain("outside-secret");
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

  it("reports nested config keys in explainConfig sources", () => {
    process.env.DEEPSEEK_WEB_SEARCH_ENGINE = "bing";

    const explain = explainConfig({ web: { proxy: "https://proxy.example" } });

    expect(explain.sources.find(source => source.source === "env")?.keys).toContain("web.search_engine");
    expect(explain.sources.find(source => source.source === "cli")?.keys).toContain("web.proxy");
  });

  it("redacts sensitive resolved values and conflict candidates from config explain output", () => {
    process.env.DEEPSEEK_API_KEY = "env-secret";
    process.env.DEEPSEEK_WEB_BRAVE_API_KEY = "env-brave-secret";

    const explain = explainConfig({
      api_key: "cli-secret",
      web: { brave_api_key: "cli-brave-secret" },
    });

    expect(explain.resolved.api_key).toBe("[redacted]");
    expect(explain.resolved.web.brave_api_key).toBe("[redacted]");
    const output = JSON.stringify(explain);
    expect(output).not.toContain("cli-secret");
    expect(output).not.toContain("env-secret");
    expect(output).not.toContain("cli-brave-secret");
    expect(output).not.toContain("env-brave-secret");
    expect(explain.conflicts.find(conflict => conflict.key === "api_key")?.winner_value).toBe("[redacted]");
  });

  it("skips unreadable config sources when explaining conflicts", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "config.toml"), "theme = [broken\n", "utf-8");

    const explain = explainConfig({ theme: "paper" });

    expect(explain.sources.find(source => source.source === "user")?.exists).toBe(true);
    expect(explain.conflicts.some(conflict => conflict.key === "theme")).toBe(false);
    expect(explain.resolved.theme).toBe("paper");
  });

  it("trims written API keys and rejects blank or NUL API keys", () => {
    writeUserApiKey("  secret-key  ");

    expect(readFileSync(userConfigPath(), "utf-8")).toContain('api_key = "secret-key"');
    expect(() => writeUserApiKey("  ")).toThrow(/non-empty/);
    expect(() => writeUserApiKey("bad\u0000key")).toThrow(/non-empty/);
  });

  it("sanitizes raw config writes before TOML serialization", () => {
    writeUserConfigRaw({
      theme: " paper ",
      bad: undefined,
      nan: Number.NaN,
      bigint_value: BigInt(7),
      "__proto__": { polluted: true },
      nested: {
        ok: " value ",
        control: "bad\u0000value",
      },
      list: [" a ", "bad\u0000value", undefined, BigInt(3)],
    });

    const raw = readFileSync(userConfigPath(), "utf-8");

    expect(raw).toContain('theme = "paper"');
    expect(raw).toContain('bigint_value = "7"');
    expect(raw).toContain('ok = "value"');
    expect(raw).toContain('"3"');
    expect(raw).not.toContain("bad\u0000value");
    expect(raw).not.toContain("__proto__");
    expect(raw).not.toContain("nan");
  });

  it("writes user config atomically without exposing orphan temp files as config sources", () => {
    writeUserConfigRaw({ theme: "paper" });
    const userDir = join(process.env.HOME!, ".seekcode");
    const orphanTemp = ".config.toml.123.tmp";
    writeFileSync(join(userDir, orphanTemp), "theme = [broken\n", "utf-8");

    writeUserApiKey("secret-key");

    expect(loadConfig().api_key).toBe("secret-key");
    expect(loadConfig().theme).toBe("paper");
    expect(readFileSync(userConfigPath(), "utf-8")).toContain('api_key = "secret-key"');
    expect(readdirSync(userDir).filter(name => name.endsWith(".tmp"))).toEqual([orphanTemp]);
  });

  it("handles throwing config override objects without crashing validation or explain output", () => {
    const throwing: Record<string, unknown> = { theme: "paper" };
    Object.defineProperty(throwing, "bad", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, "search_engine", {
      enumerable: true,
      get() {
        throw new Error("nested getter failed");
      },
    });
    throwing.web = nested;

    const validation = validateConfig(throwing);
    const explain = explainConfig(throwing);

    expect(validation.ok).toBe(true);
    expect(explain.resolved.theme).toBe("paper");
    expect(JSON.stringify(explain)).not.toContain("getter failed");
    expect(() => writeUserConfigRaw(throwing)).not.toThrow();
  });

  it("returns warnings for NUL-containing config migration paths", () => {
    const report = migrateConfigFile(`${tmp}\u0000bad`, { dryRun: true });

    expect(report.changed).toBe(false);
    expect(report.warnings.join("\n")).toContain("NUL");
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

  it.each([
    ["max_tokens", { max_tokens: 0 }, /max_tokens/i],
    ["max_turns", { max_turns: 0 }, /max_turns/i],
    ["context_limit", { context_limit: 0 }, /context_limit/i],
    ["tool_call_budget_per_turn", { tool_call_budget_per_turn: 0 }, /tool_call_budget_per_turn/i],
    ["tool_failure_degrade_threshold", { tool_failure_degrade_threshold: 0 }, /tool_failure_degrade_threshold/i],
  ])("rejects non-positive runtime budget config for %s", (_label, overrides, message) => {
    expect(() => loadConfig(overrides)).toThrow(message);

    const validation = validateConfig(overrides);

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.source === "resolved" && message.test(issue.message))).toBe(true);
  });
});
