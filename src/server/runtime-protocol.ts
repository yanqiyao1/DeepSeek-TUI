import type { EngineRuntimeEvent } from "../engine/events.js";
import type { RuntimeEvent } from "./runtime-store.js";
import { safeJsonStringify, toJsonSafe } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

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
const MAX_RUNTIME_ARTIFACT_ID_SCAN = 500;
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
  const frameData = safeProperty(frame, "data");
  if (!frameData) return null;
  const parsed = parseJson(frameData);
  if (!isRecord(parsed)) return null;
  if (hasProperty(parsed, "seq") || hasProperty(parsed, "thread_id") || hasProperty(parsed, "turn_id") || hasProperty(parsed, "created_at")) {
    const seq = safeProperty(parsed, "seq");
    const rawEvent = safeProperty(parsed, "event");
    if (typeof seq !== "number" || typeof rawEvent !== "string" || !hasProperty(parsed, "data")) return null;
    if (!Number.isSafeInteger(seq) || seq < 0) return null;
    const event = safeEventName(rawEvent);
    if (!event) return null;
    const rawThreadId = safeProperty(parsed, "thread_id");
    if (rawThreadId === undefined || rawThreadId === null) return null;
    const threadId = optionalSafeId(rawThreadId);
    const turnId = optionalSafeId(safeProperty(parsed, "turn_id"));
    if (!threadId || turnId === undefined) return null;
    const createdAt = safeProperty(parsed, "created_at");
    if (createdAt !== undefined && !safeDateString(createdAt)) return null;
    return {
      seq,
      thread_id: threadId,
      event,
      data: safeFrameData(safeProperty(parsed, "data")),
      created_at: typeof createdAt === "string" ? createdAt.trim() : "",
      ...(turnId !== null ? { turn_id: turnId } : {}),
    };
  }
  const event = safeEventName(safeProperty(frame, "event")) ?? "message";
  const seq = parseFrameId(safeProperty(frame, "id"));
  return {
    seq,
    thread_id: "",
    event,
    data: safeFrameData(parsed),
    created_at: "",
  };
}

export function parseRuntimeSSEMessage(frame: RuntimeSSEFrameLike): RuntimeSSEMessage | null {
  const event = safeEventName(safeProperty(frame, "event"));
  const frameData = safeProperty(frame, "data");
  if (!event || !frameData) return null;
  return { event, data: safeFrameData(parseJson(frameData)) };
}

function parseJson(value: unknown): unknown {
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
  return typeof value === "string" ? safeSliceTextBoundary(value.replace(CONTROL_TEXT_GLOBAL_RE, " "), maxChars) : "";
}

function textDeltaData(value: unknown): Record<string, string> {
  const data = isRecord(value) ? value : {};
  const text = safeText(safeProperty(data, "text"), MAX_RUNTIME_TEXT_CHARS);
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
  for (const item of safeArrayItems(value, MAX_RUNTIME_ARTIFACT_ID_SCAN)) {
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
  const tool = safeToolName(safeProperty(value, "tool"));
  if (!tool) return null;
  const toolCallId = safeToolCallId(safeProperty(value, "tool_call_id"));
  const rawProgress = safeProperty(value, "progress");
  const progress = isRecord(rawProgress) ? rawProgress : {};
  const progressPercent = safeProperty(progress, "percent");
  const progressMessage = safeText(safeProperty(progress, "message"), MAX_RUNTIME_TEXT_CHARS);
  const percent = typeof progressPercent === "number" && Number.isFinite(progressPercent) && progressPercent >= 0 && progressPercent <= 100
    ? progressPercent
    : undefined;
  return {
    event: "tool_progress",
    data: {
      tool,
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      progress: {
        ...(progressMessage ? { message: progressMessage } : {}),
        ...(percent !== undefined ? { percent } : {}),
        ...(hasProperty(progress, "data") ? { data: safeProgressData(safeProperty(progress, "data")) } : {}),
      },
    },
  };
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
      // Skip hostile artifact id entries.
    }
  }
  return items;
}
