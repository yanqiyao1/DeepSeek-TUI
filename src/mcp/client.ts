/** MCP client — stdio subprocess and SSE transport. */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { appendFileSync } from "node:fs";
import type { MCPConfig } from "../config.js";
import { VERSION } from "../version.js";
import { createRequest, type JSONRPCResponse, type MCPTool } from "./protocol.js";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeTailTextBoundary } from "../utils/text-boundary.js";

type PendingRequest = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  controller?: AbortController;
};

const MCP_DISCONNECT_SIGKILL_MS = 250;
const MCP_DISCONNECT_MAX_WAIT_MS = 1_000;
const MAX_STDIO_LINE_CHARS = 1_000_000;
const MAX_SSE_RESPONSE_CHARS = 1_000_000;
const MAX_STDERR_TAIL_CHARS = 20_000;
const MAX_MCP_CLIENT_TOOLS = 100;
const MAX_MCP_CONTENT_ITEMS = 1_000;
const MAX_MCP_CLIENT_ARGS = 128;
const MAX_MCP_CLIENT_ENV_ENTRIES = 128;

export class MCPClient {
  private config: MCPConfig;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pending: Map<string, PendingRequest> = new Map();
  private stderrTail = "";
  private logFile?: string;
  private closeHandler?: (message: string) => void;
  private intentionalDisconnect = false;
  private stdoutDecoder = new StringDecoder("utf8");
  private stderrDecoder = new StringDecoder("utf8");

  constructor(config: MCPConfig) { this.config = config; }

  setLogFile(path: string): void { this.logFile = path; }

  onClose(handler: (message: string) => void): void { this.closeHandler = handler; }

