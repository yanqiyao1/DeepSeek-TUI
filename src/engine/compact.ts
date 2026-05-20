/** Controlled context compaction with explicit cache-breaking boundaries. */

import { get_encoding, type Tiktoken } from "tiktoken";
import type { Config } from "../config.js";
import { messageToApiDict, type Message } from "../session/types.js";
import type { ConversationHistory } from "../session/history.js";
import { omitUndefined } from "../utils/object.js";

const TOOL_PREVIEW_CHARS = 280;
const SUMMARY_TARGET_CHARS = 2400;
const SUMMARY_WINDOW_MESSAGES = 10;
const RECENT_MESSAGE_KEEP = 20;
const MIN_RECENT_MESSAGES = 4;
const MAX_COMPACTION_FAILURES = 2;
const CIRCUIT_BREAKER_ATTEMPTS = 3;

export interface CompactionResult {
  status?: "compacted" | "failed" | "skipped";
  actions: string[];
  finalTokens: number;
  message: string;
  boundary_id?: string;
  removed_messages?: number;
  original_tokens?: number;
  summary_message_name?: string;
  preserved_messages?: number;
  prefix_invalidated?: boolean;
  prefix_invalidation_reason?: string;
  error?: string;
  failure_count?: number;
  circuit_open?: boolean;
  circuit_open_until_attempt?: number;
}

interface CompactionProjection {
  summaryCandidates: Message[];
  recentMessages: Message[];
  recentStartIndex: number;
  summarizedMessages: number;
  largeToolResults: number;
  reasoningBlocks: number;
}

interface BoundaryMetadata {
  boundaryId: string;
  compactionIndex: number;
  originalTokens: number;
  projectedTokensBefore: number;
  projectedTokensAfter: number;
  originalMessages: number;
  preserveFromIndex: number;
  summarizedMessages: number;
  preservedMessages: number;
  largeToolResults: number;
  droppedReasoning: number;
}

export class ContextCompactor {
  private readonly config: Config;
  private compactionCount = 0;
  private compactionAttempts = 0;
  private consecutiveFailures = 0;
  private circuitOpenUntilAttempt = 0;

  constructor(config: Config) {
    this.config = config;
  }

  shouldCompact(history: ConversationHistory): boolean {
    return estimateMessagesTokens(projectMessagesForRequest(history.session.messages)) > this.config.context_limit;
  }

  compact(history: ConversationHistory): CompactionResult {
    const attempt = ++this.compactionAttempts;
    const originalTokens = estimateMessagesTokens(projectMessagesForRequest(history.session.messages));
    if (attempt <= this.circuitOpenUntilAttempt) {
      return {
        status: "skipped",
        actions: [],
        finalTokens: originalTokens,
        message: `Compaction circuit breaker is open after ${this.consecutiveFailures} failed attempt(s).`,
        original_tokens: originalTokens,
        removed_messages: 0,
        preserved_messages: projectMessagesForRequest(history.session.messages).length,
        prefix_invalidated: false,
        failure_count: this.consecutiveFailures,
        circuit_open: true,
        circuit_open_until_attempt: this.circuitOpenUntilAttempt,
      };
    }

    const originalLength = history.session.messages.length;
    let result: CompactionResult;
    try {
      result = this.performCompaction(history);
    } catch (error: any) {
      history.session.messages.splice(originalLength);
      return this.recordFailure(originalTokens, `Compaction failed: ${error?.message || String(error)}`, error?.message || String(error));
    }

    const madeProgress = !!result.prefix_invalidated
      && typeof result.original_tokens === "number"
      && result.finalTokens < result.original_tokens;
    if (madeProgress) {
      this.consecutiveFailures = 0;
      return { status: "compacted", ...result, failure_count: 0, circuit_open: false };
    }

    if (result.prefix_invalidated) history.session.messages.splice(originalLength);
    return this.recordFailure(
      originalTokens,
      result.message || "Compaction did not reduce projected tokens.",
      result.error,
      result,
    );
  }

