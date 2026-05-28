/** Core session dataclasses: Message, ToolCall, Session, Turn. */

import { safeJsonStringify, toJsonSafe } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const TOOL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const MAX_SESSION_STRING_CHARS = 1_000_000;
const MAX_TOOL_CALLS = 100;
const MAX_TOOL_ARGUMENT_CHARS = 1_000_000;
const MAX_ARTIFACT_IDS = 500;
const MAX_ARTIFACT_INDEX_KEYS = 1_000;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const VALID_SESSION_MODES = new Set(["plan", "agent", "yolo"]);
const PREFIX_HASH_RE = /^[a-fA-F0-9]{16,64}$/;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  is_error: boolean;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string | null;
  name?: string | null;
  reasoning_content?: string | null;
  is_error?: boolean | null;
}

export function messageToApiDict(m: Message): Record<string, unknown> {
  const d: Record<string, unknown> = { role: safeProperty(m, "role") };
  const content = safeSessionString(safeProperty(m, "content"));
  if (content !== null) d.content = content;
  const toolCalls = normalizeToolCalls(safeProperty(m, "tool_calls"));
  if (toolCalls.length > 0) {
    d.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: safeJsonStringify(tc.arguments),
      },
    }));
  }
  const toolCallId = safeToolCallId(safeProperty(m, "tool_call_id"));
  const name = safeToolName(safeProperty(m, "name"));
  const reasoningContent = safeSessionString(safeProperty(m, "reasoning_content"));
  if (toolCallId) d.tool_call_id = toolCallId;
  if (name) d.name = name;
  if (reasoningContent) d.reasoning_content = reasoningContent;
  return d;
}

export function toolCallFromApi(tc: Record<string, unknown>): ToolCall {
  const functionValue = safeProperty(tc, "function");
  const fn = functionValue && typeof functionValue === "object" && !Array.isArray(functionValue)
    ? functionValue as Record<string, unknown>
    : {};
  let args = safeProperty(tc, "arguments") ?? safeProperty(fn, "arguments") ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    args = {};
  } else {
    try {
      args = toJsonSafe(args) as Record<string, unknown>;
      if (isTruncatedJsonObject(args)) args = {};
    } catch {
      args = {};
    }
  }
  return {
    id: safeToolCallId(safeProperty(tc, "id")) ?? "",
    name: safeToolName(safeProperty(tc, "name")) ?? safeToolName(safeProperty(fn, "name")) ?? "",
    arguments: safeToolArguments(args as Record<string, unknown>),
  };
}

export function normalizeToolCall(toolCall: unknown): ToolCall | null {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return null;
  const record = toolCall as Record<string, unknown>;
  const normalized = toolCallFromApi(record);
  return normalized.id && normalized.name ? normalized : null;
}

export function normalizeToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  const normalized: ToolCall[] = [];
  const seen = new Set<string>();
  for (const rawToolCall of safeArrayItems(toolCalls, MAX_TOOL_CALLS)) {
    const toolCall = normalizeToolCall(rawToolCall);
    if (!toolCall || seen.has(toolCall.id)) continue;
    seen.add(toolCall.id);
    normalized.push(toolCall);
  }
  return normalized;
}

export function safeSessionString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  return safeSliceTextBoundary(value.replace(CONTROL_TEXT_GLOBAL_RE, " "), MAX_SESSION_STRING_CHARS);
}

export function safeToolCallId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && TOOL_ID_RE.test(id) && !CONTROL_TEXT_RE.test(id) ? id : null;
}

export function safeToolName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && TOOL_NAME_RE.test(name) && !CONTROL_TEXT_RE.test(name) ? name : null;
}

export function safeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  let json = "{}";
  try {
    json = safeJsonStringify(args);
  } catch {
    return {};
  }
  if (json.length > MAX_TOOL_ARGUMENT_CHARS) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && !isTruncatedJsonObject(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isTruncatedJsonObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).truncated === true);
}

