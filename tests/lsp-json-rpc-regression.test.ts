import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { JsonRpcProcessClient } from "../src/lsp/json-rpc.js";
import { LspManager } from "../src/lsp/manager.js";
import { findTypeScriptLanguageServer } from "../src/lsp/typescript-lsp.js";

let tmp: string | null = null;
let manager: LspManager | null = null;
const oldServer = process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER;
const oldServerArgs = process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS;

afterEach(async () => {
  await manager?.dispose();
  manager = null;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
  if (oldServer === undefined) delete process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER;
  else process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER = oldServer;
  if (oldServerArgs === undefined) delete process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS;
  else process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS = oldServerArgs;
});

it("uses a configured JSON-RPC language server for document symbols", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-"));
  const server = join(tmp, "fake-lsp.mjs");
  const source = join(tmp, "sample.ts");
  writeFileSync(source, "export function JsonRpcSample() { return 1; }\n");
  writeFileSync(server, fakeLanguageServerSource());

  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER = process.execPath;
  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS = server;

  manager = new LspManager();
  const result = await manager.documentSymbolsWithBackend(source, tmp);

  expect(result.backend).toBe("json-rpc");
  expect(result.value).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "JsonRpcSample", kind: "function", line: 1 }),
  ]));
});

it("recovers after malformed JSON-RPC frames from the language server", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-bad-frame-"));
  const server = join(tmp, "fake-lsp-bad-frame.mjs");
  const source = join(tmp, "sample.ts");
  writeFileSync(source, "export function JsonRpcSample() { return 1; }\n");
  writeFileSync(server, fakeLanguageServerWithBadFrameSource());

  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER = process.execPath;
  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS = server;

  manager = new LspManager();
  const result = await manager.documentSymbolsWithBackend(source, tmp);

  expect(result.backend).toBe("json-rpc");
  expect(result.value).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "JsonRpcSample", kind: "function", line: 1 }),
  ]));
});

it("recovers after malformed JSON-RPC headers and non-object frames from the language server", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-bad-header-"));
  const server = join(tmp, "fake-lsp-bad-header.mjs");
  const source = join(tmp, "sample.ts");
  writeFileSync(source, "export function JsonRpcSample() { return 1; }\n");
  writeFileSync(server, fakeLanguageServerWithBadHeadersSource());

  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER = process.execPath;
  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS = server;

  manager = new LspManager();
  const result = await manager.documentSymbolsWithBackend(source, tmp);

  expect(result.backend).toBe("json-rpc");
  expect(result.value).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "JsonRpcSample", kind: "function", line: 1 }),
  ]));
});

it("recovers after duplicate and unsafe JSON-RPC headers from the language server", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-strict-header-"));
  const server = join(tmp, "fake-lsp-strict-header.mjs");
  const source = join(tmp, "sample.ts");
  writeFileSync(source, "export function JsonRpcSample() { return 1; }\n");
  writeFileSync(server, fakeLanguageServerWithUnsafeHeadersSource());

  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER = process.execPath;
  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS = server;

  manager = new LspManager();
  const result = await manager.documentSymbolsWithBackend(source, tmp);

  expect(result.backend).toBe("json-rpc");
  expect(result.value).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "JsonRpcSample", kind: "function", line: 1 }),
  ]));
});

it("ignores malformed string response ids without resolving the wrong pending request", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-bad-id-"));
  const server = join(tmp, "fake-lsp-bad-id.mjs");
  const source = join(tmp, "sample.ts");
  writeFileSync(source, "export function JsonRpcSample() { return 1; }\n");
  writeFileSync(server, fakeLanguageServerWithBadIdSource());

  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER = process.execPath;
  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS = server;

  manager = new LspManager();
  const result = await manager.documentSymbolsWithBackend(source, tmp);

  expect(result.backend).toBe("json-rpc");
  expect(result.value).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "JsonRpcSample", kind: "function", line: 1 }),
  ]));
});

