/** MCP Manager — lifecycle and tool registration bridge. */

import { loadConfig, loadUserConfigRaw, writeUserConfigRaw, type Config, type MCPConfig } from "../config.js";
import { MCPClient } from "./client.js";
import { PermissionLevel } from "../tools/base.js";
import { getRegistry } from "../tools/registry.js";
import { createArtifact } from "../artifacts/store.js";
import { omitUndefined } from "../utils/object.js";

export type MCPServerStatus = "configured" | "connected" | "disabled" | "failed";

interface MCPServerStatusRecord {
  status: MCPServerStatus;
  message?: string;
  tool_count?: number;
  failure_count?: number;
  log_artifact_id?: string;
  stderr_tail?: string;
}

export interface MCPServerView extends MCPConfig {
  status: MCPServerStatus;
  message?: string;
  tool_count?: number;
  failure_count?: number;
  log_artifact_id?: string;
  stderr_tail?: string;
}

export class MCPManager {
  private config: Config;
  private clients: Map<string, MCPClient> = new Map();
  private statuses: Map<string, MCPServerStatusRecord> = new Map();
  private toolFingerprints: Map<string, string> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: Config) { this.config = config; }

  async connectAll(): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    for (const serverCfg of this.config.mcp_servers) {
      if (serverCfg.enabled === false) {
        results[serverCfg.name] = "disabled";
        this.statuses.set(serverCfg.name, { status: "disabled" });
        continue;
      }
      results[serverCfg.name] = await this.connectOne(serverCfg);
    }
    return results;
  }

  async connectOne(serverCfg: MCPConfig): Promise<string> {
    if (serverCfg.enabled === false) {
      await this.disconnectOne(serverCfg.name);
      this.statuses.set(serverCfg.name, { status: "disabled" });
      return "disabled";
    }
    await this.disconnectOne(serverCfg.name);
    const client = new MCPClient(serverCfg);
    const log = createArtifact({
      kind: "mcp_log",
      name: `${serverCfg.name}.log`,
      content: "",
      metadata: { server: serverCfg.name, transport: serverCfg.transport },
      extension: ".log",
    });
    client.setLogFile(log.path);
    client.onClose((message) => {
      const current = this.statuses.get(serverCfg.name);
      this.clients.delete(serverCfg.name);
      this.toolFingerprints.delete(serverCfg.name);
      unregisterMCPTools(serverCfg.name);
      this.statuses.set(serverCfg.name, mergeStatus(current, {
        status: "failed",
        message,
        failure_count: failureCount(current) + 1,
        stderr_tail: client.getStderrTail(),
        log_artifact_id: current?.log_artifact_id ?? log.id,
      }));
      this.scheduleReconnect(serverCfg);
    });
    try {
      await client.connect();
      await client.initialize();
      const tools = await client.listTools();
      this.registerTools(serverCfg, client, tools);
      this.clients.set(serverCfg.name, client);
      const fingerprint = JSON.stringify(tools.map(tool => ({ name: tool.name, schema: tool.inputSchema })).sort((a, b) => a.name.localeCompare(b.name)));
      this.toolFingerprints.set(serverCfg.name, fingerprint);
      const message = `connected (${tools.length} tools)`;
      this.statuses.set(serverCfg.name, {
        status: "connected",
        message,
        tool_count: tools.length,
        failure_count: failureCount(this.statuses.get(serverCfg.name)),
        log_artifact_id: log.id,
      });
      return message;
    } catch (e: any) {
      await client.disconnect().catch(() => undefined);
      const message = `failed: ${e.message}`;
      const previous = this.statuses.get(serverCfg.name);
      this.statuses.set(serverCfg.name, mergeStatus(previous, {
        status: "failed",
        message,
        failure_count: failureCount(previous) + 1,
        log_artifact_id: log.id,
        stderr_tail: client.getStderrTail(),
      }));
      this.scheduleReconnect(serverCfg);
      return message;
    }
  }

  async healthCheck(name?: string): Promise<Record<string, MCPServerView>> {
    const views: Record<string, MCPServerView> = {};
    for (const serverCfg of this.config.mcp_servers) {
      if (name && serverCfg.name !== name) continue;
      const client = this.clients.get(serverCfg.name);
      if (!client) {
        views[serverCfg.name] = this.viewFor(serverCfg);
        continue;
      }
      const health = await client.health();
      if (!health.ok) {
        const current = this.statuses.get(serverCfg.name);
        unregisterMCPTools(serverCfg.name);
        this.toolFingerprints.delete(serverCfg.name);
        this.statuses.set(serverCfg.name, mergeStatus(current, {
          status: "failed" as const,
          message: health.message,
          tool_count: 0,
          failure_count: failureCount(current) + 1,
          ...(health.stderr_tail ? { stderr_tail: health.stderr_tail } : {}),
        }));
        this.scheduleReconnect(serverCfg);
      } else {
        await this.refreshTools(serverCfg);
      }
      views[serverCfg.name] = this.viewFor(serverCfg);
    }
    return views;
  }

  async refreshTools(serverCfg: MCPConfig): Promise<boolean> {
    const client = this.clients.get(serverCfg.name);
    if (!client) return false;
    try {
      const tools = await client.listTools();
      const fingerprint = JSON.stringify(tools.map(tool => ({ name: tool.name, schema: tool.inputSchema })).sort((a, b) => a.name.localeCompare(b.name)));
      if (fingerprint === this.toolFingerprints.get(serverCfg.name)) return false;
      unregisterMCPTools(serverCfg.name);
      this.registerTools(serverCfg, client, tools);
      this.toolFingerprints.set(serverCfg.name, fingerprint);
      const current = this.statuses.get(serverCfg.name);
      this.statuses.set(serverCfg.name, mergeStatus(current, {
        status: "connected",
        message: `tools refreshed (${tools.length} tools)`,
        tool_count: tools.length,
      }));
      return true;
    } catch (e: any) {
      const current = this.statuses.get(serverCfg.name);
      unregisterMCPTools(serverCfg.name);
      this.toolFingerprints.delete(serverCfg.name);
      this.statuses.set(serverCfg.name, mergeStatus(current, {
        status: "failed",
        message: e.message,
        tool_count: 0,
        failure_count: failureCount(current) + 1,
      }));
      return false;
    }
  }

  private registerTools(serverCfg: MCPConfig, client: MCPClient, tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): void {
    const registry = getRegistry();
    for (const tool of tools) {
      if (!isValidMCPToolName(tool.name)) continue;
      const localName = mcpToolName(serverCfg.name, tool.name);
      registry.register({
        name: localName,
        description: `[MCP:${serverCfg.name}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema || { type: "object", properties: {} },
        execute: async (args: Record<string, unknown>) => {
          try { return await client.callTool(tool.name, args); }
          catch (e: any) { return `Error: ${e.message}`; }
        },
        permission: PermissionLevel.ASK,
        category: "mcp",
        parallelOk: true,
      });
    }
  }

  async disconnectOne(name: string): Promise<boolean> {
    const client = this.clients.get(name);
    const timer = this.reconnectTimers.get(name);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(name);
    if (!client) {
      unregisterMCPTools(name);
      this.toolFingerprints.delete(name);
      this.statuses.set(name, { status: "configured" });
      return false;
    }
    await client.disconnect();
    this.clients.delete(name);
    this.toolFingerprints.delete(name);
    unregisterMCPTools(name);
    this.statuses.set(name, { status: "configured" });
    return true;
  }

  async disconnectAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      await client.disconnect();
      unregisterMCPTools(name);
    }
    this.clients.clear();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.toolFingerprints.clear();
  }

  list(): MCPServerView[] {
    return this.config.mcp_servers.map(server => this.viewFor(server));
  }

  get serverNames(): string[] { return [...this.clients.keys()]; }

  private viewFor(server: MCPConfig): MCPServerView {
    const status = this.statuses.get(server.name);
    return omitUndefined({
      ...server,
      status: server.enabled === false ? "disabled" : status?.status || (this.clients.has(server.name) ? "connected" : "configured"),
      ...statusFields(status),
    });
  }

  private scheduleReconnect(serverCfg: MCPConfig): void {
    if (serverCfg.enabled === false || this.reconnectTimers.has(serverCfg.name)) return;
    const failures = this.statuses.get(serverCfg.name)?.failure_count || 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, failures - 1));
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(serverCfg.name);
      void this.connectOne(serverCfg);
    }, delay);
    this.reconnectTimers.set(serverCfg.name, timer);
  }
}

function mergeStatus(current: MCPServerStatusRecord | undefined, patch: MCPServerStatusRecord): MCPServerStatusRecord {
  return { ...(current ?? {}), ...patch };
}

function statusFields(status: MCPServerStatusRecord | undefined): Omit<MCPServerStatusRecord, "status"> {
  return omitUndefined({
    message: status?.message,
    tool_count: status?.tool_count,
    failure_count: status?.failure_count,
    log_artifact_id: status?.log_artifact_id,
    stderr_tail: status?.stderr_tail,
  });
}

function failureCount(status: MCPServerStatusRecord | undefined): number {
  return status?.failure_count ?? 0;
}

let manager: MCPManager | null = null;

export function getMCPManager(config = loadConfig()): MCPManager {
  if (!manager) manager = new MCPManager(config);
  return manager;
}

export async function reloadMCPManager(config = loadConfig()): Promise<MCPManager> {
  if (manager) await manager.disconnectAll();
  manager = new MCPManager(config);
  await manager.connectAll();
  return manager;
}

export async function clearMCPManagerForTests(): Promise<void> {
  if (manager) await manager.disconnectAll();
  manager = null;
}

export function addMCPServer(server: MCPConfig): MCPConfig[] {
  const config = loadUserConfigRaw();
  const servers = normalizeServers(config.mcp_servers);
  const next = [...servers.filter(item => item.name !== server.name), { ...server, enabled: server.enabled !== false }];
  config.mcp_servers = next;
  writeUserConfigRaw(config);
  return next;
}

export function setMCPServerEnabled(name: string, enabled: boolean): MCPConfig[] {
  const config = loadUserConfigRaw();
  const servers = normalizeServers(config.mcp_servers);
  let found = false;
  const next = servers.map(server => {
    if (server.name !== name) return server;
    found = true;
    return { ...server, enabled };
  });
  if (!found) throw new Error(`MCP server not found: ${name}`);
  config.mcp_servers = next;
  writeUserConfigRaw(config);
  return next;
}

export function removeMCPServer(name: string): MCPConfig[] {
  const config = loadUserConfigRaw();
  const servers = normalizeServers(config.mcp_servers);
  const next = servers.filter(server => server.name !== name);
  if (next.length === servers.length) throw new Error(`MCP server not found: ${name}`);
  config.mcp_servers = next;
  writeUserConfigRaw(config);
  return next;
}

function unregisterMCPTools(serverName: string): void {
  const prefix = `mcp_${safeMCPNamePart(serverName)}_`;
  const registry = getRegistry();
  for (const tool of registry.listAll()) {
    if (tool.name.startsWith(prefix)) registry.unregister(tool.name);
  }
}

function safeMCPNamePart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "").slice(0, 64) || "server";
}

function isValidMCPToolName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
}

function mcpToolName(serverName: string, toolName: string): string {
  return `mcp_${safeMCPNamePart(serverName)}_${toolName}`;
}

function normalizeServers(value: unknown): MCPConfig[] {
  if (!Array.isArray(value)) return [];
  const servers: MCPConfig[] = [];
  for (const item of value) {
    const server = normalizeServerRecord(item);
    if (server) servers.push(server);
  }
  return servers;
}

function normalizeServerEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") env[key] = entry;
  }
  return env;
}

function normalizeServerRecord(value: unknown): MCPConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim() ? record.name : null;
  if (!name) return null;
  const url = typeof record.url === "string" && record.url.trim() ? record.url : undefined;
  const transport: MCPConfig["transport"] = record.transport === "sse" ? "sse" : "stdio";
  return {
    name,
    transport,
    command: typeof record.command === "string" && record.command.trim() ? record.command : undefined,
    args: Array.isArray(record.args)
      ? record.args.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [],
    url,
    env: normalizeServerEnv(record.env),
    enabled: record.enabled !== false,
  };
}
