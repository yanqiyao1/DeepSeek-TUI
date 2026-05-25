/** DeepSeek API client wrapping the OpenAI SDK. */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { StreamEvent, ContentDelta, ThinkingDelta, ToolCallBegin, ToolCallArgsDelta, StreamDone, SendOptions, UsageTelemetry } from "./base.js";
import type { Message, ToolCall } from "../session/types.js";
import { messageToApiDict } from "../session/types.js";
import {
  applyReasoningEffort,
  parseProvider,
  providerCapability,
  shouldReplayReasoningContent,
  type ApiProvider,
  type ProviderCapability,
} from "./capabilities.js";
import { safeJsonStringify, toJsonSafe } from "../utils/json-safe.js";

interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: string;
}

const SAFE_TOOL_CALL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const SAFE_FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"]);
const MAX_STREAM_TEXT_CHARS = 2_000_000;
const MAX_TOOL_CALLS = 100;
const MAX_TOOL_ARGUMENT_CHARS = 1_000_000;
const MAX_TOOL_SCHEMA_CHARS = 250_000;
const MAX_TOOL_SCHEMAS = 256;
const MAX_REQUEST_MESSAGES = 2_000;
const MAX_TOKEN_COUNT_TEXT_CHARS = 2_000_000;
const MAX_TOKENIZER_INPUT_CHARS = 120_000;
const MAX_USAGE_DEPTH = 8;
const MAX_USAGE_KEYS = 100;
const MAX_MODEL_CHARS = 512;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export class DeepSeekClient {
  private client: OpenAI;
  private model: string;
  private provider: ApiProvider;
  readonly capability: ProviderCapability;

  constructor(opts: ClientOptions) {
    const apiKey = normalizeApiKey(opts.apiKey);
    const baseURL = normalizeBaseUrl(opts.baseUrl);
    const model = normalizeModel(opts.model);
    this.provider = parseProvider(opts.provider);
    this.capability = providerCapability(this.provider, model);
    this.client = new OpenAI({
      apiKey,
      baseURL,
    });
    this.model = this.capability.resolved_model;
  }

  async *send(
    messages: Message[],
    tools?: Record<string, unknown>[] | null,
    options: SendOptions = {},
  ): AsyncIterable<StreamEvent> {
    throwIfAborted(options.signal);
    const apiMessages = sanitizeMessagesForThinkingMode(
      messages.slice(-MAX_REQUEST_MESSAGES).map(messageToApiDict),
      this.model,
      options.reasoning_effort,
    ) as unknown as ChatCompletionMessageParam[];

    const effectiveMaxTokens = Math.min(normalizeMaxTokens(options.max_tokens), this.capability.max_output);

    const request: Record<string, unknown> = {
      model: this.model,
      messages: apiMessages,
      stream: true,
      max_tokens: effectiveMaxTokens,
      stream_options: { include_usage: true },
    };
    const normalizedTools = normalizeToolSchemas(tools);
    if (normalizedTools.length) {
      request.tools = normalizedTools as any;
    }
    applyReasoningEffort(request, options.reasoning_effort, this.provider, this.capability.thinking_supported);

    const stream = options.signal
      ? await this.client.chat.completions.create(request as any, { signal: options.signal } as any) as any
      : await this.client.chat.completions.create(request as any) as any;

    let accumulatedContent = "";
    let accumulatedReasoning = "";
    const toolCallsAcc: Map<number, { id: string; name: string; arguments: string; began: boolean }> = new Map();
    const begunToolCallIds = new Set<string>();
    let finishReason = "stop";
    let streamUsage: UsageTelemetry | null = null;

    for await (const chunk of stream) {
      throwIfAborted(options.signal);
      const delta = safeGet(() => (chunk.choices?.[0] as any)?.delta);
      const chunkUsage = safeGet(() => (chunk as any).usage);
      if (chunkUsage && typeof chunkUsage === "object" && !Array.isArray(chunkUsage)) {
        const usage = normalizeUsageTelemetry(chunkUsage);
        if (usage) streamUsage = usage;
      }
      if (!delta) continue;

      // Content
      if (typeof delta.content === "string" && delta.content.length > 0) {
        const text = sanitizeStreamText(delta.content, remainingChars(accumulatedContent, MAX_STREAM_TEXT_CHARS));
        if (text) {
          accumulatedContent += text;
          yield { type: "content", text } as ContentDelta;
        }
      }

      // Reasoning (DeepSeek-specific, in model_extra or directly)
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
      if (reasoning.length > 0) {
        const text = sanitizeStreamText(reasoning, remainingChars(accumulatedReasoning, MAX_STREAM_TEXT_CHARS));
        if (text) {
          accumulatedReasoning += text;
          yield { type: "thinking", text } as ThinkingDelta;
        }
      }

      // Tool calls
      const tcDeltas = Array.isArray(delta.tool_calls) ? (delta.tool_calls as any[]).slice(0, MAX_TOOL_CALLS) : [];
      for (const tc of tcDeltas) {
        if (!tc || typeof tc !== "object") continue;
        const idx = normalizeToolCallIndex(tc.index);
        if (idx === null) continue;
        if (!toolCallsAcc.has(idx) && toolCallsAcc.size >= MAX_TOOL_CALLS) continue;
        if (!toolCallsAcc.has(idx)) {
          toolCallsAcc.set(idx, { id: "", name: "", arguments: "", began: false });
        }
        const acc = toolCallsAcc.get(idx)!;
        const id = normalizeToolCallId(tc.id);
        if (id) acc.id = id;
        const name = normalizeToolName(tc.function?.name);
        if (name) acc.name = name;
        if (acc.id && acc.name && !acc.began && begunToolCallIds.has(acc.id)) continue;
        if (acc.id && acc.name && !acc.began) {
          begunToolCallIds.add(acc.id);
          acc.began = true;
          yield { type: "tool_call_begin", index: idx, tool_call_id: acc.id, name: acc.name } as ToolCallBegin;
          if (acc.arguments) {
            yield {
              type: "tool_call_args",
              index: idx,
              tool_call_id: acc.id,
              name: acc.name,
              arguments: acc.arguments,
            } as ToolCallArgsDelta;
          }
        }
        if (typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0) {
          const argumentsDelta = sanitizeToolArgumentsDelta(tc.function.arguments, acc.arguments);
          if (!argumentsDelta) continue;
          acc.arguments += argumentsDelta;
          if (acc.began) {
            yield {
              type: "tool_call_args",
              index: idx,
              tool_call_id: acc.id,
              name: acc.name,
              arguments: argumentsDelta,
            } as ToolCallArgsDelta;
          }
        }
      }

      const fin = safeGet(() => (chunk.choices?.[0] as any)?.finish_reason);
      if (typeof fin === "string" && fin) finishReason = normalizeFinishReason(fin);

    }
    throwIfAborted(options.signal);

    // Assemble final tool calls
    const toolCalls: ToolCall[] = [];
    const seenToolCallIds = new Set<string>();
    for (const [, tc] of [...toolCallsAcc.entries()].sort(([a], [b]) => a - b).slice(0, MAX_TOOL_CALLS)) {
      if (!tc.id || !tc.name) continue;
      if (seenToolCallIds.has(tc.id)) continue;
      seenToolCallIds.add(tc.id);
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(tc.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const safe = toJsonSafe(parsed, { dropUndefinedObjectFields: true });
          if (safe && typeof safe === "object" && !Array.isArray(safe)) args = safe as Record<string, unknown>;
        }
      } catch { /* empty */ }
      toolCalls.push({ id: tc.id, name: tc.name, arguments: args });
    }

    yield {
      type: "done",
      finish_reason: finishReason,
      usage: streamUsage,
      content: accumulatedContent,
      reasoning_content: accumulatedReasoning || null,
      tool_calls: toolCalls,
    } as StreamDone;
  }

  estimateTokens(text: string): number {
    return Math.ceil(safeClientText(text, MAX_TOKEN_COUNT_TEXT_CHARS).length / 4);
  }

  async countTokens(messages: Message[]): Promise<number> {
    const safeMessages = Array.isArray(messages) ? messages.slice(-MAX_REQUEST_MESSAGES) : [];
    if (estimateMessageTextChars(safeMessages) > MAX_TOKENIZER_INPUT_CHARS) {
      return estimateMessagesTokens(safeMessages);
    }
    let enc: { encode(text: string): ArrayLike<number>; free?: () => void } | undefined;
    try {
      const tiktoken = await import("tiktoken");
      enc = tiktoken.get_encoding("cl100k_base");
      let total = 0;
      for (const m of safeMessages) {
        total += 4; // framing overhead
        let text = safeClientText(m.content || "", MAX_TOKEN_COUNT_TEXT_CHARS);
        if (m.reasoning_content) text += safeClientText(m.reasoning_content, MAX_TOKEN_COUNT_TEXT_CHARS);
        if (m.tool_calls) {
          for (const tc of m.tool_calls.slice(0, MAX_TOOL_CALLS)) {
            text += safeClientText(tc.name, 128) + safeToolArgumentText(tc.arguments);
          }
        }
        total += enc.encode(text).length;
      }
      return total;
    } catch {
      return estimateMessagesTokens(safeMessages);
    } finally {
      enc?.free?.();
    }
  }
}