export function cloneToolCall(toolCall: ToolCall): ToolCall {
  return {
    id: safeToolCallId(safeProperty(toolCall, "id")) ?? "",
    name: safeToolName(safeProperty(toolCall, "name")) ?? "",
    arguments: safeToolArguments(asRecord(safeProperty(toolCall, "arguments")) ?? {}),
  };
}

export function cloneMessage(message: Message): Message {
  const role = safeProperty(message, "role");
  const toolCalls = role === "assistant" ? normalizeToolCalls(safeProperty(message, "tool_calls")).map(cloneToolCall) : [];
  const isError = safeProperty(message, "is_error");
  return {
    role: role === "system" || role === "user" || role === "assistant" || role === "tool" ? role : "user",
    content: safeSessionString(safeProperty(message, "content")),
    tool_calls: toolCalls.length ? toolCalls : null,
    tool_call_id: safeToolCallId(safeProperty(message, "tool_call_id")),
    name: safeToolName(safeProperty(message, "name")),
    reasoning_content: safeSessionString(safeProperty(message, "reasoning_content")),
    is_error: typeof isError === "boolean" ? isError : null,
  };
}

export function cloneToolResult(result: ToolResult): ToolResult | null {
  const toolCallId = safeToolCallId(safeProperty(result, "tool_call_id"));
  const name = safeToolName(safeProperty(result, "name"));
  if (!toolCallId || !name) return null;
  return {
    tool_call_id: toolCallId,
    name,
    content: safeSessionString(safeProperty(result, "content")) ?? "",
    is_error: safeProperty(result, "is_error") === true,
  };
}

export function normalizeArtifactIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of safeArrayItems(value, MAX_ARTIFACT_IDS)) {
    if (typeof item !== "string" || item.includes("\0")) continue;
    const id = item.trim();
    if (!id || id.length > 256 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function normalizeArtifactIndex(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [key, raw] of safeObjectEntries(value, MAX_ARTIFACT_INDEX_KEYS)) {
    if (!isSafeArtifactIndexKey(key)) continue;
    result[key] = normalizeArtifactIdArray(raw);
  }
  return result;
}

function isSafeArtifactIndexKey(value: string): boolean {
  return value === "session" || /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
}

function safeSessionId(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const filename = value.split(/[\\/]/).pop() ?? "";
  const id = filename.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128);
  return id && id !== "." && id !== ".." ? id : null;
}

function safeSessionTitle(value: unknown, fallback: string): string {
  const title = safeSessionString(value)?.trim();
  return title ? title : fallback;
}

function safeDateString(value: unknown, fallback: string): string {
  const text = safeSessionString(value)?.trim();
  return text ? text : fallback;
}

function safeMode(value: unknown, fallback: string): string {
  const mode = safeSessionString(value)?.trim();
  return mode && VALID_SESSION_MODES.has(mode) ? mode : fallback;
}

function safeModel(value: unknown, fallback: string): string {
  const model = safeSessionString(value)?.trim();
  return model ? model : fallback;
}

function safeWorkspacePath(value: unknown, fallback: string): string {
  if (typeof value === "string" && CONTROL_TEXT_RE.test(value)) return fallback;
  const path = safeSessionString(value)?.trim();
  return path && !CONTROL_TEXT_RE.test(path) ? path : fallback;
}

function nonNegativeSafeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function nonNegativeFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizePrefixHash(value: unknown): string | undefined {
  const text = safeSessionString(value)?.trim();
  return text && PREFIX_HASH_RE.test(text) ? text.toLowerCase() : undefined;
}