  private performCompaction(history: ConversationHistory): CompactionResult {
    this.compactionCount++;
    const messages = history.session.messages;
    const originalMessages = messages.length;
    const originalTokens = estimateMessagesTokens(projectMessagesForRequest(messages));
    const projection = selectCompactionProjection(messages);

    if (!projection.summaryCandidates.length) {
      return {
        status: "failed",
        actions: [],
        finalTokens: originalTokens,
        message: "Compaction attempted, but no compactable content was found.",
        original_tokens: originalTokens,
        removed_messages: 0,
        preserved_messages: projection.recentMessages.length,
        prefix_invalidated: false,
      };
    }

    const boundaryId = `compact_${Date.now().toString(36)}_${this.compactionCount}`;
    const summary = buildSummaryMessage(boundaryId, projection.summaryCandidates);
    const boundaryPlaceholder: Message = {
      role: "system",
      content: "",
      tool_calls: null,
      tool_call_id: null,
      name: "context_compaction_boundary",
      reasoning_content: null,
    };
    messages.push(boundaryPlaceholder, summary);

    const metadata: BoundaryMetadata = {
      boundaryId,
      compactionIndex: this.compactionCount,
      originalTokens,
      projectedTokensBefore: originalTokens,
      projectedTokensAfter: 0,
      originalMessages,
      preserveFromIndex: projection.recentStartIndex,
      summarizedMessages: projection.summarizedMessages,
      preservedMessages: projection.recentMessages.length,
      largeToolResults: projection.largeToolResults,
      droppedReasoning: projection.reasoningBlocks,
    };
    boundaryPlaceholder.content = buildBoundaryContent(metadata, describeActions(metadata));
    metadata.projectedTokensAfter = estimateMessagesTokens(projectMessagesForRequest(messages));
    const actions = describeActions(metadata);
    boundaryPlaceholder.content = buildBoundaryContent(metadata, actions);
    const finalProjectedTokens = estimateMessagesTokens(projectMessagesForRequest(messages));
    metadata.projectedTokensAfter = finalProjectedTokens;
    const finalActions = describeActions(metadata);
    boundaryPlaceholder.content = buildBoundaryContent(metadata, finalActions);

    return {
      status: "compacted",
      actions: finalActions,
      finalTokens: finalProjectedTokens,
      message: `Context compacted with boundary ${boundaryId}; prompt projection now uses summary + recent messages.`,
      boundary_id: boundaryId,
      removed_messages: projection.summarizedMessages,
      original_tokens: originalTokens,
      preserved_messages: projection.recentMessages.length,
      summary_message_name: summary.name || "context_summary",
      prefix_invalidated: true,
      prefix_invalidation_reason: "context_compaction",
    };
  }

  private recordFailure(
    originalTokens: number,
    message: string,
    error?: string,
    base?: CompactionResult,
  ): CompactionResult {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= MAX_COMPACTION_FAILURES) {
      this.circuitOpenUntilAttempt = this.compactionAttempts + CIRCUIT_BREAKER_ATTEMPTS;
    }
    return omitUndefined({
      ...(base || {}),
      status: "failed" as const,
      actions: base?.actions || [],
      finalTokens: base?.finalTokens ?? originalTokens,
      message,
      original_tokens: base?.original_tokens ?? originalTokens,
      removed_messages: base?.removed_messages ?? 0,
      preserved_messages: base?.preserved_messages,
      prefix_invalidated: false as const,
      error,
      failure_count: this.consecutiveFailures,
      circuit_open: this.compactionAttempts < this.circuitOpenUntilAttempt,
      circuit_open_until_attempt: this.circuitOpenUntilAttempt || undefined,
    });
  }
}

export function projectMessagesForRequest(messages: Message[]): Message[] {
  const latestBoundaryIndex = findLatestBoundaryIndex(messages);
  if (latestBoundaryIndex < 0) return [...messages];

  const boundary = messages[latestBoundaryIndex];
  if (!boundary) return [...messages];
  const preserveFromIndex = parseNumberField(boundary.content || "", "preserve_from_index") ?? latestBoundaryIndex;
  const summary = findSummaryAfterBoundary(messages, latestBoundaryIndex);
  const suffixStart = summary ? messages.indexOf(summary, latestBoundaryIndex + 1) + 1 : latestBoundaryIndex + 1;
  const preservedRecent = messages
    .slice(Math.max(0, Math.min(preserveFromIndex, latestBoundaryIndex)), latestBoundaryIndex)
    .filter(message => !isCompactionMarker(message));
  const suffix = messages.slice(suffixStart).filter(message => !isCompactionMarker(message));

  return [
    boundary,
    ...(summary ? [summary] : []),
    ...preservedRecent,
    ...suffix,
  ];
}

