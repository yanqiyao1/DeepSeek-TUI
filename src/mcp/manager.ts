/** MCP Manager — lifecycle and tool registration bridge. */

import { loadConfig, loadUserConfigRaw, writeUserConfigRaw, type Config, type MCPConfig } from "../config.js";
import { MCPClient } from "./client.js";
import { PermissionLevel } from "../tools/base.js";
import { getRegistry } from "../tools/registry.js";
import { createArtifact } from "../artifacts/store.js";
import { omitUndefined } from "../utils/object.js";
import { stableJsonStringify, toJsonSafe } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

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
const MCP_SERVER_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
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
  /** Monotonic connection generations prevent stale connect/close callbacks from
   * mutating state belonging to a newer manual reconnect. */
  private connectionGenerations: Map<string, number> = new Map();
  /** Clients that have spawned but have not finished initialize/tools discovery. */
  private connectingClients: Map<string, MCPClient> = new Map();

  constructor(config: Config) { this.config = config; }

  async connectAll(): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    for (const serverCfg of this.serverConfigs()) {
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
    const normalizedServerCfg = normalizeServerRecord(serverCfg);
    if (!normalizedServerCfg) return "failed: invalid MCP server configuration";
    serverCfg = normalizedServerCfg;
    if (serverCfg.enabled === false) {
      const generation = this.bumpConnectionGeneration(serverCfg.name);
      await this.disconnectCurrent(serverCfg.name);
      if (this.connectionGenerations.get(serverCfg.name) !== generation) return "superseded";
      this.statuses.set(serverCfg.name, { status: "disabled" });
      return "disabled";
    }
    const generation = this.bumpConnectionGeneration(serverCfg.name);
    await this.disconnectCurrent(serverCfg.name);
    const client = new MCPClient(serverCfg);
    this.connectingClients.set(serverCfg.name, client);
    const log = createArtifact({
      kind: "mcp_log",
      name: `${serverCfg.name}.log`,
      content: "",
      metadata: { server: serverCfg.name, transport: serverCfg.transport },
      extension: ".log",
    });
    client.setLogFile(log.path);
    let closeHandled = false;
    client.onClose((message) => {
      if (this.connectionGenerations.get(serverCfg.name) !== generation
        || (this.clients.get(serverCfg.name) !== client && this.connectingClients.get(serverCfg.name) !== client)) return;
      closeHandled = true;
      if (this.clients.get(serverCfg.name) === client) this.clients.delete(serverCfg.name);
      if (this.connectingClients.get(serverCfg.name) === client) this.connectingClients.delete(serverCfg.name);
      const current = this.statuses.get(serverCfg.name);
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
      if (this.connectionGenerations.get(serverCfg.name) !== generation
        || this.connectingClients.get(serverCfg.name) !== client) {
        await client.disconnect().catch(() => undefined);
        return "superseded";
      }
      this.connectingClients.delete(serverCfg.name);
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
      if (this.connectingClients.get(serverCfg.name) === client) this.connectingClients.delete(serverCfg.name);
      await client.disconnect().catch(() => undefined);
      if (this.connectionGenerations.get(serverCfg.name) !== generation) return "superseded";
      const message = `failed: ${errorText(e)}`;
      if (closeHandled) return message;
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
    for (const serverCfg of this.serverConfigs()) {
      if (name && serverCfg.name !== name) continue;
      const client = this.clients.get(serverCfg.name);
      if (!client) {
        views[serverCfg.name] = this.viewFor(serverCfg);
        continue;
      }
      const generation = this.connectionGenerations.get(serverCfg.name) || 0;
      const health = await client.health();
      if (this.connectionGenerations.get(serverCfg.name) !== generation || this.clients.get(serverCfg.name) !== client) {
        views[serverCfg.name] = this.viewFor(serverCfg);
        continue;
      }
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
    const normalizedServerCfg = normalizeServerRecord(serverCfg);
    if (!normalizedServerCfg) return false;
    serverCfg = normalizedServerCfg;
    const client = this.clients.get(serverCfg.name);
    if (!client) return false;
    const generation = this.connectionGenerations.get(serverCfg.name) || 0;
    try {
      const tools = boundedMCPTools(await client.listTools());
      if (this.connectionGenerations.get(serverCfg.name) !== generation || this.clients.get(serverCfg.name) !== client) return false;
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
      // A reconnect may have replaced this client while listTools was pending.
      // Ignore failures from the superseded client so they cannot unregister
      // tools or mark the replacement connection as failed.
      if (this.connectionGenerations.get(serverCfg.name) !== generation || this.clients.get(serverCfg.name) !== client) return false;
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
        parameters: fallbackSchemaObject(tool.inputSchema),
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
    this.bumpConnectionGeneration(name);
    return this.disconnectCurrent(name);
  }

  private async disconnectCurrent(name: string): Promise<boolean> {
    const clients = new Set<MCPClient>();
    const connected = this.clients.get(name);
    const connecting = this.connectingClients.get(name);
    if (connected) clients.add(connected);
    if (connecting) clients.add(connecting);
    const timer = this.reconnectTimers.get(name);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(name);
    this.clients.delete(name);
    this.connectingClients.delete(name);
    if (!clients.size) {
      unregisterMCPTools(name);
      this.toolFingerprints.delete(name);
      this.statuses.set(name, { status: "configured" });
      return false;
    }
    for (const client of clients) await client.disconnect();
    this.toolFingerprints.delete(name);
    unregisterMCPTools(name);
    this.statuses.set(name, { status: "configured" });
    return true;
  }

  async disconnectAll(): Promise<void> {
    const names = new Set([...this.clients.keys(), ...this.connectingClients.keys(), ...this.reconnectTimers.keys()]);
    for (const name of names) await this.disconnectOne(name);
    this.clients.clear();
    this.connectingClients.clear();
    this.toolFingerprints.clear();
  }

  list(): MCPServerView[] {
    return this.serverConfigs().map(server => this.viewFor(server));
  }

  get serverNames(): string[] { return [...this.clients.keys()]; }

  private serverConfigs(): MCPConfig[] {
    return normalizeServers(safeProperty(this.config, "mcp_servers"));
  }

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

  private bumpConnectionGeneration(name: string): number {
    const next = (this.connectionGenerations.get(name) || 0) + 1;
    this.connectionGenerations.set(name, next);
    return next;
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
  for (const item of safeArrayItems(value, MAX_MCP_SERVERS)) {
    const server = normalizeServerRecord(item);
    if (server) servers.push(server);
    if (servers.length >= MAX_MCP_SERVERS) break;
  }
  return servers;
}

function normalizeServerEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, entry] of safeObjectEntries(value, MAX_MCP_ENV_ENTRIES)) {
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
  const name = normalizeServerSelector(safeProperty(value, "name"));
  if (!name) return null;
  const rawUrl = safeProperty(value, "url");
  const url = typeof rawUrl === "string" && rawUrl.trim() && rawUrl.trim().length <= MAX_MCP_URL_CHARS && !CONTROL_TEXT_RE.test(rawUrl) ? rawUrl.trim() : undefined;
  const transport: MCPConfig["transport"] = safeProperty(value, "transport") === "sse" ? "sse" : "stdio";
  const command = safeProperty(value, "command");
  return {
    name,
    transport,
    command: typeof command === "string" && command.trim() && command.trim().length <= MAX_MCP_COMMAND_CHARS && !CONTROL_TEXT_RE.test(command) ? command.trim() : undefined,
    args: normalizeServerArgs(safeProperty(value, "args")),
    url,
    env: normalizeServerEnv(safeProperty(value, "env")),
    enabled: safeProperty(value, "enabled") !== false,
  };
}

function normalizeServerSelector(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_MCP_SERVER_NAME_CHARS && MCP_SERVER_NAME_RE.test(trimmed) && !CONTROL_TEXT_RE.test(trimmed) ? trimmed : "";
}

function normalizeServerArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const args: string[] = [];
  for (const entry of safeArrayItems(value, MAX_MCP_ARGS)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > MAX_MCP_ARG_CHARS || CONTROL_TEXT_RE.test(trimmed)) continue;
    args.push(trimmed);
    if (args.length >= MAX_MCP_ARGS) break;
  }
  return args;
}

