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
import { omitUndefined } from "../utils/object.js";

export interface RuntimeItemLike {
  type: string;
  data: unknown;
  artifact_ids?: string[];
}

export function sessionMessagesToRuntimeEvents(
  messages: Message[],
  options: { maxMessages?: number } = {},
): EngineRuntimeEvent[] {
  const maxMessages = options.maxMessages ?? 80;
  const replayMessages = messages.slice(-maxMessages);
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
      if (typeof message.content !== "string") continue;
      events.push({ type: "user_message", data: { text: message.content } });
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
      const content = typeof message.content === "string" ? message.content : "";
      const name = typeof message.name === "string" && message.name ? message.name : undefined;
      const toolCallId = typeof message.tool_call_id === "string" && message.tool_call_id
        ? message.tool_call_id
        : undefined;
      if (!name && !toolCallId) continue;
      const result: ToolResult = {
        tool_call_id: toolCallId || "",
        name: name || toolCallId || "",
        content,
        is_error: message.is_error ?? /^Error:|was denied\./i.test(content),
      };
      events.push({ type: "tool_result", data: result, preview: content });
    }
  }

  return events;
}

export function runtimeItemsToEngineRuntimeEvents(items: RuntimeItemLike[]): EngineRuntimeEvent[] {
  return items
    .map(runtimeItemToEngineRuntimeEvent)
    .filter((event): event is EngineRuntimeEvent => !!event);
}

