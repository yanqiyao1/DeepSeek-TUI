/** Request handlers for HTTP/SSE server using Hono. */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { loadConfig, type Config } from "../config.js";
import { DeepSeekClient } from "../client/deepseek.js";
import type { EngineRuntimeEvent } from "../engine/events.js";
import { getRegistry } from "../tools/registry.js";
import { getMode } from "../modes/base.js";
import { Engine } from "../engine/loop.js";
import { createSession } from "../session/types.js";
import { SkillRegistry } from "../engine/skills.js";
import { buildPinnedPrefix } from "../engine/prefix-builder.js";
import { systemMessage } from "../engine/prefix.js";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import {
  appendEvent,
  appendRuntimeItem,
  createRuntimeRecord,
  createTurn,
  deleteRuntimeRecordBySession,
  forkRuntimeThread,
  getRuntimeRecord,
  getRuntimeRecordBySession,
  listRuntimeRecords,
  replayRuntimeEvents,
  replayRuntimeItems,
  setRuntimePrefix,
  subscribeRuntimeEvents,
  updateRuntimeThread,
  updateTurn,
  type RuntimeEvent,
  type RuntimeRecord,
} from "./runtime-store.js";
import { registerBuiltInTools } from "../tools/setup.js";
import { VERSION } from "../version.js";
import { isSpeculativeRuntimeEvent, runtimeEventToSSE } from "./runtime-protocol.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

let toolsReadyKey = "";
function ensureTools(config?: Config, workspacePath = process.cwd()) {
  const key = safeJsonStringify({ web: config?.web ?? {}, workspace: workspacePath }, { sortKeys: true });
  if (toolsReadyKey === key && getRegistry().size > 0) return;
  toolsReadyKey = key;
  registerBuiltInTools(config, { clear: true, workspacePath });
}

const VALID_THREAD_MODES = new Set<Config["mode"]>(["plan", "agent", "yolo"]);
const MAX_JSON_BODY_CHARS = 1_000_000;
const MAX_TEXT_FIELD_CHARS = 4_096;
const MAX_CHAT_MESSAGE_CHARS = 200_000;
const MAX_SEARCH_QUERY_CHARS = 200;
const MAX_RUNTIME_ID_CHARS = 128;
const MAX_SSE_PENDING_EVENTS = 1_000;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const UNSAFE_DECODED_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/;

type JsonObject = Record<string, unknown>;

async function readJsonObject(c: Context): Promise<JsonObject | null> {
  const contentLength = c.req.header("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_JSON_BODY_CHARS) return null;
  const raw = await c.req.text().catch(() => "");
  if (!raw || raw.length > MAX_JSON_BODY_CHARS || CONTROL_TEXT_RE.test(raw)) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  return body && typeof body === "object" && !Array.isArray(body) ? body as JsonObject : null;
}

function requestId(c: Context, name: string): string {
  return sanitizeId(c.req.param(name) || "");
}

function sanitizeId(value: string): string {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_RUNTIME_ID_CHARS && !UNSAFE_DECODED_RE.test(trimmed) ? trimmed : "";
}

function parseOptionalTextField(body: JsonObject, field: string): { value?: string; error?: string } {
  const raw = body[field];
  if (raw === undefined) return {};
  if (typeof raw !== "string") return { error: `${field} must be a string` };
  const value = raw.trim();
  if (!value) return { error: `${field} must be a non-empty string` };
  if (value.length > MAX_TEXT_FIELD_CHARS) return { error: `${field} is too long` };
  if (UNSAFE_DECODED_RE.test(value)) return { error: `${field} must not contain control characters` };
  return { value };
}

function parseOptionalMode(body: JsonObject): { value?: Config["mode"]; error?: string } {
  const raw = body.mode;
  if (raw === undefined) return {};
  if (typeof raw !== "string") return { error: "mode must be a string" };
  const value = raw.trim();
  if (!value || !VALID_THREAD_MODES.has(value as Config["mode"])) {
    return { error: "mode must be one of plan, agent, or yolo" };
  }
  return { value: value as Config["mode"] };
}

function parseChatMessage(value: unknown): { value?: string; error?: string } {
  if (typeof value !== "string") return { error: "message must be a string" };
  if (!value.trim()) return { error: "message required" };
  if (value.length > MAX_CHAT_MESSAGE_CHARS) return { error: "message is too long" };
  if (UNSAFE_DECODED_RE.test(value)) return { error: "message must not contain control characters" };
  return { value };
}

function parseBooleanQuery(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function parseBoundedQueryInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

function parseSinceSeq(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  if (!/^\d+$/.test(raw.trim())) return 0;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed)) return 0;
  return Math.max(0, parsed);
}

