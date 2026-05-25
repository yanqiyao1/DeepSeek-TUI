import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(".");
const srcCli = ["npx", ["tsx", "src/index.ts"]] as const;
const distCli = ["node", [join(repoRoot, "dist", "index.js")]] as const;

let tmp: string;
let server: Server | undefined;
let serverUrl = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-cli-"));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
    server = undefined;
    serverUrl = "";
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("CLI and packaging", () => {
  it("exposes the seek bin and builds an executable dist entry", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    const dist = join(repoRoot, "dist", "index.js");

    expect(pkg.name).toBe("seekcode");
    expect(pkg.bin).toEqual({ seek: "dist/index.js" });
    expect(existsSync(dist)).toBe(true);
    expect(readFileSync(dist, "utf-8").startsWith("#!/usr/bin/env node")).toBe(true);
    expect((statSync(dist).mode & 0o111) !== 0).toBe(true);
  });

  it("prints help and version from source and dist entrypoints", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    for (const cli of [srcCli, distCli]) {
      const help = runCli(cli, ["--help"]);
      const version = runCli(cli, ["--version"]);

      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage: seek");
      expect(help.stdout).toContain("Seek Code");
      expect(help.stdout).toContain("serve [options]");
      expect(help.stdout).toContain("config [options]");
      expect(help.stdout).toContain("update [options]");
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe(pkg.version);
    }
  });

  it("does not let command defaults override env or config values", () => {
    writeUserConfig("model = \"deepseek-v4-flash\"\nmode = \"plan\"\nreasoning_effort = \"low\"\n");

    const fromConfig = runCli(srcCli, ["config", "explain"], { env: { DEEPSEEK_API_KEY: "test-key" } });
    const fromEnv = runCli(srcCli, ["config", "explain"], {
      env: { DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "deepseek-v4-pro", DEEPSEEK_MODE: "yolo" },
    });
    const fromCli = runCli(srcCli, ["--model", "deepseek-v4-flash", "--mode", "agent", "config", "explain"], {
      env: { DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "deepseek-v4-pro", DEEPSEEK_MODE: "yolo" },
    });

    expect(JSON.parse(fromConfig.stdout).resolved).toMatchObject({ model: "deepseek-v4-flash", mode: "plan", reasoning_effort: "low" });
    expect(JSON.parse(fromEnv.stdout).resolved).toMatchObject({ model: "deepseek-v4-pro", mode: "yolo" });
    expect(JSON.parse(fromCli.stdout).resolved).toMatchObject({ model: "deepseek-v4-flash", mode: "agent" });
  });

  it("rejects partially parsed CLI integer options instead of accepting numeric prefixes", () => {
    const result = runCli(srcCli, ["--max-tokens", "7abc", "config", "explain"], {
      env: { DEEPSEEK_API_KEY: "test-key" },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).resolved.max_tokens).toBe(8192);
  });

  it("applies project config from the current workspace during runtime commands", async () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(join(workspace, ".seekcode"), { recursive: true });
    writeFileSync(join(workspace, ".seekcode", "config.toml"), [
      'base_url = "http://127.0.0.1:9/v1"',
      'reasoning_effort = "off"',
      "",
    ].join("\n"));

    const result = await runCliAsync(distCli, ["hello", "from", "workspace"], {
      env: { DEEPSEEK_API_KEY: "test-key" },
      cwd: workspace,
      timeoutMs: 10_000,
    });
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(1);
    expect(output).toContain("Error:");
    expect(output).not.toContain("one-shot ok");
  });

  it("fails fast for invalid provider values in config validation", () => {
    writeUserConfig('provider = "not-a-provider"\n');

    const result = runCli(srcCli, ["config", "validate"]);
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(1);
    expect(output).toContain("provider");
  });

  it("fails fast for invalid provider values during runtime startup", () => {
    writeUserConfig('provider = "not-a-provider"\napi_key = "config-key"\n');

    const result = runCli(srcCli, ["hello", "from", "bad-provider"]);
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(1);
    expect(output).toContain("provider");
    expect(output).not.toContain("one-shot ok");
  });

  it("lets explicit CLI base_url override workspace project config", async () => {
    const requests: any[] = [];
    await startFakeOpenAIServer(requests);
    const workspace = join(tmp, "workspace");
    mkdirSync(join(workspace, ".seekcode"), { recursive: true });
    writeFileSync(join(workspace, ".seekcode", "config.toml"), [
      'base_url = "http://127.0.0.1:9/v1"',
      'reasoning_effort = "off"',
      "",
    ].join("\n"));

    const result = await runCliAsync(distCli, ["--base-url", serverUrl, "--api-key", "test-key", "hello", "override"], {
      cwd: workspace,
      timeoutMs: 10_000,
    });

    expect(result.status).toBe(0);
    expect(stripAnsi(result.stdout)).toContain("one-shot ok");
    expect(requests).toHaveLength(1);
  });

  it("creates ~/.seekcode/config.toml during config commands", () => {
    const configPath = join(tmp, "home", ".seekcode", "config.toml");

    const result = runCli(srcCli, ["config", "validate"]);

    expect(result.status).toBe(0);
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toContain('api_key = ""');
  });

  it("rejects unknown config migration targets", () => {
    const result = runCli(srcCli, ["config", "migrate", "--target", "workspace", "--dry-run"]);
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(1);
    expect(output).toContain("Migration target must be user or project");
  });

  it("prints update diagnostics without requiring API configuration", () => {
    const result = runCli(srcCli, ["update", "--diagnose"], {
      env: { DEEPSEEK_API_KEY: "", SEEKCODE_SKIP_UPDATE_CHECK: "1" },
    });

    expect(result.status).toBe(0);
    expect(stripAnsi(result.stdout)).toContain("Installation:");
    expect(stripAnsi(result.stdout)).toContain("Update command:");
    expect(existsSync(join(tmp, "home", ".seekcode", "config.toml"))).toBe(false);
  });

  it("runs one-shot prompts with multiple words against an OpenAI-compatible endpoint", async () => {
    const requests: any[] = [];
    await startFakeOpenAIServer(requests);

    for (const cli of [srcCli, distCli]) {
      const result = await runCliAsync(cli, ["--base-url", serverUrl, "--api-key", "test-key", "--reasoning-effort", "off", "hello", "from", "seek"], {
        env: { DEEPSEEK_API_KEY: "env-key" },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(stripAnsi(result.stdout)).toContain("one-shot ok");
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.messages.at(-1)).toMatchObject({ role: "user", content: "hello from seek" });
      expect(request.stream).toBe(true);
      expect(request.model).toBe("deepseek-v4-pro");
      expect(request.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "read" }) }),
      ]));
    }
  });

  it("routes one-shot prompts through the engine tool loop", async () => {
    const requests: any[] = [];
    await startFakeOpenAIServer(requests, (_request, res, requestNumber) => {
      if (requestNumber === 1) {
        writeSse(res, {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_read_fixture",
                type: "function",
                function: { name: "read", arguments: "{\"path\":\"fixture.txt\"}" },
              }],
            },
            finish_reason: null,
          }],
        });
        writeSse(res, {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 11, completion_tokens: 2 },
        });
      } else {
        writeSse(res, { choices: [{ delta: { content: "read via tool ok" }, finish_reason: null }] });
        writeSse(res, {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 13, completion_tokens: 4 },
        });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "fixture.txt"), "fixture body from tool\n");

    const result = await runCliAsync(distCli, ["--base-url", serverUrl, "--api-key", "test-key", "--reasoning-effort", "off", "summarize", "fixture"], {
      cwd: workspace,
      timeoutMs: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(stripAnsi(result.stdout)).toContain("read via tool ok");
    expect(requests).toHaveLength(2);
    expect(requests[0].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "read" }) }),
    ]));
    expect(requests[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", name: "read", content: expect.stringContaining("fixture body from tool") }),
    ]));
  });

  it("sanitizes malformed one-shot usage telemetry before printing token totals", async () => {
    const requests: any[] = [];
    await startFakeOpenAIServer(requests, (_request, res) => {
      writeSse(res, { choices: [{ delta: { content: "usage ok" }, finish_reason: null }] });
      writeSse(res, {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: "12", completion_tokens: Number.POSITIVE_INFINITY, total_tokens: 99 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const result = await runCliAsync(srcCli, ["--base-url", serverUrl, "--api-key", "test-key", "--reasoning-effort", "off", "check", "usage"], {
      timeoutMs: 10_000,
    });
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(0);
    expect(output).toContain("usage ok");
    expect(output).toContain("--- Tokens: 0 in / 0 out ---");
    expect(output).not.toContain("NaN");
    expect(output).not.toContain("Infinity");
    expect(output).not.toContain("12 in");
  });

  it("reads the API key and base URL from ~/.seekcode/config.toml", async () => {
    const requests: any[] = [];
    await startFakeOpenAIServer(requests);
    writeUserConfig([
      'api_key = "config-key"',
      `base_url = "${serverUrl}"`,
      'reasoning_effort = "off"',
      "",
    ].join("\n"));

    const result = await runCliAsync(srcCli, ["hello", "from", "config"], {
      env: { DEEPSEEK_API_KEY: "" },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(stripAnsi(result.stdout)).toContain("one-shot ok");
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe("Bearer config-key");
    expect(requests[0].messages.at(-1)).toMatchObject({ role: "user", content: "hello from config" });
  });

  it("starts interactive UI and exits cleanly from stdin", () => {
    const result = runCli(srcCli, ["--no-alt-screen"], {
      input: "/exit\n",
      timeoutMs: 5_000,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_TUI_ALTERNATE_SCREEN: "never",
        DEEPSEEK_STATUS_ITEMS: "mode,model,workspace,hints",
        COLUMNS: "100",
        LINES: "30",
      },
    });
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(0);
    expect(output).toContain("Seek Code");
    expect(output).toContain("Type a request or /help");
    expect(output).toContain("Goodbye!");
    expect(output).toContain("Session saved as");
    expect(output).toContain("Resume with: seek");
  });

  it("reports missing API key before interactive startup", () => {
    const result = runCli(srcCli, ["--no-alt-screen"], { env: { DEEPSEEK_API_KEY: "" } });

    expect(result.status).toBe(1);
    expect(stripAnsi(result.stderr)).toContain("DEEPSEEK_API_KEY is required");
    expect(stripAnsi(result.stderr)).toContain("platform.deepseek.com");
    expect(stripAnsi(result.stderr)).toContain(".seekcode/config.toml");
    expect(stripAnsi(result.stdout)).not.toContain("Seek Code");
  });
});

function runCli(
  cli: readonly [string, readonly string[]],
  args: string[],
  options: { env?: Record<string, string>; input?: string; timeoutMs?: number; cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const env = {
    ...process.env,
    HOME: join(tmp, "home"),
    XDG_DATA_HOME: join(tmp, "data"),
    DEEPCODE_ARTIFACTS_DIR: join(tmp, "artifacts"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    ...options.env,
  };
  const result = spawnSync(cli[0], [...cli[1], ...args], {
    cwd: options.cwd || repoRoot,
    env,
    input: options.input,
    encoding: "utf-8",
    timeout: options.timeoutMs || 10_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function runCliAsync(
  cli: readonly [string, readonly string[]],
  args: string[],
  options: { env?: Record<string, string>; input?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    HOME: join(tmp, "home"),
    XDG_DATA_HOME: join(tmp, "data"),
    DEEPCODE_ARTIFACTS_DIR: join(tmp, "artifacts"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    ...options.env,
  };
  return new Promise(resolve => {
    const child = spawn(cli[0], [...cli[1], ...args], {
      cwd: options.cwd || repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs || 10_000);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    child.on("close", status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function writeUserConfig(content: string): void {
  const configDir = join(tmp, "home", ".seekcode");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), content);
}

type FakeOpenAIResponder = (request: any, res: ServerResponse, requestNumber: number) => void;

async function startFakeOpenAIServer(requests: any[], respond: FakeOpenAIResponder = defaultOpenAIResponder): Promise<void> {
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/chat/completions") {
        res.writeHead(404).end("not found");
        return;
      }
      const request = { ...JSON.parse(body), authorization: req.headers.authorization };
      requests.push(request);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      respond(request, res, requests.length);
    });
  });
  await new Promise<void>(resolveListen => server!.listen(0, "127.0.0.1", () => resolveListen()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
  serverUrl = `http://127.0.0.1:${address.port}`;
}

function defaultOpenAIResponder(_request: any, res: ServerResponse): void {
  writeSse(res, { choices: [{ delta: { content: "one-shot ok" }, finish_reason: null }] });
  writeSse(res, {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeSse(res: ServerResponse, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