it("normalizes configured TypeScript language server environment values", () => {
  const hostileEnv: Record<string, string | undefined> = { PATH: "" };
  Object.defineProperty(hostileEnv, "SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER", {
    enumerable: true,
    get() {
      throw new Error("server getter failed");
    },
  });

  expect(findTypeScriptLanguageServer(tmpdir(), hostileEnv)).toBeNull();
  expect(findTypeScriptLanguageServer(tmpdir(), {
    SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER: "  ",
    DEEPSEEK_TYPESCRIPT_LANGUAGE_SERVER: "\0bad",
    PATH: "",
  })).toBeNull();

  const command = findTypeScriptLanguageServer(tmpdir(), {
    SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER: ` ${process.execPath} `,
    SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS: " --stdio  \"--log-level\" debug ".repeat(40),
    PATH: "",
  });

  expect(command).toMatchObject({ command: process.execPath, source: "env" });
  expect(command?.args.length).toBeLessThanOrEqual(64);
  expect(command?.args).not.toContain("");
});

it("filters JSON-RPC symbols and definitions that point outside the workspace", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-outside-result-"));
  const outside = mkdtempSync(join(tmpdir(), "seek-code-lsp-outside-file-"));
  const server = join(tmp, "fake-lsp-outside.mjs");
  const source = join(tmp, "sample.ts");
  const outsideFile = join(outside, "secret.ts");
  mkdirSync(outside, { recursive: true });
  writeFileSync(source, "export function JsonRpcSample() { return helper(); }\n");
  writeFileSync(outsideFile, "export function Secret() { return 1; }\n");
  writeFileSync(server, fakeLanguageServerWithOutsideResultsSource(outsideFile));

  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER = process.execPath;
  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS = server;

  manager = new LspManager();
  const symbols = await manager.documentSymbolsWithBackend(source, tmp);
  const definitions = await manager.definitionWithBackend("helper", tmp, { file: source, line: 1, character: 37 });

  expect(symbols.backend).toBe("json-rpc");
  expect(symbols.value.map(item => item.name)).toEqual(["JsonRpcSample"]);
  expect(definitions.backend).toBe("json-rpc");
  expect(definitions.value).toEqual([
    expect.objectContaining({ file: source, line: 1 }),
  ]);

  rmSync(outside, { recursive: true, force: true });
});

it("bounds and sanitizes JSON-RPC symbols, definitions, and hover results", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-bounds-"));
  const server = join(tmp, "fake-lsp-bounds.mjs");
  const source = join(tmp, "sample.ts");
  writeFileSync(source, "export function JsonRpcSample() { return helper(); }\n");
  writeFileSync(server, fakeLanguageServerWithOversizedResultsSource());

  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER = process.execPath;
  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS = server;

  manager = new LspManager();
  const symbols = await manager.documentSymbolsWithBackend(source, tmp);
  const definitions = await manager.definitionWithBackend("helper", tmp, { file: source, line: 1, character: 37 });
  const hover = await manager.hoverWithBackend(source, 1, tmp, 2, 1);

  expect(symbols.backend).toBe("json-rpc");
  expect(symbols.value).toHaveLength(500);
  expect(symbols.value.every(item => item.name && !item.name.includes("\0"))).toBe(true);
  expect(symbols.value.some(item => item.name === "Bad\u0000Name")).toBe(false);
  expect(definitions.backend).toBe("json-rpc");
  expect(definitions.value).toHaveLength(100);
  expect(definitions.value.every(item => item.file === source && item.text.length <= 1000)).toBe(true);
  expect(hover.backend).toBe("json-rpc");
  expect(hover.value.length).toBeLessThanOrEqual(8000);
  expect(hover.value).not.toContain("\0");
});

it("falls back safely for invalid local hover positions and large files", () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-local-bounds-"));
  const source = join(tmp, "sample.ts");
  const large = join(tmp, "large.ts");
  writeFileSync(source, "export function helper() {}\nconst value = helper();\n");
  writeFileSync(large, "x".repeat(2 * 1024 * 1024 + 1));

  manager = new LspManager();

  expect(manager.hover(source, Number.NaN, tmp, Number.POSITIVE_INFINITY)).toContain("> 1:");
  expect(manager.hover(source, Number.POSITIVE_INFINITY, tmp, -1)).toContain("> 1:");
  expect(manager.documentSymbols(large, tmp)).toEqual([]);
  expect(manager.hover(large, 1, tmp)).toContain("file too large");
});

