/** Convert persisted runtime/session records into replayable EngineRuntimeEvent streams. */

import type {
  EngineRuntimeEvent,
  EngineRuntimeEventMap,
  PrefixInvalidatedEventData,
  ToolProgressRuntimeEvent,
  ToolResultRuntimeEvent,
} from "../engine/events.js";
import type { ContextIntervention } from "../engine/context-manager.js";
import type { Message, ToolCall, ToolResult } from "../session/types.js";
import { normalizeToolCall, normalizeToolCalls, safeSessionString, safeToolCallId, safeToolName } from "../session/types.js";
import { omitUndefined } from "../utils/object.js";
import { toJsonSafe } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_RUNTIME_REPLAY_ITEMS = 10_000;
const MAX_RUNTIME_ARTIFACT_IDS = 100;
const MAX_RUNTIME_ARTIFACT_ID_CHARS = 160;
const ARTIFACT_ID_RE = /^[A-Za-z0-9._:-]+$/;
const MAX_BOUNDARY_CONTENT_CHARS = 200_000;
const MAX_BOUNDARY_ACTIONS = 100;

export interface RuntimeItemLike {
  type: string;
  data: unknown;
  artifact_ids?: string[];
}

export function sessionMessagesToRuntimeEvents(
  messages: Message[],
  options: { maxMessages?: number } = {},
): EngineRuntimeEvent[] {
  const maxMessages = safePositiveInteger(options.maxMessages, 80);
  const replayMessages = safeArrayItems(messages, maxMessages, true);
  const events: EngineRuntimeEvent[] = [];

  for (const rawMessage of replayMessages) {
    const message = sanitizeMessage(rawMessage);
    if (!message) continue;
    if (message.role === "system") {
      const compactionEvent = compactionBoundaryToRuntimeEvent(message);
      if (compactionEvent) events.push(compactionEvent);
      continue;
    }

    if (message.role === "user") {
      const text = safeSessionString(message.content);
      if (text === null) continue;
      events.push({ type: "user_message", data: { text } });
      continue;
    }

    if (message.role === "assistant") {
      events.push({ type: "assistant_message", data: message });
      for (const toolCall of message.tool_calls || []) {
        events.push({ type: "tool_call", data: toolCall });
      }
      continue;
    }

    if (message.role === "tool") {
      const content = safeSessionString(message.content) ?? "";
      const name = safeToolName(message.name);
      const toolCallId = safeToolCallId(message.tool_call_id);
      if (!name || !toolCallId) continue;
      const result: ToolResult = {
        tool_call_id: toolCallId,
        name,
        content,
        is_error: message.is_error ?? /^Error:|was denied\./i.test(content),
      };
      events.push({ type: "tool_result", data: result, preview: content });
    }
  }

  return events;
}

export function runtimeItemsToEngineRuntimeEvents(items: RuntimeItemLike[]): EngineRuntimeEvent[] {
  if (!Array.isArray(items)) return [];
  const events: EngineRuntimeEvent[] = [];
  for (const item of safeArrayItems(items, MAX_RUNTIME_REPLAY_ITEMS, true)) {
    const event = runtimeItemToEngineRuntimeEvent(item as RuntimeItemLike);
    if (event) events.push(event);
  }
  return events;
}