export async function health(c: Context) {
  return c.json({ status: "ok", version: VERSION });
}

export async function openApiHandler(c: Context) {
  return c.json({
    openapi: "3.1.0",
    info: { title: "Seek Code Runtime API", version: VERSION },
    paths: {
      "/v1/health": { get: { summary: "Health check" } },
      "/v1/session": { post: { summary: "Create a session and runtime thread" } },
      "/v1/sessions": { get: { summary: "List runtime sessions" } },
      "/v1/sessions/{session_id}": {
        get: { summary: "Get a session" },
        delete: { summary: "Delete a session" },
      },
      "/v1/sessions/{session_id}/resume-thread": { post: { summary: "Resume a session thread" } },
      "/v1/session/{session_id}/chat": { post: { summary: "Run a chat turn over SSE" } },
      "/v1/threads": {
        get: { summary: "List runtime threads" },
        post: { summary: "Create a runtime thread" },
      },
      "/v1/threads/{thread_id}": {
        get: { summary: "Get a runtime thread" },
        patch: { summary: "Update a runtime thread" },
      },
      "/v1/threads/{thread_id}/fork": { post: { summary: "Fork a runtime thread" } },
      "/v1/threads/{thread_id}/events": { get: { summary: "Replay runtime SSE events" } },
      "/v1/threads/{thread_id}/items": { get: { summary: "Replay normalized runtime items" } },
      "/v1/threads/{thread_id}/turns/{turn_id}/interrupt": { post: { summary: "Interrupt a running turn" } },
      "/v1/tools": { get: { summary: "List registered tools" } },
      "/v1/skills": { get: { summary: "List discovered skills" } },
    },
  });
}

export async function createSessionHandler(c: Context) {
  const cfg = loadConfig();
  const session = createSession({ model: cfg.model, mode: cfg.mode });
  const record = createRuntimeRecord(cfg, session);
  ensureTools(cfg, session.workspace_path || process.cwd());
  const prefix = buildPinnedPrefix(cfg, session.workspace_path || process.cwd(), getRegistry());
  session.prefix_hash = prefix.hash;
  record.history.addSystem(prefix.systemPrompt);
  setRuntimePrefix(record, prefix);
  return c.json({ session_id: session.id, thread_id: record.thread.id, prefix_hash: prefix.hash });
}

export async function getSessionHandler(c: Context) {
  const id = requestId(c, "session_id");
  if (!id) return c.json({ error: "invalid session id" }, 400);
  const record = getRuntimeRecordBySession(id);
  if (!record) return c.json({ error: "Session not found" }, 404);
  return c.json({
    id: record.session.id,
    thread_id: record.thread.id,
    mode: record.session.mode,
    model: record.session.model,
    message_count: record.session.messages.length,
    prefix_hash: record.prefix?.hash ?? record.session.prefix_hash,
  });
}

export async function listSessionsHandler(c: Context) {
  const limit = parseBoundedQueryInt(c.req.query("limit"), 50, 1, 200);
  const search = sanitizeQueryText(c.req.query("search") || "", MAX_SEARCH_QUERY_CHARS).toLowerCase();
  const sessions = listRuntimeRecords()
    .filter(record => !search || record.session.title.toLowerCase().includes(search) || record.session.id.includes(search))
    .slice(0, limit)
    .map(record => ({
      id: record.session.id,
      thread_id: record.thread.id,
      title: record.session.title,
      updated_at: record.thread.updated_at,
      mode: record.session.mode,
      model: record.session.model,
      message_count: record.session.messages.length,
      prefix_hash: record.prefix?.hash || record.session.prefix_hash,
    }));
  return c.json({ sessions });
}