function normalizeTurnForCreate(turn: unknown, index: number): Turn | null {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
  const record = turn as Record<string, unknown>;
  const assistantMessages = safeProperty(record, "assistant_messages");
  const toolResults = safeProperty(record, "tool_results");
  const normalized: Turn = {
    index: positiveSafeInteger(safeProperty(record, "index")) ?? index + 1,
    user_message: safeSessionString(safeProperty(record, "user_message")) ?? "",
    assistant_messages: Array.isArray(assistantMessages)
      ? safeArrayItems(assistantMessages, Number.POSITIVE_INFINITY).map(message => cloneMessage(message as Message)).filter(message => message.role === "assistant")
      : [],
    tool_calls: normalizeToolCalls(safeProperty(record, "tool_calls")).map(cloneToolCall),
    tool_results: Array.isArray(toolResults)
      ? safeArrayItems(toolResults, Number.POSITIVE_INFINITY).map(result => cloneToolResult(result as ToolResult)).filter((result): result is ToolResult => !!result)
      : [],
    tokens_in: nonNegativeSafeInteger(safeProperty(record, "tokens_in")),
    tokens_out: nonNegativeSafeInteger(safeProperty(record, "tokens_out")),
    cost: nonNegativeFiniteNumber(safeProperty(record, "cost")),
    duration_s: nonNegativeFiniteNumber(safeProperty(record, "duration_s")),
    artifact_ids: normalizeArtifactIdArray(safeProperty(record, "artifact_ids")),
  };
  return normalized;
}

export interface Turn {
  index: number;
  user_message: string;
  assistant_messages: Message[];
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
  tokens_in: number;
  tokens_out: number;
  cost: number;
  duration_s: number;
  artifact_ids?: string[];
}

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  mode: string;
  model: string;
  turns: Turn[];
  messages: Message[];
  cumulative_tokens_in: number;
  cumulative_tokens_out: number;
  cumulative_cost: number;
  workspace_path: string;
  artifact_index: Record<string, string[]>;
  prefix_hash?: string;
}

export function createSession(opts?: Partial<Session>): Session {
  const session: Session = {
    id: Math.random().toString(36).slice(2, 14),
    title: "Untitled session",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    mode: "agent",
    model: "deepseek-v4-pro",
    turns: [],
    messages: [],
    cumulative_tokens_in: 0,
    cumulative_tokens_out: 0,
    cumulative_cost: 0,
    workspace_path: process.cwd(),
    artifact_index: {},
  };
  if (!opts) return session;
  const merged = opts as Partial<Session>;
  const turns = safeProperty(merged, "turns");
  const messages = safeProperty(merged, "messages");
  const normalized: Session = {
    ...session,
    id: safeSessionId(safeProperty(merged, "id")) ?? session.id,
    title: safeSessionTitle(safeProperty(merged, "title"), session.title),
    created_at: safeDateString(safeProperty(merged, "created_at"), session.created_at),
    updated_at: safeDateString(safeProperty(merged, "updated_at"), session.updated_at),
    mode: safeMode(safeProperty(merged, "mode"), session.mode),
    model: safeModel(safeProperty(merged, "model"), session.model),
    turns: Array.isArray(turns)
      ? safeArrayItems(turns, Number.POSITIVE_INFINITY).map(normalizeTurnForCreate).filter((turn): turn is Turn => !!turn)
      : session.turns,
    messages: Array.isArray(messages) ? safeArrayItems(messages, Number.POSITIVE_INFINITY).map(message => cloneMessage(message as Message)) : session.messages,
    cumulative_tokens_in: nonNegativeSafeInteger(safeProperty(merged, "cumulative_tokens_in")),
    cumulative_tokens_out: nonNegativeSafeInteger(safeProperty(merged, "cumulative_tokens_out")),
    cumulative_cost: nonNegativeFiniteNumber(safeProperty(merged, "cumulative_cost")),
    workspace_path: safeWorkspacePath(safeProperty(merged, "workspace_path"), session.workspace_path),
    artifact_index: normalizeArtifactIndex(safeProperty(merged, "artifact_index")),
  };
  const prefixHash = normalizePrefixHash(safeProperty(merged, "prefix_hash"));
  if (prefixHash) normalized.prefix_hash = prefixHash;
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  try {
    return (source as Record<string, unknown>)[key];
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
  const limit = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : length;
  const items: unknown[] = [];
  for (let index = 0; index < Math.min(length, limit); index++) {
    try {
      items.push(value[index]);
    } catch {
      continue;
    }
  }
  return items;
}

function safeObjectEntries(value: object, maxEntries: number): Array<[string, unknown]> {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys.slice(0, maxEntries)) {
    try {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      entries.push([key, []]);
    }
  }
  return entries;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
