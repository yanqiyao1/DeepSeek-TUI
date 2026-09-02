/** Session persistence - JSON snapshot plus append-only event log. */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import type { Message, Session, ToolCall, ToolResult, Turn } from "./types.js";
import {
  createSession,
  normalizeArtifactIdArray,
  normalizeArtifactIndex as normalizeSessionArtifactIndex,
  normalizeToolCall as normalizeSessionToolCall,
  safeSessionString,
  safeToolArguments,
  safeToolCallId,
  safeToolName,
} from "./types.js";
import { deriveSessionTitle, normalizeSessionTitle, refreshSessionTitle } from "./title.js";
import { LEGACY_DEEPSEEK_DIR, SEEKCODE_DIR, legacyDeepseekDataPath, seekcodeDataPath } from "../paths.js";
import { safeJsonStringify, toJsonSafe } from "../utils/json-safe.js";
import { decodeUtf8Tail } from "../utils/text-boundary.js";

interface SessionListEntry {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  mode: string;
  model: string;
  workspace_path: string;
  message_count: number;
}

type StoredSessionListEntry = SessionListEntry & { duplicate_time: number };

const VALID_SESSION_MODES = new Set(["plan", "agent", "yolo"]);
const PREFIX_HASH_RE = /^[a-fA-F0-9]{16,64}$/;
const EVENT_NAME_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_STORED_MESSAGES = 10_000;
const MAX_STORED_TURNS = 5_000;
const MAX_STORED_TOOL_CALLS = 100;
const MAX_TURN_TOOL_RESULTS = 100;
const MAX_SESSION_EVENT_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_SESSION_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SESSION_LIST_ENTRIES = 2_000;
const MAX_SESSION_LIST_CANDIDATES = 20_000;
const MAX_SESSION_EVENT_LOG_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_EVENT_TRIM_BYTES = 1 * 1024 * 1024;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
let atomicWriteCounter = 0;

function primarySessionsDir(): string {
  const configured = configuredSessionsDir();
  if (configured) return resolve(configured);
  return seekcodeDataPath("sessions");
}

function legacyPrimarySessionsDir(): string | null {
  if (configuredSessionsDir()) return null;
  return legacyDeepseekDataPath("sessions");
}

function configuredSessionsDir(): string | null {
  for (const key of ["SEEKCODE_SESSIONS_DIR", "DEEPSEEK_SESSIONS_DIR"]) {
    const value = process.env[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || CONTROL_TEXT_RE.test(trimmed) || trimmed.length > 4096) continue;
    return trimmed;
  }
  return null;
}

function fallbackSessionsDir(): string {
  return resolve(process.cwd(), SEEKCODE_DIR, "sessions");
}

function legacyFallbackSessionsDir(): string {
  return resolve(process.cwd(), LEGACY_DEEPSEEK_DIR, "sessions");
}

function writeSessionDirs(): string[] {
  return [...new Set([primarySessionsDir(), fallbackSessionsDir()])];
}

function readSessionDirs(): string[] {
  return [...new Set([primarySessionsDir(), legacyPrimarySessionsDir(), fallbackSessionsDir(), legacyFallbackSessionsDir()].filter((dir): dir is string => !!dir))];
}

function safeSessionId(sessionId: unknown): string {
  if (typeof sessionId !== "string" || sessionId.includes("\0")) return "";
  const id = basename(sessionId)
    .replace(/\.json$/i, "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 128);
  return id && id !== "." && id !== ".." ? id : "";
}

function sessionEventPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.jsonl`);
}

function isMissingFileError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function readSafeRegularFile(path: string, maxBytes: number): { text: string; mtimeMs: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return { text: readFileSync(fd, "utf-8"), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function assertSafeWriteTarget(path: string, label: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to write ${label} through a symlink.`);
    if (!stat.isFile()) throw new Error(`Refusing to write ${label} over a non-file path.`);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

