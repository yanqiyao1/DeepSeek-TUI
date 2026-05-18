import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { LspManager } from "../src/lsp/manager.js";

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
