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
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

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
    const apiKey = normalizeApiKey(safeProperty(opts, "apiKey"));
    const baseURL = normalizeBaseUrl(safeProperty(opts, "baseUrl"));
    const model = normalizeModel(safeProperty(opts, "model"));
    this.provider = parseProvider(safeProperty(opts, "provider"));
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
    const signal = normalizeAbortSignal(safeProperty(options, "signal"));
    const reasoningEffort = normalizeReasoningEffortOption(safeProperty(options, "reasoning_effort"));
    throwIfAborted(signal);
    const apiMessages = sanitizeMessagesForThinkingMode(
      safeArrayItemsFromEnd(messages, MAX_REQUEST_MESSAGES).map(message => messageToApiDict(message as Message)),
      this.model,
      reasoningEffort,
    ) as unknown as ChatCompletionMessageParam[];

    const effectiveMaxTokens = Math.min(normalizeMaxTokens(safeProperty(options, "max_tokens")), this.capability.max_output);

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
    applyReasoningEffort(request, reasoningEffort, this.provider, this.capability.thinking_supported);

    const stream = signal
      ? await this.client.chat.completions.create(request as any, { signal } as any) as any
      : await this.client.chat.completions.create(request as any) as any;

    let accumulatedContent = "";
    let accumulatedReasoning = "";
    const toolCallsAcc: Map<number, { id: string; name: string; arguments: string; began: boolean }> = new Map();
    const begunToolCallIds = new Set<string>();
    let finishReason = "stop";
    let streamUsage: UsageTelemetry | null = null;

    const iterator = safeAsyncIterator(stream);
    if (!iterator) throw new Error("API stream is not async iterable");
    const abortStream = () => {
      void safeIteratorReturn(iterator);
    };
    addAbortListener(signal, abortStream);
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value: chunk } = await safeIteratorNext(iterator);
        if (done) break;
        throwIfAborted(signal);
        const firstChoice = safeFirstChoice(chunk);
        const delta = safeProperty(firstChoice, "delta");
        const chunkUsage = asRecord(safeProperty(chunk, "usage"));
        if (chunkUsage) {
          const usage = normalizeUsageTelemetry(chunkUsage);
          if (usage) streamUsage = usage;
        }
        const deltaRecord = asRecord(delta);
        if (!deltaRecord) continue;

        // Content
        const contentDelta = safeProperty(deltaRecord, "content");
        if (typeof contentDelta === "string" && contentDelta.length > 0) {
          const text = sanitizeStreamText(contentDelta, remainingChars(accumulatedContent, MAX_STREAM_TEXT_CHARS));
          if (text) {
            accumulatedContent += text;
            yield { type: "content", text } as ContentDelta;
          }
        }

        // Reasoning (DeepSeek-specific, in model_extra or directly)
        const rawReasoning = safeProperty(deltaRecord, "reasoning_content");
        const reasoning = typeof rawReasoning === "string" ? rawReasoning : "";
        if (reasoning.length > 0) {
          const text = sanitizeStreamText(reasoning, remainingChars(accumulatedReasoning, MAX_STREAM_TEXT_CHARS));
          if (text) {
            accumulatedReasoning += text;
            yield { type: "thinking", text } as ThinkingDelta;
          }
        }

        // Tool calls
        const tcDeltas = safeArrayItems(safeProperty(deltaRecord, "tool_calls"), MAX_TOOL_CALLS);
        for (const tc of tcDeltas) {
          const tcRecord = asRecord(tc);
          if (!tcRecord) continue;
          const idx = normalizeToolCallIndex(safeProperty(tcRecord, "index"));
          if (idx === null) continue;
          if (!toolCallsAcc.has(idx) && toolCallsAcc.size >= MAX_TOOL_CALLS) continue;
          if (!toolCallsAcc.has(idx)) {
            toolCallsAcc.set(idx, { id: "", name: "", arguments: "", began: false });
          }
          const acc = toolCallsAcc.get(idx)!;
          const id = normalizeToolCallId(safeProperty(tcRecord, "id"));
          if (id) acc.id = id;
          const fn = asRecord(safeProperty(tcRecord, "function"));
          const name = normalizeToolName(safeProperty(fn, "name"));
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
          const rawArguments = safeProperty(fn, "arguments");
          if (typeof rawArguments === "string" && rawArguments.length > 0) {
            const argumentsDelta = sanitizeToolArgumentsDelta(rawArguments, acc.arguments);
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

        const fin = safeProperty(firstChoice, "finish_reason");
        if (typeof fin === "string" && fin) finishReason = normalizeFinishReason(fin);
      }
    } finally {
      removeAbortListener(signal, abortStream);
      if (isAborted(signal)) {
        await safeIteratorReturn(iterator);
      }
    }
    throwIfAborted(signal);

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
    const safeMessages = safeArrayItemsFromEnd(messages, MAX_REQUEST_MESSAGES);
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
        let text = safeClientText(safeProperty(m, "content"), MAX_TOKEN_COUNT_TEXT_CHARS);
        text += safeClientText(safeProperty(m, "reasoning_content"), MAX_TOKEN_COUNT_TEXT_CHARS);
        for (const tc of safeArrayItems(safeProperty(m, "tool_calls"), MAX_TOOL_CALLS)) {
          text += safeClientText(safeProperty(tc, "name"), 128) + safeToolArgumentText(safeProperty(tc, "arguments"));
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

function normalizeMaxTokens(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : Number.isFinite(value) && (value as number) > 0
      ? Math.floor(value as number)
      : 8192;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!isAborted(signal)) return;
  throw new DOMException("Request aborted", "AbortError");
}

