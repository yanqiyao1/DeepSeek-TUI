/** Persistent runtime thread/turn/event store for HTTP/SSE API. */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSession, type Message, type Session, type ToolCall, type ToolResult, type Turn } from "../session/types.js";
import { ConversationHistory } from "../session/history.js";
import type { Config } from "../config.js";
import type { Engine } from "../engine/loop.js";
import { ImmutablePrefix, type SerializedImmutablePrefix } from "../engine/prefix.js";
import { linkArtifact } from "../artifacts/store.js";
import { seekcodeDataPath } from "../paths.js";

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
  abortController?: AbortController;
  activeEngine?: Engine;
}

type RuntimeEventSubscriber = (event: RuntimeEvent) => void | Promise<void>;

const records = new Map<string, RuntimeRecord>();
const eventSubscribers = new Map<string, Set<RuntimeEventSubscriber>>();
let seq = 0;
let loaded = false;

function dataRoot(): string {
  if (process.env.SEEKCODE_RUNTIME_DIR) return resolve(process.env.SEEKCODE_RUNTIME_DIR);
  if (process.env.DEEPCODE_RUNTIME_DIR) return resolve(process.env.DEEPCODE_RUNTIME_DIR);
  if (process.env.DEEPSEEK_RUNTIME_DIR) return resolve(process.env.DEEPSEEK_RUNTIME_DIR);
  return seekcodeDataPath("runtime");
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
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128);
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    mkdirSync(threadDir(), { recursive: true });
    mkdirSync(eventDir(), { recursive: true });
    for (const file of readdirSync(threadDir()).filter(name => name.endsWith(".json"))) {
      try {
        const raw = parsePersistedRuntimeRecord(JSON.parse(readFileSync(join(threadDir(), file), "utf-8")));
        if (!raw) continue;
        const history = new ConversationHistory(raw.session);
        const interruptedTurns: RuntimeTurn[] = [];
        for (const turn of raw.turns || []) {
          if (turn.status === "queued" || turn.status === "in_progress") {
            turn.status = "interrupted";
            turn.error = "Interrupted by process restart";
            turn.updated_at = new Date().toISOString();
            turn.interrupted_at = turn.updated_at;
            raw.thread.updated_at = turn.updated_at;
            interruptedTurns.push(turn);
          }
        }
        const events = loadEvents(raw.thread.id);
        const items = loadItems(raw.thread.id);
        for (const event of events) seq = Math.max(seq, event.seq);
        for (const item of items) seq = Math.max(seq, item.seq);
        const record: RuntimeRecord = {
          config: raw.config,
          session: raw.session,
          history,
          thread: raw.thread,
          turns: (raw.turns || []).map(turn => ({ ...turn, artifact_ids: turn.artifact_ids || [] })),
          events,
          items,
          prefix: raw.prefix ? ImmutablePrefix.fromJSON(raw.prefix) : undefined,
        };
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
  const record = value as Record<string, unknown>;
  const config = record.config && typeof record.config === "object" && !Array.isArray(record.config)
    ? record.config as Config
    : null;
  const session = record.session && typeof record.session === "object" && !Array.isArray(record.session)
    ? record.session as Session
    : null;
  const thread = parseRuntimeThread(record.thread);
  const turns = parseRuntimeTurns(record.turns);
  const prefix = record.prefix && typeof record.prefix === "object" && !Array.isArray(record.prefix)
    ? record.prefix as SerializedImmutablePrefix
    : undefined;

  if (!config || !session || !thread || !turns) return null;
  return { config, session, thread, turns, ...(prefix ? { prefix } : {}) };
}

function parseRuntimeThread(value: unknown): RuntimeThread | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = nonEmptyString(record.id);
  const sessionId = nonEmptyString(record.session_id);
  const createdAt = nonEmptyString(record.created_at);
  const updatedAt = nonEmptyString(record.updated_at);
  const model = nonEmptyString(record.model);
  const mode = nonEmptyString(record.mode);
  const workspace = nonEmptyString(record.workspace);
  const archived = typeof record.archived === "boolean" ? record.archived : null;
  const latestTurnId = optionalString(record.latest_turn_id);
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
  for (const item of value) {
    const turn = parseRuntimeTurn(item);
    if (!turn) return null;
    turns.push(turn);
  }
  return turns;
}

