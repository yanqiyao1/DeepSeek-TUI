/** Session persistence — JSON snapshot plus append-only event log. */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { basename, resolve, join } from "node:path";
import type { Message, Session, ToolCall, Turn } from "./types.js";
import { createSession } from "./types.js";
import { deriveSessionTitle, refreshSessionTitle } from "./title.js";
import { LEGACY_DEEPSEEK_DIR, SEEKCODE_DIR, legacyDeepseekDataPath, seekcodeDataPath } from "../paths.js";

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

function primarySessionsDir(): string {
  if (process.env.SEEKCODE_SESSIONS_DIR) return resolve(process.env.SEEKCODE_SESSIONS_DIR);
  if (process.env.DEEPSEEK_SESSIONS_DIR) return resolve(process.env.DEEPSEEK_SESSIONS_DIR);
  return seekcodeDataPath("sessions");
}

function legacyPrimarySessionsDir(): string | null {
  if (process.env.SEEKCODE_SESSIONS_DIR || process.env.DEEPSEEK_SESSIONS_DIR) return null;
  return legacyDeepseekDataPath("sessions");
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
  if (typeof sessionId !== "string") return "";
  return basename(sessionId)
    .replace(/\.json$/i, "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 128);
}

function sessionEventPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.jsonl`);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}

function normalizeToolCall(raw: unknown): ToolCall | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object" && !Array.isArray(record.function)
    ? record.function as Record<string, unknown>
    : {};
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : typeof fn.name === "string" ? fn.name : "";
  const rawArgs = record.arguments ?? fn.arguments;
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  }
  if (!id && !name) return null;
  return { id, name, arguments: args };
}

function normalizeMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!["system", "user", "assistant", "tool"].includes(record.role as string)) return null;

  const toolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls.map(normalizeToolCall).filter((toolCall): toolCall is ToolCall => !!toolCall)
    : null;

  return {
    role: record.role as Message["role"],
    content: stringOrNull(record.content),
    tool_calls: toolCalls && toolCalls.length ? toolCalls : null,
    tool_call_id: typeof record.tool_call_id === "string" ? record.tool_call_id : null,
    name: typeof record.name === "string" ? record.name : null,
    reasoning_content: typeof record.reasoning_content === "string" ? record.reasoning_content : null,
    is_error: typeof record.is_error === "boolean" ? record.is_error : null,
  };
}

function normalizeTurn(raw: unknown, index: number): Turn | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const storedIndex = numberOrZero(record.index);
  return {
    index: storedIndex > 0 ? storedIndex : index + 1,
    user_message: typeof record.user_message === "string" ? record.user_message : "",
    assistant_messages: Array.isArray(record.assistant_messages)
      ? record.assistant_messages.map(normalizeMessage).filter((message): message is Message => !!message)
      : [],
    tool_calls: Array.isArray(record.tool_calls)
      ? record.tool_calls.map(normalizeToolCall).filter((toolCall): toolCall is ToolCall => !!toolCall)
      : [],
    tool_results: Array.isArray(record.tool_results) ? record.tool_results.map((toolResult: unknown) => {
      const tr = (toolResult && typeof toolResult === "object" ? toolResult : {}) as Record<string, unknown>;
      return {
        tool_call_id: typeof tr.tool_call_id === "string" ? tr.tool_call_id : "",
        name: typeof tr.name === "string" ? tr.name : "",
        content: stringOrNull(tr.content) || "",
        is_error: !!tr.is_error,
      };
    }) : [],
    tokens_in: numberOrZero(record.tokens_in),
    tokens_out: numberOrZero(record.tokens_out),
    cost: numberOrZero(record.cost),
    duration_s: numberOrZero(record.duration_s),
    artifact_ids: stringArray(record.artifact_ids),
  };
}

function normalizeSession(data: unknown, fallbackId?: string): Session {
  const base = createSession();
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const messages = Array.isArray(record.messages)
    ? record.messages.map(normalizeMessage).filter((message): message is Message => !!message)
    : [];
  const session: Session = {
    ...base,
    id: safeSessionId(record.id) || fallbackId || base.id,
    title: typeof record.title === "string" ? record.title.trim() : "",
    created_at: typeof record.created_at === "string" ? record.created_at : base.created_at,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : base.updated_at,
    mode: ["plan", "agent", "yolo"].includes(record.mode as string) ? record.mode as string : base.mode,
    model: typeof record.model === "string" && record.model.trim() ? record.model : base.model,
    turns: Array.isArray(record.turns)
      ? record.turns.map(normalizeTurn).filter((turn): turn is Turn => !!turn)
      : [],
    messages,
    cumulative_tokens_in: numberOrZero(record.cumulative_tokens_in),
    cumulative_tokens_out: numberOrZero(record.cumulative_tokens_out),
    cumulative_cost: numberOrZero(record.cumulative_cost),
    workspace_path: typeof record.workspace_path === "string" && record.workspace_path.trim()
      ? resolve(record.workspace_path)
      : base.workspace_path,
    artifact_index: normalizeArtifactIndex(record.artifact_index),
  };

  if (!session.title || session.title === "Untitled session") {
    session.title = deriveSessionTitle(session);
  }
  return session;
}

function normalizeArtifactIndex(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!Array.isArray(raw)) continue;
    result[key] = raw.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function sessionSortTime(session: Pick<Session, "updated_at">, mtimeMs = 0): number {
  const parsed = Date.parse(session.updated_at);
  return Number.isFinite(parsed) ? parsed : mtimeMs;
}

export function saveSession(session: Session): string {
  const id = safeSessionId(session.id);
  if (!id) throw new Error("Invalid session id.");
  session.id = id;
  session.updated_at = new Date().toISOString();
  refreshSessionTitle(session);

  const payload = JSON.stringify(session, null, 2);
  const errors: string[] = [];
  for (const dir of writeSessionDirs()) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.json`), payload, "utf-8");
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
    const payload = {
      seq: Date.now(),
      session_id: session.id,
      event,
      created_at: session.updated_at,
      message_count: session.messages.length,
      turn_count: session.turns.length,
      cumulative_tokens_in: session.cumulative_tokens_in,
      cumulative_tokens_out: session.cumulative_tokens_out,
    };
    writeFileSync(sessionEventPath(dir, session.id), JSON.stringify(payload) + "\n", { encoding: "utf-8", flag: "a" });
  } catch {
    // Snapshot persistence remains authoritative if the event log append fails.
  }
}