export function runtimeItemToEngineRuntimeEvent(item: RuntimeItemLike): EngineRuntimeEvent | null {
  if (!item || typeof item !== "object") return null;
  const type = safeProperty(item, "type");
  if (typeof type !== "string") return null;
  const rawData = safeProperty(item, "data");
  const data = asRecord(rawData);
  const artifact_ids = sanitizeArtifactIds(safeProperty(item, "artifact_ids"));
  switch (type) {
    case "api_call_start":
      return { type: "api_call_start", data: {} };
    case "thinking_delta": {
      const text = asString(safeProperty(data, "text"));
      return text === undefined ? null : { type: "thinking_delta", data: { text } };
    }
    case "content_delta": {
      const text = asString(safeProperty(data, "text"));
      return text === undefined ? null : { type: "content_delta", data: { text } };
    }
    case "user_message": {
      const text = asString(safeProperty(data, "text"));
      return text === undefined ? null : { type: "user_message", data: { text } };
    }
    case "assistant_message": {
      const message = sanitizeMessage(rawData);
      return message ? { type: "assistant_message", data: message } : null;
    }
    case "tool_call_begin": {
      const name = safeToolName(safeProperty(data, "name"));
      if (!name) return null;
      const toolCallId = safeToolCallId(safeProperty(data, "tool_call_id"));
      return {
        type: "tool_call_begin",
        data: omitUndefined({
          name,
          tool_call_id: toolCallId ?? undefined,
          index: safeIndex(safeProperty(data, "index")),
        }),
        ...(artifact_ids.length ? { artifact_ids } : {}),
      };
    }
    case "tool_call": {
      const toolCall = sanitizeToolCall(rawData);
      return toolCall ? { type: "tool_call", data: toolCall, ...(artifact_ids.length ? { artifact_ids } : {}) } : null;
    }
    case "tool_call_args": {
      const toolCallArgs = sanitizeToolCallArgs(rawData);
      return toolCallArgs ? { type: "tool_call_args", data: toolCallArgs, ...(artifact_ids.length ? { artifact_ids } : {}) } : null;
    }
    case "approval_required": {
      const tool = safeToolName(safeProperty(data, "tool"));
      if (!tool) return null;
      const args = asJsonObject(safeProperty(data, "args"));
      return {
        type: "approval_required",
        data: omitUndefined({
          tool,
          args,
          description: safeSessionString(safeProperty(data, "description")) ?? undefined,
        }),
        ...(artifact_ids.length ? { artifact_ids } : {}),
      };
    }
    case "tool_result": {
      const result = sanitizeToolResult(rawData);
      if (!result) return null;
      return {
        type: "tool_result",
        data: result,
        preview: result.content,
        ...(artifact_ids.length ? { artifact_ids } : {}),
      } satisfies ToolResultRuntimeEvent;
    }
    case "tool_progress": {
      const progress = sanitizeToolProgress(rawData);
      if (!progress) return null;
      return {
        type: "tool_progress",
        data: progress,
        ...(artifact_ids.length ? { artifact_ids } : {}),
      };
    }
    case "context_intervention":
      return {
        type: "context_intervention",
        data: sanitizeContextIntervention(data),
        ...(artifact_ids.length ? { artifact_ids } : {}),
      };
    case "prefix_invalidated":
      return {
        type: "prefix_invalidated",
        data: sanitizePrefixInvalidated(data),
        ...(artifact_ids.length ? { artifact_ids } : {}),
      };
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return safeSessionString(value) ?? undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  const text = safeSessionString(value)?.trim();
  return text ? text : undefined;
}

function sanitizeToolCall(value: unknown): ToolCall | null {
  return normalizeToolCall(value);
}

function sanitizeToolResult(value: unknown): ToolResult | null {
  const data = asRecord(value);
  const name = safeToolName(safeProperty(data, "name"));
  const toolCallId = safeToolCallId(safeProperty(data, "tool_call_id"));
  if (!name || !toolCallId) return null;
  const content = safeSessionString(safeProperty(data, "content")) || "";
  const isError = safeProperty(data, "is_error");
  return {
    tool_call_id: toolCallId,
    name,
    content,
    is_error: typeof isError === "boolean" ? isError : /^Error:|was denied\./i.test(content),
  };
}

function sanitizeToolCallArgs(value: unknown): EngineRuntimeEventMap["tool_call_args"] | null {
  const data = asRecord(value);
  const toolCallId = safeToolCallId(safeProperty(data, "tool_call_id"));
  const name = safeToolName(safeProperty(data, "name"));
  const argumentsText = safeSessionString(safeProperty(data, "arguments"));
  if (!toolCallId || !name || argumentsText === null) return null;
  return omitUndefined({
    tool_call_id: toolCallId,
    name,
    index: safeIndex(safeProperty(data, "index")),
    arguments: argumentsText,
  });
}

function sanitizeToolProgress(value: unknown): ToolProgressRuntimeEvent["data"] | null {
  const data = asRecord(value);
  const progress = asRecord(safeProperty(data, "progress"));
  const tool = safeToolName(safeProperty(data, "tool"));
  const toolCallId = safeToolCallId(safeProperty(data, "tool_call_id"));
  const message = safeSessionString(safeProperty(progress, "message"));
  if (!tool || !toolCallId || !message) return null;
  return {
    tool,
    tool_call_id: toolCallId,
    progress: omitUndefined({
      message,
      percent: safePercent(safeProperty(progress, "percent")),
      data: asJsonObject(safeProperty(progress, "data")),
    }),
  };
}

function sanitizeContextIntervention(value: Record<string, unknown> | null): ContextIntervention {
  const compaction = asRecord(safeProperty(value, "compaction"));
  const intervention: ContextIntervention = {
    action: normalizeGuardrailAction(safeProperty(value, "action")),
    risk: normalizeRiskBand(safeProperty(value, "risk")),
    reason: asNonEmptyString(safeProperty(value, "reason")) ?? "capacity intervention",
    tokens_before: finiteNonNegativeNumber(safeProperty(value, "tokens_before")) ?? 0,
    tokens_after: finiteNonNegativeNumber(safeProperty(value, "tokens_after")) ?? 0,
    layers: [],
  };
  const injectedMessage = asNonEmptyString(safeProperty(value, "injected_message"));
  if (injectedMessage !== undefined) intervention.injected_message = injectedMessage;
  if (compaction) intervention.compaction = sanitizeCompaction(compaction);
  return intervention;
}

function sanitizePrefixInvalidated(value: Record<string, unknown> | null): PrefixInvalidatedEventData {
  const compaction = asRecord(safeProperty(value, "compaction"));
  const data: PrefixInvalidatedEventData = {
    reason: asNonEmptyString(safeProperty(value, "reason")) ?? "unknown",
  };
  const boundaryId = asNonEmptyString(safeProperty(value, "boundary_id"));
  if (boundaryId !== undefined) data.boundary_id = boundaryId;
  if (compaction) data.compaction = sanitizePrefixCompaction(compaction);
  return data;
}

function sanitizeCompaction(value: Record<string, unknown>) {
  const actions = safeStringArray(safeProperty(value, "actions"), MAX_BOUNDARY_ACTIONS);
  const finalTokens = finiteNonNegativeNumber(safeProperty(value, "finalTokens"));
  const boundaryId = asNonEmptyString(safeProperty(value, "boundary_id"));
  const removedMessages = finiteNonNegativeNumber(safeProperty(value, "removed_messages"));
  const originalTokens = finiteNonNegativeNumber(safeProperty(value, "original_tokens"));
  const summaryMessageName = asNonEmptyString(safeProperty(value, "summary_message_name"));
  const preservedMessages = finiteNonNegativeNumber(safeProperty(value, "preserved_messages"));
  const prefixInvalidationReason = asNonEmptyString(safeProperty(value, "prefix_invalidation_reason"));
  const prefixInvalidated = safeProperty(value, "prefix_invalidated");
  const result = {
    actions,
    finalTokens: finalTokens ?? 0,
    message: asNonEmptyString(safeProperty(value, "message")) ?? "",
    ...(boundaryId !== undefined ? { boundary_id: boundaryId } : {}),
    ...(removedMessages !== undefined ? { removed_messages: removedMessages } : {}),
    ...(originalTokens !== undefined ? { original_tokens: originalTokens } : {}),
    ...(summaryMessageName !== undefined ? { summary_message_name: summaryMessageName } : {}),
    ...(preservedMessages !== undefined ? { preserved_messages: preservedMessages } : {}),
    ...(typeof prefixInvalidated === "boolean" ? { prefix_invalidated: prefixInvalidated } : {}),
    ...(prefixInvalidationReason !== undefined ? { prefix_invalidation_reason: prefixInvalidationReason } : {}),
  };
  return result;
}

function sanitizePrefixCompaction(value: Record<string, unknown>): NonNullable<PrefixInvalidatedEventData["compaction"]> {
  const actions = safeStringArray(safeProperty(value, "actions"), MAX_BOUNDARY_ACTIONS);
  const originalTokens = finiteNonNegativeNumber(safeProperty(value, "original_tokens"));
  const removedMessages = finiteNonNegativeNumber(safeProperty(value, "removed_messages"));
  const preservedMessages = finiteNonNegativeNumber(safeProperty(value, "preserved_messages"));
  const summaryMessageName = asNonEmptyString(safeProperty(value, "summary_message_name"));
  return {
    actions,
    finalTokens: finiteNonNegativeNumber(safeProperty(value, "finalTokens")) ?? 0,
    ...(originalTokens !== undefined ? { original_tokens: originalTokens } : {}),
    ...(removedMessages !== undefined ? { removed_messages: removedMessages } : {}),
    ...(preservedMessages !== undefined ? { preserved_messages: preservedMessages } : {}),
    ...(summaryMessageName !== undefined ? { summary_message_name: summaryMessageName } : {}),
  };
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safePercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function asJsonObject(value: unknown): Record<string, unknown> {
  try {
    const safe = toJsonSafe(value);
    return safe && typeof safe === "object" && !Array.isArray(safe) && !isTruncatedJsonObject(safe) ? safe as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isTruncatedJsonObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).truncated === true);
}

function normalizeGuardrailAction(value: unknown): ContextIntervention["action"] {
  return value === "no_intervention"
    || value === "targeted_context_refresh"
    || value === "verify_with_tool_replay"
    || value === "verify_and_replan"
    ? value
    : "intervention" as ContextIntervention["action"];
}

function normalizeRiskBand(value: unknown): ContextIntervention["risk"] {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : "unknown" as ContextIntervention["risk"];
}

function sanitizeMessage(value: unknown): Message | null {
  const data = asRecord(value);
  const role = safeProperty(data, "role");
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return null;
  const toolCalls = safeProperty(data, "tool_calls");
  const isError = safeProperty(data, "is_error");
  return {
    role,
    content: safeSessionString(safeProperty(data, "content")),
    tool_calls: role === "assistant" && Array.isArray(toolCalls)
      ? normalizeToolCalls(toolCalls)
      : null,
    tool_call_id: safeToolCallId(safeProperty(data, "tool_call_id")),
    name: safeToolName(safeProperty(data, "name")),
    reasoning_content: safeSessionString(safeProperty(data, "reasoning_content")),
    is_error: typeof isError === "boolean" || isError === null ? isError : null,
  };
}

function compactionBoundaryToRuntimeEvent(message: Message): EngineRuntimeEvent | null {
  if (message.name !== "context_compaction_boundary") return null;
  const content = safeSliceTextBoundary(message.content || "", MAX_BOUNDARY_CONTENT_CHARS);
  const data: PrefixInvalidatedEventData = {
    reason: "context_compaction",
  };
  const compaction: NonNullable<PrefixInvalidatedEventData["compaction"]> = {
    actions: extractBoundaryActions(content),
    finalTokens: parseBoundaryNumber(content, "projected_tokens_after") ?? 0,
  };
  const originalTokens = parseBoundaryNumber(content, "projected_tokens_before");
  const removedMessages = parseBoundaryNumber(content, "removed_messages");
  const preservedMessages = parseBoundaryNumber(content, "preserved_messages");
  if (originalTokens !== undefined) compaction.original_tokens = originalTokens;
  if (removedMessages !== undefined) compaction.removed_messages = removedMessages;
  if (preservedMessages !== undefined) compaction.preserved_messages = preservedMessages;
  compaction.summary_message_name = "context_summary";
  data.compaction = compaction;
  const boundaryId = extractBoundaryField(content, "boundary_id");
  if (boundaryId !== undefined) data.boundary_id = boundaryId;
  return {
    type: "prefix_invalidated",
    data,
  };
}

function extractBoundaryField(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() || undefined;
}

function parseBoundaryNumber(content: string, key: string): number | undefined {
  const value = extractBoundaryField(content, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function extractBoundaryActions(content: string): string[] {
  const lines = content.split("\n");
  const actions: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (collecting && line.startsWith("- ")) {
      actions.push(line.slice(2).trim());
      if (actions.length >= MAX_BOUNDARY_ACTIONS) break;
      continue;
    }
    if (line.trim() === "actions:") {
      collecting = true;
      continue;
    }
    if (collecting) break;
  }
  return actions;
}

function sanitizeArtifactIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of safeArrayItems(value, MAX_RUNTIME_ARTIFACT_IDS * 10)) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > MAX_RUNTIME_ARTIFACT_ID_CHARS || !ARTIFACT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_RUNTIME_ARTIFACT_IDS) break;
  }
  return ids;
}

function safeProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function safeArrayItems(value: unknown, maxItems: number, fromEnd = false): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return [];
  }
  const limit = Math.max(0, Math.floor(maxItems));
  const start = fromEnd ? Math.max(0, length - limit) : 0;
  const end = fromEnd ? length : Math.min(length, limit);
  const items: unknown[] = [];
  for (let index = start; index < end; index++) {
    try {
      items.push(value[index]);
    } catch {
      continue;
    }
  }
  return items;
}

function safeStringArray(value: unknown, maxItems: number): string[] {
  const result: string[] = [];
  for (const item of safeArrayItems(value, maxItems * 10)) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text) result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}