function parseRuntimeTurn(value: unknown): RuntimeTurn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = nonEmptyString(record.id);
  const threadId = nonEmptyString(record.thread_id);
  const status = typeof record.status === "string" ? record.status : null;
  const message = typeof record.message === "string" ? record.message : "";
  const createdAt = nonEmptyString(record.created_at);
  const updatedAt = nonEmptyString(record.updated_at);
  const artifactIds = stringArray(record.artifact_ids);
  const error = optionalString(record.error);
  const interruptedAt = optionalString(record.interrupted_at);
  const resumedFromTurnId = optionalString(record.resumed_from_turn_id);
  const usage = record.usage === undefined || record.usage === null
    ? null
    : (record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
        ? record.usage as Record<string, unknown>
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
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function parseRuntimeEvent(value: unknown): RuntimeEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const seq = finiteNonNegativeInteger(record.seq);
  const threadId = nonEmptyString(record.thread_id);
  const event = nonEmptyString(record.event);
  const createdAt = nonEmptyString(record.created_at);
  const turnId = optionalString(record.turn_id);
  if (seq === null || !threadId || !event || !createdAt || turnId === undefined || !("data" in record)) return null;
  return {
    seq,
    thread_id: threadId,
    event,
    data: record.data,
    created_at: createdAt,
    ...(turnId !== null ? { turn_id: turnId } : {}),
  };
}

function parseRuntimeItem(value: unknown): RuntimeItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const seq = finiteNonNegativeInteger(record.seq);
  const id = nonEmptyString(record.id);
  const threadId = nonEmptyString(record.thread_id);
  const type = nonEmptyString(record.type);
  const createdAt = nonEmptyString(record.created_at);
  const turnId = optionalString(record.turn_id);
  if (seq === null || !id || !threadId || !type || !createdAt || turnId === undefined || !("data" in record)) return null;
  return {
    seq,
    id,
    thread_id: threadId,
    type,
    data: record.data,
    artifact_ids: stringArray(record.artifact_ids),
    created_at: createdAt,
    ...(turnId !== null ? { turn_id: turnId } : {}),
  };
}

function finiteNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: cloneJson(toolCall.arguments || {}),
  };
}

function cloneToolResult(toolResult: ToolResult): ToolResult {
  return { ...toolResult };
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    tool_calls: message.tool_calls?.map(cloneToolCall) ?? null,
  };
}

function cloneTurn(turn: Turn): Turn {
  return {
    ...turn,
    assistant_messages: turn.assistant_messages.map(cloneMessage),
    tool_calls: turn.tool_calls.map(cloneToolCall),
    tool_results: turn.tool_results.map(cloneToolResult),
    artifact_ids: [...(turn.artifact_ids || [])],
  };
}

function loadJsonLines<T>(path: string, parseRecord: (value: unknown) => T | null): T[] {
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
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
  try {
    mkdirSync(threadDir(), { recursive: true });
    writeFileSync(threadPath(record.thread.id), JSON.stringify({
      config: record.config,
      session: record.session,
      thread: record.thread,
      turns: record.turns,
      prefix: record.prefix?.toJSON(),
    }, null, 2), "utf-8");
  } catch {
    // keep memory state even if persistence fails
  }
}

function persistEvent(event: RuntimeEvent): void {
  try {
    mkdirSync(eventDir(), { recursive: true });
    writeFileSync(eventPath(event.thread_id), JSON.stringify(event) + "\n", { encoding: "utf-8", flag: "a" });
  } catch {
    // event remains in memory
  }
}

function persistItem(item: RuntimeItem): void {
  try {
    mkdirSync(itemDir(), { recursive: true });
    writeFileSync(itemPath(item.thread_id), JSON.stringify(item) + "\n", { encoding: "utf-8", flag: "a" });
  } catch {
    // item remains in memory
  }
}

export function createRuntimeRecord(config: Config, session = createSession()): RuntimeRecord {
  ensureLoaded();
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
      model: session.model || config.model,
      mode: session.mode || config.mode,
      workspace: session.workspace_path || process.cwd(),
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
  return [...records.values()].find(record => record.session.id === sessionId);
}

export function listRuntimeRecords(): RuntimeRecord[] {
  ensureLoaded();
  return [...records.values()].sort((a, b) => b.thread.updated_at.localeCompare(a.thread.updated_at));
}

