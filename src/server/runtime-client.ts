import { parseRuntimeSSEFrame, parseRuntimeSSEMessage, type RuntimeSSEMessage } from "./runtime-protocol.js";
import type { RuntimeEvent, RuntimeItem, RuntimeThread, RuntimeTurn } from "./runtime-store.js";
import { parseSSEFrames } from "./transport.js";
import { omitUndefined } from "../utils/object.js";

type FetchLike = typeof fetch;

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
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
  }

  async createSession(): Promise<RuntimeSessionCreated> {
    return this.json<RuntimeSessionCreated>("/v1/session", { method: "POST" });
  }

  async getThread(threadId: string): Promise<RuntimeThreadSnapshot> {
    return this.json<RuntimeThreadSnapshot>(`/v1/threads/${encodeURIComponent(threadId)}`);
  }

  async getThreadItems(threadId: string, sinceSeq = 0): Promise<RuntimeItem[]> {
    const response = await this.json<{ items: RuntimeItem[] }>(`/v1/threads/${encodeURIComponent(threadId)}/items?since_seq=${Math.max(0, Math.floor(sinceSeq))}`);
    return response.items ?? [];
  }

  async getThreadEvents(threadId: string, sinceSeq = 0): Promise<RuntimeEvent[]> {
    const response = await this.json<{ events: RuntimeEvent[] }>(`/v1/threads/${encodeURIComponent(threadId)}/events?since_seq=${Math.max(0, Math.floor(sinceSeq))}`);
    return response.events ?? [];
  }

  async *streamThreadEvents(threadId: string, sinceSeq = 0, signal?: AbortSignal): AsyncGenerator<RuntimeEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/threads/${encodeURIComponent(threadId)}/events?since_seq=${Math.max(0, Math.floor(sinceSeq))}`, omitUndefined({
      headers: { ...this.headers, Accept: "text/event-stream" },
      signal,
    }));
    if (!response.ok) throw new Error(`Runtime events stream failed: HTTP ${response.status}`);
    if (!response.body) throw new Error("Runtime events stream has no body");
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const parsed = parseSSEFrames(buffer);
      buffer = parsed.remaining;
      for (const frame of parsed.frames) {
        const event = parseRuntimeSSEFrame(frame);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const parsed = parseSSEFrames(buffer);
    for (const frame of parsed.frames) {
      const event = parseRuntimeSSEFrame(frame);
      if (event) yield event;
    }
  }

  async *chat(sessionId: string, message: string, signal?: AbortSignal): AsyncGenerator<RuntimeSSEMessage> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/session/${encodeURIComponent(sessionId)}/chat`, omitUndefined({
      method: "POST" as const,
      headers: { ...this.headers, Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal,
    }));
    if (!response.ok) throw new Error(`Runtime chat stream failed: HTTP ${response.status}`);
    if (!response.body) throw new Error("Runtime chat stream has no body");
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const parsed = parseSSEFrames(buffer);
      buffer = parsed.remaining;
      for (const frame of parsed.frames) {
        const event = parseRuntimeSSEMessage(frame);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const parsed = parseSSEFrames(buffer);
    for (const frame of parsed.frames) {
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
    return response.json() as Promise<T>;
  }
}
