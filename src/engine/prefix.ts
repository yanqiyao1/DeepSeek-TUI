/** Immutable request prefix for DeepSeek prompt-cache stability. */

import { createHash } from "node:crypto";
import type { Message } from "../session/types.js";

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
    this.systemPrompt = options.systemPrompt;
    this.memoryIndex = options.memoryIndex?.trim() || null;
    this.schemas = cloneJsonArray(options.toolSchemas ?? []);
    this.fewShots = cloneJsonArray(options.fewShotMessages ?? []);
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
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = canonicalize(child);
  }
  return out;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneJsonArray<T>(value: readonly T[]): T[] {
  return JSON.parse(JSON.stringify(value)) as T[];
}
