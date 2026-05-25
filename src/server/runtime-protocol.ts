import type { EngineRuntimeEvent } from "../engine/events.js";
import type { RuntimeEvent } from "./runtime-store.js";
import { safeJsonStringify, toJsonSafe } from "../utils/json-safe.js";

export interface RuntimeSSEMessage {
  event: string;
  data: unknown;
}

export interface RuntimeSSEFrameLike {
  event?: string;
  id?: string;
  data?: string;
}

const SAFE_EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const SAFE_TOOL_CALL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const MAX_RUNTIME_FRAME_DATA_CHARS = 1_000_000;
const MAX_RUNTIME_TEXT_CHARS = 200_000;
const MAX_RUNTIME_RENDERED_CHARS = 200_000;
const MAX_RUNTIME_EVENT_JSON_CHARS = 2_000_000;
const MAX_RUNTIME_PROGRESS_DATA_CHARS = 500_000;
const MAX_RUNTIME_ARTIFACT_IDS = 100;
const MAX_RUNTIME_ARTIFACT_ID_CHARS = 160;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function isSpeculativeRuntimeEvent(event: EngineRuntimeEvent): boolean {
  return event.type === "api_call_start"
    || event.type === "thinking_delta"
    || event.type === "content_delta"
    || event.type === "tool_call_begin";
}

export function runtimeEventToSSE(
  event: EngineRuntimeEvent,
  streamedToolCalls: Set<string>,
): RuntimeSSEMessage | null {
  switch (event.type) {
    case "thinking_delta":
      return { event: "thinking", data: textDeltaData(event.data) };
    case "content_delta":
      return { event: "content", data: textDeltaData(event.data) };
    case "tool_call_begin": {
      const name = safeToolName(event.data.name);
      if (!name) return null;
      const toolCallId = safeToolCallId(event.data.tool_call_id);
      const key = toolCallId || name;
      streamedToolCalls.add(key);
      return { event: "tool_call", data: { name, ...(toolCallId ? { tool_call_id: toolCallId } : {}) } };
    }
    case "tool_call": {
      const name = safeToolName(event.data.name);
      if (!name) return null;
      const toolCallId = safeToolCallId(event.data.id);
      const key = toolCallId || name;
      if (key && streamedToolCalls.has(key)) return null;
      if (key) streamedToolCalls.add(key);
      return { event: "tool_call", data: { name, ...(toolCallId ? { tool_call_id: toolCallId } : {}) } };
    }
    case "tool_result": {
      const name = safeToolName(event.data.name);
      if (!name) return null;
      return {
        event: "tool_result",
        data: {
          name,
          preview: safeText(event.preview, MAX_RUNTIME_RENDERED_CHARS),
          artifact_ids: safeArtifactIds(event.artifact_ids),
        },
      };
    }
    case "tool_progress":
      return toolProgressData(event.data);
    case "context_intervention":
      return { event: "context_intervention", data: safeFrameData(event.data) };
    case "prefix_invalidated":
      return { event: "prefix_invalidated", data: safeFrameData(event.data) };
    default:
      return null;
  }
}

export function parseRuntimeSSEFrame(frame: RuntimeSSEFrameLike): RuntimeEvent | null {
  if (!frame.data) return null;
  const parsed = parseJson(frame.data);
  if (!isRecord(parsed)) return null;
  if ("seq" in parsed || "thread_id" in parsed || "turn_id" in parsed || "created_at" in parsed) {
    if (typeof parsed.seq !== "number" || typeof parsed.event !== "string" || !("data" in parsed)) return null;
    if (!Number.isSafeInteger(parsed.seq) || parsed.seq < 0) return null;
    const event = safeEventName(parsed.event);
    if (!event) return null;
    if (parsed.thread_id === undefined || parsed.thread_id === null) return null;
    const threadId = optionalSafeId(parsed.thread_id);
    const turnId = optionalSafeId(parsed.turn_id);
    if (!threadId || turnId === undefined) return null;
    if (parsed.created_at !== undefined && !safeDateString(parsed.created_at)) return null;
    return {
      seq: parsed.seq,
      thread_id: threadId,
      event,
      data: safeFrameData(parsed.data),
      created_at: typeof parsed.created_at === "string" ? parsed.created_at.trim() : "",
      ...(turnId !== null ? { turn_id: turnId } : {}),
    };
  }
  const event = safeEventName(frame.event) ?? "message";
  const seq = parseFrameId(frame.id);
  return {
    seq,
    thread_id: "",
    event,
    data: safeFrameData(parsed),
    created_at: "",
  };
}