export function loadSession(sessionId: string): Session | null {
  const safeId = safeSessionId(sessionId);
  if (!safeId) return null;
  const matches: Array<{ session: Session; time: number }> = [];
  for (const dir of readSessionDirs()) {
    try {
      const filepath = join(dir, `${safeId}.json`);
      const data = JSON.parse(readFileSync(filepath, "utf-8"));
      const stat = statSync(filepath);
      const session = normalizeSession(data, safeId);
      matches.push({ session, time: sessionSortTime(session, stat.mtimeMs) });
    } catch {
      // try next candidate
    }
  }
  return matches.sort((a, b) => b.time - a.time)[0]?.session || null;
}

export function listSessions(): SessionListEntry[] {
  const byId = new Map<string, StoredSessionListEntry>();
  for (const dir of readSessionDirs()) {
    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        try {
          const filepath = join(dir, f);
          const data = JSON.parse(readFileSync(filepath, "utf-8"));
          const stat = statSync(filepath);
          const session = normalizeSession(data, safeSessionId(f));
          const previous = byId.get(session.id);
          const sessionTime = sessionSortTime(session, stat.mtimeMs);
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
    try {
      unlinkSync(join(dir, `${safeId}.json`));
      deleted = true;
    } catch {
      // try next candidate
    }
  }
  return deleted;
}