export function runtimeItemToEngineRuntimeEvent(item: RuntimeItemLike): EngineRuntimeEvent | null {
  const data = asRecord(item.data);
  switch (item.type) {
    case "api_call_start":
      return { type: "api_call_start", data: {} };
    case "thinking_delta": {
      const text = asString(data?.text);
      return text === undefined ? null : { type: "thinking_delta", data: { text } };
    }
    case "content_delta": {
      const text = asString(data?.text);
      return text === undefined ? null : { type: "content_delta", data: { text } };
    }
    case "user_message": {
      const text = asString(data?.text);
      return text === undefined ? null : { type: "user_message", data: { text } };
    }
    case "assistant_message":
      return sanitizeMessage(item.data)
        ? { type: "assistant_message", data: sanitizeMessage(item.data)! }
        : null;
    case "tool_call_begin": {
      const name = asString(data?.name);
      if (!name) return null;
      return {
        type: "tool_call_begin",
        data: omitUndefined({
          name,
          tool_call_id: typeof data?.tool_call_id === "string" ? data.tool_call_id : undefined,
          index: typeof data?.index === "number" ? data.index : undefined,
        }),
        ...(item.artifact_ids ? { artifact_ids: item.artifact_ids } : {}),
      };
    }
    case "tool_call": {
      const toolCall = sanitizeToolCall(item.data);
      return toolCall ? { type: "tool_call", data: toolCall, ...(item.artifact_ids ? { artifact_ids: item.artifact_ids } : {}) } : null;
    }
    case "tool_call_args": {
      const toolCallArgs = sanitizeToolCallArgs(item.data);
      return toolCallArgs ? { type: "tool_call_args", data: toolCallArgs, ...(item.artifact_ids ? { artifact_ids: item.artifact_ids } : {}) } : null;
    }
    case "approval_required": {
      const tool = asString(data?.tool);
      if (!tool) return null;
      return {
        type: "approval_required",
        data: omitUndefined({
          tool,
          args: (data?.args && typeof data.args === "object") ? data.args as Record<string, unknown> : {},
          description: typeof data?.description === "string" ? data.description : undefined,
        }),
        ...(item.artifact_ids ? { artifact_ids: item.artifact_ids } : {}),
      };
    }
    case "tool_result": {
      const result = sanitizeToolResult(item.data);
      if (!result) return null;
      return {
        type: "tool_result",
        data: result,
        preview: result.content,
        ...(item.artifact_ids ? { artifact_ids: item.artifact_ids } : {}),
      } satisfies ToolResultRuntimeEvent;
    }
    case "tool_progress": {
      const progress = sanitizeToolProgress(item.data);
      if (!progress) return null;
      return {
        type: "tool_progress",
        data: progress,
        ...(item.artifact_ids ? { artifact_ids: item.artifact_ids } : {}),
      };
    }
    case "context_intervention":
      return {
        type: "context_intervention",
        data: sanitizeContextIntervention(data),
        ...(item.artifact_ids ? { artifact_ids: item.artifact_ids } : {}),
      };
    case "prefix_invalidated":
      return {
        type: "prefix_invalidated",
        data: sanitizePrefixInvalidated(data),
        ...(item.artifact_ids ? { artifact_ids: item.artifact_ids } : {}),
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
  return typeof value === "string" ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sanitizeToolCall(value: unknown): ToolCall | null {
  const data = asRecord(value);
  const name = asString(data?.name);
  if (!name) return null;
  return {
    id: asString(data?.id) || "",
    name,
    arguments: asRecord(data?.arguments) || {},
  };
}

function sanitizeToolResult(value: unknown): ToolResult | null {
  const data = asRecord(value);
  const name = asString(data?.name);
  if (!name) return null;
  const content = asString(data?.content) || "";
  return {
    tool_call_id: asString(data?.tool_call_id) || "",
    name,
    content,
    is_error: typeof data?.is_error === "boolean" ? data.is_error : /^Error:|was denied\./i.test(content),
  };
}

function sanitizeToolCallArgs(value: unknown): EngineRuntimeEventMap["tool_call_args"] | null {
  const data = asRecord(value);
  const toolCallId = asString(data?.tool_call_id);
  const name = asString(data?.name);
  const argumentsText = asString(data?.arguments);
  if (!toolCallId || !name || argumentsText === undefined) return null;
  return omitUndefined({
    tool_call_id: toolCallId,
    name,
    index: typeof data?.index === "number" ? data.index : undefined,
    arguments: argumentsText,
  });
}

function sanitizeToolProgress(value: unknown): ToolProgressRuntimeEvent["data"] | null {
  const data = asRecord(value);
  const progress = asRecord(data?.progress);
  const tool = asString(data?.tool);
  const toolCallId = asString(data?.tool_call_id);
  const message = asString(progress?.message);
  if (!tool || !toolCallId || !message) return null;
  return {
    tool,
    tool_call_id: toolCallId,
    progress: omitUndefined({
      message,
      percent: typeof progress?.percent === "number" ? progress.percent : undefined,
      data: asRecord(progress?.data) || undefined,
    }),
  };
}

function sanitizeContextIntervention(value: Record<string, unknown> | null): ContextIntervention {
  const compaction = asRecord(value?.compaction);
  return {
    action: asNonEmptyString(value?.action) ?? "intervention",
    risk: asNonEmptyString(value?.risk) ?? "unknown",
    reason: asNonEmptyString(value?.reason) ?? "capacity intervention",
    tokens_before: typeof value?.tokens_before === "number" && Number.isFinite(value.tokens_before) ? value.tokens_before : 0,
    tokens_after: typeof value?.tokens_after === "number" && Number.isFinite(value.tokens_after) ? value.tokens_after : 0,
    layers: [],
    ...(typeof value?.injected_message === "string" && value.injected_message.trim()
      ? { injected_message: value.injected_message }
      : {}),
    ...(compaction ? { compaction: sanitizeCompaction(compaction) } : {}),
  } as ContextIntervention;
}

function sanitizePrefixInvalidated(value: Record<string, unknown> | null): PrefixInvalidatedEventData {
  const compaction = asRecord(value?.compaction);
  return omitUndefined({
    reason: asNonEmptyString(value?.reason) ?? "unknown",
    boundary_id: typeof value?.boundary_id === "string" && value.boundary_id ? value.boundary_id : undefined,
    compaction: compaction ? sanitizePrefixCompaction(compaction) : undefined,
  });
}

function sanitizeCompaction(value: Record<string, unknown>) {
  const actions = Array.isArray(value.actions)
    ? value.actions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    actions,
    finalTokens: typeof value.finalTokens === "number" && Number.isFinite(value.finalTokens) ? value.finalTokens : Number.NaN,
    message: asNonEmptyString(value.message) ?? "",
    ...(typeof value.boundary_id === "string" ? { boundary_id: value.boundary_id } : {}),
    ...(typeof value.removed_messages === "number" && Number.isFinite(value.removed_messages) ? { removed_messages: value.removed_messages } : {}),
    ...(typeof value.original_tokens === "number" && Number.isFinite(value.original_tokens) ? { original_tokens: value.original_tokens } : {}),
    ...(typeof value.summary_message_name === "string" ? { summary_message_name: value.summary_message_name } : {}),
    ...(typeof value.preserved_messages === "number" && Number.isFinite(value.preserved_messages) ? { preserved_messages: value.preserved_messages } : {}),
    ...(typeof value.prefix_invalidated === "boolean" ? { prefix_invalidated: value.prefix_invalidated } : {}),
    ...(typeof value.prefix_invalidation_reason === "string" ? { prefix_invalidation_reason: value.prefix_invalidation_reason } : {}),
  };
}

function sanitizePrefixCompaction(value: Record<string, unknown>): PrefixInvalidatedEventData["compaction"] {
  const actions = Array.isArray(value.actions)
    ? value.actions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    actions,
    finalTokens: typeof value.finalTokens === "number" && Number.isFinite(value.finalTokens) ? value.finalTokens : Number.NaN,
    ...(typeof value.original_tokens === "number" && Number.isFinite(value.original_tokens) ? { original_tokens: value.original_tokens } : {}),
    ...(typeof value.removed_messages === "number" && Number.isFinite(value.removed_messages) ? { removed_messages: value.removed_messages } : {}),
    ...(typeof value.preserved_messages === "number" && Number.isFinite(value.preserved_messages) ? { preserved_messages: value.preserved_messages } : {}),
    ...(typeof value.summary_message_name === "string" ? { summary_message_name: value.summary_message_name } : {}),
  };
}

function sanitizeMessage(value: unknown): Message | null {
  const data = asRecord(value);
  const role = data?.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return null;
  return {
    role,
    content: typeof data?.content === "string" || data?.content === null ? data.content : null,
    tool_calls: Array.isArray(data?.tool_calls)
      ? data.tool_calls.map(sanitizeToolCall).filter((toolCall): toolCall is ToolCall => !!toolCall)
      : null,
    tool_call_id: typeof data?.tool_call_id === "string" || data?.tool_call_id === null ? data.tool_call_id : null,
    name: typeof data?.name === "string" || data?.name === null ? data.name : null,
    reasoning_content: typeof data?.reasoning_content === "string" || data?.reasoning_content === null ? data.reasoning_content : null,
    is_error: typeof data?.is_error === "boolean" || data?.is_error === null ? data.is_error : null,
  };
}

function compactionBoundaryToRuntimeEvent(message: Message): EngineRuntimeEvent | null {
  if (message.name !== "context_compaction_boundary") return null;
  const content = message.content || "";
  const data: PrefixInvalidatedEventData = {
    reason: "context_compaction",
    compaction: omitUndefined({
      actions: extractBoundaryActions(content),
      finalTokens: parseBoundaryNumber(content, "projected_tokens_after") ?? 0,
      original_tokens: parseBoundaryNumber(content, "projected_tokens_before") ?? undefined,
      removed_messages: parseBoundaryNumber(content, "removed_messages") ?? undefined,
      preserved_messages: parseBoundaryNumber(content, "preserved_messages") ?? undefined,
      summary_message_name: "context_summary",
    }),
  };
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
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractBoundaryActions(content: string): string[] {
  const lines = content.split("\n");
  const actions: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (collecting && line.startsWith("- ")) {
      actions.push(line.slice(2).trim());
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
