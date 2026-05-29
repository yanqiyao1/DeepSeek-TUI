/** Immutable request prefix for DeepSeek prompt-cache stability. */

import { createHash } from "node:crypto";
import type { Message } from "../session/types.js";
import { safeJsonStringify, toJsonSafe } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_PREFIX_SYSTEM_CHARS = 200_000;
const MAX_PREFIX_MEMORY_CHARS = 80_000;
const MAX_PREFIX_SCHEMAS = 512;
const MAX_PREFIX_SCHEMA_CHARS = 32_000;
const MAX_PREFIX_FEW_SHOTS = 50;
const MAX_PREFIX_MESSAGE_CHARS = 80_000;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface ImmutablePrefixOptions {
  systemPrompt: string;
  toolSchemas?: readonly Record<string, unknown>[];
  fewShotMessages?: readonly Message[];
  memoryIndex?: string | null;
}

export interface PrefixMetadata {
  hash: string;
  tool_count: number;
  few_shot_count: number;
  system_chars: number;
  memory_index_chars: number;
}

export interface SerializedImmutablePrefix {
  system_prompt: string;
  tool_schemas: Record<string, unknown>[];
  few_shot_messages: Message[];
  memory_index: string | null;
  hash: string;
  metadata: PrefixMetadata;
}

export class ImmutablePrefix {
  readonly systemPrompt: string;
  readonly memoryIndex: string | null;
  private readonly schemas: Record<string, unknown>[];
  private readonly fewShots: Message[];
  private hashCache: string | null = null;

  constructor(options: ImmutablePrefixOptions) {
    const systemPrompt = safePrefixProperty(options, "systemPrompt");
    const memoryIndex = safePrefixProperty(options, "memoryIndex");
    const toolSchemas = safeReadonlyArray<Record<string, unknown>>(safePrefixProperty(options, "toolSchemas"), MAX_PREFIX_SCHEMAS);
    const fewShotMessages = safeReadonlyArray<Message>(safePrefixProperty(options, "fewShotMessages"), MAX_PREFIX_FEW_SHOTS);
    this.systemPrompt = sanitizePrefixText(typeof systemPrompt === "string" ? systemPrompt : "", MAX_PREFIX_SYSTEM_CHARS);
    this.memoryIndex = typeof memoryIndex === "string" && memoryIndex.trim()
      ? sanitizePrefixText(memoryIndex.trim(), MAX_PREFIX_MEMORY_CHARS) || null
      : null;
    this.schemas = cloneJsonArray(toolSchemas)
      .map(schema => boundPrefixSchema(schema))
      .filter(schema => Object.keys(schema).length > 0);
    this.fewShots = fewShotMessages.map(boundPrefixMessage);
  }

  get hash(): string {
    if (!this.hashCache) this.hashCache = this.computeHash();
    return this.hashCache;
  }

  get metadata(): PrefixMetadata {
    return {
      hash: this.hash,
      tool_count: this.schemas.length,
      few_shot_count: this.fewShots.length,
      system_chars: this.systemPrompt.length,
      memory_index_chars: this.memoryIndex?.length ?? 0,
    };
  }

  toMessages(): Message[] {
    return [
      systemMessage(this.systemPrompt),
      ...cloneJson(this.fewShots),
    ];
  }

  toolSchemas(): Record<string, unknown>[] {
    return cloneJson(this.schemas);
  }

  hasTool(name: string): boolean {
    return this.toolNames().has(name);
  }

  toolNames(): Set<string> {
    const names = new Set<string>();
    for (const schema of this.schemas) {
      const fn = (schema as { function?: { name?: unknown } }).function;
      if (typeof fn?.name === "string" && fn.name) names.add(fn.name);
    }
    return names;
  }

  toJSON(): SerializedImmutablePrefix {
    return {
      system_prompt: this.systemPrompt,
      tool_schemas: this.toolSchemas(),
      few_shot_messages: cloneJson(this.fewShots),
      memory_index: this.memoryIndex,
      hash: this.hash,
      metadata: this.metadata,
    };
  }

  static fromJSON(value: SerializedImmutablePrefix): ImmutablePrefix {
    return new ImmutablePrefix({
      systemPrompt: safePrefixProperty(value, "system_prompt") as string,
      toolSchemas: safePrefixProperty(value, "tool_schemas") as Record<string, unknown>[],
      fewShotMessages: safePrefixProperty(value, "few_shot_messages") as Message[],
      memoryIndex: safePrefixProperty(value, "memory_index") as string | null,
    });
  }

  private computeHash(): string {
    const payload = canonicalJson({
      system: this.systemPrompt,
      tools: this.schemas,
      fewShots: this.fewShots,
      memoryIndex: this.memoryIndex,
    });
    return createHash("sha256").update(payload).digest("hex").slice(0, 16);
  }
}