function cleanupAtomicTemp(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

function writeFileAtomic(path: string, payload: string, label: string): void {
  assertSafeWriteTarget(path, label);
  const dir = dirname(path);
  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${atomicWriteCounter++}.tmp`);
  try {
    writeFileSync(tmpPath, payload, { encoding: "utf-8", flag: "wx" });
    assertSafeWriteTarget(path, label);
    renameSync(tmpPath, path);
  } catch (error) {
    cleanupAtomicTemp(tmpPath);
    throw error;
  }
}

function appendFileNoFollow(path: string, payload: string, label: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    writeSync(fd, payload, undefined, "utf-8");
  } catch (error: any) {
    if (error?.code === "ELOOP") throw new Error(`Refusing to write ${label} through a symlink.`);
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function nonNegativeFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nonNegativeSafeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveSafeIntegerOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return safeSessionString(value);
}

function trimmedNonEmptyString(value: unknown): string | null {
  const text = safeSessionString(value)?.trim();
  return text ? text : null;
}

function safePathString(value: unknown): string | null {
  if (typeof value === "string" && CONTROL_TEXT_RE.test(value)) return null;
  return trimmedNonEmptyString(value);
}

function safeDateString(value: unknown, fallback: string): string {
  return trimmedNonEmptyString(value) ?? fallback;
}

function safePrefixHash(value: unknown): string | null {
  const text = trimmedNonEmptyString(value);
  return text && PREFIX_HASH_RE.test(text) ? text.toLowerCase() : null;
}

function safeEventName(value: unknown): string | null {
  const text = trimmedNonEmptyString(value);
  return text && EVENT_NAME_RE.test(text) ? text : null;
}

function parseMode(value: unknown, fallback: string): string {
  const mode = trimmedNonEmptyString(value);
  return mode && VALID_SESSION_MODES.has(mode) ? mode : fallback;
}

function normalizeToolArguments(rawArgs: unknown): Record<string, unknown> {
  let args: unknown = {};
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs;
  }
  const safe = toJsonSafe(args);
  return safe && typeof safe === "object" && !Array.isArray(safe) ? safeToolArguments(safe as Record<string, unknown>) : {};
}

function normalizeToolCall(raw: unknown): ToolCall | null {
  const toolCall = normalizeSessionToolCall(raw);
  if (!toolCall) return null;
  return { ...toolCall, arguments: normalizeToolArguments(toolCall.arguments) };
}

function normalizeMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const role = record.role as Message["role"];
  if (!["system", "user", "assistant", "tool"].includes(role)) return null;
  const toolCallId = safeToolCallId(record.tool_call_id);
  if (role === "tool" && !toolCallId) return null;

  const toolCalls = Array.isArray(record.tool_calls)
    && role === "assistant"
    ? record.tool_calls.slice(0, MAX_STORED_TOOL_CALLS).map(normalizeToolCall).filter((toolCall): toolCall is ToolCall => !!toolCall)
    : null;

  return {
    role,
    content: stringOrNull(record.content),
    tool_calls: toolCalls && toolCalls.length ? toolCalls : null,
    tool_call_id: toolCallId,
    name: safeToolName(record.name),
    reasoning_content: stringOrNull(record.reasoning_content),
    is_error: typeof record.is_error === "boolean" ? record.is_error : null,
  };
}

function normalizeToolResult(raw: unknown): ToolResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const toolCallId = safeToolCallId(record.tool_call_id);
  const name = safeToolName(record.name);
  if (!toolCallId || !name) return null;
  return {
    tool_call_id: toolCallId,
    name,
    content: stringOrNull(record.content) || "",
    is_error: record.is_error === true,
  };
}

function normalizeTurn(raw: unknown, index: number): Turn | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const toolResults = Array.isArray(record.tool_results)
    ? record.tool_results.slice(0, MAX_TURN_TOOL_RESULTS).map(normalizeToolResult).filter((toolResult): toolResult is ToolResult => !!toolResult)
    : [];
  return {
    index: positiveSafeIntegerOrFallback(record.index, index + 1),
    user_message: safeSessionString(record.user_message) ?? "",
    assistant_messages: Array.isArray(record.assistant_messages)
      ? record.assistant_messages.slice(0, MAX_STORED_MESSAGES).map(normalizeMessage).filter((message): message is Message => !!message)
      : [],
    tool_calls: Array.isArray(record.tool_calls)
      ? record.tool_calls.slice(0, MAX_STORED_TOOL_CALLS).map(normalizeToolCall).filter((toolCall): toolCall is ToolCall => !!toolCall)
      : [],
    tool_results: toolResults,
    tokens_in: nonNegativeSafeInteger(record.tokens_in),
    tokens_out: nonNegativeSafeInteger(record.tokens_out),
    cost: nonNegativeFiniteNumber(record.cost),
    duration_s: nonNegativeFiniteNumber(record.duration_s),
    artifact_ids: stringArray(record.artifact_ids),
  };
}

function normalizeSession(data: unknown, fallbackId?: string): Session {
  const base = createSession();
  const record = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const messages = Array.isArray(record.messages)
    ? record.messages.slice(-MAX_STORED_MESSAGES).map(normalizeMessage).filter((message): message is Message => !!message)
    : [];
  const workspacePath = safePathString(record.workspace_path);
  const session: Session = {
    ...base,
    id: safeSessionId(fallbackId) || safeSessionId(record.id) || base.id,
    title: normalizeSessionTitle(record.title),
    created_at: safeDateString(record.created_at, base.created_at),
    updated_at: safeDateString(record.updated_at, base.updated_at),
    mode: parseMode(record.mode, base.mode),
    model: trimmedNonEmptyString(record.model) ?? base.model,
    turns: Array.isArray(record.turns)
      ? record.turns.slice(-MAX_STORED_TURNS).map(normalizeTurn).filter((turn): turn is Turn => !!turn)
      : [],
    messages,
    cumulative_tokens_in: nonNegativeSafeInteger(record.cumulative_tokens_in),
    cumulative_tokens_out: nonNegativeSafeInteger(record.cumulative_tokens_out),
    cumulative_cost: nonNegativeFiniteNumber(record.cumulative_cost),
    workspace_path: workspacePath
      ? resolve(workspacePath)
      : base.workspace_path,
    artifact_index: normalizeArtifactIndex(record.artifact_index),
  };
  const prefixHash = safePrefixHash(record.prefix_hash);
  if (prefixHash) session.prefix_hash = prefixHash;

  if (!session.title || session.title === "Untitled session") {
    session.title = deriveSessionTitle(session);
  }
  return session;
}

function normalizeArtifactIndex(value: unknown): Record<string, string[]> {
  return normalizeSessionArtifactIndex(value);
}

function stringArray(value: unknown): string[] {
  return normalizeArtifactIdArray(value);
}

function sessionSortTime(session: Pick<Session, "updated_at">, mtimeMs = 0): number {
  const parsed = Date.parse(session.updated_at);
  return Number.isFinite(parsed) ? parsed : mtimeMs;
}

export function saveSession(session: Session): string {
  const id = safeSessionId(session.id);
  if (!id) throw new Error("Invalid session id.");
  const normalized = normalizeSession(session, id);
  Object.assign(session, normalized);
  if (!normalized.prefix_hash) delete session.prefix_hash;
  session.id = id;
  session.updated_at = new Date().toISOString();
  if (!session.title || session.title === "Untitled session") refreshSessionTitle(session);

  const payload = safeJsonStringify(session, { space: 2 });
  const errors: string[] = [];
  for (const dir of writeSessionDirs()) {
    try {
      ensureSafeSessionDir(dir);
      const snapshotPath = join(dir, `${id}.json`);
      writeFileAtomic(snapshotPath, payload, "session snapshot");
      appendSessionEvent(dir, session, "session.saved");
      return id;
    } catch (e: any) {
      errors.push(`${dir}: ${e?.message || String(e)}`);
    }
  }

  throw new Error(`Could not write session. ${errors.join(" | ")}`);
}

function appendSessionEvent(dir: string, session: Session, event: string): void {
  try {
    const eventName = safeEventName(event);
    if (!eventName) return;
    const id = safeSessionId(session.id);
    if (!id) return;
    const payload = {
      seq: Date.now(),
      session_id: id,
      event: eventName,
      created_at: safeDateString(session.updated_at, new Date().toISOString()),
      message_count: Array.isArray(session.messages) ? Math.min(session.messages.length, MAX_SESSION_EVENT_COUNT) : 0,
      turn_count: Array.isArray(session.turns) ? Math.min(session.turns.length, MAX_SESSION_EVENT_COUNT) : 0,
      cumulative_tokens_in: nonNegativeSafeInteger(session.cumulative_tokens_in),
      cumulative_tokens_out: nonNegativeSafeInteger(session.cumulative_tokens_out),
    };
    const path = sessionEventPath(dir, id);
    assertSafeWriteTarget(path, "session event log");
    trimSessionEventLog(path);
    assertSafeWriteTarget(path, "session event log");
    appendFileNoFollow(path, safeJsonStringify(payload) + "\n", "session event log");
  } catch {
    // Snapshot persistence remains authoritative if the event log append fails.
  }
}

export function loadSession(sessionId: string): Session | null {
  const safeId = safeSessionId(sessionId);
  if (!safeId) return null;
  const matches: Array<{ session: Session; time: number }> = [];
  for (const dir of readSessionDirs()) {
    if (!isSafeExistingSessionDir(dir)) continue;
    try {
      const filepath = join(dir, `${safeId}.json`);
      const file = readSafeRegularFile(filepath, MAX_SESSION_FILE_BYTES);
      if (!file) continue;
      const data = JSON.parse(file.text);
      const session = normalizeSession(data, safeId);
      matches.push({ session, time: sessionSortTime(session, file.mtimeMs) });
    } catch {
      // try next candidate
    }
  }
  return matches.sort((a, b) => b.time - a.time)[0]?.session || null;
}

export function listSessions(): SessionListEntry[] {
  const byId = new Map<string, StoredSessionListEntry>();
  for (const dir of readSessionDirs()) {
    if (!isSafeExistingSessionDir(dir)) continue;
    try {
      const files = readdirSync(dir)
        .filter(f => f.endsWith(".json"))
        .sort()
        .slice(0, MAX_SESSION_LIST_CANDIDATES);
      let accepted = 0;
      for (const f of files) {
        if (accepted >= MAX_SESSION_LIST_ENTRIES) break;
        try {
          const filepath = join(dir, f);
          const fallbackId = safeSessionId(f);
          if (!fallbackId) continue;
          const file = readSafeRegularFile(filepath, MAX_SESSION_FILE_BYTES);
          if (!file) continue;
          const data = JSON.parse(file.text);
          const session = normalizeSession(data, fallbackId);
          const previous = byId.get(session.id);
          const sessionTime = sessionSortTime(session, file.mtimeMs);
          if (previous && previous.duplicate_time >= sessionTime) continue;
          byId.set(session.id, {
            id: session.id,
            title: session.title,
            created_at: session.created_at,
            updated_at: session.updated_at,
            mode: session.mode,
            model: session.model,
            workspace_path: session.workspace_path,
            message_count: session.messages.filter(message => message.role !== "system").length,
            duplicate_time: sessionTime,
          });
          accepted++;
        } catch {
          // skip invalid session file
        }
      }
    } catch {
      // skip unreadable candidate
    }
  }
  return [...byId.values()]
    .sort((a, b) => sessionSortTime(b) - sessionSortTime(a))
    .map(({ duplicate_time: _duplicateTime, ...session }) => session);
}

export function deleteSession(sessionId: string): boolean {
  const safeId = safeSessionId(sessionId);
  if (!safeId) return false;
  let deleted = false;
  for (const dir of readSessionDirs()) {
    if (!isSafeExistingSessionDir(dir)) continue;
    try {
      const snapshotPath = join(dir, `${safeId}.json`);
      const stat = lstatSync(snapshotPath);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        unlinkSync(snapshotPath);
        deleted = true;
      }
    } catch {
      // try next candidate
    }
    try {
      const eventPath = sessionEventPath(dir, safeId);
      const stat = lstatSync(eventPath);
      if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(eventPath);
    } catch {
      // event logs are best-effort companion files
    }
  }
  return deleted;
}

function ensureSafeSessionDir(path: string): void {
  const resolved = resolve(path);
  const missing: string[] = [];
  let current = resolved;
  let anchor: string | undefined;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to use session directory through a symlink: ${path}`);
      anchor ??= current;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      missing.unshift(basename(current));
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!anchor) throw new Error(`Could not create session directory: ${path}`);
  current = anchor;
  for (const segment of missing) {
    const next = join(current, segment);
    try {
      mkdirSync(next);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to use session directory through a symlink: ${path}`);
    current = next;
  }
}

function isSafeExistingSessionDir(path: string): boolean {
  let current = resolve(path);
  try {
    while (true) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  } catch {
    return false;
  }
}

function trimSessionEventLog(path: string): void {
  try {
    const file = readFileTail(path, MAX_SESSION_EVENT_TRIM_BYTES, MAX_SESSION_EVENT_LOG_BYTES);
    if (!file || file.size <= MAX_SESSION_EVENT_LOG_BYTES) return;
    const tail = decodeUtf8Tail(file.buffer, file.size > MAX_SESSION_EVENT_TRIM_BYTES);
    const boundary = tail.indexOf("\n");
    const trimmed = boundary >= 0 ? tail.slice(boundary + 1) : tail;
    writeFileAtomic(path, trimmed.replace(CONTROL_TEXT_GLOBAL_RE, " "), "session event log");
  } catch {
    // Missing or unreadable event logs are fine; append will recreate when possible.
  }
}

function readFileTail(path: string, bytesToRead: number, minimumSize = 0): { buffer: Buffer; size: number } | null {
  if (bytesToRead <= 0) return { buffer: Buffer.alloc(0), size: 0 };
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size <= minimumSize) return { buffer: Buffer.alloc(0), size: stat.size };
    const boundedBytes = Math.min(stat.size, bytesToRead);
    if (boundedBytes <= 0) return { buffer: Buffer.alloc(0), size: stat.size };
    const buffer = Buffer.allocUnsafe(boundedBytes);
    const bytesRead = readSync(fd, buffer, 0, boundedBytes, Math.max(0, stat.size - boundedBytes));
    return { buffer: buffer.subarray(0, bytesRead), size: stat.size };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
