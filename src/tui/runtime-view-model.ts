/** Runtime-event driven TUI state for transcript, thinking, and tool status. */

import type { EngineRuntimeEvent } from "../engine/events.js";
import type { Message, Session } from "../session/types.js";
import type { ToolUseRuntimeMetadata } from "../tools/base.js";
import { renderMarkdown } from "../ui/markdown.js";
import { p } from "../ui/palette.js";
import * as r from "../ui/renderer.js";
import { AssistantStream } from "./assistant-stream.js";
import { defaultToolActivityLabel, describeToolActivity, describeToolActivityFromArgsStream } from "./tool-activity.js";
import { ActiveToolLines } from "./tool-lines.js";
import { Transcript } from "./transcript.js";
import { runtimeItemsToEngineRuntimeEvents, sessionMessagesToRuntimeEvents, type RuntimeItemLike } from "./runtime-replay.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_ACTIVE_TOOL_LINES = 200;
const MAX_TOOL_ARGUMENT_STREAM_CHARS = 200_000;
const MAX_THINKING_BUFFER_CHARS = 200_000;
const MAX_RUNTIME_PREVIEW_CHARS = 200_000;
const MAX_RUNTIME_RENDER_LINE_CHARS = 20_000;
const MAX_INLINE_TOOL_PREVIEW_CHARS = 160;
const MAX_TOOL_RESULT_PREVIEW_CHARS = 1_200;
const MAX_TOOL_RESULT_PREVIEW_LINES = 8;
const CONTROL_RUNTIME_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export type TuiTranscriptEventKind = "tool" | "thinking" | "content" | "other";

export interface TuiRuntimeViewState {
  activeStatusLine: string | null;
  activeToolCount: number;
  thinkingActive: boolean;
  thinkingStartedAt: number | null;
  lastTranscriptEvent: TuiTranscriptEventKind;
}

export type TuiStoreListener = () => void;

export class TuiStore<State> {
  private listeners = new Set<TuiStoreListener>();

  constructor(private state: State) {}

  getState(): Readonly<State> {
    return this.state;
  }