it("normalizes invalid backend positions and uses local fallback when no JSON-RPC lookup is possible", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-invalid-position-"));
  const server = join(tmp, "fake-lsp-record-request.mjs");
  const source = join(tmp, "sample.ts");
  writeFileSync(source, "export function JsonRpcSample() { return 1; }\n");
  writeFileSync(server, fakeLanguageServerThatRecordsRequestsSource());

  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER = process.execPath;
  process.env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS = server;

  manager = new LspManager();
  const result = await manager.definitionWithBackend("x".repeat(5 * 1024 * 1024), tmp, {
    file: source,
    line: Number.NaN,
    character: Number.POSITIVE_INFINITY,
  });

  expect(result.backend).toBe("local-fallback");
  expect(result.value).toEqual([]);
});

it("rejects invalid or oversized outbound JSON-RPC requests before writing to the server", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-outbound-limits-"));
  const server = join(tmp, "fake-lsp-outbound-limits.mjs");
  writeFileSync(server, fakeLanguageServerThatRecordsRequestsSource());
  const client = new JsonRpcProcessClient(process.execPath, [server], tmp);

  await expect(client.request("bad method", {}, 100)).rejects.toThrow(/invalid LSP request method/);
  await expect(client.request("textDocument/definition", { text: "x".repeat(5 * 1024 * 1024) }, 100)).rejects.toThrow(/outbound message exceeded/);

  await client.close();
});

it("rejects oversized inbound JSON-RPC content lengths instead of buffering fake bodies", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-inbound-limits-"));
  const server = join(tmp, "fake-lsp-inbound-limits.mjs");
  writeFileSync(server, fakeLanguageServerWithOversizedInboundFrameSource());
  const client = new JsonRpcProcessClient(process.execPath, [server], tmp);

  await expect(client.request("initialize", {}, 1000)).rejects.toThrow(/message exceeded limit|exited/);

  await client.close();
});

it("bounds stderr tails from noisy JSON-RPC servers", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-stderr-tail-"));
  const server = join(tmp, "fake-lsp-stderr-tail.mjs");
  writeFileSync(server, fakeLanguageServerWithNoisyStderrSource());
  const client = new JsonRpcProcessClient(process.execPath, [server], tmp);

  await expect(client.request("initialize", {}, 1000)).rejects.toThrow(/request timed out|exited/);

  expect(client.stderrTail().length).toBeLessThanOrEqual(4096);
  expect(client.stderrTail()).not.toContain("\0");
  await client.close();
});

it("ignores language server requests it cannot respond to without crashing pending requests", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-server-request-"));
  const server = join(tmp, "fake-lsp-idle.mjs");
  writeFileSync(server, "setTimeout(() => {}, 5000);\n");
  const client = new JsonRpcProcessClient(process.execPath, [server], tmp);
  const child = client as unknown as { child: { stdin: { destroy(): void } }; handleMessage(message: unknown): void };
  child.child.stdin.destroy();

  expect(() => child.handleMessage({ jsonrpc: "2.0", id: "server-request", method: "workspace/configuration", params: {} })).not.toThrow();

  expect(client.stderrTail()).toContain("Dropped LSP server request response");
  await client.close();
});

it("ignores hostile JSON-RPC response getters without resolving the wrong request", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-hostile-response-"));
  const server = join(tmp, "fake-lsp-idle.mjs");
  writeFileSync(server, "setTimeout(() => {}, 5000);\n");
  const client = new JsonRpcProcessClient(process.execPath, [server], tmp);
  const internals = client as unknown as { handleMessage(message: unknown): void };
  const response: Record<string, unknown> = { jsonrpc: "2.0", id: 1 };
  Object.defineProperty(response, "result", {
    enumerable: true,
    get() {
      throw new Error("result getter failed");
    },
  });

  const request = client.request("initialize", {}, 1000);
  expect(() => internals.handleMessage(response)).not.toThrow();
  await expect(request).resolves.toBeUndefined();

  await client.close();
});