export class PrefixManager {
  private current: ImmutablePrefix;

  constructor(prefix: ImmutablePrefix) {
    this.current = prefix;
  }

  get prefix(): ImmutablePrefix {
    return this.current;
  }

  get prefixHash(): string {
    return this.current.hash;
  }

  replace(prefix: ImmutablePrefix): ImmutablePrefix {
    this.current = prefix;
    return this.current;
  }
}

export function systemMessage(content: string): Message {
  return {
    role: "system",
    content,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    reasoning_content: null,
  };
}

export function stripPinnedPrefixMessages(messages: Message[], prefix: ImmutablePrefix): Message[] {
  let stripped = false;
  return messages.filter(message => {
    if (
      !stripped &&
      message.role === "system" &&
      message.name == null &&
      message.content === prefix.systemPrompt
    ) {
      stripped = true;
      return false;
    }
    return true;
  });
}

function canonicalJson(value: unknown): string {
  return safeJsonStringify(value, { sortKeys: true });
}

function cloneJson<T>(value: T): T {
  return toJsonSafe(value, { sortKeys: true }) as T;
}

function cloneJsonArray<T>(value: readonly T[]): T[] {
  return value.map(item => toJsonSafe(item, { sortKeys: true })) as T[];
}

function boundPrefixSchema(value: Record<string, unknown>): Record<string, unknown> {
  const json = safeJsonStringify(value, { sortKeys: true });
  if (json.length > MAX_PREFIX_SCHEMA_CHARS) {
    const fn = value.function && typeof value.function === "object" && !Array.isArray(value.function)
      ? value.function as Record<string, unknown>
      : {};
    return {
      type: "function",
      function: {
        name: typeof fn.name === "string" ? sanitizePrefixText(fn.name, 64) : "tool",
        description: typeof fn.description === "string" ? sanitizePrefixText(fn.description, 1_000) : "",
        parameters: { type: "object", properties: {} },
      },
    };
  }
  return value;
}

function boundPrefixMessage(message: Message): Message {
  const base = cloneJson(safePrefixObjectClone(message)) as Record<string, unknown>;
  const role = safePrefixProperty(message, "role");
  const content = safePrefixProperty(message, "content");
  const reasoningContent = safePrefixProperty(message, "reasoning_content");
  const toolCalls = safePrefixProperty(message, "tool_calls");
  const toolCallId = safePrefixProperty(message, "tool_call_id");
  const name = safePrefixProperty(message, "name");
  const isError = safePrefixProperty(message, "is_error");
  const result: Message = {
    ...base,
    role: role === "assistant" || role === "user" || role === "tool" ? role : "system",
    content: content === null ? null : sanitizePrefixText(typeof content === "string" ? content : "", MAX_PREFIX_MESSAGE_CHARS),
    reasoning_content: reasoningContent === null || reasoningContent === undefined
      ? null
      : sanitizePrefixText(typeof reasoningContent === "string" ? reasoningContent : "", MAX_PREFIX_MESSAGE_CHARS),
  };
  if (Array.isArray(toolCalls)) result.tool_calls = cloneJson(toolCalls);
  else if (toolCalls === null) result.tool_calls = null;
  if (typeof toolCallId === "string") result.tool_call_id = toolCallId;
  else if (toolCallId === null) result.tool_call_id = null;
  if (typeof name === "string") result.name = name;
  else if (name === null) result.name = null;
  if (typeof isError === "boolean") result.is_error = isError;
  else if (isError === null) result.is_error = null;
  return result;
}

function sanitizePrefixText(value: string, maxChars: number): string {
  return safeSliceTextBoundary(value.replace(CONTROL_TEXT_GLOBAL_RE, " "), maxChars);
}

function safePrefixProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeReadonlyArray<T>(value: unknown, maxItems: number): readonly T[] {
  if (!Array.isArray(value)) return [];
  const items: T[] = [];
  let length = 0;
  try {
    length = Math.min(value.length, Math.max(0, maxItems));
  } catch {
    return [];
  }
  for (let index = 0; index < length; index++) {
    try {
      items.push(value[index] as T);
    } catch {
      continue;
    }
  }
  return items;
}

function safePrefixObjectClone(value: unknown): Record<string, unknown> {
  if (!value || (typeof value !== "object" && typeof value !== "function") || Array.isArray(value)) return {};
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return {};
  }
  const clone: Record<string, unknown> = {};
  for (const key of keys) {
    const item = safePrefixProperty(value, key);
    if (item !== undefined) clone[key] = item;
  }
  return clone;
}
