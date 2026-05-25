/** Robust SSE transport with reconnect, liveness detection, and error handling.
 *
 * Adopted from claude-code-rev: supports SSE connection lifecycle with
 * exponential backoff, liveness timeouts, permanent error detection,
 * and keepalive handling.
 */

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_GIVE_UP_MS = 600_000; // 10 minutes
const LIVENESS_TIMEOUT_MS = 45_000;
const PERMANENT_HTTP_CODES = new Set([401, 403, 404]);
const MAX_SSE_BUFFER_CHARS = 1_000_000;
const MAX_SSE_FRAME_CHARS = 256_000;
const MAX_SSE_DATA_CHARS = 256_000;
const MAX_SSE_CHUNK_CHARS = 256_000;
const MAX_SSE_FRAMES_PER_PARSE = 1_000;
const MAX_SSE_FIELD_VALUE_CHARS = 8_192;
const MAX_SSE_URL_CHARS = 8_192;
const MAX_SSE_HEADERS = 64;
const MAX_SSE_HEADER_NAME_CHARS = 128;
const MAX_SSE_HEADER_VALUE_CHARS = 8_192;
const SAFE_SSE_FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SAFE_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F]/;

// ── Types ────────────────────────────────────────────────────

export type TransportState = "disconnected" | "connecting" | "connected" | "closed";

export interface TransportEvents {
  onMessage?: (data: string) => void;
  onStateChange?: (state: TransportState) => void;
  onError?: (error: Error) => void;
}

export interface SSETransportOptions {
  url: string;
  headers?: Record<string, string>;
  events?: TransportEvents;
  /** Reconnect on connection loss */
  autoReconnect?: boolean;
  /** Custom backoff function */
  getReconnectDelay?: (attempt: number) => number;
}

// ── SSE Frame Parser ─────────────────────────────────────────

export interface SSEFrame {
  event?: string;
  id?: string;
  data?: string;
}

/**
 * Incrementally parse SSE frames from a text buffer.
 * Returns parsed frames and the remaining buffer.
 */
export function parseSSEFrames(buffer: string): { frames: SSEFrame[]; remaining: string } {
  buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (buffer.length > MAX_SSE_BUFFER_CHARS) buffer = buffer.slice(-MAX_SSE_BUFFER_CHARS);
  const frames: SSEFrame[] = [];
  let pos = 0;

  while (frames.length < MAX_SSE_FRAMES_PER_PARSE) {
    const idx = buffer.indexOf("\n\n", pos);
    if (idx === -1) break;

    const rawFrame = buffer.slice(pos, idx);
    pos = idx + 2;
    if (!rawFrame.trim()) continue;
    if (rawFrame.length > MAX_SSE_FRAME_CHARS) continue;

    const frame: SSEFrame = {};
    let hasData = false;

    for (const line of rawFrame.split("\n")) {
      if (line.length > MAX_SSE_FRAME_CHARS) continue;
      if (line.startsWith(":")) {
        // keepalive comments are normal
        continue;
      }
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const field = line.slice(0, colonIdx).trim();
      if (!SAFE_SSE_FIELD_RE.test(field)) continue;
      let value = line.slice(colonIdx + 1);
      if (value.startsWith(" ")) value = value.slice(1); // trim single leading space
      if (/[\r\n]/.test(value) || CONTROL_TEXT_RE.test(value)) continue;

      if (field === "event") {
        if (value.length <= MAX_SSE_FIELD_VALUE_CHARS) frame.event = value;
      } else if (field === "id") {
        if (value.length <= MAX_SSE_FIELD_VALUE_CHARS) frame.id = value;
      }
      else if (field === "data") {
        frame.data = frame.data ? frame.data + "\n" + value : value;
        if (frame.data.length > MAX_SSE_DATA_CHARS) {
          frame.data = safeSlice(frame.data, MAX_SSE_DATA_CHARS);
        }
        hasData = true;
      }
    }

    if (hasData) {
      frames.push(frame);
    }
  }

  return { frames, remaining: buffer.slice(pos) };
}

// ── Reconnect utilities ──────────────────────────────────────

export function defaultReconnectDelay(attempt: number): number {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? Math.min(attempt, 30) : 0;
  // Exponential backoff with jitter
  const base = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, safeAttempt),
    RECONNECT_MAX_DELAY_MS,
  );
  const jitter = Math.random() * 1000;
  return base + jitter;
}

export function isPermanentError(statusCode: number): boolean {
  return PERMANENT_HTTP_CODES.has(statusCode);
}

// ── SSE Transport ────────────────────────────────────────────

export class SSETransport {
  readonly url: string;
  private headers: Record<string, string>;
  private events: TransportEvents;
  private autoReconnect: boolean;
  private getReconnectDelay: (attempt: number) => number;

  private state: TransportState = "disconnected";
  private abortController: AbortController | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionStart = 0;

