/** MCP client — stdio subprocess and SSE transport. */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { MCPConfig } from "../config.js";
import { VERSION } from "../version.js";
import { createRequest, type JSONRPCResponse, type MCPTool } from "./protocol.js";
import { omitUndefined } from "../utils/object.js";

type PendingRequest = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class MCPClient {
  private config: MCPConfig;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pending: Map<string, PendingRequest> = new Map();
  private stderrTail = "";
  private logFile?: string;
  private closeHandler?: (message: string) => void;
  private intentionalDisconnect = false;

  constructor(config: MCPConfig) { this.config = config; }

  setLogFile(path: string): void { this.logFile = path; }

  onClose(handler: (message: string) => void): void { this.closeHandler = handler; }

  async connect(): Promise<void> {
    if (this.config.transport === "stdio") {
      const cmd = this.config.command;
      if (!cmd) throw new Error("MCP stdio command is not configured");
      const args = this.config.args ?? [];
      this.intentionalDisconnect = false;
      this.proc = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(this.config.env ?? {}) },
      });
      this.proc.stdout?.on("data", (d: Buffer) => {
        this.buffer += d.toString("utf-8");
        while (this.buffer.includes("\n")) {
          const idx = this.buffer.indexOf("\n");
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const resp = JSON.parse(line) as JSONRPCResponse;
            const pending = this.pending.get(resp.id);
            if (pending) {
              this.pending.delete(resp.id);
              clearTimeout(pending.timer);
              if (resp.error) pending.reject(new Error(`MCP error ${resp.error.code}: ${resp.error.message}`));
              else pending.resolve(resp.result);
            }
          } catch { /* skip malformed lines */ }
        }
      });
      this.proc.stderr?.on("data", (d: Buffer) => {
        const text = d.toString("utf-8");
        this.stderrTail = (this.stderrTail + text).slice(-20_000);
        if (this.logFile) {
          try { appendFileSync(this.logFile, `[stderr] ${text}`, "utf-8"); } catch { /* ignore log failures */ }
        }
      });
      this.proc.on("error", (err) => this.rejectPending(err));
      this.proc.on("close", (code, signal) => {
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
    const result = await this.request("tools/list", {}) as { tools?: MCPTool[] } | undefined;
    return result?.tools ?? [];
  }

  async health(): Promise<{ ok: boolean; message: string; stderr_tail?: string }> {
    try {
      await this.listTools();
      const stderrTail = this.stderrTail.length > 0 ? this.stderrTail : undefined;
      return omitUndefined({ ok: true, message: "tools/list ok", stderr_tail: stderrTail });
    } catch (e: any) {
      const stderrTail = this.stderrTail.length > 0 ? this.stderrTail : undefined;
      return omitUndefined({ ok: false, message: String(e?.message ?? e), stderr_tail: stderrTail });
    }
  }

  getStderrTail(): string { return this.stderrTail; }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: arguments_ }) as { content?: Array<{ type: string; text?: string }> } | undefined;
    if (result?.content) {
      return result.content.map(c => c.text ?? JSON.stringify(c)).join("\n");
    }
    return JSON.stringify(result);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const req = createRequest(method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(req.id)) {
          this.pending.delete(req.id);
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, 30_000);
      this.pending.set(req.id, { resolve, reject, timer });
      if (this.config.transport === "stdio") {
        if (!this.proc || this.proc.killed || this.proc.stdin?.destroyed) {
          clearTimeout(timer);
          this.pending.delete(req.id);
          reject(new Error("MCP stdio process is not connected"));
          return;
        }
        const ok = this.proc.stdin?.write(JSON.stringify(req) + "\n");
        if (ok === false && this.proc.stdin?.destroyed) {
          clearTimeout(timer);
          this.pending.delete(req.id);
          reject(new Error("MCP process stdin is closed"));
        }
      } else {
        // SSE transport
        fetch(`${this.config.url}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
        }).then(r => r.json()).then((raw: unknown) => {
          clearTimeout(timer);
          this.pending.delete(req.id);
          const data = raw as JSONRPCResponse;
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
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
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async disconnect(): Promise<void> {
    if (this.proc) {
      this.intentionalDisconnect = true;
      this.proc.kill();
      this.proc = null;
    }
    this.rejectPending(new Error("MCP client disconnected"));
  }
}
