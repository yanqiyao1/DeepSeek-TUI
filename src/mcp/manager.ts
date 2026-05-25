/** MCP Manager — lifecycle and tool registration bridge. */

import { loadConfig, loadUserConfigRaw, writeUserConfigRaw, type Config, type MCPConfig } from "../config.js";
import { MCPClient } from "./client.js";
import { PermissionLevel } from "../tools/base.js";
import { getRegistry } from "../tools/registry.js";
import { createArtifact } from "../artifacts/store.js";
import { omitUndefined } from "../utils/object.js";
import { stableJsonStringify, toJsonSafe } from "../utils/json-safe.js";

const MAX_MCP_TOOLS = 100;
const MAX_MCP_TEXT_CHARS = 2_000;
const MAX_MCP_STATUS_TAIL_CHARS = 8_000;
const MAX_MCP_NAME_PART_CHARS = 48;
const MAX_MCP_SERVER_NAME_CHARS = 80;
const MAX_MCP_COMMAND_CHARS = 4_096;
const MAX_MCP_URL_CHARS = 8_192;
const MAX_MCP_ARGS = 128;
const MAX_MCP_ARG_CHARS = 4_096;
const MAX_MCP_ENV_ENTRIES = 128;
const MAX_MCP_ENV_KEY_CHARS = 128;
const MAX_MCP_ENV_VALUE_CHARS = 8_192;
const MAX_MCP_SERVERS = 64;
const MCP_LOCAL_TOOL_NAME_MAX = 64;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

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
        message: text(message, MAX_MCP_TEXT_CHARS),
        failure_count: failureCount(current) + 1,
        stderr_tail: text(client.getStderrTail(), MAX_MCP_STATUS_TAIL_CHARS),
        log_artifact_id: current?.log_artifact_id ?? log.id,
      }));
      this.scheduleReconnect(serverCfg);
    });
    try {
      await client.connect();
      await client.initialize();
      const tools = boundedMCPTools(await client.listTools());
      this.registerTools(serverCfg, client, tools);
      this.clients.set(serverCfg.name, client);
      const fingerprint = toolsFingerprint(tools);
      this.toolFingerprints.set(serverCfg.name, fingerprint);
      const message = `connected (${tools.length} tools)`;
      this.statuses.set(serverCfg.name, {
        status: "connected",
        message: text(message, MAX_MCP_TEXT_CHARS),
        tool_count: tools.length,
        failure_count: failureCount(this.statuses.get(serverCfg.name)),
        log_artifact_id: log.id,
      });
      return message;
    } catch (e: any) {
      await client.disconnect().catch(() => undefined);
      const message = `failed: ${errorText(e)}`;
      const previous = this.statuses.get(serverCfg.name);
      this.statuses.set(serverCfg.name, mergeStatus(previous, {
        status: "failed",
        message: text(message, MAX_MCP_TEXT_CHARS),
        failure_count: failureCount(previous) + 1,
        log_artifact_id: log.id,
        stderr_tail: text(client.getStderrTail(), MAX_MCP_STATUS_TAIL_CHARS),
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
          message: text(health.message, MAX_MCP_TEXT_CHARS),
          tool_count: 0,
          failure_count: failureCount(current) + 1,
          ...(health.stderr_tail ? { stderr_tail: text(health.stderr_tail, MAX_MCP_STATUS_TAIL_CHARS) } : {}),
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
      const tools = boundedMCPTools(await client.listTools());
      const fingerprint = toolsFingerprint(tools);
      if (fingerprint === this.toolFingerprints.get(serverCfg.name)) return false;
      unregisterMCPTools(serverCfg.name);
      this.registerTools(serverCfg, client, tools);
      this.toolFingerprints.set(serverCfg.name, fingerprint);
      const current = this.statuses.get(serverCfg.name);
      this.statuses.set(serverCfg.name, mergeStatus(current, {
        status: "connected",
        message: text(`tools refreshed (${tools.length} tools)`, MAX_MCP_TEXT_CHARS),
        tool_count: tools.length,
      }));
      return true;
    } catch (e: any) {
      const current = this.statuses.get(serverCfg.name);
      unregisterMCPTools(serverCfg.name);
      this.toolFingerprints.delete(serverCfg.name);
      this.statuses.set(serverCfg.name, mergeStatus(current, {
        status: "failed",
        message: errorText(e),
        tool_count: 0,
        failure_count: failureCount(current) + 1,
      }));
      return false;
    }
  }

  private registerTools(serverCfg: MCPConfig, client: MCPClient, tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): void {
    const registry = getRegistry();
    for (const tool of boundedMCPTools(tools)) {
      if (!isValidMCPToolName(tool.name)) continue;
      const localName = mcpToolName(serverCfg.name, tool.name);
      if (localName.length > MCP_LOCAL_TOOL_NAME_MAX) continue;
      registry.register({
        name: localName,
        description: text(`[MCP:${serverCfg.name}] ${tool.description || tool.name}`, MAX_MCP_TEXT_CHARS),
        parameters: schemaObject(tool.inputSchema),
        execute: async (args: Record<string, unknown>) => {
          try { return await client.callTool(tool.name, args); }
          catch (e: any) { return `Error: ${errorText(e)}`; }
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
    timer.unref?.();
    this.reconnectTimers.set(serverCfg.name, timer);
  }
}

function mergeStatus(current: MCPServerStatusRecord | undefined, patch: MCPServerStatusRecord): MCPServerStatusRecord {
  return { ...(current ?? {}), ...patch };
}

function statusFields(status: MCPServerStatusRecord | undefined): Omit<MCPServerStatusRecord, "status"> {
  return omitUndefined({
    message: status?.message ? text(status.message, MAX_MCP_TEXT_CHARS) : undefined,
    tool_count: status?.tool_count,
    failure_count: status?.failure_count,
    log_artifact_id: status?.log_artifact_id,
    stderr_tail: status?.stderr_tail ? text(status.stderr_tail, MAX_MCP_STATUS_TAIL_CHARS) : undefined,
  });
}

function failureCount(status: MCPServerStatusRecord | undefined): number {
  const value = status?.failure_count ?? 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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

export async function shutdownMCPManager(): Promise<void> {
  if (!manager) return;
  await manager.disconnectAll();
  manager = null;
}

export async function clearMCPManagerForTests(): Promise<void> {
  await shutdownMCPManager();
}

export function addMCPServer(server: MCPConfig): MCPConfig[] {
  const config = loadUserConfigRaw();
  const servers = normalizeServers(config.mcp_servers);
  const normalized = normalizeServerRecord(server);
  if (!normalized) throw new Error("invalid MCP server configuration");
  if (normalized.transport === "stdio" && !normalized.command) throw new Error("command is required for stdio MCP servers.");
  if (normalized.transport === "sse" && !normalized.url) throw new Error("url is required for SSE MCP servers.");
  const next = [...servers.filter(item => item.name !== normalized.name), normalized].slice(-MAX_MCP_SERVERS);
  config.mcp_servers = next;
  writeUserConfigRaw(config);
  return next;
}

export function setMCPServerEnabled(name: string, enabled: boolean): MCPConfig[] {
  const targetName = normalizeServerSelector(name);
  if (!targetName) throw new Error("name is required.");
  const config = loadUserConfigRaw();
  const servers = normalizeServers(config.mcp_servers);
  let found = false;
  const next = servers.map(server => {
    if (server.name !== targetName) return server;
    found = true;
    return { ...server, enabled };
  });
  if (!found) throw new Error(`MCP server not found: ${targetName}`);
  config.mcp_servers = next;
  writeUserConfigRaw(config);
  return next;
}

export function removeMCPServer(name: string): MCPConfig[] {
  const targetName = normalizeServerSelector(name);
  if (!targetName) throw new Error("name is required.");
  const config = loadUserConfigRaw();
  const servers = normalizeServers(config.mcp_servers);
  const next = servers.filter(server => server.name !== targetName);
  if (next.length === servers.length) throw new Error(`MCP server not found: ${targetName}`);
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
  return value.trim().replace(CONTROL_TEXT_GLOBAL_RE, "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "").slice(0, MAX_MCP_NAME_PART_CHARS) || "server";
}

function isValidMCPToolName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(value) && !CONTROL_TEXT_RE.test(value);
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
    if (servers.length >= MAX_MCP_SERVERS) break;
  }
  return servers;
}

function normalizeServerEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      key.length <= MAX_MCP_ENV_KEY_CHARS
      && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      && typeof entry === "string"
      && entry.length <= MAX_MCP_ENV_VALUE_CHARS
      && !CONTROL_TEXT_RE.test(entry)
    ) {
      env[key] = entry;
      if (Object.keys(env).length >= MAX_MCP_ENV_ENTRIES) break;
    }
  }
  return env;
}

function normalizeServerRecord(value: unknown): MCPConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = normalizeServerSelector(record.name);
  if (!name) return null;
  const url = typeof record.url === "string" && record.url.trim() && record.url.trim().length <= MAX_MCP_URL_CHARS && !CONTROL_TEXT_RE.test(record.url) ? record.url.trim() : undefined;
  const transport: MCPConfig["transport"] = record.transport === "sse" ? "sse" : "stdio";
  return {
    name,
    transport,
    command: typeof record.command === "string" && record.command.trim() && record.command.trim().length <= MAX_MCP_COMMAND_CHARS && !CONTROL_TEXT_RE.test(record.command) ? record.command.trim() : undefined,
    args: normalizeServerArgs(record.args),
    url,
    env: normalizeServerEnv(record.env),
    enabled: record.enabled !== false,
  };
}

function normalizeServerSelector(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_MCP_SERVER_NAME_CHARS && !CONTROL_TEXT_RE.test(trimmed) ? trimmed : "";
}

function normalizeServerArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const args: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > MAX_MCP_ARG_CHARS || CONTROL_TEXT_RE.test(trimmed)) continue;
    args.push(trimmed);
    if (args.length >= MAX_MCP_ARGS) break;
  }
  return args;
}

function boundedMCPTools(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> {
  return Array.isArray(tools) ? tools.slice(0, MAX_MCP_TOOLS) : [];
}

function toolsFingerprint(tools: Array<{ name: string; inputSchema?: Record<string, unknown> }>): string {
  return stableJsonStringify(tools.map(tool => ({ name: tool.name, schema: schemaObject(tool.inputSchema) })).sort((a, b) => a.name.localeCompare(b.name)));
}

function schemaObject(value: unknown): Record<string, unknown> {
  const safe = toJsonSafe(value, { dropUndefinedObjectFields: true });
  return safe && typeof safe === "object" && !Array.isArray(safe)
    ? safe as Record<string, unknown>
    : { type: "object", properties: {} };
}

function text(value: unknown, maxChars: number): string {
  return String(value ?? "").replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function errorText(error: unknown): string {
  return text(error instanceof Error ? error.message : error, MAX_MCP_TEXT_CHARS);
}