  setState(next: State | ((state: Readonly<State>) => State)): void {
    const nextState = typeof next === "function"
      ? (next as (state: Readonly<State>) => State)(this.state)
      : next;
    if (Object.is(nextState, this.state)) return;
    this.state = nextState;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: TuiStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export interface TuiRuntimeViewModelOptions {
  thinkingVisible?: boolean | (() => boolean);
  turnStartedAt?: () => number;
  renderNow?: () => void;
  requestRender?: () => void;
  now?: () => number;
  enableThinkingTimer?: boolean;
}

export interface RenderSessionTranscriptOptions {
  session: Pick<Session, "id" | "title" | "messages">;
  loaded?: boolean;
  version: string;
  model: string;
  mode: string;
  toolCount: number;
}

export class TuiRuntimeViewModel {
  readonly store = new TuiStore<TuiRuntimeViewState>({
    activeStatusLine: null,
    activeToolCount: 0,
    thinkingActive: false,
    thinkingStartedAt: null,
    lastTranscriptEvent: "other",
  });

  private readonly activeToolLines = new ActiveToolLines();
  private readonly assistantStream = new AssistantStream();
  private readonly renderedToolCalls = new Set<string>();
  private readonly activeToolNames = new Map<string, string>();
  private readonly activeToolLabels = new Map<string, string>();
  private readonly toolArgumentStreams = new Map<string, string>();
  private inThinking = false;
  private thinkingBuf = "";
  private thinkingStartedAt = 0;
  private thinkingRenderTimer: NodeJS.Timeout | null = null;
  private thinkingBodyFlushed = false;
  private lastTranscriptEvent: TuiTranscriptEventKind = "other";
  private replayingRuntimeEvents = false;
  private assistantContentStreamed = false;
  private thinkingStreamed = false;

  constructor(readonly transcript: Transcript, private readonly options: TuiRuntimeViewModelOptions = {}) {}

  get state(): Readonly<TuiRuntimeViewState> {
    return this.store.getState();
  }

  get activeStatusLine(): string | null {
    return this.state.activeStatusLine;
  }

  get activeToolCount(): number {
    return this.state.activeToolCount;
  }

  get mutableTranscriptStartLine(): number | null {
    const assistantStart = this.assistantStream.mutableStartLine;
    const toolStart = this.activeToolLines.earliestLine();
    if (assistantStart === null) return toolStart ?? null;
    if (toolStart === undefined) return assistantStart;
    return Math.min(assistantStart, toolStart);
  }

  getSnapshot(): Readonly<TuiRuntimeViewState> {
    return this.store.getState();
  }

  subscribe(listener: TuiStoreListener): () => void {
    return this.store.subscribe(listener);
  }

  beginTurn(): void {
    this.resetRuntimeState();
  }

  finishTurn(): void {
    this.finishThinkingStatus();
    this.flushAssistantStream();
    this.assistantStream.reset();
    this.activeToolLines.clear();
    this.activeToolNames.clear();
    this.activeToolLabels.clear();
    this.toolArgumentStreams.clear();
    this.renderedToolCalls.clear();
    this.inThinking = false;
    this.thinkingBuf = "";
    this.thinkingBodyFlushed = false;
    this.patchState({
      activeToolCount: 0,
      activeStatusLine: null,
      thinkingActive: false,
      thinkingStartedAt: null,
    });
  }

  dispose(): void {
    this.finishTurn();
    this.clearThinkingTimer();
  }

  renderSessionTranscript(options: RenderSessionTranscriptOptions): void {
    this.resetRuntimeState();
    this.transcript.clear();
    this.transcript.append(r.welcomeBanner(options.version, options.model, options.mode, options.toolCount));
    this.transcript.append(p.dim(options.loaded
      ? `\nLoaded session: ${options.session.title || options.session.id}. Continue typing or /help.`
      : "\nType a request or /help. Tab completes commands. Alt+R searches history. Shift+Tab cycles modes when idle."));
    if (options.loaded) this.replayRuntimeEvents(sessionMessagesToRuntimeEvents(options.session.messages));
    this.transcript.scrollToBottom();
  }

  replayRuntimeEvents(events: EngineRuntimeEvent[]): void {
    const wasReplaying = this.replayingRuntimeEvents;
    this.replayingRuntimeEvents = true;
    try {
      for (const event of events) this.handleRuntimeEvent(event);
      this.flushThinkingBody();
      this.flushAssistantStream();
      this.assistantStream.reset();
      this.activeToolLines.clear();
      this.activeToolNames.clear();
      this.activeToolLabels.clear();
      this.toolArgumentStreams.clear();
      this.renderedToolCalls.clear();
      this.assistantContentStreamed = false;
      this.thinkingStreamed = false;
      this.syncActiveToolCount();
      this.transcript.scrollToBottom();
    } finally {
      this.replayingRuntimeEvents = wasReplaying;
    }
  }

  replayRuntimeItems(items: RuntimeItemLike[]): void {
    this.replayRuntimeEvents(runtimeItemsToEngineRuntimeEvents(items));
  }

  finishThinkingStatus(): void {
    if (!this.thinkingStartedAt) return;
    this.flushThinkingBody();
    this.clearThinkingTimer();
    this.thinkingStartedAt = 0;
    this.thinkingBodyFlushed = false;
    this.patchState({
      activeStatusLine: null,
      thinkingActive: false,
      thinkingStartedAt: null,
    });
    this.options.renderNow?.();
  }

  handleRuntimeEvent(event: EngineRuntimeEvent): void {
    switch (event.type) {
      case "api_call_start":
        this.assistantContentStreamed = false;
        this.thinkingStreamed = false;
        if (!this.isThinkingVisible()) return;
        this.ensureThinkingHeader(this.currentTurnStartedAt() || this.now());
        break;
      case "thinking_delta":
        if (!this.isThinkingVisible()) return;
        this.thinkingStreamed = true;
        if (!this.inThinking) this.separateAfterTool();
        if (!this.inThinking) {
          this.thinkingBuf = "";
          this.inThinking = true;
          this.thinkingBodyFlushed = false;
          this.ensureThinkingHeader(this.currentTurnStartedAt() || this.now());
        }
        this.thinkingBuf = appendBoundedRuntimeText(this.thinkingBuf, event.data.text, MAX_THINKING_BUFFER_CHARS);
        this.updateThinkingHeader(false);
        break;
      case "content_delta":
        this.flushThinkingBody();
        this.assistantContentStreamed = true;
        if (!this.assistantStream.append(this.transcript, event.data.text)) break;
        this.setLastTranscriptEvent("content");
        this.autoFollowBottom();
        this.options.requestRender?.();
        break;
      case "user_message":
        if (this.replayingRuntimeEvents) this.renderUserMessage(event.data.text);
        break;
      case "assistant_message":
        if (this.replayingRuntimeEvents) this.renderAssistantMessage(event.data);
        break;
      case "tool_call_begin":
        this.renderToolCallStart(event.data.name, event.data.tool_call_id || event.data.name);
        break;
      case "tool_call_args":
        this.renderToolCallArgs(event.data.tool_call_id, event.data.name, event.data.arguments);
        break;
      case "tool_call":
        this.renderToolCall(event.data.id || event.data.name, event.data.name, event.data.arguments, event.data.metadata);
        break;
      case "approval_required":
        this.renderApprovalRequired(event.data.tool, event.data.args);
        break;
      case "tool_result":
        this.renderToolResult(event.data.name, event.preview, event.data.tool_call_id || event.data.name, event.metadata, event.data.is_error);
        break;
      case "tool_progress":
        this.renderToolProgress(event);
        break;
      case "context_intervention":
        this.renderContextIntervention(event.data);
        break;
      case "prefix_invalidated":
        this.renderPrefixInvalidated(event.data);
        break;
    }
  }

  private renderUserMessage(text: string): void {
    this.finishThinkingStatus();
    this.flushAssistantStream();
    this.assistantStream.reset();
    this.activeToolLines.clear();
    this.activeToolNames.clear();
    this.activeToolLabels.clear();
    this.toolArgumentStreams.clear();
    this.renderedToolCalls.clear();
    this.assistantContentStreamed = false;
    this.thinkingStreamed = false;
    this.transcript.append(r.userMessageBlock(text));
    this.setLastTranscriptEvent("other");
    this.autoFollowBottom();
  }

  private renderAssistantMessage(message: Message): void {
    if (this.assistantContentStreamed) {
      this.flushAssistantStream();
    }
    if (message.reasoning_content && !this.thinkingStreamed) {
      this.transcript.append(r.thinkingHeader(undefined, false));
      this.transcript.append(r.thinkingText(message.reasoning_content));
      if (message.content) this.transcript.append("");
      this.setLastTranscriptEvent("thinking");
    }
    if (message.content && !this.assistantContentStreamed) {
      this.flushThinkingBody();
      this.transcript.append(renderMarkdown(message.content));
      this.setLastTranscriptEvent("content");
    }
    this.assistantStream.reset();
    this.autoFollowBottom();
  }

  private renderToolCallStart(name: string, key?: string): void {
    if (this.activeToolLines.size >= MAX_ACTIVE_TOOL_LINES && key && this.activeToolLines.current(key) === undefined) {
      this.transcript.append(r.toolCallStatus(defaultToolActivityLabel(name), "denied", "Too many active tools to render concurrently."));
      this.autoFollowBottom();
      this.options.requestRender?.();
      return;
    }
    if (key && this.renderedToolCalls.has(key)) return;
    if (key) this.renderedToolCalls.add(key);
    this.flushThinkingBody();
    this.flushAssistantStream();
    this.assistantStream.reset();
    const label = defaultToolActivityLabel(name);
    this.transcript.append(r.toolCallStatus(label, "running"));
    if (key) {
      this.activeToolLines.start(key, this.transcript.lines.length - 1);
      this.activeToolNames.set(key, name);
      this.activeToolLabels.set(key, label);
    }
    this.syncActiveToolCount();
    this.autoFollowBottom();
    this.options.renderNow?.();
  }

  private renderToolCall(toolCallId: string, name: string, args: Record<string, unknown>, metadata?: ToolUseRuntimeMetadata): void {
    if (!toolCallId && !name) return;
    if (toolCallId && name && toolCallId !== name) {
      this.promoteToolKey(name, toolCallId, name);
    }
    if (!this.renderedToolCalls.has(toolCallId) && !this.renderedToolCalls.has(name)) {
      this.renderToolCallStart(name, toolCallId || name);
    }
    this.updateToolActivity(toolCallId || name, name, safeRuntimeStringProperty(metadata, "activity") || describeToolActivity(name, args), true);
    this.toolArgumentStreams.delete(toolCallId);
  }

  private renderToolCallArgs(toolCallId: string, name: string, chunk: string): void {
    if (!chunk) return;
    if (toolCallId && name && toolCallId !== name) {
      this.promoteToolKey(name, toolCallId, name);
    }
    const key = toolCallId || name;
    const activeName = this.activeToolNames.get(key) || name;
    if (!key || !activeName) return;
    const previous = this.toolArgumentStreams.get(key) || "";
    const next = appendBoundedRuntimeText(previous, chunk, MAX_TOOL_ARGUMENT_STREAM_CHARS);
    this.toolArgumentStreams.set(key, next);
    const label = describeToolActivityFromArgsStream(activeName, next);
    if (!label) return;
    this.updateToolActivity(key, activeName, label, false);
  }

  private renderToolResult(name: string, preview: string, toolCallId = name, metadata?: ToolUseRuntimeMetadata, isError = false): void {
    this.flushAssistantStream();
    const safePreview = sanitizeRuntimeText(preview, MAX_RUNTIME_PREVIEW_CHARS);
    const inlinePreview = summarizeInlineToolPreview(safePreview);
    const activeToolLine = this.activeToolLines.finish(toolCallId);
    const existingLabel = activeToolLine !== undefined && shouldKeepToolActivityLabel(name)
      ? this.currentToolLabel(toolCallId, name)
      : name;
    const metadataSummary = safeRuntimeStringProperty(metadata, "summary");
    const metadataActivity = safeRuntimeStringProperty(metadata, "activity");
    const metadataRender = asRecord(safeRuntimeProperty(metadata, "render"));
    const metadataUserFacingName = safeRuntimeStringProperty(metadataRender, "userFacingName");
    const label = sanitizeRuntimeLine(metadataSummary || metadataActivity || metadataUserFacingName || existingLabel, 120) || name;
    const line = r.toolCallStatus(label, isError || safePreview.startsWith("Error:") ? "error" : "success", inlinePreview);
    this.activeToolNames.delete(toolCallId);
    this.activeToolLabels.delete(toolCallId);
    this.toolArgumentStreams.delete(toolCallId);
    if (activeToolLine !== undefined) this.transcript.replaceLine(activeToolLine, line);
    else this.transcript.append(line);
    const diffPreview = r.toolDiffPreview(safePreview);
    if (diffPreview) this.transcript.append(diffPreview);
    else if (shouldRenderToolResultPreview(safePreview, inlinePreview)) {
      const resultPreview = r.toolResultPreview(safePreview, MAX_TOOL_RESULT_PREVIEW_CHARS, MAX_TOOL_RESULT_PREVIEW_LINES);
      if (resultPreview) this.transcript.append(resultPreview);
    }
    this.assistantStream.reset();
    this.setLastTranscriptEvent("tool");
    this.syncActiveToolCount();
    this.autoFollowBottom();
    this.options.renderNow?.();
  }

  private renderApprovalRequired(name: string, args: Record<string, unknown>): void {
    this.flushAssistantStream();
    const safeName = sanitizeRuntimeLine(name, 120) || "tool";
    const safeArgs = safeRuntimeJsonObject(args);
    const argsText = Object.keys(safeArgs).length ? safeJsonStringify(safeArgs, { sortKeys: true }) : "no arguments";
    const line = r.toolCallStatus(safeName, "denied", sanitizeRuntimeLine(`Approval required: ${argsText}`, MAX_RUNTIME_RENDER_LINE_CHARS));
    const toolCallId = this.findActiveToolCallIdByName(name) || name;
    const activeToolLine = this.activeToolLines.finish(toolCallId);
    this.activeToolNames.delete(toolCallId);
    this.activeToolLabels.delete(toolCallId);
    this.toolArgumentStreams.delete(toolCallId);
    if (activeToolLine !== undefined) this.transcript.replaceLine(activeToolLine, line);
    else this.transcript.append(line);
    this.assistantStream.reset();
    this.setLastTranscriptEvent("tool");
    this.syncActiveToolCount();
    this.autoFollowBottom();
    this.options.renderNow?.();
  }

  private renderToolProgress(event: Extract<EngineRuntimeEvent, { type: "tool_progress" }>): void {
    const rendered = asRecord(safeRuntimeProperty(event, "rendered"));
    const renderedPreview = safeRuntimeProperty(rendered, "preview");
    const data = asRecord(safeRuntimeProperty(event, "data"));
    const progress = asRecord(safeRuntimeProperty(data, "progress"));
    const messageValue = typeof renderedPreview === "string" && renderedPreview
      ? renderedPreview
      : safeRuntimeProperty(progress, "message");
    const message = typeof messageValue === "string" ? messageValue : "";
    const toolCallId = sanitizeRuntimeLine(safeRuntimeStringProperty(data, "tool_call_id"), 120) || "tool";
    const toolName = sanitizeRuntimeLine(safeRuntimeStringProperty(data, "tool"), 120) || "tool";
    const activity = this.currentToolLabel(toolCallId, toolName);
    const line = r.toolCallStatus(activity, "running", sanitizeRuntimeLine(message, MAX_RUNTIME_RENDER_LINE_CHARS));
    const activeToolLine = this.activeToolLines.current(toolCallId);
    if (activeToolLine !== undefined) this.transcript.replaceLine(activeToolLine, line);
    else this.transcript.append(line);
    this.autoFollowBottom();
    this.options.requestRender?.();
  }

  private updateToolActivity(toolCallId: string, name: string, label: string, immediate: boolean): void {
    const activeToolLine = this.activeToolLines.current(toolCallId);
    if (activeToolLine === undefined) return;
    this.activeToolNames.set(toolCallId, name);
    this.activeToolLabels.set(toolCallId, label);
    this.transcript.replaceLine(activeToolLine, r.toolCallStatus(label, "running"));
    this.autoFollowBottom();
    if (immediate) this.options.renderNow?.();
    else this.options.requestRender?.();
  }

  private currentToolLabel(toolCallId: string, fallbackName: string): string {
    const existingLabel = this.activeToolLabels.get(toolCallId);
    if (existingLabel) return existingLabel;
    const name = this.activeToolNames.get(toolCallId) || fallbackName;
    const argsText = this.toolArgumentStreams.get(toolCallId);
    if (argsText) {
      const streamed = describeToolActivityFromArgsStream(name, argsText);
      if (streamed) return streamed;
    }
    return defaultToolActivityLabel(name);
  }

  private promoteToolKey(previousKey: string, nextKey: string, name: string): void {
    if (!previousKey || !nextKey || previousKey === nextKey) return;
    if (this.activeToolLines.current(nextKey) !== undefined) return;
    const hadRenderedCall = this.renderedToolCalls.has(previousKey);
    const hasPreviousState = hadRenderedCall
      || this.activeToolLines.current(previousKey) !== undefined
      || this.activeToolNames.has(previousKey)
      || this.activeToolLabels.has(previousKey)
      || this.toolArgumentStreams.has(previousKey);
    if (!hasPreviousState) return;
    const line = this.activeToolLines.finish(previousKey);
    if (line !== undefined) this.activeToolLines.start(nextKey, line);
    const previousName = this.activeToolNames.get(previousKey);
    if (previousName !== undefined) this.activeToolNames.delete(previousKey);
    this.activeToolNames.set(nextKey, previousName || name);
    const previousLabel = this.activeToolLabels.get(previousKey);
    if (previousLabel !== undefined) this.activeToolLabels.delete(previousKey);
    if (previousLabel) this.activeToolLabels.set(nextKey, previousLabel);
    const argsText = this.toolArgumentStreams.get(previousKey);
    if (argsText !== undefined) {
      this.toolArgumentStreams.delete(previousKey);
      this.toolArgumentStreams.set(nextKey, argsText);
    }
    if (hadRenderedCall) {
      this.renderedToolCalls.delete(previousKey);
      this.renderedToolCalls.add(nextKey);
    }
  }

  private findActiveToolCallIdByName(name: string): string | undefined {
    for (const [toolCallId, toolName] of this.activeToolNames.entries()) {
      if (toolName === name) return toolCallId;
    }
    return undefined;
  }

  private renderContextIntervention(data: unknown): void {
    const value = asRecord(data);
    const compaction = asRecord(value?.compaction);
    const risk = asString(value?.risk) ?? "unknown";
    const action = asString(value?.action) ?? "intervention";
    const reason = asString(value?.reason) ?? "capacity intervention";
    this.transcript.append(p.dim(`\nContext guard: ${sanitizeRuntimeLine(risk, 80)} / ${sanitizeRuntimeLine(action, 80)} — ${sanitizeRuntimeLine(reason, 500)}.\n`));
    if (typeof compaction?.message === "string" && compaction.message) {
      this.transcript.append(p.dim(sanitizeRuntimeText(compaction.message, 10_000) + "\n"));
    }
    this.options.renderNow?.();
  }

  private renderPrefixInvalidated(data: unknown): void {
    const value = asRecord(data);
    const compaction = asRecord(value?.compaction);
    const parts = [
      `Prompt cache reset: ${asString(value?.reason) ?? "unknown"}`,
      typeof value?.boundary_id === "string" && value.boundary_id ? `boundary ${sanitizeRuntimeLine(value.boundary_id, 120)}` : null,
      typeof compaction?.removed_messages === "number" ? `${compaction.removed_messages} summarized` : null,
      typeof compaction?.preserved_messages === "number" ? `${compaction.preserved_messages} recent kept` : null,
      typeof compaction?.finalTokens === "number" ? `${compaction.finalTokens.toLocaleString()} projected tokens` : null,
    ].filter(Boolean);
    this.transcript.append(p.dim(parts.join(" | ") + "\n"));
    this.options.renderNow?.();
  }

  private resetRuntimeState(): void {
    this.clearThinkingTimer();
    this.activeToolLines.clear();
    this.activeToolNames.clear();
    this.activeToolLabels.clear();
    this.toolArgumentStreams.clear();
    this.assistantStream.reset();
    this.renderedToolCalls.clear();
    this.inThinking = false;
    this.thinkingBuf = "";
    this.thinkingStartedAt = 0;
    this.thinkingBodyFlushed = false;
    this.lastTranscriptEvent = "other";
    this.assistantContentStreamed = false;
    this.thinkingStreamed = false;
    this.patchState({
      activeStatusLine: null,
      activeToolCount: 0,
      thinkingActive: false,
      thinkingStartedAt: null,
      lastTranscriptEvent: "other",
    });
  }

  private ensureThinkingHeader(startedAt = this.now()): void {
    if (this.thinkingStartedAt) return;
    this.thinkingStartedAt = startedAt;
    this.setLastTranscriptEvent("thinking");
    this.patchState({
      activeStatusLine: r.thinkingStatusLine(0, true),
      thinkingActive: true,
      thinkingStartedAt: startedAt,
    });
    this.options.renderNow?.();
    this.clearThinkingTimer();
    if (this.options.enableThinkingTimer === false) return;
    this.thinkingRenderTimer = setInterval(() => {
      if (!this.thinkingStartedAt) return;
      this.updateThinkingHeader(false);
    }, 250);
    this.thinkingRenderTimer.unref?.();
  }

  private updateThinkingHeader(final = false): void {
    if (!this.thinkingStartedAt) return;
    this.patchState({
      activeStatusLine: final ? null : r.thinkingStatusLine(this.now() - this.thinkingStartedAt, true),
    });
    if (final) this.options.renderNow?.();
    else this.options.requestRender?.();
  }

  private flushThinkingBody(): void {
    if (this.thinkingBodyFlushed) return;
    this.flushAssistantStream();
    if (this.thinkingBuf.trim()) {
      const formatted = r.thinkingText(this.thinkingBuf);
      this.transcript.append(formatted);
      this.transcript.append("");
      this.transcript.append("");
      this.setLastTranscriptEvent("thinking");
    }
    this.thinkingBodyFlushed = true;
    this.inThinking = false;
    this.thinkingBuf = "";
    this.assistantStream.reset();
  }

  private flushAssistantStream(): boolean {
    const changed = this.assistantStream.flush(this.transcript);
    if (!changed) return false;
    this.setLastTranscriptEvent("content");
    this.autoFollowBottom();
    return true;
  }

  private separateAfterTool(): void {
    if (this.lastTranscriptEvent !== "tool") return;
    if (!this.transcript.lines.length) return;
    if (!this.transcript.lines.at(-1)?.text.trim()) return;
    this.transcript.append("");
    this.setLastTranscriptEvent("other");
  }

  private syncActiveToolCount(): void {
    this.patchState({ activeToolCount: this.activeToolLines.size });
  }

  private setLastTranscriptEvent(kind: TuiTranscriptEventKind): void {
    this.lastTranscriptEvent = kind;
    this.patchState({ lastTranscriptEvent: kind });
  }

  private autoFollowBottom(): void {
    if (this.transcript.scrollOffset === 0) this.transcript.scrollToBottom();
  }

  private clearThinkingTimer(): void {
    if (!this.thinkingRenderTimer) return;
    clearInterval(this.thinkingRenderTimer);
    this.thinkingRenderTimer = null;
  }

  private isThinkingVisible(): boolean {
    const visible = this.options.thinkingVisible;
    return typeof visible === "function" ? visible() : visible !== false;
  }

  private currentTurnStartedAt(): number {
    return this.options.turnStartedAt?.() ?? 0;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private patchState(patch: Partial<TuiRuntimeViewState>): void {
    const previous = this.store.getState();
    let changed = false;
    for (const key of Object.keys(patch) as (keyof TuiRuntimeViewState)[]) {
      if (previous[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.store.setState({ ...previous, ...patch });
  }
}

function appendBoundedRuntimeText(previous: string, chunk: unknown, maxChars: number): string {
  const appended = previous + sanitizeRuntimeText(chunk, maxChars);
  if (appended.length <= maxChars) return appended;
  return safeSliceRuntimeText(appended, maxChars);
}

function sanitizeRuntimeLine(value: unknown, maxChars: number): string {
  return sanitizeRuntimeText(value, maxChars).replace(/\r\n/g, " ").replace(/\r/g, " ").replace(/\n/g, " ");
}

function sanitizeRuntimeText(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || maxChars <= 0) return "";
  return safeSliceRuntimeText(value.replace(CONTROL_RUNTIME_TEXT_RE, " "), maxChars);
}

function safeSliceRuntimeText(text: string, maxChars: number): string {
  return safeSliceTextBoundary(text, maxChars);
}

function summarizeInlineToolPreview(preview: string): string {
  const firstBreak = preview.search(/\r\n|\r|\n/);
  const head = firstBreak >= 0 ? safeSliceRuntimeText(preview, firstBreak) : preview;
  const line = sanitizeRuntimeLine(head, MAX_INLINE_TOOL_PREVIEW_CHARS);
  if (firstBreak < 0 && preview.length <= line.length) return line;
  return line ? `${line} ...` : "";
}

function shouldRenderToolResultPreview(preview: string, inlinePreview: string): boolean {
  if (!preview.trim()) return false;
  if (preview.includes("\n")) return true;
  return preview.length > inlinePreview.length;
}

function shouldKeepToolActivityLabel(name: string): boolean {
  switch (name) {
    case "write":
    case "edit":
    case "read":
    case "ls":
    case "search":
    case "glob":
    case "bash":
    case "task_gate_run":
    case "task_shell_start":
    case "task_create":
    case "apply_patch":
      return true;
    default:
      return false;
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

function safeRuntimeProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeRuntimeStringProperty(source: unknown, key: string): string | undefined {
  const value = safeRuntimeProperty(source, key);
  return typeof value === "string" ? value : undefined;
}

function safeRuntimeJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe = safeJsonObjectValue(value, new WeakSet<object>(), 0);
  return safe && typeof safe === "object" && !Array.isArray(safe)
    ? safe as Record<string, unknown>
    : {};
}

function safeJsonObjectValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= 8) return "[Truncated]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      let length = 0;
      try {
        length = Math.min(value.length, 256);
      } catch {
        return "[Unreadable]";
      }
      for (let index = 0; index < length; index++) {
        let child: unknown;
        try {
          child = value[index];
        } catch {
          result.push("[Unreadable]");
          continue;
        }
        result.push(safeJsonObjectValue(child, seen, depth + 1));
      }
      return result;
    }
    let keys: string[];
    try {
      keys = Object.keys(value).slice(0, 256);
    } catch {
      return {};
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      let child: unknown;
      try {
        child = (value as Record<string, unknown>)[key];
      } catch {
        result[key] = "[Unreadable]";
        continue;
      }
      result[key] = safeJsonObjectValue(child, seen, depth + 1);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