export function sanitizeMessagesForThinkingMode(
  messages: Record<string, unknown>[],
  model: string,
  effort?: string | null,
): Record<string, unknown>[] {
  const safeMessages = safeArrayItems(messages, MAX_REQUEST_MESSAGES).map(cloneRequestMessage);
  if (!shouldReplayReasoningContent(model, effort)) {
    return safeMessages.map(stripReasoningContent);
  }

  const sanitized = safeMessages;
  for (const message of sanitized) {
    if (safeProperty(message, "role") !== "assistant") continue;
    const rawReasoning = safeProperty(message, "reasoning_content");
    const reasoning = typeof rawReasoning === "string" ? rawReasoning.trim() : "";
    if (!reasoning) message.reasoning_content = "(reasoning omitted)";
    const content = safeProperty(message, "content");
    if (content === undefined || content === null) {
      message.content = "";
    }
  }
  return sanitized;
}

function stripReasoningContent(message: Record<string, unknown>): Record<string, unknown> {
  delete message.reasoning_content;
  return message;
}

function normalizeApiKey(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || CONTROL_TEXT_RE.test(trimmed) || trimmed.length > 4096) throw new Error("apiKey must be a non-empty string.");
  return trimmed;
}

function normalizeBaseUrl(value: unknown): string {
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

function normalizeModel(value: unknown): string {
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
  const normalized: Record<string, unknown>[] = [];
  for (const tool of safeArrayItems(tools, MAX_TOOL_SCHEMAS)) {
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
  return safeSliceTextBoundary(value.replace(CONTROL_TEXT_GLOBAL_RE, " "), maxChars);
}

function sanitizeToolArgumentsDelta(value: string, current: string): string {
  return sanitizeStreamText(value, remainingChars(current, MAX_TOOL_ARGUMENT_CHARS));
}

function safeClientText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? safeSliceTextBoundary(value.replace(CONTROL_TEXT_GLOBAL_RE, " "), maxChars) : "";
}

function safeToolArgumentText(value: unknown): string {
  try {
    return safeSliceTextBoundary(safeJsonStringify(value).replace(CONTROL_TEXT_GLOBAL_RE, " "), MAX_TOOL_ARGUMENT_CHARS);
  } catch {
    return "{}";
  }
}

function estimateMessageTextChars(messages: unknown[]): number {
  let total = 0;
  for (const m of messages) {
    total += safeClientText(safeProperty(m, "content"), MAX_TOKEN_COUNT_TEXT_CHARS).length;
    total += safeClientText(safeProperty(m, "reasoning_content"), MAX_TOKEN_COUNT_TEXT_CHARS).length;
    for (const tc of safeArrayItems(safeProperty(m, "tool_calls"), MAX_TOOL_CALLS)) {
      total += safeClientText(safeProperty(tc, "name"), 128).length + safeToolArgumentText(safeProperty(tc, "arguments")).length;
    }
    if (total > MAX_TOKENIZER_INPUT_CHARS) return total;
  }
  return total;
}

function estimateMessagesTokens(messages: unknown[]): number {
  return Math.ceil(estimateMessageTextChars(messages) / 4) + messages.length * 4;
}

function normalizeUsageTelemetry(value: Record<string, unknown>): UsageTelemetry | null {
  const normalized = normalizeUsageValue(value, new WeakSet<object>(), 0);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized as UsageTelemetry
    : null;
}

function safeJsonValue(value: unknown, options: Parameters<typeof toJsonSafe>[1] = {}): unknown {
  try {
    return toJsonSafe(value, options);
  } catch {
    return null;
  }
}

function isTruncatedJsonObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && safeProperty(value, "truncated") === true);
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
    for (const [key, child] of safeObjectEntries(value, MAX_USAGE_KEYS)) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) continue;
      const normalized = normalizeUsageValue(child, seen, depth + 1);
      if (normalized !== undefined) out[key] = normalized;
    }
  } finally {
    seen.delete(value);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeReasoningEffortOption(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeAbortSignal(value: unknown): AbortSignal | undefined {
  if (!value || typeof value !== "object") return undefined;
  return typeof safeProperty(value, "aborted") === "boolean" ? value as AbortSignal : undefined;
}

function isAborted(signal?: AbortSignal): boolean {
  return safeProperty(signal, "aborted") === true;
}

function addAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
  const addEventListener = safeProperty(signal, "addEventListener");
  if (typeof addEventListener !== "function") return;
  try {
    addEventListener.call(signal, "abort", listener, { once: true });
  } catch {
    // ignore invalid or hostile signal objects
  }
}

function removeAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
  const removeEventListener = safeProperty(signal, "removeEventListener");
  if (typeof removeEventListener !== "function") return;
  try {
    removeEventListener.call(signal, "abort", listener);
  } catch {
    // ignore invalid or hostile signal objects
  }
}