  constructor(options: SSETransportOptions) {
    this.url = normalizeTransportUrl(options.url);
    this.headers = normalizeHeaders(options.headers);
    this.events = options.events ?? {};
    this.autoReconnect = options.autoReconnect !== false;
    this.getReconnectDelay = options.getReconnectDelay ?? defaultReconnectDelay;
  }

  get currentState(): TransportState {
    return this.state;
  }

  async connect(): Promise<void> {
    if (this.state === "connected") return;
    if (this.state === "connecting" && (this.abortController || this.reconnectTimer)) return;

    this.transition("connecting");
    this.connectionStart = Date.now();
    this.abortController = new AbortController();

    try {
      const response = await fetch(this.url, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...this.headers,
        },
        signal: this.abortController.signal,
      });

      // Permanent error — don't retry
      if (isPermanentError(response.status)) {
        this.transition("closed");
        this.events.onError?.(new Error(`SSE connection rejected: HTTP ${response.status}`));
        return;
      }

      if (!response.ok) {
        throw new Error(`SSE connection failed: HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("SSE response has no readable body");
      }

      this.transition("connected");
      this.reconnectAttempt = 0;
      this.resetLiveness();

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const decoded = decoder.decode(value, { stream: true });
        if (decoded.length > MAX_SSE_CHUNK_CHARS) throw new Error("SSE chunk is too large");
        if (decoded) this.resetLiveness();
        buffer += decoded;
        const { frames, remaining } = parseSSEFrames(buffer);
        buffer = remaining;

        for (const frame of frames) {
          if (frame.data !== undefined) {
            this.events.onMessage?.(frame.data);
          }
        }
      }

      const tail = decoder.decode();
      if (tail.length > MAX_SSE_CHUNK_CHARS) throw new Error("SSE chunk is too large");
      if (tail) {
        this.resetLiveness();
        buffer += tail;
        const { frames } = parseSSEFrames(buffer);
        for (const frame of frames) {
          if (frame.data !== undefined) this.events.onMessage?.(frame.data);
        }
      }

      this.clearLivenessTimer();
      this.abortController = null;
      if (this.state === "closed") return;
      if (this.autoReconnect) {
        this.scheduleReconnect();
      } else {
        this.transition("disconnected");
      }
    } catch (error: any) {
      if (error.name === "AbortError") {
        this.abortController = null;
        if (this.state !== "closed") this.transition("disconnected");
        return;
      }
      this.clearLivenessTimer();
      this.abortController = null;
      this.events.onError?.(error);

      // Attempt reconnect
      if (this.autoReconnect && this.state !== "closed") {
        this.scheduleReconnect();
      } else {
        this.transition("disconnected");
      }
    }
  }

  private resetLiveness(): void {
    this.clearLivenessTimer();
    this.livenessTimer = setTimeout(() => {
      // No data received within liveness window — reconnect
      this.events.onError?.(new Error("SSE liveness timeout"));
      const shouldReconnect = this.autoReconnect;
      this.dropConnection();
      if (shouldReconnect) {
        this.scheduleReconnect();
      }
    }, LIVENESS_TIMEOUT_MS);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const elapsed = Date.now() - this.connectionStart;
    if (elapsed > RECONNECT_GIVE_UP_MS) {
      this.transition("closed");
      this.events.onError?.(new Error("SSE reconnect give-up time reached"));
      return;
    }

    const rawDelay = this.getReconnectDelay(this.reconnectAttempt++);
    const delay = Number.isFinite(rawDelay) && rawDelay >= 0 ? Math.min(rawDelay, RECONNECT_MAX_DELAY_MS) : RECONNECT_BASE_DELAY_MS;
    this.transition("connecting");
    this.reconnectTimer = setTimeout(() => {
      if (this.state === "closed") return;
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private dropConnection(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearLivenessTimer();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.transition("disconnected");
  }

  disconnect(): void {
    this.dropConnection();
    this.autoReconnect = false;
  }

  close(): void {
    this.disconnect();
    this.transition("closed");
  }

  private transition(newState: TransportState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.events.onStateChange?.(newState);
    }
  }
}

function normalizeTransportUrl(value: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error("SSE URL is required");
  if (raw.length > MAX_SSE_URL_CHARS || CONTROL_TEXT_RE.test(raw)) throw new Error("SSE URL is invalid");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SSE URL must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("SSE URL must use http or https");
  if (url.username || url.password) throw new Error("SSE URL must not include credentials");
  url.hash = "";
  return url.href;
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {}).slice(0, MAX_SSE_HEADERS)) {
    const name = key.trim();
    if (!name || name.length > MAX_SSE_HEADER_NAME_CHARS || !SAFE_HEADER_NAME_RE.test(name)) continue;
    if (typeof value !== "string" || value.length > MAX_SSE_HEADER_VALUE_CHARS || /[\r\n]/.test(value)) continue;
    normalized[name] = value;
  }
  return normalized;
}

function safeSlice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, Math.floor(maxChars));
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return text.slice(0, end);
}
