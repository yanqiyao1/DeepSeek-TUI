import { parseRuntimeSSEFrame, parseRuntimeSSEMessage, type RuntimeSSEMessage } from "./runtime-protocol.js";
import type { RuntimeEvent, RuntimeItem, RuntimeThread, RuntimeTurn } from "./runtime-store.js";
import { parseSSEFrames } from "./transport.js";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify } from "../utils/json-safe.js";

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
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = normalizeHeaders(options.headers);
  }

  async createSession(): Promise<RuntimeSessionCreated> {
    return this.json<RuntimeSessionCreated>("/v1/session", { method: "POST" });
  }

  async getThread(threadId: string): Promise<RuntimeThreadSnapshot> {
    return this.json<RuntimeThreadSnapshot>(`/v1/threads/${encodeURIComponent(cleanId(threadId))}`);
  }

  async getThreadItems(threadId: string, sinceSeq = 0): Promise<RuntimeItem[]> {
    const response = await this.json<{ items?: unknown }>(`/v1/threads/${encodeURIComponent(cleanId(threadId))}/items?since_seq=${normalizeSeq(sinceSeq)}`);
    return Array.isArray(response.items) ? response.items.map(parseRuntimeItem).filter((item): item is RuntimeItem => !!item) : [];
  }

  async getThreadEvents(threadId: string, sinceSeq = 0): Promise<RuntimeEvent[]> {
    const response = await this.json<{ events?: unknown }>(`/v1/threads/${encodeURIComponent(cleanId(threadId))}/events?since_seq=${normalizeSeq(sinceSeq)}`);
    return Array.isArray(response.events) ? response.events.map(parseRuntimeEvent).filter((event): event is RuntimeEvent => !!event) : [];
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
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    const decoded = decoder.decode(chunk, { stream: true });
  if (decoded.length > MAX_RUNTIME_SSE_CHUNK_CHARS) throw new Error("Runtime SSE chunk is too large");
    buffer = (buffer + decoded).slice(-MAX_RUNTIME_SSE_BUFFER_CHARS);
    const parsed = parseSSEFrames(buffer);
    buffer = parsed.remaining;
    for (const frame of parsed.frames) yield frame;
  }
  const tail = decoder.decode();
  if (tail.length > MAX_RUNTIME_SSE_CHUNK_CHARS) throw new Error("Runtime SSE chunk is too large");
  buffer += tail;
  const parsed = parseSSEFrames(buffer);
  for (const frame of parsed.frames) yield frame;
}

function normalizeBaseUrl(value: string): string {
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

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {}).slice(0, MAX_RUNTIME_HEADER_ENTRIES)) {
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
  const record = value as Record<string, unknown>;
  const seq = safeSeq(record.seq);
  const threadId = cleanOptionalId(record.thread_id);
  const event = cleanEventName(record.event);
  const createdAt = typeof record.created_at === "string" && record.created_at.trim() ? record.created_at : "";
  const turnId = record.turn_id === undefined || record.turn_id === null ? undefined : cleanOptionalId(record.turn_id);
  if (seq === null || !threadId || !event || turnId === null || !("data" in record)) return null;
  return {
    seq,
    thread_id: threadId,
    event,
    data: record.data,
    created_at: createdAt,
    ...(turnId ? { turn_id: turnId } : {}),
  };
}

function parseRuntimeItem(value: unknown): RuntimeItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const seq = safeSeq(record.seq);
  const id = cleanOptionalId(record.id);
  const threadId = cleanOptionalId(record.thread_id);
  const type = cleanEventName(record.type);
  const createdAt = typeof record.created_at === "string" && record.created_at.trim() ? record.created_at : "";
  const turnId = record.turn_id === undefined || record.turn_id === null ? undefined : cleanOptionalId(record.turn_id);
  if (seq === null || !id || !threadId || !type || turnId === null || !("data" in record)) return null;
  return {
    seq,
    id,
    thread_id: threadId,
    type,
    data: record.data,
    artifact_ids: Array.isArray(record.artifact_ids)
      ? [...new Set(record.artifact_ids.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim()))].slice(0, 100)
      : [],
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
