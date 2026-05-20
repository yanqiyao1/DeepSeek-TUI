import type { EngineRuntimeEvent } from "../engine/events.js";
import type { RuntimeEvent } from "./runtime-store.js";

export interface RuntimeSSEMessage {
  event: string;
  data: unknown;
}

export interface RuntimeSSEFrameLike {
  event?: string;
  id?: string;
  data?: string;
}

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
      return { event: "thinking", data: event.data };
    case "content_delta":
      return { event: "content", data: event.data };
    case "tool_call_begin": {
      const key = event.data.tool_call_id || event.data.name;
      streamedToolCalls.add(key);
      return { event: "tool_call", data: { name: event.data.name, tool_call_id: event.data.tool_call_id } };
    }
    case "tool_call": {
      if (streamedToolCalls.has(event.data.id) || streamedToolCalls.has(event.data.name)) return null;
      streamedToolCalls.add(event.data.id || event.data.name);
      return { event: "tool_call", data: { name: event.data.name, tool_call_id: event.data.id } };
    }
    case "tool_result":
      return { event: "tool_result", data: { name: event.data.name, preview: event.preview, artifact_ids: event.artifact_ids || [] } };
    case "tool_progress":
      return { event: "tool_progress", data: event.data };
    case "context_intervention":
      return { event: "context_intervention", data: event.data };
    case "prefix_invalidated":
      return { event: "prefix_invalidated", data: event.data };
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
    if (!Number.isFinite(parsed.seq) || parsed.seq < 0 || !parsed.event.trim()) return null;
    if (parsed.thread_id !== undefined && typeof parsed.thread_id !== "string") return null;
    if (parsed.turn_id !== undefined && typeof parsed.turn_id !== "string") return null;
    if (parsed.created_at !== undefined && typeof parsed.created_at !== "string") return null;
    return {
      seq: Math.floor(parsed.seq),
      thread_id: typeof parsed.thread_id === "string" ? parsed.thread_id : "",
      event: parsed.event.trim(),
      data: parsed.data,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
      ...(typeof parsed.turn_id === "string" ? { turn_id: parsed.turn_id } : {}),
    };
  }
  const event = typeof frame.event === "string" && frame.event.trim() ? frame.event.trim() : "message";
  const seq = Number(frame.id);
  return {
    seq: Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : 0,
    thread_id: "",
    event,
    data: parsed,
    created_at: "",
  };
}

export function parseRuntimeSSEMessage(frame: RuntimeSSEFrameLike): RuntimeSSEMessage | null {
  if (!frame.event || !frame.event.trim() || !frame.data) return null;
  return { event: frame.event.trim(), data: parseJson(frame.data) };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