export function deleteRuntimeRecordBySession(sessionId: string): boolean {
  ensureLoaded();
  const record = getRuntimeRecordBySession(sessionId);
  if (!record) return false;
  record.abortController?.abort();
  records.delete(record.thread.id);
  eventSubscribers.delete(record.thread.id);
  try {
    rmSync(threadPath(record.thread.id), { force: true });
    rmSync(eventPath(record.thread.id), { force: true });
    rmSync(itemPath(record.thread.id), { force: true });
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
  const clonedSession = createSession({
    ...source.session,
    id: id("ses"),
    created_at: now,
    updated_at: now,
    messages: source.session.messages.map(cloneMessage),
    turns: source.session.turns.map(cloneTurn),
    artifact_index: cloneJson(source.session.artifact_index || {}),
  });
  const fork = createRuntimeRecord(source.config, clonedSession);
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
  Object.assign(record.thread, patch, { updated_at: new Date().toISOString() });
  if (patch.mode) {
    record.session.mode = patch.mode;
    record.config.mode = patch.mode as Config["mode"];
  }
  if (patch.model) {
    record.session.model = patch.model;
    record.config.model = patch.model;
  }
  if (patch.workspace) record.session.workspace_path = patch.workspace;
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
  Object.assign(turn, patch, { status, updated_at: new Date().toISOString() });
  record.thread.updated_at = turn.updated_at;
  persistRecord(record);
  appendEvent(record, `turn.${status}`, { turn }, turn.id);
}

export function appendEvent(record: RuntimeRecord, event: string, data: unknown, turnId?: string): RuntimeEvent {
  const runtimeEvent: RuntimeEvent = {
    seq: ++seq,
    thread_id: record.thread.id,
    turn_id: turnId,
    event,
    data,
    created_at: new Date().toISOString(),
  };
  record.events.push(runtimeEvent);
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
  return (records.get(threadId)?.events || []).filter(event => event.seq > sinceSeq);
}

export function appendRuntimeItem(
  record: RuntimeRecord,
  type: string,
  data: unknown,
  options: { turnId?: string; artifactIds?: string[] } = {},
): RuntimeItem {
  const artifactIds = [...new Set([...(options.artifactIds || []), ...extractArtifactIds(data)])];
  const runtimeItem: RuntimeItem = {
    seq: ++seq,
    id: id("item"),
    thread_id: record.thread.id,
    turn_id: options.turnId,
    type,
    data,
    artifact_ids: artifactIds,
    created_at: new Date().toISOString(),
  };
  record.items.push(runtimeItem);
  if (options.turnId && artifactIds.length) {
    const turn = record.turns.find(item => item.id === options.turnId);
    if (turn) {
      turn.artifact_ids = [...new Set([...(turn.artifact_ids || []), ...artifactIds])];
      persistRecord(record);
    }
  }
  for (const artifactId of artifactIds) {
    linkArtifact(artifactId, "session", record.session.id, { thread_id: record.thread.id, turn_id: options.turnId, item_id: runtimeItem.id });
    if (options.turnId) linkArtifact(artifactId, "turn", options.turnId, { thread_id: record.thread.id, session_id: record.session.id, item_id: runtimeItem.id });
  }
  persistItem(runtimeItem);
  appendEvent(record, `item.${type}`, { item: runtimeItem }, options.turnId);
  return runtimeItem;
}

export function replayRuntimeItems(threadId: string, sinceSeq = 0): RuntimeItem[] {
  ensureLoaded();
  return (records.get(threadId)?.items || []).filter(item => item.seq > sinceSeq);
}

export function subscribeRuntimeEvents(threadId: string, subscriber: RuntimeEventSubscriber): () => void {
  ensureLoaded();
  let subscribers = eventSubscribers.get(threadId);
  if (!subscribers) {
    subscribers = new Set();
    eventSubscribers.set(threadId, subscribers);
  }
  subscribers.add(subscriber);
  return () => {
    subscribers?.delete(subscriber);
    if (subscribers?.size === 0) eventSubscribers.delete(threadId);
  };
}

export function clearRuntimeStoreForTests(): void {
  for (const record of records.values()) record.abortController?.abort();
  records.clear();
  eventSubscribers.clear();
  seq = 0;
  loaded = false;
  try { rmSync(dataRoot(), { recursive: true, force: true }); } catch { /* ignore */ }
}

export function reloadRuntimeStoreForTests(): void {
  for (const record of records.values()) record.abortController?.abort();
  records.clear();
  eventSubscribers.clear();
  seq = 0;
  loaded = false;
}

function extractArtifactIds(value: unknown): string[] {
  const ids = new Set<string>();
  if (typeof value === "string") {
    for (const match of value.matchAll(/\b[a-zA-Z][a-zA-Z0-9._-]*_[a-z0-9]{6,}_[a-f0-9]{8,}\b/g)) ids.add(match[0]);
    return [...ids];
  }
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    for (const item of value) for (const id of extractArtifactIds(item)) ids.add(id);
    return [...ids];
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "artifact_id" || key === "artifactId") && typeof child === "string") ids.add(child);
    else for (const id of extractArtifactIds(child)) ids.add(id);
  }
  return [...ids];
}