function safeAsyncIterator(stream: unknown): AsyncIterator<unknown> | null {
  const iteratorFactory = safeProperty(stream, Symbol.asyncIterator);
  if (typeof iteratorFactory !== "function") return null;
  try {
    const iterator = iteratorFactory.call(stream);
    return iterator && typeof iterator === "object" && typeof safeProperty(iterator, "next") === "function"
      ? iterator as AsyncIterator<unknown>
      : null;
  } catch {
    return null;
  }
}

async function safeIteratorNext(iterator: AsyncIterator<unknown>): Promise<{ done: boolean; value: unknown }> {
  const next = safeProperty(iterator, "next");
  if (typeof next !== "function") throw new Error("API stream is not async iterable");
  const result = await next.call(iterator);
  if (!result || typeof result !== "object") return { done: true, value: undefined };
  const done = safeProperty(result, "done");
  const value = safeProperty(result, "value");
  return {
    done: done === true || (done !== false && value === undefined),
    value,
  };
}

async function safeIteratorReturn(iterator: AsyncIterator<unknown>): Promise<void> {
  const returnFn = safeProperty(iterator, "return");
  if (typeof returnFn !== "function") return;
  try {
    await returnFn.call(iterator);
  } catch {
    // ignore cleanup failures
  }
}

function safeFirstChoice(chunk: unknown): unknown {
  return safeArrayItems(safeProperty(chunk, "choices"), 1)[0];
}

function cloneRequestMessage(message: unknown): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of safeObjectEntries(message, 64)) {
    cloned[key] = value;
  }
  return cloned;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeProperty(source: unknown, key: string | symbol): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string | symbol, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeArrayItems(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return [];
  }
  const limit = Math.min(length, Math.max(0, Math.floor(maxItems)));
  const items: unknown[] = [];
  for (let index = 0; index < limit; index++) {
    try {
      items.push(value[index]);
    } catch {
      items.push(undefined);
    }
  }
  return items;
}

function safeArrayItemsFromEnd(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return [];
  }
  const limit = Math.max(0, Math.floor(maxItems));
  const start = Math.max(0, length - limit);
  const items: unknown[] = [];
  for (let index = start; index < length; index++) {
    try {
      items.push(value[index]);
    } catch {
      items.push(undefined);
    }
  }
  return items;
}

function safeObjectEntries(value: unknown, maxEntries: number): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys.slice(0, Math.max(0, Math.floor(maxEntries)))) {
    entries.push([key, safeProperty(value, key)]);
  }
  return entries;
}
