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
    expect(output).toContain("Tab complete");
  });

  it("saves the interactive session when stdin closes without /exit", () => {
    const result = runCli(srcCli, ["--no-alt-screen"], {
      input: "",
      timeoutMs: 5_000,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_TUI_ALTERNATE_SCREEN: "never",
        COLUMNS: "100",
        LINES: "30",
      },
    });
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(0);
    expect(output).toContain("Goodbye!");
    expect(output).toContain("Session saved as");
    expect(output).toContain("Resume with: seek");
  });

  it("honors cost tracking and configurable footer status items in interactive mode", async () => {
    const requests: any[] = [];
    await startFakeOpenAIServer(requests, (_request, res) => {
      writeSse(res, { choices: [{ delta: { content: "interactive ok" }, finish_reason: null }] });
      writeSse(res, {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 2_000_000, completion_tokens: 1_000_000 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const workspace = join(tmp, "interactive-workspace");
    mkdirSync(workspace, { recursive: true });

    const result = await runCliAsync(distCli, ["--no-alt-screen"], {
      cwd: workspace,
      timeoutMs: 8_000,
      inputDriver: async ({ stdin, waitForStdout }) => {
        await waitForStdout("Type a request", 5_000);
        stdin.write("inspect cost tracking\n");
        await waitForStdout("interactive ok", 5_000);
        stdin.write("/exit\n");
        stdin.end();
      },
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: serverUrl,
        DEEPSEEK_TUI_ALTERNATE_SCREEN: "never",
        DEEPSEEK_STATUS_ITEMS: "mode,model,workspace,context,hints",
        DEEPSEEK_COST_TRACKING: "false",
        COLUMNS: "120",
        LINES: "30",
      },
    });
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(0);
    expect(requests).toHaveLength(1);
    expect(output).toContain("interactive ok");
    expect(output).toContain("Tab complete");
    expect(output).not.toContain("$");
    expect(output).toContain("Session saved as");

    const sessionId = /Session saved as ([a-zA-Z0-9._-]+)/.exec(output)?.[1];
    expect(sessionId).toBeTruthy();
    if (!sessionId) return;
    const sessionsDir = join(tmp, "data", "seekcode", "sessions");
    const saved = JSON.parse(readFileSync(join(sessionsDir, `${sessionId}.json`), "utf-8"));
    expect(saved.cumulative_cost).toBe(0);
    expect(saved.turns.at(-1)?.cost).toBe(0);
  });

  it("flushes submitted prompt history before exiting interactive UI", async () => {
    const workspace = join(tmp, "prompt-history-workspace");
    mkdirSync(workspace, { recursive: true });
    const result = await runCliAsync(distCli, ["--no-alt-screen"], {
      timeoutMs: 5_000,
      cwd: workspace,
      inputChunks: [
        { data: "remember this prompt\n", delayMs: 0 },
        { data: "/exit\n", delayMs: 1_000 },
      ],
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "http://127.0.0.1:9/v1",
        DEEPSEEK_TUI_ALTERNATE_SCREEN: "never",
        DEEPSEEK_STATUS_ITEMS: "mode,model,workspace,hints",
        COLUMNS: "100",
        LINES: "30",
      },
    });
    const output = stripAnsi(result.stdout + result.stderr);
    const promptHistory = readFileSync(join(tmp, "data", "seekcode", "prompt-history.txt"), "utf-8");

    expect(result.status).toBe(0);
    expect(output).toContain("Goodbye!");
    expect(promptHistory).toContain("remember this prompt\n");
    expect(promptHistory).not.toContain("/exit");
  });

  it("exits and saves when stdin closes during an approval prompt", async () => {
    const requests: any[] = [];
    const workspace = join(tmp, "approval-eof-workspace");
    mkdirSync(workspace, { recursive: true });
    let pendingApprovalResponse: ServerResponse | null = null;

    await startFakeOpenAIServer(requests, (_request, res, requestNumber) => {
      if (requestNumber === 1) {
        pendingApprovalResponse = res;
        return;
      }
      writeSse(res, { choices: [{ delta: { content: "unexpected follow-up" }, finish_reason: null }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const finishApprovalResponse = () => {
      if (!pendingApprovalResponse) throw new Error("missing approval response");
      writeSse(pendingApprovalResponse, {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_write_eof",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "approval-eof.txt", content: "should not write\n" }),
              },
            }],
          },
          finish_reason: null,
        }],
      });
      writeSse(pendingApprovalResponse, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      pendingApprovalResponse.write("data: [DONE]\n\n");
      pendingApprovalResponse.end();
      pendingApprovalResponse = null;
    };

    const result = await runCliAsync(distCli, [
      "--no-alt-screen",
      "--base-url", serverUrl,
      "--api-key", "test-key",
      "--reasoning-effort", "off",
    ], {
      cwd: workspace,
      inputDriver: async ({ stdin, waitForStdout }) => {
        await waitForStdout("Type a request", 5_000);
        stdin.write("start approval eof\n");
        await waitForCondition(() => requests.length >= 1 && !!pendingApprovalResponse, 5_000);
        finishApprovalResponse();
        await waitForStdout("Approval required", 5_000);
        stdin.end();
      },
      timeoutMs: 10_000,
      env: {
        DEEPSEEK_TUI_ALTERNATE_SCREEN: "never",
        DEEPSEEK_STATUS_ITEMS: "mode,model,workspace,hints",
        COLUMNS: "100",
        LINES: "30",
      },
    });
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(0);
    expect(output).toContain("Goodbye!");
    expect(output).toContain("Session saved as");
    expect(existsSync(join(workspace, "approval-eof.txt"))).toBe(false);
  }, 12_000);

  it("preserves live input drafts while approval prompts are open", async () => {
    const requests: any[] = [];
    const workspace = join(tmp, "approval-workspace");
    mkdirSync(workspace, { recursive: true });
    let pendingApprovalResponse: ServerResponse | null = null;
    let pendingFirstTurnResponse: ServerResponse | null = null;

    await startFakeOpenAIServer(requests, (_request, res, requestNumber) => {
      if (requestNumber === 1) {
        pendingApprovalResponse = res;
        return;
      }
      if (requestNumber === 2) {
        pendingFirstTurnResponse = res;
        return;
      }
      writeSse(res, { choices: [{ delta: { content: "second turn done" }, finish_reason: null }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const finishApprovalResponse = () => {
      if (!pendingApprovalResponse) throw new Error("missing approval response");
      writeSse(pendingApprovalResponse, {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_write_approval",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "approval-draft.txt", content: "approved\n" }),
              },
            }],
          },
          finish_reason: null,
        }],
      });
      writeSse(pendingApprovalResponse, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      pendingApprovalResponse.write("data: [DONE]\n\n");
      pendingApprovalResponse.end();
      pendingApprovalResponse = null;
    };

    const finishFirstTurnResponse = () => {
      if (!pendingFirstTurnResponse) throw new Error("missing first turn response");
      writeSse(pendingFirstTurnResponse, { choices: [{ delta: { content: "first turn done" }, finish_reason: null }] });
      writeSse(pendingFirstTurnResponse, { choices: [{ delta: {}, finish_reason: "stop" }] });
      pendingFirstTurnResponse.write("data: [DONE]\n\n");
      pendingFirstTurnResponse.end();
      pendingFirstTurnResponse = null;
    };

    const result = await runCliAsync(distCli, [
      "--no-alt-screen",
      "--base-url", serverUrl,
      "--api-key", "test-key",
      "--reasoning-effort", "off",
    ], {
      cwd: workspace,
      inputDriver: async ({ stdin, waitForStdout }) => {
        await waitForStdout("Type a request", 5_000);
        stdin.write("start approval\n");
        await waitForCondition(() => requests.length >= 1 && !!pendingApprovalResponse, 5_000);
        stdin.write("follow up");
        await waitForStdout("follow up", 5_000);
        finishApprovalResponse();
        await waitForStdout("Approval required", 5_000);
        stdin.write("y");
        await waitForCondition(() => requests.length >= 2 && !!pendingFirstTurnResponse, 5_000);
        stdin.write(" done");
        await waitForStdout("follow up done", 5_000);
        await new Promise(resolve => setTimeout(resolve, 120));
        stdin.write("\n");
        await waitForStdout("Queued for the next turn.", 5_000);
        finishFirstTurnResponse();
        await waitForCondition(() => requests.length >= 3, 5_000);
        stdin.write("/exit\n");
        stdin.end();
      },
      timeoutMs: 10_000,
      env: {
        DEEPSEEK_TUI_ALTERNATE_SCREEN: "never",
        DEEPSEEK_STATUS_ITEMS: "mode,model,workspace,hints",
        COLUMNS: "100",
        LINES: "30",
      },
    });
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(0);
    expect(output).toContain("Goodbye!");
    expect(readFileSync(join(workspace, "approval-draft.txt"), "utf-8")).toBe("approved\n");
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests[2].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "follow up done" }),
    ]));
  }, 12_000);

  it("rejects invalid live slash commands instead of queueing them as prompts", async () => {
    const requests: any[] = [];
    const workspace = join(tmp, "live-invalid-slash-workspace");
    mkdirSync(workspace, { recursive: true });
    let pendingFirstResponse: ServerResponse | null = null;

    await startFakeOpenAIServer(requests, (_request, res, requestNumber) => {
      if (requestNumber === 1) {
        pendingFirstResponse = res;
        return;
      }
      writeSse(res, { choices: [{ delta: { content: "unexpected queued turn" }, finish_reason: null }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const finishFirstResponse = () => {
      if (!pendingFirstResponse) throw new Error("missing first response");
      writeSse(pendingFirstResponse, { choices: [{ delta: { content: "first done" }, finish_reason: null }] });
      writeSse(pendingFirstResponse, { choices: [{ delta: {}, finish_reason: "stop" }] });
      pendingFirstResponse.write("data: [DONE]\n\n");
      pendingFirstResponse.end();
      pendingFirstResponse = null;
    };

    const result = await runCliAsync(distCli, [
      "--no-alt-screen",
      "--base-url", serverUrl,
      "--api-key", "test-key",
      "--reasoning-effort", "off",
    ], {
      cwd: workspace,
      inputDriver: async ({ stdin, waitForStdout }) => {
        await waitForStdout("Type a request", 5_000);
        stdin.write("start long turn\n");
        await waitForCondition(() => requests.length >= 1 && !!pendingFirstResponse, 5_000);
        stdin.write(`/model bad${String.fromCharCode(7)}\n`);
        await waitForStdout("Invalid slash command input", 5_000);
        finishFirstResponse();
        await waitForStdout("first done", 5_000);
        stdin.write("/exit\n");
        stdin.end();
      },
      timeoutMs: 10_000,
      env: {
        DEEPSEEK_TUI_ALTERNATE_SCREEN: "never",
        DEEPSEEK_STATUS_ITEMS: "mode,model,workspace,hints",
        COLUMNS: "100",
        LINES: "30",
      },
    });
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(0);
    expect(output).toContain("Invalid slash command input");
    expect(output).not.toContain("Queued for the next turn.");
    expect(requests).toHaveLength(1);
  }, 12_000);

  it("shuts down MCP stdio subprocesses before returning from /exit", () => {
    const serverFile = join(tmp, "sticky-mcp.mjs");
    writeFileSync(serverFile, [
      "function respond(id, result) {",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
      "}",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk.toString('utf-8');",
      "  let index;",
      "  while ((index = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, index).trim();",
      "    buffer = buffer.slice(index + 1);",
      "    if (!line) continue;",
      "    const request = JSON.parse(line);",
      "    if (request.method === 'initialize') respond(request.id, { protocolVersion: '2024-11-05', capabilities: {} });",
      "    else if (request.method === 'tools/list') respond(request.id, { tools: [] });",
      "    else respond(request.id, {});",
      "  }",
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    writeUserConfig([
      'api_key = "config-key"',
      'reasoning_effort = "off"',
      'tui_alternate_screen = "never"',
      "[[mcp_servers]]",
      'name = "sticky"',
      'transport = "stdio"',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(serverFile)}]`,
      "",
    ].join("\n"));

    const result = runCli(srcCli, ["--no-alt-screen"], {
      input: "/exit\n",
      timeoutMs: 4_000,
      env: {
        DEEPSEEK_STATUS_ITEMS: "mode,model,workspace,hints",
        COLUMNS: "100",
        LINES: "30",
      },
    });
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(0);
    expect(output).toContain("Goodbye!");
    expect(output).toContain("Session saved as");
  });

  it("shuts down LSP subprocesses before returning from /exit", async () => {
    const requests: any[] = [];
    await startFakeOpenAIServer(requests, (request, res, requestNumber) => {
      if (requestNumber === 1) {
        writeSse(res, {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_lsp",
                type: "function",
                function: {
                  name: "lsp_symbols",
                  arguments: JSON.stringify({ file: "sample.ts" }),
                },
              }],
            },
            finish_reason: null,
          }],
        });
        writeSse(res, {
          choices: [{
            delta: {},
            finish_reason: "tool_calls",
          }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
	      }
	      if (requestNumber === 2) {
	        writeSse(res, { choices: [{ delta: { content: "waiting" }, finish_reason: null }] });
	        return;
	      }
	      writeSse(res, { choices: [{ delta: { content: "done" }, finish_reason: null }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const workspace = join(tmp, "workspace");
    const lspServer = join(tmp, "sticky-lsp.mjs");
    const lspMarker = join(tmp, "lsp-symbols.marker");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "sample.ts"), "export function StickySymbol() { return 1; }\n");
    writeFileSync(lspServer, stickyLspServerSource(lspMarker));

    const result = await runCliAsync(["npx", ["tsx", join(repoRoot, "src/index.ts")]], ["--no-alt-screen"], {
      cwd: workspace,
      inputDriver: async ({ stdin }) => {
        stdin.write("inspect symbols");
        stdin.write("\n");
        await waitForCondition(() => requests.length >= 2 && existsSync(lspMarker), 5_000);
        stdin.write("/exit\n");
        stdin.end();
      },
      timeoutMs: 6_000,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: serverUrl,
        DEEPSEEK_MODEL: "deepseek-chat",
        DEEPSEEK_REASONING_EFFORT: "off",
        DEEPSEEK_TUI_ALTERNATE_SCREEN: "never",
        DEEPSEEK_STATUS_ITEMS: "mode,model,workspace,hints",
        SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER: process.execPath,
        SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS: lspServer,
        COLUMNS: "100",
        LINES: "30",
      },
    });
    const output = stripAnsi(result.stdout + result.stderr);

    expect(result.status).toBe(0);
    expect(output).toContain("Goodbye!");
    expect(output).toContain("Session saved as");
    expect(requests.length).toBeGreaterThanOrEqual(2);
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
  options: {
    env?: Record<string, string>;
    input?: string;
    inputChunks?: Array<{ data: string; delayMs?: number }>;
    inputDriver?: (ctx: { stdin: NodeJS.WritableStream; waitForStdout: (needle: string, timeoutMs?: number) => Promise<void> }) => Promise<void> | void;
    timeoutMs?: number;
    cwd?: string;
  } = {},
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
	    const inputTimers: NodeJS.Timeout[] = [];
	    const stdoutWaiters: Array<{ needle: string; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }> = [];
	    const waitForStdout = (needle: string, timeoutMs = 2_000) => new Promise<void>((resolve, reject) => {
	      if (stdout.includes(needle)) {
	        resolve();
	        return;
	      }
	      const waiter = {
	        needle,
	        resolve,
	        reject,
	        timer: setTimeout(() => {
	          const index = stdoutWaiters.indexOf(waiter);
	          if (index >= 0) stdoutWaiters.splice(index, 1);
	          reject(new Error(`Timed out waiting for stdout: ${needle}`));
	        }, timeoutMs),
	      };
	      stdoutWaiters.push(waiter);
	    });
	    const checkStdoutWaiters = () => {
	      for (const waiter of [...stdoutWaiters]) {
	        if (!stdout.includes(waiter.needle)) continue;
	        clearTimeout(waiter.timer);
	        stdoutWaiters.splice(stdoutWaiters.indexOf(waiter), 1);
	        waiter.resolve();
	      }
	    };
	    const timer = setTimeout(() => {
	      child.kill("SIGTERM");
	    }, options.timeoutMs || 10_000);
	    child.stdin.on("error", () => undefined);
	    child.stdout.setEncoding("utf-8");
	    child.stderr.setEncoding("utf-8");
	    child.stdout.on("data", chunk => { stdout += chunk; checkStdoutWaiters(); });
	    child.stderr.on("data", chunk => { stderr += chunk; });
	    if (options.inputDriver) {
	      Promise.resolve(options.inputDriver({ stdin: child.stdin, waitForStdout })).catch(error => {
	        stderr += `\ninput driver failed: ${error instanceof Error ? error.message : String(error)}\n`;
	        child.stdin.end();
	      });
	    } else if (options.inputChunks) {
	      const chunks = options.inputChunks;
	      let elapsed = 0;
	      chunks.forEach((chunk, index) => {
	        elapsed += chunk.delayMs ?? 0;
	        const inputTimer = setTimeout(() => {
	          if (!child.stdin.destroyed) child.stdin.write(chunk.data);
	          if (index === chunks.length - 1 && !child.stdin.destroyed) child.stdin.end();
	        }, elapsed);
	        inputTimers.push(inputTimer);
	      });
	    } else if (options.input !== undefined) child.stdin.end(options.input);
	    else child.stdin.end();
	    child.on("close", status => {
	      clearTimeout(timer);
	      for (const inputTimer of inputTimers) clearTimeout(inputTimer);
	      for (const waiter of stdoutWaiters.splice(0)) {
	        clearTimeout(waiter.timer);
	        waiter.reject(new Error("process closed before stdout waiter resolved"));
	      }
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

async function waitForCondition(fn: () => boolean | Promise<boolean>, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for condition");
}

function stickyLspServerSource(markerFile: string): string {
  return `
import { writeFileSync } from "node:fs";
let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) return;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
}

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf-8") + "\\r\\n\\r\\n" + body);
}

function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { capabilities: { documentSymbolProvider: true } } });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    writeFileSync(${JSON.stringify(markerFile)}, "1");
    send({
      id: message.id,
      result: [{
        name: "StickySymbol",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 28 } }
      }]
    });
    return;
  }
  if (message.method === "shutdown") {
    return;
  }
  if (message.id !== undefined) send({ id: message.id, result: null });
}

setInterval(() => {}, 1000);
`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