function normalizeMaxTokens(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : Number.isFinite(value) && (value as number) > 0
      ? Math.floor(value as number)
      : 8192;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Request aborted", "AbortError");
}

export function sanitizeMessagesForThinkingMode(
  messages: Record<string, unknown>[],
  model: string,
  effort?: string | null,
): Record<string, unknown>[] {
  if (!shouldReplayReasoningContent(model, effort)) {
    return messages.map(message => stripReasoningContent({ ...message }));
  }

  const sanitized = messages.map(message => ({ ...message }));
  for (const message of sanitized) {
    if (message.role !== "assistant") continue;
    const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    if (!reasoning) message.reasoning_content = "(reasoning omitted)";
    if (message.content === undefined || message.content === null) {
      message.content = "";
    }
  }
  return sanitized;
}

function stripEmptyReasoningContent(message: Record<string, unknown>): Record<string, unknown> {
  const reasoning = message.reasoning_content;
  if (typeof reasoning !== "string" || !reasoning.trim()) delete message.reasoning_content;
  return message;
}

function stripReasoningContent(message: Record<string, unknown>): Record<string, unknown> {
  delete message.reasoning_content;
  return message;
}

function normalizeApiKey(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || CONTROL_TEXT_RE.test(trimmed) || trimmed.length > 4096) throw new Error("apiKey must be a non-empty string.");
  return trimmed;
}