  async connect(): Promise<void> {
    if (this.transport() === "stdio") {
      if (this.proc && !this.proc.killed) return;
      const cmd = safeString(safeProperty(this.config, "command"));
      if (!cmd) throw new Error("MCP stdio command is not configured");
      const args = safeStringArray(safeProperty(this.config, "args"), MAX_MCP_CLIENT_ARGS);
      this.intentionalDisconnect = false;
      this.stdoutDecoder = new StringDecoder("utf8");
      this.stderrDecoder = new StringDecoder("utf8");
      this.proc = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...safeStringRecord(safeProperty(this.config, "env"), MAX_MCP_CLIENT_ENV_ENTRIES) },
      });
      this.proc.stdout?.on("data", (d: Buffer) => {
        this.buffer += this.stdoutDecoder.write(d);
        this.drainStdoutBuffer();
      });
      this.proc.stderr?.on("data", (d: Buffer) => {
        const text = this.stderrDecoder.write(d);
        if (!text) return;
        this.appendStderr(text);
        if (this.logFile) {
          try { appendFileSync(this.logFile, `[stderr] ${text}`, "utf-8"); } catch { /* ignore log failures */ }
        }
      });
      this.proc.on("error", (err) => this.rejectPending(err));
      this.proc.on("close", (code, signal) => {
        const stdoutRest = this.stdoutDecoder.end();
        if (stdoutRest) {
          this.buffer += stdoutRest;
          this.drainStdoutBuffer();
        }
        const stderrRest = this.stderrDecoder.end();
        if (stderrRest) {
          this.appendStderr(stderrRest);
          if (this.logFile) {
            try { appendFileSync(this.logFile, `[stderr] ${stderrRest}`, "utf-8"); } catch { /* ignore log failures */ }
          }
        }
        const message = signal ? `MCP process exited with signal ${signal}` : `MCP process exited with code ${code}`;
        this.proc = null;
        if (this.logFile) {
          try { appendFileSync(this.logFile, `[close] ${message}\n`, "utf-8"); } catch { /* ignore log failures */ }
        }
        if (!this.intentionalDisconnect) this.closeHandler?.(message);
        this.rejectPending(new Error(message));
      });
    }
  }

  async initialize(): Promise<Record<string, unknown>> {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "seek-code", version: VERSION },
    }) as Promise<Record<string, unknown>>;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request("tools/list", {});
    return normalizeMCPTools(safeProperty(result, "tools"));
  }

  async health(): Promise<{ ok: boolean; message: string; stderr_tail?: string }> {
    try {
      await this.listTools();
      const stderrTail = this.stderrTail.length > 0 ? this.stderrTail : undefined;
      return omitUndefined({ ok: true, message: "tools/list ok", stderr_tail: stderrTail });
    } catch (e: any) {
      const stderrTail = this.stderrTail.length > 0 ? this.stderrTail : undefined;
      return omitUndefined({ ok: false, message: errorMessage(e), stderr_tail: stderrTail });
    }
  }

  getStderrTail(): string { return this.stderrTail; }

  private drainStdoutBuffer(): void {
    while (this.buffer.includes("\n")) {
      const idx = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      this.handleStdoutLine(line);
    }
    if (this.buffer.length > MAX_STDIO_LINE_CHARS) {
      this.buffer = "";
      this.rejectPending(new Error("MCP stdio line exceeded limit"));
      try { this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }

  private handleStdoutLine(line: string): void {
    if (!line || line.length > MAX_STDIO_LINE_CHARS) return;
    try {
      const resp = JSON.parse(line) as JSONRPCResponse;
      const id = safeString(safeProperty(resp, "id"));
      if (!id) return;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const responseError = safeProperty(resp, "error");
        if (responseError !== undefined && responseError !== null) pending.reject(new Error(mcpErrorText(responseError)));
        else pending.resolve(safeProperty(resp, "result"));
      }
    } catch {
      // skip malformed lines
    }
  }

  private appendStderr(text: string): void {
    this.stderrTail = safeTailTextBoundary(this.stderrTail + text, MAX_STDERR_TAIL_CHARS);
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: arguments_ });
    const content = safeProperty(result, "content");
    if (safeIsArray(content)) {
      return normalizeMCPContent(content).join("\n");
    }
    return safeJsonStringify(result);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const req = createRequest(method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(req.id);
        if (pending) {
          this.pending.delete(req.id);
          pending.controller?.abort();
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, 30_000);
      let controller: AbortController | undefined;
      this.pending.set(req.id, { resolve, reject, timer });
      if (this.transport() === "stdio") {
        if (!this.proc || this.proc.killed || this.proc.stdin?.destroyed) {
          clearTimeout(timer);
          this.pending.delete(req.id);
          reject(new Error("MCP stdio process is not connected"));
          return;
        }
        const ok = this.proc.stdin?.write(safeJsonStringify(req) + "\n");
        if (ok === false && this.proc.stdin?.destroyed) {
          clearTimeout(timer);
          this.pending.delete(req.id);
          reject(new Error("MCP process stdin is closed"));
        }
      } else {
        // SSE transport
        const url = safeString(safeProperty(this.config, "url"));
        if (!url) {
          clearTimeout(timer);
          this.pending.delete(req.id);
          reject(new Error("MCP SSE URL is not configured"));
          return;
        }
        controller = new AbortController();
        const pending = this.pending.get(req.id);
        if (pending) pending.controller = controller;
        const endpoint = mcpMessageEndpoint(url);
        if (!endpoint) {
          clearTimeout(timer);
          this.pending.delete(req.id);
          reject(new Error("MCP SSE URL is invalid"));
          return;
        }
        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: safeJsonStringify(req),
          signal: controller.signal,
        }).then(r => {
          if (!r.ok) throw new Error(`MCP SSE request failed: HTTP ${r.status}`);
          return readBoundedResponseText(r, MAX_SSE_RESPONSE_CHARS).then(body => JSON.parse(body) as unknown);
        }).then((raw: unknown) => {
          clearTimeout(timer);
          this.pending.delete(req.id);
          const responseId = safeProperty(raw, "id");
          if (!isRecord(raw) || responseId !== req.id) {
            reject(new Error("MCP SSE response did not match request"));
            return;
          }
          const responseError = safeProperty(raw, "error");
          if (responseError !== undefined && responseError !== null) reject(new Error(mcpErrorText(responseError)));
          else resolve(safeProperty(raw, "result"));
        }).catch((err) => {
          clearTimeout(timer);
          this.pending.delete(req.id);
          reject(err);
        });
      }
    });
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.controller?.abort();
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async disconnect(): Promise<void> {
    const proc = this.proc;
    this.intentionalDisconnect = true;
    this.proc = null;
    this.buffer = "";
    this.rejectPending(new Error("MCP client disconnected"));
    if (proc) await terminateMCPProcess(proc);
  }

  private transport(): MCPConfig["transport"] {
    return safeProperty(this.config, "transport") === "sse" ? "sse" : "stdio";
  }
}

