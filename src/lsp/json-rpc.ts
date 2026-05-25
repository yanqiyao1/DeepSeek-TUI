import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { safeJsonStringify } from "../utils/json-safe.js";

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = MAX_MESSAGE_BYTES + MAX_HEADER_BYTES;
const MAX_OUTBOUND_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES_PER_DRAIN = 512;
const MAX_PENDING_REQUESTS = 128;
const MAX_PROCESS_ARGS = 64;
const MAX_PROCESS_ARG_CHARS = 4096;
const MAX_PROCESS_ENV_ENTRIES = 512;
const MAX_PROCESS_ENV_KEY_CHARS = 256;
const MAX_PROCESS_ENV_VALUE_CHARS = 16_384;
const MAX_STDERR_TAIL_CHARS = 4096;
const SAFE_METHOD_RE = /^[A-Za-z0-9_$/.:-]{1,160}$/;
const SAFE_HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const SAFE_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F]/;

export class JsonRpcProcessClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private stderrTailValue = "";
  private drainScheduled = false;

  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
    const safeCommand = safeProcessCommand(command);
    if (!safeCommand) throw new Error("invalid language server command");
    this.child = spawn(safeCommand, sanitizeProcessArgs(args), {
      cwd,
      env: sanitizeProcessEnv(env),
      stdio: "pipe",
    });
    this.child.stdout.on("data", data => this.handleData(data));
    this.child.stderr.on("data", data => {
      const start = Math.max(0, data.length - MAX_STDERR_TAIL_CHARS * 2);
      this.appendStderr(data.toString("utf-8", start));
    });
    this.child.on("error", error => {
      this.closed = true;
      this.rejectAll(error);
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`language server exited (${signal || (code ?? "unknown")})`));
    });
  }

  stderrTail(): string {
    return this.stderrTailValue.trim();
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    if (this.closed) throw new Error("language server is closed");
    const safeMethod = safeMethodName(method);
    if (!safeMethod) throw new Error("invalid LSP request method");
    if (this.pending.size >= MAX_PENDING_REQUESTS) throw new Error("too many pending LSP requests");
    const id = this.nextId++;
    const safeTimeoutMs = safeTimeout(timeoutMs);
    const pending = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${safeMethod}`));
      }, safeTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
    });
    try {
      this.send({ jsonrpc: "2.0", id, method: safeMethod, params });
    } catch (error) {
      const pendingRequest = this.pending.get(id);
      if (pendingRequest) {
        clearTimeout(pendingRequest.timer);
        this.pending.delete(id);
      }
      throw error;
    }
    return pending;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const safeMethod = safeMethodName(method);
    if (!safeMethod) return;
    try {
      this.send({ jsonrpc: "2.0", method: safeMethod, params });
    } catch {
      this.stderrTailValue = `${this.stderrTailValue}\nDropped oversized LSP notification: ${safeMethod}`.slice(-4096);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      this.rejectAll(new Error("language server is closed"));
      return;
    }
    try {
      await this.request("shutdown", null, 1_000);
      this.notify("exit");
    } catch {
      this.child.kill();
    }
    this.closed = true;
    this.rejectAll(new Error("language server is closed"));
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child.stdin.writable) throw new Error("language server stdin is closed");
    let body: string;
    try {
      body = safeJsonStringify(message, { dropUndefinedObjectFields: true });
    } catch {
      throw new Error("LSP outbound message could not be encoded");
    }
    const bytes = Buffer.byteLength(body, "utf-8");
    if (bytes > MAX_OUTBOUND_MESSAGE_BYTES) {
      throw new Error("LSP outbound message exceeded limit");
    }
    const header = `Content-Length: ${bytes}\r\n\r\n`;
    this.child.stdin.write(header + body);
  }

  private handleData(data: Buffer): void {
    if (!Buffer.isBuffer(data) || data.length === 0 || this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.appendStderr(`\nLSP message buffer exceeded ${MAX_BUFFER_BYTES} bytes`);
      this.buffer = Buffer.alloc(0);
      this.rejectAll(new Error("LSP message buffer exceeded limit"));
      this.child.kill();
      return;
    }
    this.drainBuffer();
  }

  private drainBuffer(): void {
    if (this.closed) return;
    let processed = 0;
    while (processed < MAX_MESSAGES_PER_DRAIN) {
      const parsed = this.nextMessage();
      if (!parsed) return;
      processed++;
      this.handleMessage(parsed);
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.closed) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drainBuffer();
    });
  }

  private nextMessage(): JsonRpcMessage | null {
    const separatorInfo = findHeaderSeparator(this.buffer);
    const fallbackHeaderEnd = separatorInfo.index;
    if (fallbackHeaderEnd < 0) {
      if (this.buffer.length > MAX_HEADER_BYTES) {
        this.appendStderr(`\nInvalid LSP header exceeded ${MAX_HEADER_BYTES} bytes`);
        this.buffer = Buffer.alloc(0);
        this.rejectAll(new Error("LSP header exceeded limit"));
        this.child.kill();
      }
      return null;
    }
    if (fallbackHeaderEnd > MAX_HEADER_BYTES) {
      this.appendStderr(`\nInvalid LSP header exceeded ${MAX_HEADER_BYTES} bytes`);
      this.buffer = this.buffer.subarray(fallbackHeaderEnd + separatorInfo.length);
      return ignoredMessage();
    }

    const headerText = this.buffer.subarray(0, fallbackHeaderEnd).toString("ascii");
    const parsedHeader = parseContentLengthHeader(headerText);
    if (!parsedHeader.ok) {
      this.appendStderr(`\nMalformed LSP header: ${parsedHeader.reason}`);
      this.buffer = this.buffer.subarray(fallbackHeaderEnd + separatorInfo.length);
      return ignoredMessage();
    }

    const bodyStart = fallbackHeaderEnd + separatorInfo.length;
    const bodyLength = parsedHeader.length;
    if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_MESSAGE_BYTES) {
      this.appendStderr(`\nInvalid LSP Content-Length: ${bodyLength}`);
      this.buffer = Buffer.alloc(0);
      this.rejectAll(new Error("LSP message exceeded limit"));
      this.child.kill();
      return null;
    }
    if (this.buffer.length < bodyStart + bodyLength) return null;

    const body = this.buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf-8");
    this.buffer = this.buffer.subarray(bodyStart + bodyLength);
    try {
      const parsed = JSON.parse(body);
      if (!isRecord(parsed)) {
        this.appendStderr("\nMalformed LSP JSON-RPC message: response was not an object");
        return ignoredMessage();
      }
      return parsed as unknown as JsonRpcMessage;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendStderr(`\nMalformed LSP JSON-RPC message: ${message}`);
      return ignoredMessage();
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    const idValue = safeProperty(message, "id");
    const methodValue = safeProperty(message, "method");
    if (idValue !== undefined && !methodValue) {
      if (safeProperty(message, "jsonrpc") !== "2.0") return;
      const id = responseId(idValue);
      if (id === undefined) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const error = safeProperty(message, "error");
      if (isRecord(error)) {
        pending.reject(new Error(safeErrorMessage(safeProperty(error, "message"))));
      } else {
        pending.resolve(safeProperty(message, "result"));
      }
      return;
    }

    if (idValue !== undefined && typeof methodValue === "string" && safeMethodName(methodValue)) {
      const id = rpcId(idValue);
      if (id !== undefined) {
        try {
          this.send({ jsonrpc: "2.0", id, result: null });
        } catch (error) {
          this.appendStderr(`\nDropped LSP server request response: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private appendStderr(text: string): void {
    this.stderrTailValue = (this.stderrTailValue + safeStderrText(text)).slice(-MAX_STDERR_TAIL_CHARS);
  }
}

