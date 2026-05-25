/** Immutable request prefix for DeepSeek prompt-cache stability. */

import { createHash } from "node:crypto";
import type { Message } from "../session/types.js";
import { safeJsonStringify, toJsonSafe } from "../utils/json-safe.js";

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
    this.systemPrompt = sanitizePrefixText(options.systemPrompt, MAX_PREFIX_SYSTEM_CHARS);
    this.memoryIndex = options.memoryIndex ? sanitizePrefixText(options.memoryIndex.trim(), MAX_PREFIX_MEMORY_CHARS) || null : null;
    this.schemas = cloneJsonArray((options.toolSchemas ?? []).slice(0, MAX_PREFIX_SCHEMAS))
      .map(schema => boundPrefixSchema(schema))
      .filter(schema => Object.keys(schema).length > 0);
    this.fewShots = cloneJsonArray((options.fewShotMessages ?? []).slice(0, MAX_PREFIX_FEW_SHOTS))
      .map(boundPrefixMessage);
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
      systemPrompt: value.system_prompt,
      toolSchemas: value.tool_schemas,
      fewShotMessages: value.few_shot_messages,
      memoryIndex: value.memory_index,
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
  return {
    ...message,
    content: message.content === null ? null : sanitizePrefixText(message.content ?? "", MAX_PREFIX_MESSAGE_CHARS),
    reasoning_content: message.reasoning_content === null || message.reasoning_content === undefined
      ? null
      : sanitizePrefixText(message.reasoning_content, MAX_PREFIX_MESSAGE_CHARS),
  };
}

function sanitizePrefixText(value: string, maxChars: number): string {
  return value.replace(CONTROL_TEXT_GLOBAL_RE, " ").slice(0, maxChars);
}