export function parseRuntimeSSEMessage(frame: RuntimeSSEFrameLike): RuntimeSSEMessage | null {
  const event = safeEventName(frame.event);
  if (!event || !frame.data) return null;
  return { event, data: safeFrameData(parseJson(frame.data)) };
}

function parseJson(value: string): unknown {
  if (typeof value !== "string" || value.length > MAX_RUNTIME_EVENT_JSON_CHARS) return { truncated: true };
  try {
    return JSON.parse(value);
  } catch {
    return safeText(value, MAX_RUNTIME_TEXT_CHARS);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeEventName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const event = value.trim();
  return SAFE_EVENT_NAME_RE.test(event) ? event : null;
}

function optionalSafeId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : undefined;
}

function safeDateString(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
  return Number.isFinite(Date.parse(value));
}

function parseFrameId(value: unknown): number {
  if (typeof value !== "string") return 0;
  const id = value.trim();
  if (!/^\d+$/.test(id)) return 0;
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function safeFrameData(value: unknown): unknown {
  let safe: unknown;
  try {
    safe = toJsonSafe(value);
  } catch {
    return { truncated: true };
  }
  try {
    return safeJsonStringify(safe).length <= MAX_RUNTIME_FRAME_DATA_CHARS ? safe : { truncated: true };
  } catch {
    return { truncated: true };
  }
}

function safeProgressData(value: unknown): unknown {
  let safe: unknown;
  try {
    safe = toJsonSafe(value);
  } catch {
    return { truncated: true };
  }
  try {
    return safeJsonStringify(safe).length <= MAX_RUNTIME_PROGRESS_DATA_CHARS ? safe : { truncated: true };
  } catch {
    return { truncated: true };
  }
}

function safeText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.replace(CONTROL_TEXT_GLOBAL_RE, " ").slice(0, maxChars) : "";
}

function textDeltaData(value: unknown): Record<string, string> {
  const data = isRecord(value) ? value : {};
  const text = safeText(data.text, MAX_RUNTIME_TEXT_CHARS);
  return { text };
}

function safeToolCallId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return SAFE_TOOL_CALL_ID_RE.test(id) ? id : null;
}

function safeToolName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return SAFE_TOOL_NAME_RE.test(name) ? name : null;
}

function safeArtifactIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = safeToolCallId(item);
    if (!id || id.length > MAX_RUNTIME_ARTIFACT_ID_CHARS || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_RUNTIME_ARTIFACT_IDS) break;
  }
  return ids;
}

function toolProgressData(value: unknown): RuntimeSSEMessage | null {
  if (!isRecord(value)) return null;
  const tool = safeToolName(value.tool);
  if (!tool) return null;
  const toolCallId = safeToolCallId(value.tool_call_id);
  const progress = isRecord(value.progress) ? value.progress : {};
  const percent = typeof progress.percent === "number" && Number.isFinite(progress.percent) && progress.percent >= 0 && progress.percent <= 100
    ? progress.percent
    : undefined;
  return {
    event: "tool_progress",
    data: {
      tool,
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      progress: {
        ...(safeText(progress.message, MAX_RUNTIME_TEXT_CHARS) ? { message: safeText(progress.message, MAX_RUNTIME_TEXT_CHARS) } : {}),
        ...(percent !== undefined ? { percent } : {}),
        ...("data" in progress ? { data: safeProgressData(progress.data) } : {}),
      },
    },
  };
}