function findHeaderSeparator(buffer: Buffer): { index: number; length: number } {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf < 0) return { index: lf, length: lf >= 0 ? 2 : 0 };
  if (lf >= 0 && lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function parseContentLengthHeader(headerText: string): { ok: true; length: number } | { ok: false; reason: string } {
  let length: number | undefined;
  for (const rawLine of headerText.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (rawLine.length > 1024 || CONTROL_TEXT_RE.test(rawLine)) {
      return { ok: false, reason: "invalid header line" };
    }
    const colon = rawLine.indexOf(":");
    if (colon <= 0) return { ok: false, reason: "invalid header field" };
    const name = rawLine.slice(0, colon).trim();
    const value = rawLine.slice(colon + 1).trim();
    if (!SAFE_HEADER_NAME_RE.test(name)) return { ok: false, reason: "invalid header name" };
    if (name.toLowerCase() !== "content-length") continue;
    if (length !== undefined) return { ok: false, reason: "duplicate Content-Length" };
    if (!/^\d{1,10}$/.test(value)) return { ok: false, reason: "invalid Content-Length" };
    length = Number(value);
  }
  return length === undefined ? { ok: false, reason: "missing Content-Length" } : { ok: true, length };
}

function ignoredMessage(): JsonRpcMessage {
  return { jsonrpc: "2.0", method: "$/seekcode/ignoredMalformedMessage" };
}

function responseId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function rpcId(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.length <= 256 && !CONTROL_TEXT_RE.test(value)) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  let entries = 0;
  for (const [key, value] of safeObjectEntries(env)) {
    if (entries >= MAX_PROCESS_ENV_ENTRIES) break;
    if (
      !SAFE_ENV_KEY_RE.test(key) ||
      key.length > MAX_PROCESS_ENV_KEY_CHARS ||
      typeof value !== "string" ||
      value.length > MAX_PROCESS_ENV_VALUE_CHARS ||
      CONTROL_TEXT_RE.test(value)
    ) continue;
    sanitized[key] = value;
    entries++;
  }
  return sanitized;
}

function sanitizeProcessArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  const sanitized: string[] = [];
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    const trimmed = arg.trim();
    if (!trimmed || trimmed.length > MAX_PROCESS_ARG_CHARS || CONTROL_TEXT_RE.test(trimmed)) continue;
    sanitized.push(trimmed);
    if (sanitized.length >= MAX_PROCESS_ARGS) break;
  }
  return sanitized;
}

function safeProcessCommand(command: unknown): string {
  if (typeof command !== "string") return "";
  const trimmed = command.trim();
  return trimmed && trimmed.length <= MAX_PROCESS_ARG_CHARS && !CONTROL_TEXT_RE.test(trimmed) ? trimmed : "";
}

function safeStderrText(text: unknown): string {
  if (typeof text !== "string") return "";
  const tail = text.length > MAX_STDERR_TAIL_CHARS * 2 ? text.slice(-MAX_STDERR_TAIL_CHARS * 2) : text;
  return tail.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
}

function safeMethodName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const method = value.trim();
  return SAFE_METHOD_RE.test(method) && !method.includes("\0") ? method : null;
}

function safeTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 60_000)
    : 10_000;
}

function safeErrorMessage(value: unknown): string {
  if (typeof value !== "string") return "LSP request failed";
  const message = safeStderrText(value).trim();
  return message ? message.slice(0, 1000) : "LSP request failed";
}

function safeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeObjectEntries(value: unknown): Array<[string, unknown]> {
  if (!value || typeof value !== "object") return [];
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if ("value" in descriptor) {
        entries.push([key, descriptor.value]);
        continue;
      }
      if (typeof descriptor.get !== "function") continue;
      try {
        entries.push([key, descriptor.get.call(value)]);
      } catch {
        // Ignore hostile accessors in caller-supplied process environments.
      }
    }
    return entries;
  } catch {
    try {
      return Object.entries(value as Record<string, unknown>);
    } catch {
      return [];
    }
  }
}