it("treats directories and unreadable local LSP sources as missing instead of throwing", () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-local-file-kind-"));
  const sourceDir = join(tmp, "sample.ts");
  mkdirSync(sourceDir);

  manager = new LspManager();

  expect(manager.documentSymbols(sourceDir, tmp)).toEqual([]);
  expect(manager.hover(sourceDir, 1, tmp)).toContain("file not found");
});

it("normalizes hostile process environment entries before launching JSON-RPC servers", async () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-env-"));
  const server = join(tmp, "fake-lsp-env.mjs");
  writeFileSync(server, fakeLanguageServerThatEchoesEnvSource());
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH || "",
    GOOD_ENV: "ok",
    "BAD-ENV": "bad",
    BAD_CONTROL: "bad\u0007value",
  };
  Object.defineProperty(env, "THROWING_ENV", {
    enumerable: true,
    get() {
      throw new Error("env getter failed");
    },
  });
  const client = new JsonRpcProcessClient(process.execPath, [server], tmp, env);

  await expect(client.request("initialize", {}, 1000)).resolves.toMatchObject({
    hasGood: true,
    hasBadDash: false,
    hasBadControl: false,
  });

  await client.close();
});

it("falls back safely for local LSP symlinks that escape the workspace", () => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-lsp-local-symlink-"));
  const workspace = join(tmp, "workspace");
  const outside = join(tmp, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const outsideFile = join(outside, "secret.ts");
  writeFileSync(outsideFile, "export function Secret() { return 1; }\n");
  symlinkSync(outsideFile, join(workspace, "link.ts"));

  manager = new LspManager();

  expect(() => manager!.documentSymbols("link.ts", workspace)).not.toThrow();
  expect(manager.documentSymbols("link.ts", workspace)).toEqual([]);
  expect(() => manager!.hover("link.ts", 1, workspace)).not.toThrow();
  expect(manager.hover("link.ts", 1, workspace)).toContain("file not found");
});

function fakeLanguageServerSource(): string {
  return `
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
    send({
      id: message.id,
      result: [{
        name: "JsonRpcSample",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 29 } }
      }]
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id !== undefined) send({ id: message.id, result: null });
}
`;
}

function fakeLanguageServerWithBadFrameSource(): string {
  return `
${fakeLanguageServerCommon()}

function handle(message) {
  if (message.method === "initialize") {
    writeRaw("Content-Length: 10\\r\\n\\r\\n{not json!");
    send({ id: message.id, result: { capabilities: { documentSymbolProvider: true } } });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    send({
      id: message.id,
      result: [{
        name: "JsonRpcSample",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 29 } }
      }]
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id !== undefined) send({ id: message.id, result: null });
}
`;
}

function fakeLanguageServerWithBadHeadersSource(): string {
  return `
${fakeLanguageServerCommon()}

function handle(message) {
  if (message.method === "initialize") {
    writeRaw("X-Bad: nope\\r\\n\\r\\n");
    writeRaw("Content-Length: 2\\r\\n\\r\\n[]");
    send({ id: message.id, result: { capabilities: { documentSymbolProvider: true } } });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    send({
      id: message.id,
      result: [{
        name: "JsonRpcSample",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 29 } }
      }]
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id !== undefined) send({ id: message.id, result: null });
}
`;
}

function fakeLanguageServerWithUnsafeHeadersSource(): string {
  return `
${fakeLanguageServerCommon()}

function handle(message) {
  if (message.method === "initialize") {
    writeRaw("Content-Length: 2\\r\\nContent-Length: 2\\r\\n\\r\\n{}");
    writeRaw("Bad Header: nope\\r\\n\\r\\n");
    send({ id: message.id, result: { capabilities: { documentSymbolProvider: true } } });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    send({
      id: message.id,
      result: [{
        name: "JsonRpcSample",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 29 } }
      }]
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id !== undefined) send({ id: message.id, result: null });
}
`;
}

function fakeLanguageServerWithBadIdSource(): string {
  return `
${fakeLanguageServerCommon()}

function handle(message) {
  if (message.method === "initialize") {
    send({ id: "1abc", result: { ignored: true } });
    send({ id: message.id, result: { capabilities: { documentSymbolProvider: true } } });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    send({ id: "2abc", result: [{ name: "Wrong", kind: 12, range: { start: { line: 8, character: 0 }, end: { line: 8, character: 5 } } }] });
    send({
      id: message.id,
      result: [{
        name: "JsonRpcSample",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 29 } }
      }]
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id !== undefined) send({ id: message.id, result: null });
}
`;
}