export function estimateMessagesTokens(messages: Message[]): number {
  return estimateValueTokens(messages.map(messageToApiDict));
}

export function estimateRequestTokens(messages: Message[], tools?: Record<string, unknown>[] | null): number {
  return estimateValueTokens({
    messages: messages.map(messageToApiDict),
    ...(tools?.length ? { tools } : {}),
  });
}

export function estimateValueTokens(value: unknown): number {
  return estimateTextTokens(typeof value === "string" ? value : stableStringify(value));
}

export function estimateTextTokens(text: string): number {
  const encoder = getTokenEncoder();
  if (!encoder) return Math.ceil(text.length / 4);
  return encoder.encode(text).length;
}

export function isCompactionMarker(message: Message): boolean {
  return message.name === "context_compaction_boundary" || message.name === "context_summary";
}

function findLatestBoundaryIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.name === "context_compaction_boundary") return index;
  }
  return -1;
}

function findSummaryAfterBoundary(messages: Message[], boundaryIndex: number): Message | null {
  for (let index = boundaryIndex + 1; index < messages.length; index++) {
    const candidate = messages[index];
    if (candidate?.name === "context_summary") return candidate;
    if (candidate?.role !== "system") break;
  }
  return null;
}

function selectCompactionProjection(messages: Message[]): CompactionProjection {
  const nonSystemIndexes = messages
    .map((message, index) => message.role !== "system" ? index : -1)
    .filter(index => index >= 0);
  if (nonSystemIndexes.length <= MIN_RECENT_MESSAGES) {
    return {
      summaryCandidates: [],
      recentMessages: nonSystemIndexes.map(index => messages[index]).filter((message): message is Message => !!message),
      recentStartIndex: nonSystemIndexes[0] ?? messages.length,
      summarizedMessages: 0,
      largeToolResults: 0,
      reasoningBlocks: 0,
    };
  }

  const recentKeep = Math.min(
    RECENT_MESSAGE_KEEP,
    Math.max(MIN_RECENT_MESSAGES, Math.floor(nonSystemIndexes.length / 2)),
  );
  const recentStartOffset = Math.max(0, nonSystemIndexes.length - recentKeep);
  const recentStartIndex = nonSystemIndexes[recentStartOffset] ?? messages.length;
  const summaryCandidates = messages.slice(0, recentStartIndex).filter(
    message => !isCompactionMarker(message) && (message.role !== "system" || message.name != null),
  );
  const recentMessages = messages.slice(recentStartIndex).filter(message => !isCompactionMarker(message));
  const summarizedMessages = summaryCandidates.filter(message => message.role !== "system").length;
  const largeToolResults = summaryCandidates.filter(
    message => message.role === "tool" && (message.content?.length || 0) > TOOL_PREVIEW_CHARS,
  ).length;
  const reasoningBlocks = summaryCandidates.filter(
    message => message.role === "assistant" && !!message.reasoning_content,
  ).length;

  return {
    summaryCandidates,
    recentMessages,
    recentStartIndex,
    summarizedMessages,
    largeToolResults,
    reasoningBlocks,
  };
}

function describeActions(metadata: BoundaryMetadata): string[] {
  const actions = [
    `summary boundary appended; ${metadata.summarizedMessages} earlier messages folded into context_summary`,
    `request projection switched to summary + ${metadata.preservedMessages} recent messages`,
  ];
  if (metadata.largeToolResults > 0) {
    actions.push(`${metadata.largeToolResults} large tool results reduced to previews inside the summary`);
  }
  if (metadata.droppedReasoning > 0) {
    actions.push(`${metadata.droppedReasoning} historical reasoning blocks omitted from request replay`);
  }
  actions.push(`projected tokens ${metadata.projectedTokensBefore.toLocaleString()} -> ${metadata.projectedTokensAfter.toLocaleString()}`);
  return actions;
}