export async function deleteSessionHandler(c: Context) {
  const id = requestId(c, "session_id");
  if (!id) return c.json({ error: "invalid session id" }, 400);
  return deleteRuntimeRecordBySession(id) ? c.json({ deleted: true, id }) : c.json({ error: "Session not found" }, 404);
}

export async function resumeSessionThreadHandler(c: Context) {
  const id = requestId(c, "session_id");
  if (!id) return c.json({ error: "invalid session id" }, 400);
  const record = getRuntimeRecordBySession(id);
  if (!record) return c.json({ error: "Session not found" }, 404);
  return c.json({ thread_id: record.thread.id, session_id: id, summary: `Resumed session ${id} into thread ${record.thread.id}` });
}

export async function listThreadsHandler(c: Context) {
  const limit = parseBoundedQueryInt(c.req.query("limit"), 50, 1, 200);
  const includeArchived = parseBooleanQuery(c.req.query("include_archived"));
  const threads = listRuntimeRecords()
    .filter(record => includeArchived || !record.thread.archived)
    .slice(0, limit)
    .map(record => record.thread);
  return c.json({ threads });
}

export async function createThreadHandler(c: Context) {
  const cfg = loadConfig();
  const body = await readJsonObject(c);
  if (!body) {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const model = parseOptionalTextField(body, "model");
  if (model.error) return c.json({ error: model.error }, 400);
  const mode = parseOptionalMode(body);
  if (mode.error) return c.json({ error: mode.error }, 400);
  const workspace = parseOptionalTextField(body, "workspace");
  if (workspace.error) return c.json({ error: workspace.error }, 400);
  const session = createSession({
    model: model.value || cfg.model,
    mode: mode.value || cfg.mode,
    workspace_path: workspace.value || process.cwd(),
  });
  const threadConfig: Config = {
    ...cfg,
    model: session.model,
    mode: session.mode as Config["mode"],
  };
  const record = createRuntimeRecord(threadConfig, session);
  ensureTools(threadConfig, session.workspace_path);
  const prefix = buildPinnedPrefix(threadConfig, session.workspace_path, getRegistry());
  session.prefix_hash = prefix.hash;
  record.history.addSystem(prefix.systemPrompt);
  setRuntimePrefix(record, prefix);
  return c.json({ thread: record.thread, prefix_hash: prefix.hash });
}

export async function getThreadHandler(c: Context) {
  const threadId = requestId(c, "thread_id");
  if (!threadId) return c.json({ error: "invalid thread id" }, 400);
  const record = getRuntimeRecord(threadId);
  if (!record) return c.json({ error: "Thread not found" }, 404);
  return c.json({
    thread: record.thread,
    turns: record.turns,
    items: record.items,
    session: record.session,
    prefix: record.prefix?.metadata,
  });
}

export async function threadItemsHandler(c: Context) {
  const threadId = requestId(c, "thread_id");
  if (!threadId) return c.json({ error: "invalid thread id" }, 400);
  const record = getRuntimeRecord(threadId);
  if (!record) return c.json({ error: "Thread not found" }, 404);
  const sinceSeq = parseSinceSeq(c.req.query("since_seq"));
  return c.json({ items: replayRuntimeItems(record.thread.id, sinceSeq) });
}

export async function updateThreadHandler(c: Context) {
  const body = await readJsonObject(c);
  if (!body) {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.archived !== undefined && typeof body.archived !== "boolean") {
    return c.json({ error: "archived must be a boolean" }, 400);
  }
  const mode = parseOptionalMode(body);
  if (mode.error) return c.json({ error: mode.error }, 400);
  const model = parseOptionalTextField(body, "model");
  if (model.error) return c.json({ error: model.error }, 400);
  const workspace = parseOptionalTextField(body, "workspace");
  if (workspace.error) return c.json({ error: workspace.error }, 400);
  const patch: Record<string, unknown> = {};
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  if (mode.value !== undefined) patch.mode = mode.value;
  if (model.value !== undefined) patch.model = model.value;
  if (workspace.value !== undefined) patch.workspace = workspace.value;
  const threadId = requestId(c, "thread_id");
  if (!threadId) return c.json({ error: "invalid thread id" }, 400);
  const thread = updateRuntimeThread(threadId, patch as any);
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  const record = getRuntimeRecord(thread.id);
  if (!record) return c.json({ error: "Thread not found" }, 404);
  if (patch.mode || patch.workspace) {
    ensureTools(record.config, record.session.workspace_path || process.cwd());
    const prefix = buildPinnedPrefix(record.config, record.session.workspace_path || process.cwd(), getRegistry());
    record.session.prefix_hash = prefix.hash;
    record.session.messages = [
      systemMessage(prefix.systemPrompt),
      ...record.session.messages.filter(message => !(message.role === "system" && message.name == null)),
    ];
    setRuntimePrefix(record, prefix);
  }
  return c.json({ thread, prefix_hash: record.prefix?.hash || record.session.prefix_hash });
}

export async function forkThreadHandler(c: Context) {
  const threadId = requestId(c, "thread_id");
  if (!threadId) return c.json({ error: "invalid thread id" }, 400);
  const fork = forkRuntimeThread(threadId);
  if (!fork) return c.json({ error: "Thread not found" }, 404);
  return c.json({ thread: fork.thread, session_id: fork.session.id });
}

export async function threadEventsHandler(c: Context) {
  const threadId = requestId(c, "thread_id");
  if (!threadId) return c.json({ error: "invalid thread id" }, 400);
  const record = getRuntimeRecord(threadId);
  if (!record) return c.json({ error: "Thread not found" }, 404);
  const sinceSeq = parseSinceSeq(c.req.query("since_seq"));
  if ((c.req.header("accept") || "").includes("text/event-stream")) {
    return streamSSE(c, async (stream) => {
      let closed = false;
      let close: () => void = () => { closed = true; };
      const closedPromise = new Promise<void>(resolve => {
        close = () => {
          if (closed) return;
          closed = true;
          resolve();
        };
      });
      stream.onAbort(close);
      await stream.write(": connected\n\n");
      const pending: RuntimeEvent[] = [];
      let liveReady = false;
      let writeChain = Promise.resolve();
      let lastSentSeq = sinceSeq;
      const writeEvent = (event: RuntimeEvent): Promise<void> => {
        writeChain = writeChain.then(async () => {
          if (closed || event.seq <= lastSentSeq) return;
          try {
            await stream.writeSSE({
              id: String(event.seq),
              event: event.event,
              data: safeJsonStringify(event),
            });
            lastSentSeq = Math.max(lastSentSeq, event.seq);
          } catch {
            close();
          }
        });
        return writeChain;
      };
      const unsubscribe = subscribeRuntimeEvents(record.thread.id, async (event) => {
        if (event.seq <= lastSentSeq) return;
        if (!liveReady) {
          if (pending.length < MAX_SSE_PENDING_EVENTS) pending.push(event);
          return;
        }
        await writeEvent(event);
      });
      try {
        for (const event of replayRuntimeEvents(record.thread.id, sinceSeq)) {
          await writeEvent(event);
        }
        while (pending.length) {
          const next = pending.shift();
          if (next) await writeEvent(next);
        }
        liveReady = true;
        const heartbeat = setInterval(() => {
          if (!closed) void stream.write(": keepalive\n\n").catch(close);
        }, 25_000);
        heartbeat.unref?.();
        await closedPromise.finally(() => clearInterval(heartbeat));
      } finally {
        close();
        unsubscribe();
      }
    });
  }
  return c.json({ events: replayRuntimeEvents(record.thread.id, sinceSeq) });
}

export async function interruptTurnHandler(c: Context) {
  const threadId = requestId(c, "thread_id");
  const turnId = requestId(c, "turn_id");
  if (!threadId) return c.json({ error: "invalid thread id" }, 400);
  if (!turnId) return c.json({ error: "invalid turn id" }, 400);
  const record = getRuntimeRecord(threadId);
  if (!record) return c.json({ error: "Thread not found" }, 404);
  const turn = record.turns.find(item => item.id === turnId);
  if (!turn) return c.json({ error: "Turn not found" }, 404);
  if (!["queued", "in_progress"].includes(turn.status)) {
    return c.json({ interrupted: false, turn, reason: `Turn is already ${turn.status}` }, 409);
  }
  record.abortController?.abort();
  record.activeEngine?.interrupt();
  appendEvent(record, "turn.interrupt_requested", { turn_id: turn.id, reason: "API request" }, turn.id);
  appendRuntimeItem(record, "interrupt", { turn_id: turn.id, reason: "API request" }, { turnId: turn.id });
  updateTurn(record, turn, "interrupted", { error: "Interrupted by API request", interrupted_at: new Date().toISOString() });
  return c.json({ interrupted: true, turn });
}

export async function listToolsHandler(c: Context) {
  ensureTools(loadConfig());
  const tools = getRegistry().listAll();
  return c.json({ tools: tools.map(tool => ({ name: tool.name, description: tool.description, category: tool.category })) });
}

export async function listSkillsHandler(c: Context) {
  const cfg = loadConfig();
  const rawWorkspace = c.req.query("workspace") || "";
  if (hasUnsafeQueryText(rawWorkspace)) return c.json({ error: "workspace must not contain control characters" }, 400);
  const workspace = sanitizeQueryText(rawWorkspace, MAX_TEXT_FIELD_CHARS) || process.cwd();
  const registry = SkillRegistry.discover({ workspaceDir: workspace, skillsDir: cfg.skills_dir });
  return c.json({
    skills: registry.list().map(skill => ({
      name: skill.name,
      description: skill.description,
      location: skill.location,
      scope: skill.scope,
      installed: skill.installed,
      trusted: skill.trusted,
      system: skill.system,
    })),
    warnings: registry.warnings(),
  });
}

export async function chatHandler(c: Context) {
  const id = requestId(c, "session_id");
  if (!id) return c.json({ error: "invalid session id" }, 400);
  const record = getRuntimeRecordBySession(id);
  if (!record) return c.json({ error: "Session not found" }, 404);

  const body = await readJsonObject(c);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  const parsedMessage = parseChatMessage(body.message);
  if (parsedMessage.error) return c.json({ error: parsedMessage.error }, 400);
  const message = parsedMessage.value!;

  ensureTools(record.config, record.session.workspace_path || process.cwd());

  const requestSignal = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    const abortController = new AbortController();
    let streamClosed = false;
    const abortTurn = () => {
      streamClosed = true;
      abortController.abort();
      record.activeEngine?.interrupt();
      markActiveTurnInterrupted(record, "Interrupted by client disconnect");
    };
    stream.onAbort(abortTurn);
    requestSignal.addEventListener("abort", abortTurn, { once: true });
    const writeStreamSSE = async (message: { event: string; data: string }): Promise<void> => {
      if (streamClosed) return;
      await stream.writeSSE(message);
    };
    try {
      const client = new DeepSeekClient({
        apiKey: record.config.api_key,
        baseUrl: record.config.base_url,
        model: record.config.model,
        provider: record.config.provider,
      });
      record.abortController = abortController;
      const turn = createTurn(record, message);
      appendRuntimeItem(record, "turn_input", { message }, { turnId: turn.id });
      updateTurn(record, turn, "in_progress");
      const tools = getRegistry();
      if (!record.prefix) {
        const prefix = buildPinnedPrefix(record.config, record.session.workspace_path || process.cwd(), tools);
        record.session.prefix_hash = prefix.hash;
        if (!record.session.messages.some(item => item.role === "system" && item.content === prefix.systemPrompt)) {
          record.history.addSystem(prefix.systemPrompt);
        }
        setRuntimePrefix(record, prefix);
      }
      const engine = new Engine(record.config, record.session, record.history, client, tools, record.prefix);
      record.activeEngine = engine;
      const mode = getMode(record.config.mode);
      const liveStreamedToolCalls = new Set<string>();
      const persistedStreamedToolCalls = new Set<string>();
      const bufferedRuntimeEvents: EngineRuntimeEvent[] = [];
      const persistRuntimeEvent = (event: EngineRuntimeEvent) => {
        appendRuntimeItem(record, event.type, event.data, omitUndefined({ turnId: turn.id, artifactIds: event.artifact_ids }));
        const sse = runtimeEventToSSE(event, persistedStreamedToolCalls);
        if (!sse) return;
        appendEvent(record, sse.event, sse.data, turn.id);
      };
      const flushBufferedRuntimeEvents = () => {
        if (!bufferedRuntimeEvents.length) return;
        for (const event of bufferedRuntimeEvents.splice(0)) persistRuntimeEvent(event);
      };
      const result = await engine.runTurn(message, mode, {
        onRuntimeEvent: async (event) => {
          const sse = runtimeEventToSSE(event, liveStreamedToolCalls);
          if (sse) await writeStreamSSE({ event: sse.event, data: safeJsonStringify(sse.data) });
          if (event.type === "assistant_message") flushBufferedRuntimeEvents();
          if (isSpeculativeRuntimeEvent(event)) {
            bufferedRuntimeEvents.push(event);
            return;
          }
          persistRuntimeEvent(event);
        },
        requestApproval: async (toolName, args, description) => {
          await emitApprovalRequired(record, { writeSSE: writeStreamSSE }, turn.id, toolName, args, description);
          return false;
        },
      }, { signal: abortController.signal });
      if (abortController.signal.aborted) {
        markActiveTurnInterrupted(record, "Interrupted by API request", turn.id);
        await writeStreamSSE({ event: "interrupted", data: safeJsonStringify({ turn_id: turn.id }) });
        return;
      }
      updateTurn(record, turn, "completed", { usage: result.usage });
      await writeStreamSSE({ event: "done", data: safeJsonStringify({ usage: result.usage, iterations: result.iterations }) });
    } catch (e: any) {
      const latest = record.turns.at(-1);
      if (abortController.signal.aborted || isAbortError(e)) {
        markActiveTurnInterrupted(record, "Interrupted by API request", latest?.id);
        await writeStreamSSE({ event: "interrupted", data: safeJsonStringify({ turn_id: latest?.id }) });
        return;
      }
      if (latest && latest.status !== "interrupted") updateTurn(record, latest, "failed", { error: e.message });
      await writeStreamSSE({ event: "error", data: safeJsonStringify({ message: e.message }) });
    } finally {
      requestSignal.removeEventListener("abort", abortTurn);
      delete record.abortController;
      delete record.activeEngine;
    }
  });
}

function markActiveTurnInterrupted(record: RuntimeRecord, error: string, turnId?: string): void {
  const turn = turnId
    ? record.turns.find(item => item.id === turnId)
    : record.turns.at(-1);
  if (!turn || !["queued", "in_progress"].includes(turn.status)) return;
  appendRuntimeItem(record, "interrupt", { turn_id: turn.id, reason: "abort signal" }, { turnId: turn.id });
  updateTurn(record, turn, "interrupted", { error, interrupted_at: new Date().toISOString() });
}

async function emitApprovalRequired(
  record: RuntimeRecord,
  stream: { writeSSE(message: { event: string; data: string }): Promise<void> },
  turnId: string,
  toolName: string,
  args: Record<string, unknown>,
  description: string,
): Promise<void> {
  const data = { tool: toolName, args, description };
  appendRuntimeItem(record, "approval_required", data, { turnId });
  appendEvent(record, "approval_required", data, turnId);
  await stream.writeSSE({ event: "approval_required", data: safeJsonStringify(data) });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

function sanitizeQueryText(value: string, maxChars: number): string {
  return safeSliceTextBoundary(value.trim(), maxChars);
}

function hasUnsafeQueryText(value: string): boolean {
  return UNSAFE_DECODED_RE.test(value);
}
