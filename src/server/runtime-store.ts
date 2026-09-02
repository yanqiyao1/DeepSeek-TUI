/** Persistent runtime thread/turn/event store for HTTP/SSE API. */

import { basename, dirname, join, resolve } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import {
  createSession,
  safeSessionString,
  safeToolArguments,
  safeToolCallId,
  safeToolName,
  normalizeToolCalls,
  normalizeArtifactIdArray,
  type Message,
  type Session,
  type ToolCall,
  type ToolResult,
  type Turn,
} from "../session/types.js";
import { ConversationHistory } from "../session/history.js";
import type { Config } from "../config.js";
import type { Engine } from "../engine/loop.js";
import { ImmutablePrefix, type SerializedImmutablePrefix } from "../engine/prefix.js";
import { linkArtifact } from "../artifacts/store.js";
import { seekcodeDataPath } from "../paths.js";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify, toJsonSafe } from "../utils/json-safe.js";

export type TurnStatus = "queued" | "in_progress" | "completed" | "failed" | "interrupted" | "canceled";

export interface RuntimeEvent {
  seq: number;
  thread_id: string;
  turn_id?: string;
  event: string;
  data: unknown;
  created_at: string;
}

export interface RuntimeTurn {
  id: string;
  thread_id: string;
  status: TurnStatus;
  message: string;
  created_at: string;
  updated_at: string;
  usage?: Record<string, unknown> | null;
  error?: string;
  artifact_ids: string[];
  interrupted_at?: string;
  resumed_from_turn_id?: string;
}

export interface RuntimeItem {
  seq: number;
  id: string;
  thread_id: string;
  turn_id?: string;
  type: string;
  data: unknown;
  artifact_ids: string[];
  created_at: string;
}

export interface RuntimeThread {
  id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  model: string;
  mode: string;
  workspace: string;
  archived: boolean;
  latest_turn_id?: string;
}

export interface RuntimeRecord {
  config: Config;
  session: Session;
  history: ConversationHistory;
  thread: RuntimeThread;
  turns: RuntimeTurn[];
  events: RuntimeEvent[];
  items: RuntimeItem[];
  prefix?: ImmutablePrefix;
  /** The single turn currently executing for this runtime thread, if any. */
  activeTurn?: {
    turnId: string;
    abortController: AbortController;
    engine?: Engine;
  };
  /**
   * Legacy aliases retained for callers that inspect the active execution.
   * New code should use `activeTurn`, which is scoped to a turn id.
   */
  abortController?: AbortController;
  activeEngine?: Engine;
  /** Set when the record is removed while an in-flight turn is unwinding. */
  deleted?: boolean;
}

type RuntimeEventSubscriber = (event: RuntimeEvent) => void | Promise<void>;

const records = new Map<string, RuntimeRecord>();
const eventSubscribers = new Map<string, Set<RuntimeEventSubscriber>>();
let seq = 0;
let loaded = false;
let atomicRuntimeWriteCounter = 0;
const MAX_PERSISTED_RUNTIME_ROWS = 10_000;
const MAX_RUNTIME_ARTIFACT_IDS = 500;
const MAX_RUNTIME_DATA_CHARS = 1_000_000;
const MAX_RUNTIME_TOOL_CALLS = 100;
const MAX_RUNTIME_TOOL_RESULTS = 100;
const MAX_RUNTIME_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RUNTIME_JSONL_BYTES = 10 * 1024 * 1024;
const MAX_RUNTIME_THREAD_SCAN = 2_000;
const VALID_THREAD_MODES = new Set<Config["mode"]>(["plan", "agent", "yolo"]);
const SAFE_EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const SAFE_ITEM_TYPE_RE = /^[A-Za-z0-9_.:-]{1,160}$/;

function dataRoot(): string {
  const override = firstNonBlankEnv("SEEKCODE_RUNTIME_DIR", "DEEPCODE_RUNTIME_DIR", "DEEPSEEK_RUNTIME_DIR");
  if (override) return resolve(override);
  return seekcodeDataPath("runtime");
}

function firstNonBlankEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function threadDir(): string {
  return join(dataRoot(), "threads");
}

function eventDir(): string {
  return join(dataRoot(), "events");
}

function itemDir(): string {
  return join(dataRoot(), "items");
}

function threadPath(threadId: string): string {
  return join(threadDir(), `${safeId(threadId)}.json`);
}

function eventPath(threadId: string): string {
  return join(eventDir(), `${safeId(threadId)}.jsonl`);
}

function itemPath(threadId: string): string {
  return join(itemDir(), `${safeId(threadId)}.jsonl`);
}

function safeId(value: string): string {
  return String(value ?? "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128);
}

function isMissingFileError(error: unknown): boolean {
  return safeProperty(error, "code") === "ENOENT";
}

function readSafeRuntimeFile(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return readFileSync(fd, "utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function ensureSafeRuntimeDir(path: string): void {
  const resolved = resolve(path);
  const missing: string[] = [];
  let current = resolved;
  let anchor: string | undefined;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe runtime data directory: ${path}`);
      anchor ??= current;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      missing.unshift(basename(current));
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!anchor) throw new Error(`unsafe runtime data directory: ${path}`);
  current = anchor;
  for (const segment of missing) {
    const next = join(current, segment);
    try {
      mkdirSync(next);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe runtime data directory: ${path}`);
    current = next;
  }
}

function isSafeExistingRuntimeDir(path: string): boolean {
  let current = resolve(path);
  try {
    while (true) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  } catch {
    return false;
  }
}

function assertSafeWriteTarget(path: string, label: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to write ${label} through a symlink.`);
    if (!stat.isFile()) throw new Error(`Refusing to write ${label} over a non-file path.`);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

function cleanupAtomicRuntimeTemp(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

function writeRuntimeFileAtomic(path: string, payload: string, label: string): void {
  assertSafeWriteTarget(path, label);
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${atomicRuntimeWriteCounter++}.tmp`);
  try {
    writeFileSync(tmpPath, payload, { encoding: "utf-8", flag: "wx" });
    assertSafeWriteTarget(path, label);
    renameSync(tmpPath, path);
  } catch (error) {
    cleanupAtomicRuntimeTemp(tmpPath);
    throw error;
  }
}

