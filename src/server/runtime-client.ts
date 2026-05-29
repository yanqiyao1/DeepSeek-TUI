import { parseRuntimeSSEFrame, parseRuntimeSSEMessage, type RuntimeSSEMessage } from "./runtime-protocol.js";
import type { RuntimeEvent, RuntimeItem, RuntimeThread, RuntimeTurn } from "./runtime-store.js";
import { parseSSEFrames } from "./transport.js";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeTailTextBoundary } from "../utils/text-boundary.js";

type FetchLike = typeof fetch;
const MAX_RUNTIME_BASE_URL_CHARS = 8_192;
const MAX_RUNTIME_HEADER_ENTRIES = 64;
const MAX_RUNTIME_HEADER_NAME_CHARS = 128;
const MAX_RUNTIME_HEADER_VALUE_CHARS = 8_192;
const MAX_RUNTIME_ID_CHARS = 128;
const MAX_RUNTIME_MESSAGE_CHARS = 200_000;
const MAX_RUNTIME_JSON_CHARS = 2_000_000;
const MAX_RUNTIME_SSE_BUFFER_CHARS = 1_000_000;
const MAX_RUNTIME_SSE_CHUNK_CHARS = 256_000;
const MAX_RUNTIME_API_ARRAY_ITEMS = 1_000;
const MAX_RUNTIME_ARTIFACT_IDS = 100;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F]/;
const MESSAGE_CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const SAFE_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface RuntimeApiClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  headers?: Record<string, string>;
}

export interface RuntimeSessionCreated {
  session_id: string;
  thread_id: string;
  prefix_hash?: string;
}

export interface RuntimeThreadSnapshot {
  thread: RuntimeThread;
  turns: RuntimeTurn[];
  items: RuntimeItem[];
  session?: unknown;
  prefix?: unknown;
}

export class RuntimeApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;

  constructor(options: RuntimeApiClientOptions) {
    this.baseUrl = normalizeBaseUrl(safeProperty(options, "baseUrl"));
    const fetchImpl = safeProperty(options, "fetchImpl");
    this.fetchImpl = typeof fetchImpl === "function" ? fetchImpl as FetchLike : fetch;
    this.headers = normalizeHeaders(safeProperty(options, "headers"));
  }

  async createSession(): Promise<RuntimeSessionCreated> {
    return this.json<RuntimeSessionCreated>("/v1/session", { method: "POST" });
  }

  async getThread(threadId: string): Promise<RuntimeThreadSnapshot> {
    return this.json<RuntimeThreadSnapshot>(`/v1/threads/${encodeURIComponent(cleanId(threadId))}`);
  }

  async getThreadItems(threadId: string, sinceSeq = 0): Promise<RuntimeItem[]> {
    const response = await this.json<{ items?: unknown }>(`/v1/threads/${encodeURIComponent(cleanId(threadId))}/items?since_seq=${normalizeSeq(sinceSeq)}`);
    return safeArrayItems(safeProperty(response, "items"), MAX_RUNTIME_API_ARRAY_ITEMS)
      .map(parseRuntimeItem)
      .filter((item): item is RuntimeItem => !!item);
  }

  async getThreadEvents(threadId: string, sinceSeq = 0): Promise<RuntimeEvent[]> {
    const response = await this.json<{ events?: unknown }>(`/v1/threads/${encodeURIComponent(cleanId(threadId))}/events?since_seq=${normalizeSeq(sinceSeq)}`);
    return safeArrayItems(safeProperty(response, "events"), MAX_RUNTIME_API_ARRAY_ITEMS)
      .map(parseRuntimeEvent)
      .filter((event): event is RuntimeEvent => !!event);
  }

  async *streamThreadEvents(threadId: string, sinceSeq = 0, signal?: AbortSignal): AsyncGenerator<RuntimeEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/threads/${encodeURIComponent(cleanId(threadId))}/events?since_seq=${normalizeSeq(sinceSeq)}`, omitUndefined({
      headers: { ...this.headers, Accept: "text/event-stream" },
      signal,
    }));
    if (!response.ok) throw new Error(`Runtime events stream failed: HTTP ${response.status}`);
    if (!response.body) throw new Error("Runtime events stream has no body");
    for await (const frame of iterateSSEFrames(response.body)) {
      const event = parseRuntimeSSEFrame(frame);
      if (event) yield event;
    }
  }

  async *chat(sessionId: string, message: string, signal?: AbortSignal): AsyncGenerator<RuntimeSSEMessage> {
    const cleanMessage = cleanMessageText(message);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/session/${encodeURIComponent(cleanId(sessionId))}/chat`, omitUndefined({
      method: "POST" as const,
      headers: { ...this.headers, Accept: "text/event-stream", "Content-Type": "application/json" },
      body: safeJsonStringify({ message: cleanMessage }),
      signal,
    }));
    if (!response.ok) throw new Error(`Runtime chat stream failed: HTTP ${response.status}`);
    if (!response.body) throw new Error("Runtime chat stream has no body");
    for await (const frame of iterateSSEFrames(response.body)) {
      const event = parseRuntimeSSEMessage(frame);
      if (event) yield event;
    }
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) throw new Error(`Runtime API failed: HTTP ${response.status}`);
    try {
      const text = await response.text();
      if (text.length > MAX_RUNTIME_JSON_CHARS) throw new Error("response too large");
      return JSON.parse(text) as T;
    } catch (e: any) {
      throw new Error(`Runtime API returned invalid JSON: ${e?.message || String(e)}`);
    }
  }
}