function boundedMCPTools(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> {
  const normalized: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];
  for (const item of safeArrayItems(tools, MAX_MCP_TOOLS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = safeProperty(item, "name");
    if (typeof name !== "string") continue;
    const description = safeProperty(item, "description");
    const inputSchema = safeProperty(item, "inputSchema");
    normalized.push(omitUndefined({
      name,
      description: typeof description === "string" ? description : undefined,
      inputSchema: schemaObject(inputSchema),
    }));
  }
  return normalized;
}

function toolsFingerprint(tools: Array<{ name: string; inputSchema?: Record<string, unknown> }>): string {
  return stableJsonStringify(boundedMCPTools(tools).map(tool => ({ name: tool.name, schema: schemaObject(tool.inputSchema) })).sort((a, b) => a.name.localeCompare(b.name)));
}

function fallbackSchemaObject(value: unknown): Record<string, unknown> {
  const schema = schemaObject(value);
  return Object.keys(schema).length > 0 ? schema : { type: "object", properties: {} };
}

function schemaObject(value: unknown): Record<string, unknown> {
  const safe = toJsonSafe(value, { dropUndefinedObjectFields: true });
  return safe && typeof safe === "object" && !Array.isArray(safe)
    ? safe as Record<string, unknown>
    : { type: "object", properties: {} };
}

function text(value: unknown, maxChars: number): string {
  return safeSliceTextBoundary(String(value ?? "").replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim(), maxChars);
}

function errorText(error: unknown): string {
  return text(error instanceof Error ? error.message : error, MAX_MCP_TEXT_CHARS);
}

function safeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeArrayItems(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
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
      // Skip hostile array elements without dropping the rest of the record.
    }
  }
  return items;
}

function safeObjectEntries(value: unknown, maxEntries: number): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  let keys: string[];
  try {
    keys = Object.keys(value).slice(0, Math.max(0, maxEntries));
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    const entry = safeProperty(value, key);
    if (entry !== undefined) entries.push([key, entry]);
  }
  return entries;
}