function appendRuntimeLine(path: string, line: string, label: string): void {
  assertSafeWriteTarget(path, label);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const nonBlock = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow | nonBlock, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Refusing to write ${label} over a non-file path.`);
    writeSync(fd, line, undefined, "utf-8");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function safeJson(value: unknown, fallback: unknown = { truncated: true }): unknown {
  try {
    return toJsonSafe(value);
  } catch {
    return fallback;
  }
}

function safeStringifyLength(value: unknown): number {
  try {
    return safeJsonStringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    ensureSafeRuntimeDir(dataRoot());
    ensureSafeRuntimeDir(threadDir());
    ensureSafeRuntimeDir(eventDir());
    for (const file of readdirSync(threadDir()).filter(name => name.endsWith(".json")).slice(0, MAX_RUNTIME_THREAD_SCAN)) {
      try {
        const path = join(threadDir(), file);
        const text = readSafeRuntimeFile(path, MAX_RUNTIME_FILE_BYTES);
        if (text === null) continue;
        const raw = parsePersistedRuntimeRecord(JSON.parse(text));
        if (!raw) continue;
        const threadIdFromFile = safeRuntimeId(file.replace(/\.json$/i, ""));
        if (threadIdFromFile !== raw.thread.id || raw.thread.session_id !== raw.session.id) continue;
        const history = new ConversationHistory(raw.session);
        const interruptedTurns: RuntimeTurn[] = [];
        for (const turn of raw.turns) {
          if (turn.status === "queued" || turn.status === "in_progress") {
            turn.status = "interrupted";
            turn.error = "Interrupted by process restart";
            turn.updated_at = new Date().toISOString();
            turn.interrupted_at = turn.updated_at;
            raw.thread.updated_at = turn.updated_at;
            interruptedTurns.push(turn);
          }
        }
        const turnIds = new Set(raw.turns.map(turn => turn.id));
        const events = loadEvents(raw.thread.id).filter(event => !event.turn_id || turnIds.has(event.turn_id));
        const items = loadItems(raw.thread.id).filter(item => !item.turn_id || turnIds.has(item.turn_id));
        for (const event of events) seq = Math.max(seq, event.seq);
        for (const item of items) seq = Math.max(seq, item.seq);
        const record: RuntimeRecord = omitUndefined({
          config: normalizeRuntimeConfig(raw.config, raw.thread, raw.session),
          session: raw.session,
          history,
          thread: raw.thread,
          turns: raw.turns.map(turn => ({ ...turn, artifact_ids: turn.artifact_ids })),
          events,
          items,
          prefix: raw.prefix ? ImmutablePrefix.fromJSON(raw.prefix) : undefined,
        });
        records.set(raw.thread.id, record);
        if (interruptedTurns.length) {
          persistRecord(record);
          for (const turn of interruptedTurns) appendEvent(record, "turn.interrupted", { turn }, turn.id);
        }
      } catch {
        // skip corrupt runtime record
      }
    }
  } catch {
    // store remains memory-backed if the filesystem is unavailable
  }
}

function parsePersistedRuntimeRecord(value: unknown): {
  config: Config;
  session: Session;
  thread: RuntimeThread;
  turns: RuntimeTurn[];
  prefix?: SerializedImmutablePrefix;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawConfig = safeProperty(value, "config");
  const rawPrefix = safeProperty(value, "prefix");
  const config = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
    ? rawConfig as Config
    : null;
  const session = parseRuntimeSession(safeProperty(value, "session"));
  const thread = parseRuntimeThread(safeProperty(value, "thread"));
  const turns = parseRuntimeTurns(safeProperty(value, "turns"));
  const prefix = rawPrefix && typeof rawPrefix === "object" && !Array.isArray(rawPrefix)
    ? rawPrefix as SerializedImmutablePrefix
    : undefined;

  if (!config || !session || !thread || !turns) return null;
  if (session.id !== thread.session_id) return null;
  const filteredTurns = turns.filter(turn => turn.thread_id === thread.id);
  return { config, session, thread, turns: filteredTurns, ...(prefix ? { prefix } : {}) };
}

function parseRuntimeSession(value: unknown): Session | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const base = createSession();
  const id = safeRuntimeId(safeProperty(value, "id"));
  const title = trimmedString(safeProperty(value, "title")) ?? "Untitled session";
  const createdAt = optionalDateString(safeProperty(value, "created_at")) ?? base.created_at;
  const updatedAt = optionalDateString(safeProperty(value, "updated_at")) ?? base.updated_at;
  const mode = parseRuntimeMode(safeProperty(value, "mode")) ?? base.mode;
  const model = trimmedString(safeProperty(value, "model")) ?? base.model;
  const workspacePath = safeRuntimePath(safeProperty(value, "workspace_path")) ?? base.workspace_path;
  const prefixHash = safeProperty(value, "prefix_hash");
  if (!id) return null;
  return {
    ...base,
    id,
    title,
    created_at: createdAt,
    updated_at: updatedAt,
    mode,
    model,
    turns: parseSessionTurns(safeProperty(value, "turns")),
    messages: parseSessionMessages(safeProperty(value, "messages")),
    cumulative_tokens_in: nonNegativeSafeInteger(safeProperty(value, "cumulative_tokens_in")),
    cumulative_tokens_out: nonNegativeSafeInteger(safeProperty(value, "cumulative_tokens_out")),
    cumulative_cost: nonNegativeFiniteNumber(safeProperty(value, "cumulative_cost")),
    workspace_path: workspacePath,
    artifact_index: parseArtifactIndex(safeProperty(value, "artifact_index")),
    ...(typeof prefixHash === "string" && prefixHash.trim() ? { prefix_hash: prefixHash.trim() } : {}),
  };
}

function parseRuntimeThread(value: unknown): RuntimeThread | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = safeRuntimeId(safeProperty(value, "id"));
  const sessionId = safeRuntimeId(safeProperty(value, "session_id"));
  const createdAt = optionalDateString(safeProperty(value, "created_at"));
  const updatedAt = optionalDateString(safeProperty(value, "updated_at"));
  const model = trimmedString(safeProperty(value, "model"));
  const mode = parseRuntimeMode(safeProperty(value, "mode"));
  const workspace = safeRuntimePath(safeProperty(value, "workspace"));
  const archivedRaw = safeProperty(value, "archived");
  const archived = typeof archivedRaw === "boolean" ? archivedRaw : null;
  const latestTurnId = optionalRuntimeId(safeProperty(value, "latest_turn_id"));
  if (!id || !sessionId || !createdAt || !updatedAt || !model || !mode || !workspace || archived === null || latestTurnId === undefined) {
    return null;
  }
  return {
    id,
    session_id: sessionId,
    created_at: createdAt,
    updated_at: updatedAt,
    model,
    mode,
    workspace,
    archived,
    ...(latestTurnId !== null ? { latest_turn_id: latestTurnId } : {}),
  };
}

function parseRuntimeTurns(value: unknown): RuntimeTurn[] | null {
  if (!Array.isArray(value)) return [];
  const turns: RuntimeTurn[] = [];
  for (const item of safeArrayItemsFromEnd(value, MAX_PERSISTED_RUNTIME_ROWS)) {
    const turn = parseRuntimeTurn(item);
    if (turn) turns.push(turn);
  }
  return turns;
}

function parseRuntimeTurn(value: unknown): RuntimeTurn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = safeRuntimeId(safeProperty(value, "id"));
  const threadId = safeRuntimeId(safeProperty(value, "thread_id"));
  const rawStatus = safeProperty(value, "status");
  const status = typeof rawStatus === "string" ? rawStatus : null;
  const rawMessage = safeProperty(value, "message");
  const message = typeof rawMessage === "string" ? rawMessage : "";
  const createdAt = optionalDateString(safeProperty(value, "created_at"));
  const updatedAt = optionalDateString(safeProperty(value, "updated_at"));
  const artifactIds = artifactIdArray(safeProperty(value, "artifact_ids"));
  const error = optionalString(safeProperty(value, "error"));
  const interruptedAt = optionalString(safeProperty(value, "interrupted_at"));
  const resumedFromTurnId = optionalRuntimeId(safeProperty(value, "resumed_from_turn_id"));
  const rawUsage = safeProperty(value, "usage");
  const usage = rawUsage === undefined || rawUsage === null
    ? null
    : (rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)
        ? rawUsage as Record<string, unknown>
        : undefined);

  if (
    !id
    || !threadId
    || !status
    || !createdAt
    || !updatedAt
    || !VALID_TURN_STATUSES.has(status as TurnStatus)
    || error === undefined
    || interruptedAt === undefined
    || resumedFromTurnId === undefined
    || usage === undefined
  ) {
    return null;
  }

  return {
    id,
    thread_id: threadId,
    status: status as TurnStatus,
    message,
    created_at: createdAt,
    updated_at: updatedAt,
    artifact_ids: artifactIds,
    ...(usage !== null ? { usage } : {}),
    ...(error !== null ? { error } : {}),
    ...(interruptedAt !== null ? { interrupted_at: interruptedAt } : {}),
    ...(resumedFromTurnId !== null ? { resumed_from_turn_id: resumedFromTurnId } : {}),
  };
}

const VALID_TURN_STATUSES = new Set<TurnStatus>(["queued", "in_progress", "completed", "failed", "interrupted", "canceled"]);

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !value.includes("\0") ? value : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !value.includes("\0") ? value.trim() : null;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && !value.includes("\0") ? value : undefined;
}

function safeRuntimeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = safeId(value.trim());
  return id && id === value.trim() ? id : null;
}

function optionalRuntimeId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return safeRuntimeId(value) ?? undefined;
}

function parseRuntimeMode(value: unknown): Config["mode"] | null {
  if (typeof value !== "string") return null;
  const mode = value.trim();
  return VALID_THREAD_MODES.has(mode as Config["mode"]) ? mode as Config["mode"] : null;
}

function safeRuntimePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  return path && !path.includes("\0") ? path : null;
}

function optionalDateString(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : null;
}

function nonNegativeFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nonNegativeSafeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedJsonData(value: unknown): unknown {
  const safe = safeJson(value);
  return boundJsonSafeData(safe);
}

function boundJsonSafeData(value: unknown): unknown {
  return safeStringifyLength(value) <= MAX_RUNTIME_DATA_CHARS ? value : { truncated: true };
}

function artifactIdArray(value: unknown): string[] {
  return normalizeArtifactIdArray(value).filter(isSafeArtifactId).slice(0, MAX_RUNTIME_ARTIFACT_IDS);
}

function isSafeArtifactId(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9._-]*_[a-z0-9]{6,}_[a-f0-9]{8,}$/.test(value);
}

function parseRuntimeEvent(value: unknown): RuntimeEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seq = finiteNonNegativeInteger(safeProperty(value, "seq"));
  const threadId = safeRuntimeId(safeProperty(value, "thread_id"));
  const event = safeEventName(safeProperty(value, "event"));
  const createdAt = optionalDateString(safeProperty(value, "created_at"));
  const turnId = optionalRuntimeId(safeProperty(value, "turn_id"));
  if (seq === null || !threadId || !event || !createdAt || turnId === undefined || !hasProperty(value, "data")) return null;
  return {
    seq,
    thread_id: threadId,
    event,
    data: boundedJsonData(safeProperty(value, "data")),
    created_at: createdAt,
    ...(turnId !== null ? { turn_id: turnId } : {}),
  };
}

function parseRuntimeItem(value: unknown): RuntimeItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seq = finiteNonNegativeInteger(safeProperty(value, "seq"));
  const id = safeRuntimeId(safeProperty(value, "id"));
  const threadId = safeRuntimeId(safeProperty(value, "thread_id"));
  const type = safeItemType(safeProperty(value, "type"));
  const createdAt = optionalDateString(safeProperty(value, "created_at"));
  const turnId = optionalRuntimeId(safeProperty(value, "turn_id"));
  if (seq === null || !id || !threadId || !type || !createdAt || turnId === undefined || !hasProperty(value, "data")) return null;
  return {
    seq,
    id,
    thread_id: threadId,
    type,
    data: boundedJsonData(safeProperty(value, "data")),
    artifact_ids: artifactIdArray(safeProperty(value, "artifact_ids")),
    created_at: createdAt,
    ...(turnId !== null ? { turn_id: turnId } : {}),
  };
}

function finiteNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function safeEventName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const event = value.trim();
  return SAFE_EVENT_NAME_RE.test(event) ? event : null;
}

function safeItemType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const type = value.trim();
  return SAFE_ITEM_TYPE_RE.test(type) ? type : null;
}

function parseSessionMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return safeArrayItemsFromEnd(value, MAX_PERSISTED_RUNTIME_ROWS)
    .map(parseSessionMessage)
    .filter((message): message is Message => !!message);
}

function parseSessionMessage(value: unknown): Message | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const role = safeProperty(value, "role");
  const rawToolCalls = safeProperty(value, "tool_calls");
  if (!["system", "user", "assistant", "tool"].includes(role as string)) return null;
  const toolCalls = Array.isArray(rawToolCalls)
    && role === "assistant"
    ? safeArrayItems(rawToolCalls, MAX_RUNTIME_TOOL_CALLS).map(parseSessionToolCall).filter((toolCall): toolCall is ToolCall => !!toolCall)
    : null;
  const toolCallId = safeToolCallId(safeProperty(value, "tool_call_id"));
  if (role === "tool" && !toolCallId) return null;
  return {
    role: role as Message["role"],
    content: safeSessionString(safeProperty(value, "content")),
    tool_calls: toolCalls && toolCalls.length ? toolCalls : null,
    tool_call_id: toolCallId,
    name: safeToolName(safeProperty(value, "name")),
    reasoning_content: safeSessionString(safeProperty(value, "reasoning_content")),
    is_error: typeof safeProperty(value, "is_error") === "boolean" ? safeProperty(value, "is_error") as boolean : null,
  };
}

function parseSessionToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawFunction = safeProperty(value, "function");
  const fn = rawFunction && typeof rawFunction === "object" && !Array.isArray(rawFunction)
    ? rawFunction as Record<string, unknown>
    : {};
  const id = safeToolCallId(safeProperty(value, "id")) ?? "";
  const name = safeToolName(safeProperty(value, "name")) ?? safeToolName(safeProperty(fn, "name")) ?? "";
  const rawArgs = safeProperty(value, "arguments") ?? safeProperty(fn, "arguments");
  const args = parseToolCallArgs(rawArgs);
  return id && name ? { id, name, arguments: args } : null;
}

function parseToolCallArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? safeToolArguments(toJsonSafe(parsed) as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe = safeJson(value, {});
  return safe && typeof safe === "object" && !Array.isArray(safe)
    ? safeToolArguments(safe as Record<string, unknown>)
    : {};
}

function parseSessionTurns(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];
  return safeArrayItemsFromEnd(value, MAX_PERSISTED_RUNTIME_ROWS)
    .map((item, index) => parseSessionTurn(item, index))
    .filter((turn): turn is Turn => !!turn);
}

function parseSessionTurn(value: unknown, index: number): Turn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawIndex = safeProperty(value, "index");
  const rawToolCalls = safeProperty(value, "tool_calls");
  const storedIndex = typeof rawIndex === "number" && Number.isSafeInteger(rawIndex) && rawIndex > 0
    ? rawIndex
    : index + 1;
  return {
    index: storedIndex,
    user_message: safeSessionString(safeProperty(value, "user_message")) ?? "",
    assistant_messages: parseSessionMessages(safeProperty(value, "assistant_messages")),
    tool_calls: Array.isArray(rawToolCalls)
      ? safeArrayItems(rawToolCalls, MAX_RUNTIME_TOOL_CALLS).map(parseSessionToolCall).filter((toolCall): toolCall is ToolCall => !!toolCall)
      : [],
    tool_results: parseToolResults(safeProperty(value, "tool_results")),
    tokens_in: nonNegativeSafeInteger(safeProperty(value, "tokens_in")),
    tokens_out: nonNegativeSafeInteger(safeProperty(value, "tokens_out")),
    cost: nonNegativeFiniteNumber(safeProperty(value, "cost")),
    duration_s: nonNegativeFiniteNumber(safeProperty(value, "duration_s")),
    artifact_ids: artifactIdArray(safeProperty(value, "artifact_ids")),
  };
}

function parseToolResults(value: unknown): ToolResult[] {
  if (!Array.isArray(value)) return [];
  return safeArrayItems(value, MAX_RUNTIME_TOOL_RESULTS).map(item => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const toolCallId = safeToolCallId(safeProperty(record, "tool_call_id"));
    const name = safeToolName(safeProperty(record, "name"));
    if (!toolCallId || !name) return null;
    return {
      tool_call_id: toolCallId,
      name,
      content: safeSessionString(safeProperty(record, "content")) ?? "",
      is_error: safeProperty(record, "is_error") === true,
    };
  }).filter((result): result is ToolResult => !!result);
}

function parseArtifactIndex(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [key, raw] of safeObjectEntries(value, MAX_RUNTIME_ARTIFACT_IDS)) {
    if (!isSafeArtifactIndexKey(key)) continue;
    result[key] = artifactIdArray(raw);
  }
  return result;
}

function isSafeArtifactIndexKey(value: string): boolean {
  return value === "session" || /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
}

function normalizeRuntimeConfig(config: Config, thread: RuntimeThread, session: Session): Config {
  return {
    ...config,
    mode: thread.mode as Config["mode"],
    model: thread.model || session.model || config.model,
  };
}

function normalizeLiveSession(session: Session, config: Config): void {
  const sessionId = safeRuntimeId(session.id);
  if (sessionId) session.id = sessionId;
  else session.id = id("ses");
  session.mode = parseRuntimeMode(session.mode) ?? config.mode;
  session.model = trimmedString(session.model) ?? config.model;
  session.workspace_path = safeRuntimePath(session.workspace_path) ?? process.cwd();
  session.artifact_index = parseArtifactIndex(session.artifact_index);
  session.messages = parseSessionMessages(session.messages);
  session.turns = parseSessionTurns(session.turns);
  session.cumulative_tokens_in = nonNegativeSafeInteger(session.cumulative_tokens_in);
  session.cumulative_tokens_out = nonNegativeSafeInteger(session.cumulative_tokens_out);
  session.cumulative_cost = nonNegativeFiniteNumber(session.cumulative_cost);
}

function normalizeThreadPatch(
  patch: Partial<Pick<RuntimeThread, "archived" | "mode" | "model" | "workspace">>,
): Partial<Pick<RuntimeThread, "archived" | "mode" | "model" | "workspace">> {
  const safePatch: Partial<Pick<RuntimeThread, "archived" | "mode" | "model" | "workspace">> = {};
  const archived = safeProperty(patch, "archived");
  if (typeof archived === "boolean") safePatch.archived = archived;
  const mode = parseRuntimeMode(safeProperty(patch, "mode"));
  if (mode) safePatch.mode = mode;
  const model = trimmedString(safeProperty(patch, "model"));
  if (model) safePatch.model = model;
  const workspace = safeRuntimePath(safeProperty(patch, "workspace"));
  if (workspace) safePatch.workspace = workspace;
  return safePatch;
}

function normalizeTurnPatch(patch: Partial<RuntimeTurn>): Partial<RuntimeTurn> {
  const safePatch: Partial<RuntimeTurn> = {};
  const usage = safeProperty(patch, "usage");
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const safeUsage = boundedJsonData(usage);
    safePatch.usage = safeUsage && typeof safeUsage === "object" && !Array.isArray(safeUsage)
      ? safeUsage as Record<string, unknown>
      : {};
  } else if (usage === null) {
    safePatch.usage = null;
  }
  const error = safeProperty(patch, "error");
  if (typeof error === "string" && !error.includes("\0")) safePatch.error = error;
  const interruptedAt = optionalDateString(safeProperty(patch, "interrupted_at"));
  if (interruptedAt) safePatch.interrupted_at = interruptedAt;
  const resumedFromTurnId = optionalRuntimeId(safeProperty(patch, "resumed_from_turn_id"));
  if (resumedFromTurnId) safePatch.resumed_from_turn_id = resumedFromTurnId;
  const artifactIds = artifactIdArray(safeProperty(patch, "artifact_ids"));
  if (artifactIds.length) safePatch.artifact_ids = artifactIds;
  return safePatch;
}

function normalizeSinceSeq(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return safeJson(value, null) as T;
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  const normalized = normalizeToolCalls([toolCall])[0];
  return normalized ?? { id: "", name: "", arguments: {} };
}

function cloneArtifactIds(value: string[] | undefined): string[] {
  return artifactIdArray(value);
}

function cloneToolResult(toolResult: ToolResult): ToolResult {
  return {
    tool_call_id: safeToolCallId(safeProperty(toolResult, "tool_call_id")) ?? "",
    name: safeToolName(safeProperty(toolResult, "name")) ?? "",
    content: safeSessionString(safeProperty(toolResult, "content")) ?? "",
    is_error: safeProperty(toolResult, "is_error") === true,
  };
}

function cloneMessage(message: Message): Message {
  const toolCalls = normalizeToolCalls(safeProperty(message, "tool_calls")).map(cloneToolCall);
  return {
    role: parseMessageRole(safeProperty(message, "role")),
    content: safeSessionString(safeProperty(message, "content")),
    tool_calls: toolCalls.length ? toolCalls : null,
    tool_call_id: safeToolCallId(safeProperty(message, "tool_call_id")),
    name: safeToolName(safeProperty(message, "name")),
    reasoning_content: safeSessionString(safeProperty(message, "reasoning_content")),
    is_error: safeProperty(message, "is_error") === true,
  };
}

function cloneTurn(turn: Turn): Turn {
  return {
    index: nonNegativeSafeInteger(safeProperty(turn, "index")) || 1,
    user_message: safeSessionString(safeProperty(turn, "user_message")) ?? "",
    assistant_messages: safeArrayItems(safeProperty(turn, "assistant_messages"), MAX_PERSISTED_RUNTIME_ROWS).map(message => cloneMessage(message as Message)),
    tool_calls: normalizeToolCalls(safeProperty(turn, "tool_calls")).map(cloneToolCall),
    tool_results: safeArrayItems(safeProperty(turn, "tool_results"), MAX_RUNTIME_TOOL_RESULTS).map(result => cloneToolResult(result as ToolResult)).filter(result => result.tool_call_id && result.name),
    tokens_in: nonNegativeSafeInteger(safeProperty(turn, "tokens_in")),
    tokens_out: nonNegativeSafeInteger(safeProperty(turn, "tokens_out")),
    cost: nonNegativeFiniteNumber(safeProperty(turn, "cost")),
    duration_s: nonNegativeFiniteNumber(safeProperty(turn, "duration_s")),
    artifact_ids: cloneArtifactIds(safeProperty(turn, "artifact_ids") as string[] | undefined),
  };
}

function parseMessageRole(value: unknown): Message["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool" ? value : "user";
}

function loadJsonLines<T>(path: string, parseRecord: (value: unknown) => T | null): T[] {
  try {
    if (!isSafeExistingRuntimeDir(dirname(path))) return [];
    const text = readSafeRuntimeFile(path, MAX_RUNTIME_JSONL_BYTES);
    if (text === null) return [];
    const lines = text.split("\n").filter(Boolean).slice(-MAX_PERSISTED_RUNTIME_ROWS);
    const records: T[] = [];
    for (const line of lines) {
      try {
        const parsed = parseRecord(JSON.parse(line));
        if (parsed) records.push(parsed);
      } catch {
        // skip corrupt persisted lines without discarding the entire stream
      }
    }
    return records;
  } catch {
    return [];
  }
}

function loadEvents(threadId: string): RuntimeEvent[] {
  return loadJsonLines<RuntimeEvent>(eventPath(threadId), value => {
    const event = parseRuntimeEvent(value);
    return event?.thread_id === threadId ? event : null;
  });
}

function loadItems(threadId: string): RuntimeItem[] {
  return loadJsonLines<RuntimeItem>(itemPath(threadId), value => {
    const item = parseRuntimeItem(value);
    return item?.thread_id === threadId ? item : null;
  });
}

function persistRecord(record: RuntimeRecord): void {
  if (!isLiveRecord(record)) return;
  try {
    ensureSafeRuntimeDir(dataRoot());
    ensureSafeRuntimeDir(threadDir());
    const path = threadPath(record.thread.id);
    writeRuntimeFileAtomic(path, safeJsonStringify({
      config: record.config,
      session: record.session,
      thread: record.thread,
      turns: record.turns,
      ...(record.prefix ? { prefix: record.prefix.toJSON() } : {}),
    }, { space: 2 }), "runtime thread");
  } catch {
    // keep memory state even if persistence fails
  }
}

function persistEvent(event: RuntimeEvent): void {
  const record = records.get(event.thread_id);
  if (!record || record.deleted) return;
  try {
    ensureSafeRuntimeDir(dataRoot());
    ensureSafeRuntimeDir(eventDir());
    const path = eventPath(event.thread_id);
    assertSafeWriteTarget(path, "runtime event log");
    appendRuntimeLine(path, safeJsonStringify(event) + "\n", "runtime event log");
  } catch {
    // event remains in memory
  }
}

function persistItem(item: RuntimeItem): void {
  const record = records.get(item.thread_id);
  if (!record || record.deleted) return;
  try {
    ensureSafeRuntimeDir(dataRoot());
    ensureSafeRuntimeDir(itemDir());
    const path = itemPath(item.thread_id);
    assertSafeWriteTarget(path, "runtime item log");
    appendRuntimeLine(path, safeJsonStringify(item) + "\n", "runtime item log");
  } catch {
    // item remains in memory
  }
}

export function createRuntimeRecord(config: Config, session = createSession()): RuntimeRecord {
  ensureLoaded();
  normalizeLiveSession(session, config);
  const threadId = id("thr");
  const history = new ConversationHistory(session);
  const now = new Date().toISOString();
  const record: RuntimeRecord = {
    config,
    session,
    history,
    thread: {
      id: threadId,
      session_id: session.id,
      created_at: now,
      updated_at: now,
      model: session.model ?? config.model,
      mode: session.mode ?? config.mode,
      workspace: session.workspace_path ?? process.cwd(),
      archived: false,
    },
    turns: [],
    events: [],
    items: [],
  };
  records.set(threadId, record);
  persistRecord(record);
  appendEvent(record, "thread.started", { thread: record.thread });
  return record;
}

export function setRuntimePrefix(record: RuntimeRecord, prefix: ImmutablePrefix): void {
  record.prefix = prefix;
  persistRecord(record);
  appendEvent(record, "prefix.pinned", { prefix: prefix.metadata });
}

export function getRuntimeRecord(threadId: string): RuntimeRecord | undefined {
  ensureLoaded();
  return records.get(threadId);
}

export function getRuntimeRecordBySession(sessionId: string): RuntimeRecord | undefined {
  ensureLoaded();
  const safeSessionId = safeRuntimeId(sessionId);
  if (!safeSessionId) return undefined;
  return [...records.values()].find(record => record.session.id === safeSessionId);
}

export function listRuntimeRecords(): RuntimeRecord[] {
  ensureLoaded();
  return [...records.values()].sort((a, b) => b.thread.updated_at.localeCompare(a.thread.updated_at));
}

export function deleteRuntimeRecordBySession(sessionId: string): boolean {
  ensureLoaded();
  const record = getRuntimeRecordBySession(sessionId);
  if (!record) return false;
  record.deleted = true;
  record.activeTurn?.abortController.abort();
  record.abortController?.abort();
  records.delete(record.thread.id);
  eventSubscribers.delete(record.thread.id);
  try {
    removeRuntimeFile(threadPath(record.thread.id));
    removeRuntimeFile(eventPath(record.thread.id));
    removeRuntimeFile(itemPath(record.thread.id));
  } catch {
    // ignore cleanup failures
  }
  return true;
}

export function forkRuntimeThread(threadId: string): RuntimeRecord | undefined {
  ensureLoaded();
  const source = records.get(threadId);
  if (!source) return undefined;
  const now = new Date().toISOString();
  const sourceSession = source.session;
  const clonedSession = createSession(omitUndefined({
    title: safeProperty(sourceSession, "title") as string | undefined,
    mode: safeProperty(sourceSession, "mode") as string | undefined,
    model: safeProperty(sourceSession, "model") as string | undefined,
    workspace_path: safeProperty(sourceSession, "workspace_path") as string | undefined,
    cumulative_tokens_in: safeProperty(sourceSession, "cumulative_tokens_in") as number | undefined,
    cumulative_tokens_out: safeProperty(sourceSession, "cumulative_tokens_out") as number | undefined,
    cumulative_cost: safeProperty(sourceSession, "cumulative_cost") as number | undefined,
    prefix_hash: safeProperty(sourceSession, "prefix_hash") as string | undefined,
    id: id("ses"),
    created_at: now,
    updated_at: now,
    messages: safeArrayItems(safeProperty(sourceSession, "messages"), MAX_PERSISTED_RUNTIME_ROWS).map(message => cloneMessage(message as Message)),
    turns: safeArrayItems(safeProperty(sourceSession, "turns"), MAX_PERSISTED_RUNTIME_ROWS).map(turn => cloneTurn(turn as Turn)),
    artifact_index: parseArtifactIndex(safeProperty(sourceSession, "artifact_index")),
  }));
  const fork = createRuntimeRecord(cloneJson(source.config), clonedSession);
  if (source.prefix) fork.prefix = ImmutablePrefix.fromJSON(source.prefix.toJSON());
  fork.thread.model = source.thread.model;
  fork.thread.mode = source.thread.mode;
  fork.thread.workspace = source.thread.workspace;
  fork.thread.archived = false;
  persistRecord(fork);
  appendEvent(fork, "thread.forked", { from_thread_id: threadId, thread: fork.thread });
  return fork;
}

export function updateRuntimeThread(threadId: string, patch: Partial<Pick<RuntimeThread, "archived" | "mode" | "model" | "workspace">>): RuntimeThread | undefined {
  ensureLoaded();
  const record = records.get(threadId);
  if (!record) return undefined;
  const safePatch = normalizeThreadPatch(patch);
  if (!Object.keys(safePatch).length) return record.thread;
  Object.assign(record.thread, safePatch, { updated_at: new Date().toISOString() });
  if (safePatch.mode) {
    record.session.mode = safePatch.mode;
    record.config.mode = safePatch.mode as Config["mode"];
  }
  if (safePatch.model) {
    record.session.model = safePatch.model;
    record.config.model = safePatch.model;
  }
  if (safePatch.workspace) record.session.workspace_path = safePatch.workspace;
  persistRecord(record);
  appendEvent(record, "thread.updated", { thread: record.thread });
  return record.thread;
}

export function createTurn(record: RuntimeRecord, message: string): RuntimeTurn {
  const now = new Date().toISOString();
  const turn: RuntimeTurn = {
    id: id("turn"),
    thread_id: record.thread.id,
    status: "queued",
    message,
    created_at: now,
    updated_at: now,
    artifact_ids: [],
  };
  record.turns.push(turn);
  record.thread.latest_turn_id = turn.id;
  record.thread.updated_at = now;
  persistRecord(record);
  appendEvent(record, "turn.queued", { turn }, turn.id);
  return turn;
}

export function updateTurn(record: RuntimeRecord, turn: RuntimeTurn, status: TurnStatus, patch: Partial<RuntimeTurn> = {}): void {
  Object.assign(turn, normalizeTurnPatch(patch), { status, updated_at: new Date().toISOString() });
  record.thread.updated_at = turn.updated_at;
  persistRecord(record);
  appendEvent(record, `turn.${status}`, { turn }, turn.id);
}

export function appendEvent(record: RuntimeRecord, event: string, data: unknown, turnId?: string): RuntimeEvent {
  const safeData = boundedJsonData(data);
  const safeTurnId = turnId === undefined ? undefined : safeRuntimeId(turnId) ?? undefined;
  const runtimeEvent: RuntimeEvent = {
    seq: ++seq,
    thread_id: record.thread.id,
    event: safeEventName(event) ?? "runtime.event",
    data: safeData,
    created_at: new Date().toISOString(),
    ...(safeTurnId !== undefined ? { turn_id: safeTurnId } : {}),
  };
  if (!isLiveRecord(record)) return runtimeEvent;
  record.events.push(runtimeEvent);
  trimRuntimeRows(record.events);
  persistEvent(runtimeEvent);
  for (const subscriber of eventSubscribers.get(record.thread.id) ?? []) {
    Promise.resolve(subscriber(runtimeEvent)).catch(() => {
      // Drop subscriber errors; event persistence already succeeded.
    });
  }
  return runtimeEvent;
}

export function replayRuntimeEvents(threadId: string, sinceSeq = 0): RuntimeEvent[] {
  ensureLoaded();
  const minSeq = normalizeSinceSeq(sinceSeq);
  return (records.get(threadId)?.events ?? []).filter(event => event.seq > minSeq).map(cloneRuntimeEvent);
}

export function appendRuntimeItem(
  record: RuntimeRecord,
  type: string,
  data: unknown,
  options: { turnId?: string; artifactIds?: string[] } = {},
): RuntimeItem {
  const safeDataForArtifacts = safeJson(data);
  const safeData = boundJsonSafeData(safeDataForArtifacts);
  const itemType = safeItemType(type) ?? "unknown";
  const rawTurnId = safeProperty(options, "turnId");
  const safeTurnId = rawTurnId === undefined ? undefined : safeRuntimeId(rawTurnId) ?? undefined;
  const optionArtifactIds = artifactIdArray(safeProperty(options, "artifactIds"));
  const artifactIds = [...new Set([...optionArtifactIds, ...extractArtifactIds(safeDataForArtifacts)]
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim())
    .filter(isSafeArtifactId))]
    .slice(0, MAX_RUNTIME_ARTIFACT_IDS);
  const runtimeItem: RuntimeItem = {
    seq: ++seq,
    id: id("item"),
    thread_id: record.thread.id,
    type: itemType,
    data: safeData,
    artifact_ids: artifactIds,
    created_at: new Date().toISOString(),
    ...(safeTurnId !== undefined ? { turn_id: safeTurnId } : {}),
  };
  if (!isLiveRecord(record)) return runtimeItem;
  record.items.push(runtimeItem);
  trimRuntimeRows(record.items);
  if (safeTurnId && artifactIds.length) {
    const turn = record.turns.find(item => item.id === safeTurnId);
    if (turn) {
      turn.artifact_ids = [...new Set([...turn.artifact_ids, ...artifactIds])];
      persistRecord(record);
    }
  }
  for (const artifactId of artifactIds) {
    try {
      linkArtifact(artifactId, "session", record.session.id, { thread_id: record.thread.id, turn_id: safeTurnId, item_id: runtimeItem.id });
      if (safeTurnId) linkArtifact(artifactId, "turn", safeTurnId, { thread_id: record.thread.id, session_id: record.session.id, item_id: runtimeItem.id });
    } catch {
      // Replay item persistence should not fail because the artifact link index is unavailable.
    }
  }
  persistItem(runtimeItem);
  appendEvent(record, `item.${itemType}`, { item: runtimeItem }, safeTurnId);
  return runtimeItem;
}

function isLiveRecord(record: RuntimeRecord): boolean {
  return !record.deleted && records.get(record.thread.id) === record;
}

function trimRuntimeRows<T>(rows: T[]): void {
  const excess = rows.length - MAX_PERSISTED_RUNTIME_ROWS;
  if (excess > 0) rows.splice(0, excess);
}

export function replayRuntimeItems(threadId: string, sinceSeq = 0): RuntimeItem[] {
  ensureLoaded();
  const minSeq = normalizeSinceSeq(sinceSeq);
  return (records.get(threadId)?.items ?? []).filter(item => item.seq > minSeq).map(cloneRuntimeItem);
}

function cloneRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return {
    seq: finiteNonNegativeInteger(safeProperty(event, "seq")) ?? 0,
    thread_id: safeRuntimeId(safeProperty(event, "thread_id")) ?? "",
    event: safeEventName(safeProperty(event, "event")) ?? "runtime.event",
    data: cloneJson(safeProperty(event, "data")),
    created_at: optionalDateString(safeProperty(event, "created_at")) ?? "",
    ...(safeRuntimeId(safeProperty(event, "turn_id")) ? { turn_id: safeRuntimeId(safeProperty(event, "turn_id"))! } : {}),
  };
}

function cloneRuntimeItem(item: RuntimeItem): RuntimeItem {
  return {
    seq: finiteNonNegativeInteger(safeProperty(item, "seq")) ?? 0,
    id: safeRuntimeId(safeProperty(item, "id")) ?? "",
    thread_id: safeRuntimeId(safeProperty(item, "thread_id")) ?? "",
    type: safeItemType(safeProperty(item, "type")) ?? "unknown",
    data: cloneJson(safeProperty(item, "data")),
    artifact_ids: cloneArtifactIds(safeProperty(item, "artifact_ids") as string[] | undefined),
    created_at: optionalDateString(safeProperty(item, "created_at")) ?? "",
    ...(safeRuntimeId(safeProperty(item, "turn_id")) ? { turn_id: safeRuntimeId(safeProperty(item, "turn_id"))! } : {}),
  };
}

function removeRuntimeFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) rmSync(path, { force: true });
  } catch {
    // ignore cleanup failures
  }
}

export function subscribeRuntimeEvents(threadId: string, subscriber: RuntimeEventSubscriber): () => void {
  ensureLoaded();
  const safeThreadId = safeRuntimeId(threadId);
  if (!safeThreadId) return () => undefined;
  let subscribers = eventSubscribers.get(safeThreadId);
  if (!subscribers) {
    subscribers = new Set();
    eventSubscribers.set(safeThreadId, subscribers);
  }
  subscribers.add(subscriber);
  return () => {
    subscribers?.delete(subscriber);
    if (subscribers?.size === 0) eventSubscribers.delete(safeThreadId);
  };
}

export function clearRuntimeStoreForTests(): void {
  for (const record of records.values()) {
    record.deleted = true;
    record.activeTurn?.abortController.abort();
    record.abortController?.abort();
  }
  records.clear();
  eventSubscribers.clear();
  seq = 0;
  loaded = false;
  if (isSafeExistingRuntimeDir(dataRoot())) {
    try { rmSync(dataRoot(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function reloadRuntimeStoreForTests(): void {
  for (const record of records.values()) {
    record.deleted = true;
    record.activeTurn?.abortController.abort();
    record.abortController?.abort();
  }
  records.clear();
  eventSubscribers.clear();
  seq = 0;
  loaded = false;
}

function extractArtifactIds(value: unknown): string[] {
  const ids = new Set<string>();
  if (typeof value === "string") {
    for (const match of value.matchAll(/\b[a-zA-Z][a-zA-Z0-9._-]*_[a-z0-9]{6,}_[a-f0-9]{8,}\b/g)) {
      if (isSafeArtifactId(match[0])) ids.add(match[0]);
    }
    return [...ids];
  }
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    for (const item of safeArrayItems(value, MAX_RUNTIME_ARTIFACT_IDS)) for (const id of extractArtifactIds(item)) ids.add(id);
    return [...ids];
  }
  for (const [key, child] of safeObjectEntries(value, MAX_RUNTIME_ARTIFACT_IDS)) {
    if ((key === "artifact_id" || key === "artifactId") && typeof child === "string" && isSafeArtifactId(child.trim())) ids.add(child.trim());
    else for (const id of extractArtifactIds(child)) ids.add(id);
  }
  return [...ids];
}

function safeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function hasProperty(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  try {
    return key in value;
  } catch {
    return false;
  }
}

function safeArrayItems(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return [];
  }
  const limit = Number.isFinite(maxItems) ? Math.min(length, Math.max(0, Math.floor(maxItems))) : length;
  const items: unknown[] = [];
  for (let index = 0; index < limit; index++) {
    try {
      items.push(value[index]);
    } catch {
      // Skip unreadable array entries while preserving later valid records.
    }
  }
  return items;
}

function safeArrayItemsFromEnd(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return [];
  }
  const limit = Number.isFinite(maxItems) ? Math.min(length, Math.max(0, Math.floor(maxItems))) : length;
  const start = Math.max(0, length - limit);
  const items: unknown[] = [];
  for (let index = start; index < length; index++) {
    try {
      items.push(value[index]);
    } catch {
      // Skip unreadable array entries while preserving later valid records.
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
    const child = safeProperty(value, key);
    if (child !== undefined) entries.push([key, child]);
  }
  return entries;
}
