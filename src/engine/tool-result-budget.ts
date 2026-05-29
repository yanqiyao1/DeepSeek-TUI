/** Persist oversized tool results and keep only a small preview in model context. */

import { Buffer } from "node:buffer";
import { createArtifact } from "../artifacts/store.js";
import { safeSliceTextBoundary, safeTailTextBoundary } from "../utils/text-boundary.js";

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 50_000;
const PREVIEW_HEAD_CHARS = 2_000;
const PREVIEW_TAIL_CHARS = 1_000;

export interface ToolResultBudgetInput {
  toolName: string;
  toolCallId: string;
  content: string;
  isError: boolean;
  sessionId?: string;
  maxChars?: number;
}

export interface BudgetedToolResult {
  content: string;
  artifactIds: string[];
  originalChars: number;
  originalBytes: number;
  replaced: boolean;
}

export function applyToolResultBudget(input: ToolResultBudgetInput): BudgetedToolResult {
  const toolName = stringOrDefault(safeBudgetProperty(input, "toolName"), "tool");
  const toolCallId = stringOrDefault(safeBudgetProperty(input, "toolCallId"), "call");
  const content = stringOrDefault(safeBudgetProperty(input, "content"), "");
  const isError = safeBudgetProperty(input, "isError") === true;
  const sessionId = stringOrDefault(safeBudgetProperty(input, "sessionId"), "");
  const maxCharsValue = safeBudgetProperty(input, "maxChars");
  const maxChars = typeof maxCharsValue === "number" ? maxCharsValue : DEFAULT_TOOL_RESULT_MAX_CHARS;
  const originalBytes = Buffer.byteLength(content, "utf-8");
  if (!Number.isFinite(maxChars) || content.length <= maxChars) {
    return {
      content,
      artifactIds: [],
      originalChars: content.length,
      originalBytes,
      replaced: false,
    };
  }

  try {
    const artifact = createArtifact({
      kind: "tool_result",
      name: `${safeName(toolName)}-${safeName(toolCallId)}.txt`,
      content,
      extension: ".txt",
      metadata: {
        tool_name: toolName,
        tool_call_id: toolCallId,
        session_id: sessionId,
        is_error: isError,
        original_chars: content.length,
        original_bytes: originalBytes,
        truncated_for_context: true,
      },
    });
    return {
      content: buildPreview({
        toolName,
        toolCallId,
        artifactId: artifact.id,
        originalChars: content.length,
        originalBytes,
        preview: previewContent(content, previewBudget(maxChars)),
      }),
      artifactIds: [artifact.id],
      originalChars: content.length,
      originalBytes,
      replaced: true,
    };
  } catch {
    return {
      content,
      artifactIds: [],
      originalChars: content.length,
      originalBytes,
      replaced: false,
    };
  }
}

function buildPreview(input: {
  toolName: string;
  toolCallId: string;
  artifactId: string;
  originalChars: number;
  originalBytes: number;
  preview: string;
}): string {
  return [
    "[Tool result stored as artifact]",
    `tool: ${input.toolName}`,
    `tool_call_id: ${input.toolCallId}`,
    `artifact_id: ${input.artifactId}`,
    `original_chars: ${input.originalChars}`,
    `original_bytes: ${input.originalBytes}`,
    `recovery: use artifact_read with this artifact_id to inspect the full output.`,
    "",
    "[preview]",
    input.preview,
  ].join("\n");
}

function previewBudget(maxChars: number): number {
  return Math.min(PREVIEW_HEAD_CHARS + PREVIEW_TAIL_CHARS, Math.max(0, Math.floor(maxChars)));
}

function previewContent(content: string, maxPreviewChars = PREVIEW_HEAD_CHARS + PREVIEW_TAIL_CHARS): string {
  if (maxPreviewChars <= 0) return "[preview omitted by tool result budget]";
  if (content.length <= maxPreviewChars) return content;
  const headChars = Math.max(1, Math.ceil(maxPreviewChars * 2 / 3));
  const tailChars = Math.max(0, maxPreviewChars - headChars);
  if (content.length <= headChars + tailChars) return content;
  return [
    safeSliceTextBoundary(content, headChars),
    "",
    `[middle omitted: ${content.length - headChars - tailChars} chars]`,
    "",
    tailChars ? safeTailTextBoundary(content, tailChars) : "",
  ].join("\n");
}

function safeName(value: string): string {
  return String(value || "tool").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "tool";
}

function safeBudgetProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