async function readBoundedResponseText(response: Response, maxChars: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxChars) {
    throw new Error("MCP SSE response exceeded limit");
  }
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    if (text.length > maxChars) throw new Error("MCP SSE response exceeded limit");
    return text;
  }
  const reader = body.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let totalChars = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value instanceof Uint8Array) {
        totalBytes += next.value.byteLength;
        if (totalBytes > maxChars * 4) throw new Error("MCP SSE response exceeded limit");
      }
      const chunk = next.value instanceof Uint8Array ? decoder.decode(next.value, { stream: true }) : String(next.value ?? "");
      totalChars += chunk.length;
      if (totalChars > maxChars) throw new Error("MCP SSE response exceeded limit");
      chunks.push(chunk);
    }
    const tail = decoder.decode();
    if (tail) {
      totalChars += tail.length;
      if (totalChars > maxChars) throw new Error("MCP SSE response exceeded limit");
      chunks.push(tail);
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore cancellation failures */ }
  }
  return chunks.join("");
}

function mcpMessageEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/message`;
    return url.toString();
  } catch {
    return null;
  }
}

function terminateMCPProcess(proc: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    let sigkillTimer: NodeJS.Timeout | null = null;
    let maxWaitTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (maxWaitTimer) clearTimeout(maxWaitTimer);
      proc.removeListener("close", finish);
      proc.removeListener("error", finish);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    proc.once("close", finish);
    proc.once("error", finish);

    try { proc.stdin?.end(); } catch { /* ignore */ }
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }

    sigkillTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, MCP_DISCONNECT_SIGKILL_MS);

    maxWaitTimer = setTimeout(() => {
      try { proc.stdin?.destroy(); } catch { /* ignore */ }
      try { proc.stdout?.destroy(); } catch { /* ignore */ }
      try { proc.stderr?.destroy(); } catch { /* ignore */ }
      proc.unref?.();
      finish();
    }, MCP_DISCONNECT_MAX_WAIT_MS);
  });
}

function normalizeMCPTools(value: unknown): MCPTool[] {
  const tools: MCPTool[] = [];
  for (const item of safeArrayItems(value, MAX_MCP_CLIENT_TOOLS)) {
    if (!isRecord(item)) continue;
    const name = safeString(safeProperty(item, "name"));
    if (!name) continue;
    tools.push({
      name,
      description: safeString(safeProperty(item, "description")),
      inputSchema: safeRecord(safeProperty(item, "inputSchema")),
    });
  }
  return tools;
}

function normalizeMCPContent(value: unknown): string[] {
  const lines: string[] = [];
  for (const item of safeArrayItems(value, MAX_MCP_CONTENT_ITEMS)) {
    const text = safeString(safeProperty(item, "text"));
    lines.push(text || safeJsonStringify(item));
  }
  return lines;
}

function mcpErrorText(value: unknown): string {
  const code = safeProperty(value, "code");
  const message = safeString(safeProperty(value, "message")) || errorMessage(value);
  return `MCP error ${typeof code === "number" && Number.isFinite(code) ? code : "unknown"}: ${message}`;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  const message = safeString(safeProperty(value, "message"));
  return message || String(value);
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeIsArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function safeArrayItems(value: unknown, maxItems: number): unknown[] {
  if (!safeIsArray(value)) return [];
  let length = 0;
  try {
    length = Math.min(value.length, Math.max(0, maxItems));
  } catch {
    return [];
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index++) {
    try {
      items.push(value[index]);
    } catch {
      // Drop hostile array elements while preserving readable neighbors.
    }
  }
  return items;
}

function safeStringArray(value: unknown, maxItems: number): string[] {
  const result: string[] = [];
  for (const item of safeArrayItems(value, maxItems)) {
    if (typeof item === "string") result.push(item);
  }
  return result;
}

function safeStringRecord(value: unknown, maxEntries: number): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(value)) return result;
  let keys: string[];
  try {
    keys = Object.keys(value).slice(0, Math.max(0, maxEntries));
  } catch {
    return result;
  }
  for (const key of keys) {
    const entry = safeProperty(value, key);
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function safeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
