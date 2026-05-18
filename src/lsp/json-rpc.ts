import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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

export class JsonRpcProcessClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private stderrTailValue = "";

  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: "pipe",
    });
    this.child.stdout.on("data", data => this.handleData(data));
    this.child.stderr.on("data", data => {
      this.stderrTailValue = (this.stderrTailValue + data.toString("utf-8")).slice(-4096);
    });
    this.child.on("error", error => this.rejectAll(error));
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
    const id = this.nextId++;
    const pending = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return pending;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("shutdown", null, 1_000);
      this.notify("exit");
    } catch {
      this.child.kill();
    }
    this.closed = true;
  }

  private send(message: JsonRpcMessage): void {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    this.child.stdin.write(header + body);
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (true) {
      const parsed = this.nextMessage();
      if (!parsed) return;
      this.handleMessage(parsed);
    }
  }

  private nextMessage(): JsonRpcMessage | null {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    const separator = headerEnd >= 0 ? "\r\n\r\n" : "\n\n";
    const fallbackHeaderEnd = headerEnd >= 0 ? headerEnd : this.buffer.indexOf(separator);
    if (fallbackHeaderEnd < 0) return null;

    const headerText = this.buffer.subarray(0, fallbackHeaderEnd).toString("ascii");
    const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      this.buffer = Buffer.alloc(0);
      return null;
    }

    const bodyStart = fallbackHeaderEnd + separator.length;
    const bodyLength = Number(lengthMatch[1]);
    if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_MESSAGE_BYTES) {
      this.stderrTailValue = `${this.stderrTailValue}\nInvalid LSP Content-Length: ${lengthMatch[1]}`.slice(-4096);
      this.buffer = Buffer.alloc(0);
      return null;
    }
    if (this.buffer.length < bodyStart + bodyLength) return null;

    const body = this.buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf-8");
    this.buffer = this.buffer.subarray(bodyStart + bodyLength);
    try {
      return JSON.parse(body) as JsonRpcMessage;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stderrTailValue = `${this.stderrTailValue}\nMalformed LSP JSON-RPC message: ${message}`.slice(-4096);
      return { jsonrpc: "2.0", method: "$/seekcode/ignoredMalformedMessage" };
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.send({ jsonrpc: "2.0", id: message.id, result: null });
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