function buildBoundaryContent(metadata: BoundaryMetadata, actions: string[]): string {
  return [
    "[Context compaction boundary]",
    `boundary_id: ${metadata.boundaryId}`,
    `compaction_index: ${metadata.compactionIndex}`,
    `original_tokens: ${metadata.originalTokens}`,
    `projected_tokens_before: ${metadata.projectedTokensBefore}`,
    `projected_tokens_after: ${metadata.projectedTokensAfter}`,
    `original_messages: ${metadata.originalMessages}`,
    `preserve_from_index: ${metadata.preserveFromIndex}`,
    `removed_messages: ${metadata.summarizedMessages}`,
    `preserved_messages: ${metadata.preservedMessages}`,
    `truncated_tool_results: ${metadata.largeToolResults}`,
    `dropped_reasoning_blocks: ${metadata.droppedReasoning}`,
    "reason: context pressure triggered a controlled cache break; history remains in the event log, but prompt replay now starts from this boundary.",
    "recovery: treat summarized details as lossy. Re-open files, rerun tools, or inspect saved artifacts before relying on omitted content.",
    "actions:",
    ...actions.map(action => `- ${action}`),
  ].join("\n");
}

function buildSummaryMessage(boundaryId: string, messages: Message[]): Message {
  const headerLine = `[Earlier conversation summarized for boundary ${boundaryId}]`;
  const lines = [headerLine];
  let chars = headerLine.length;
  const window = messages.slice(-SUMMARY_WINDOW_MESSAGES);
  if (messages.length > window.length) {
    const header = `- ${messages.length - window.length} earlier messages omitted here; highlights below prioritize the most recent summarized context.`;
    lines.push(header);
    chars += header.length + 1;
  }

  for (const message of window) {
    const line = summarizeMessage(message);
    if (!line) continue;
    if (chars + line.length + 1 > SUMMARY_TARGET_CHARS) {
      lines.push("- ... additional earlier context omitted; re-open transcript or rerun tools if needed.");
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }

  return {
    role: "system",
    content: lines.join("\n"),
    tool_calls: null,
    tool_call_id: null,
    name: "context_summary",
    reasoning_content: null,
  };
}

function summarizeMessage(message: Message): string | null {
  switch (message.role) {
    case "system":
      return message.name ? `- system(${message.name}): ${clip(message.content || "", 180)}` : null;
    case "user":
      return `- user: ${clip(message.content || "", 220)}`;
    case "assistant": {
      const parts: string[] = [];
      if (message.content?.trim()) parts.push(`content=${clip(message.content, 220)}`);
      if (message.tool_calls?.length) {
        const tools = message.tool_calls.map(call => `${call.name}(${clip(JSON.stringify(call.arguments), 100)})`);
        parts.push(`tool_calls=${tools.join(", ")}`);
      }
      if (message.reasoning_content?.trim()) {
        parts.push(`reasoning=${clip(message.reasoning_content, 120)}`);
      }
      return parts.length ? `- assistant: ${parts.join(" | ")}` : "- assistant";
    }
    case "tool": {
      const state = message.is_error ? "error" : "ok";
      return `- tool ${message.name || "tool"} [${state}]: ${toolPreview(message.content || "")}`;
    }
    default:
      return null;
  }
}

function toolPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "(empty)";
  return clip(normalized, TOOL_PREVIEW_CHARS);
}

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function parseNumberField(content: string, key: string): number | null {
  const match = content.match(new RegExp(`^${key}:\\s*(\\d+)$`, "m"));
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

let tokenEncoder: Tiktoken | null | undefined;

function getTokenEncoder(): Tiktoken | null {
  if (tokenEncoder !== undefined) return tokenEncoder;
  try {
    tokenEncoder = get_encoding("cl100k_base");
  } catch {
    tokenEncoder = null;
  }
  return tokenEncoder;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
}