function fakeLanguageServerWithOutsideResultsSource(outsideFile: string): string {
  const outsideUri = JSON.stringify(`file://${outsideFile}`);
  return `
${fakeLanguageServerCommon()}

function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { capabilities: { documentSymbolProvider: true, definitionProvider: true } } });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    send({
      id: message.id,
      result: [
        {
          name: "JsonRpcSample",
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
          selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 29 } }
        },
        {
          name: "Secret",
          kind: 12,
          location: { uri: ${outsideUri}, range: { start: { line: 0, character: 0 } } }
        }
      ]
    });
    return;
  }
  if (message.method === "textDocument/definition") {
    send({
      id: message.id,
      result: [
        { uri: ${outsideUri}, range: { start: { line: 0, character: 0 } } },
        { uri: message.params.textDocument.uri, range: { start: { line: 0, character: 16 } } }
      ]
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id !== undefined) send({ id: message.id, result: null });
}
`;
}

function fakeLanguageServerWithOversizedResultsSource(): string {
  return `
${fakeLanguageServerCommon()}

function deepChild(depth) {
  if (depth > 30) {
    return { name: "TooDeep", kind: 12, range: { start: { line: depth, character: 0 } } };
  }
  return { name: "Deep" + depth, kind: 12, range: { start: { line: depth, character: 0 } }, children: [deepChild(depth + 1)] };
}

function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { capabilities: { documentSymbolProvider: true, definitionProvider: true, hoverProvider: true } } });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    const result = [];
    result.push({ name: "Bad\\u0000Name", kind: 12, range: { start: { line: 0, character: 0 } } });
    result.push(deepChild(0));
    for (let i = 0; i < 700; i++) {
      result.push({ name: "Sym" + i, kind: 12, range: { start: { line: i, character: 0 } } });
    }
    send({ id: message.id, result });
    return;
  }
  if (message.method === "textDocument/definition") {
    const line = "x".repeat(2000);
    const result = Array.from({ length: 150 }, (_, i) => ({
      uri: message.params.textDocument.uri,
      range: { start: { line: 0, character: i } },
      line
    }));
    send({ id: message.id, result });
    return;
  }
  if (message.method === "textDocument/hover") {
    send({ id: message.id, result: { contents: { kind: "markdown", value: "h".repeat(9000) + "\\u0000bad" } } });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id !== undefined) send({ id: message.id, result: null });
}
`;
}

function fakeLanguageServerThatRecordsRequestsSource(): string {
  return `
${fakeLanguageServerCommon()}

function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { capabilities: { definitionProvider: true, hoverProvider: true } } });
    return;
  }
  if (message.method === "textDocument/definition") {
    send({ id: message.id, result: [] });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id !== undefined) send({ id: message.id, result: null });
}
`;
}

function fakeLanguageServerWithOversizedInboundFrameSource(): string {
  return `
${fakeLanguageServerCommon()}

function handle(message) {
  if (message.method === "initialize") {
    writeRaw("Content-Length: 33554433\\r\\n\\r\\n{}");
    setTimeout(() => {}, 5000);
    return;
  }
}
`;
}

function fakeLanguageServerWithNoisyStderrSource(): string {
  return `
process.stderr.write("start\\u0000" + "x".repeat(10000));
setTimeout(() => {}, 5000);
`;
}

function fakeLanguageServerThatEchoesEnvSource(): string {
  return `
${fakeLanguageServerCommon()}

function handle(message) {
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        hasGood: process.env.GOOD_ENV === "ok",
        hasBadDash: Object.prototype.hasOwnProperty.call(process.env, "BAD-ENV"),
        hasBadControl: Object.prototype.hasOwnProperty.call(process.env, "BAD_CONTROL")
      }
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id !== undefined) send({ id: message.id, result: null });
}
`;
}

function fakeLanguageServerCommon(): string {
  return `
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

function writeRaw(raw) {
  process.stdout.write(raw);
}

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf-8") + "\\r\\n\\r\\n" + body);
}
`;
}