function normalizeBaseUrl(value: string): string {
  try {
    const raw = typeof value === "string" ? value.trim() : "";
    if (CONTROL_TEXT_RE.test(raw) || raw.length > 8192) throw new Error("baseUrl must be an http:// or https:// URL.");
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("baseUrl must be an http:// or https:// URL.");
    if (parsed.username || parsed.password) throw new Error("baseUrl must not contain credentials.");
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch (e: any) {
    if (typeof e?.message === "string" && e.message.startsWith("baseUrl")) throw e;
    throw new Error("baseUrl must be an http:// or https:// URL.");
  }
}

function normalizeModel(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > MAX_MODEL_CHARS || CONTROL_TEXT_RE.test(trimmed)) {
    throw new Error("model must be a non-empty string.");
  }
  return trimmed;
}

function normalizeToolCallIndex(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) return null;
  return value;
}

function normalizeToolCallId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return SAFE_TOOL_CALL_ID_RE.test(trimmed) && !CONTROL_TEXT_RE.test(trimmed) ? trimmed : "";
}

function normalizeToolName(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return SAFE_TOOL_NAME_RE.test(trimmed) && !CONTROL_TEXT_RE.test(trimmed) ? trimmed : "";
}

function normalizeFinishReason(value: string): string {
  const normalized = value.trim();
  return SAFE_FINISH_REASONS.has(normalized) ? normalized : "stop";
}