async function* iterateSSEFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<ReturnType<typeof parseSSEFrames>["frames"][number]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (!value) continue;
      const decoded = decoder.decode(value, { stream: true });
      if (decoded.length > MAX_RUNTIME_SSE_CHUNK_CHARS) throw new Error("Runtime SSE chunk is too large");
      buffer = safeTailTextBoundary(buffer + decoded, MAX_RUNTIME_SSE_BUFFER_CHARS);
      const parsed = parseSSEFrames(buffer);
      buffer = parsed.remaining;
      for (const frame of parsed.frames) yield frame;
    }
    const tail = decoder.decode();
    if (tail.length > MAX_RUNTIME_SSE_CHUNK_CHARS) throw new Error("Runtime SSE chunk is too large");
    buffer += tail;
    const parsed = parseSSEFrames(buffer);
    for (const frame of parsed.frames) yield frame;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released by the underlying implementation.
    }
  }
}

function normalizeBaseUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error("Runtime API baseUrl is required");
  if (raw.length > MAX_RUNTIME_BASE_URL_CHARS || CONTROL_TEXT_RE.test(raw)) throw new Error("Runtime API baseUrl is invalid");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Runtime API baseUrl must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Runtime API baseUrl must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Runtime API baseUrl must not include credentials");
  }
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/+$/, "");
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of safeObjectEntries(headers, MAX_RUNTIME_HEADER_ENTRIES)) {
    const name = key.trim();
    if (!name || name.length > MAX_RUNTIME_HEADER_NAME_CHARS || !SAFE_HEADER_NAME_RE.test(name)) continue;
    if (typeof value !== "string" || value.length > MAX_RUNTIME_HEADER_VALUE_CHARS || /[\r\n]/.test(value)) continue;
    result[name] = value;
  }
  return result;
}

function normalizeSeq(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cleanId(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > MAX_RUNTIME_ID_CHARS || CONTROL_TEXT_RE.test(trimmed)) throw new Error("Runtime API id is invalid");
  return trimmed;
}

function cleanMessageText(value: string): string {
  if (typeof value !== "string") throw new Error("Runtime chat message must be a string");
  if (!value.trim()) throw new Error("Runtime chat message is required");
  if (value.length > MAX_RUNTIME_MESSAGE_CHARS || MESSAGE_CONTROL_TEXT_RE.test(value)) throw new Error("Runtime chat message is invalid");
  return value;
}

function parseRuntimeEvent(value: unknown): RuntimeEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seq = safeSeq(safeProperty(value, "seq"));
  const threadId = cleanOptionalId(safeProperty(value, "thread_id"));
  const event = cleanEventName(safeProperty(value, "event"));
  const rawCreatedAt = safeProperty(value, "created_at");
  const createdAt = typeof rawCreatedAt === "string" && rawCreatedAt.trim() ? rawCreatedAt : "";
  const rawTurnId = safeProperty(value, "turn_id");
  const turnId = rawTurnId === undefined || rawTurnId === null ? undefined : cleanOptionalId(rawTurnId);
  if (seq === null || !threadId || !event || turnId === null || !hasProperty(value, "data")) return null;
  return {
    seq,
    thread_id: threadId,
    event,
    data: safeProperty(value, "data"),
    created_at: createdAt,
    ...(turnId ? { turn_id: turnId } : {}),
  };
}

function parseRuntimeItem(value: unknown): RuntimeItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seq = safeSeq(safeProperty(value, "seq"));
  const id = cleanOptionalId(safeProperty(value, "id"));
  const threadId = cleanOptionalId(safeProperty(value, "thread_id"));
  const type = cleanEventName(safeProperty(value, "type"));
  const rawCreatedAt = safeProperty(value, "created_at");
  const createdAt = typeof rawCreatedAt === "string" && rawCreatedAt.trim() ? rawCreatedAt : "";
  const rawTurnId = safeProperty(value, "turn_id");
  const turnId = rawTurnId === undefined || rawTurnId === null ? undefined : cleanOptionalId(rawTurnId);
  if (seq === null || !id || !threadId || !type || turnId === null || !hasProperty(value, "data")) return null;
  return {
    seq,
    id,
    thread_id: threadId,
    type,
    data: safeProperty(value, "data"),
    artifact_ids: safeArtifactIds(safeProperty(value, "artifact_ids")),
    created_at: createdAt,
    ...(turnId ? { turn_id: turnId } : {}),
  };
}

function safeSeq(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cleanOptionalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return cleanId(value);
  } catch {
    return null;
  }
}

function cleanEventName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^[A-Za-z0-9_.:-]{1,160}$/.test(text) ? text : null;
}

function safeArtifactIds(value: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of safeArrayItems(value, MAX_RUNTIME_ARTIFACT_IDS)) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_RUNTIME_ARTIFACT_IDS) break;
  }
  return ids;
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
    length = Math.min(value.length, Math.max(0, maxItems));
  } catch {
    return [];
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index++) {
    try {
      items.push(value[index]);
    } catch {
      // Skip hostile array entries while keeping readable neighbors.
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