function normalizeToolSchemas(tools?: Record<string, unknown>[] | null): Record<string, unknown>[] {
  if (!Array.isArray(tools)) return [];
  const normalized: Record<string, unknown>[] = [];
  for (const tool of tools.slice(0, MAX_TOOL_SCHEMAS)) {
    const schema = safeJsonValue(tool, { dropUndefinedObjectFields: true });
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || isTruncatedJsonObject(schema)) continue;
    const json = safeJsonStringify(schema);
    if (json.length > MAX_TOOL_SCHEMA_CHARS) continue;
    try {
      normalized.push(JSON.parse(json) as Record<string, unknown>);
    } catch {
      normalized.push(schema as Record<string, unknown>);
    }
  }
  return normalized;
}

function remainingChars(current: string, maxChars: number): number {
  return Math.max(0, maxChars - current.length);
}

function sanitizeStreamText(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  return value.replace(CONTROL_TEXT_GLOBAL_RE, " ").slice(0, maxChars);
}

function sanitizeToolArgumentsDelta(value: string, current: string): string {
  return sanitizeStreamText(value, remainingChars(current, MAX_TOOL_ARGUMENT_CHARS));
}

function safeClientText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.replace(CONTROL_TEXT_GLOBAL_RE, " ").slice(0, maxChars) : "";
}

function safeToolArgumentText(value: unknown): string {
  try {
    return safeJsonStringify(value).replace(CONTROL_TEXT_GLOBAL_RE, " ").slice(0, MAX_TOOL_ARGUMENT_CHARS);
  } catch {
    return "{}";
  }
}

function estimateMessageTextChars(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += safeClientText(m.content || "", MAX_TOKEN_COUNT_TEXT_CHARS).length;
    total += safeClientText(m.reasoning_content || "", MAX_TOKEN_COUNT_TEXT_CHARS).length;
    for (const tc of (m.tool_calls || []).slice(0, MAX_TOOL_CALLS)) {
      total += safeClientText(tc.name, 128).length + safeToolArgumentText(tc.arguments).length;
    }
    if (total > MAX_TOKENIZER_INPUT_CHARS) return total;
  }
  return total;
}

function estimateMessagesTokens(messages: Message[]): number {
  return Math.ceil(estimateMessageTextChars(messages) / 4) + messages.length * 4;
}

function normalizeUsageTelemetry(value: Record<string, unknown>): UsageTelemetry | null {
  const normalized = normalizeUsageValue(value, new WeakSet<object>(), 0);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized as UsageTelemetry
    : null;
}

function safeGet<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function safeJsonValue(value: unknown, options: Parameters<typeof toJsonSafe>[1] = {}): unknown {
  try {
    return toJsonSafe(value, options);
  } catch {
    return null;
  }
}

function isTruncatedJsonObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).truncated === true);
}

function normalizeUsageValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === "bigint") return value >= 0n ? value.toString() : undefined;
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return undefined;
  if (depth >= MAX_USAGE_DEPTH) return undefined;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const out: Record<string, unknown> = {};
  try {
    for (const [key, child] of Object.entries(value).slice(0, MAX_USAGE_KEYS)) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) continue;
      const normalized = normalizeUsageValue(child, seen, depth + 1);
      if (normalized !== undefined) out[key] = normalized;
    }
  } finally {
    seen.delete(value);
  }
  return Object.keys(out).length ? out : undefined;
}
