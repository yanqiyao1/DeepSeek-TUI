/** Stream accumulator helpers used by the UI layer. */

import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_STREAM_TEXT_CHARS = 2_000_000;
const MAX_TOOL_CALLS = 100;
const MAX_TOOL_ARGUMENT_CHARS = 1_000_000;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SAFE_TOOL_CALL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export class StreamAccumulator {
  content = "";
  reasoning = "";
  toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

  addContent(text: string): void {
    this.content += sanitizeText(text, remainingChars(this.content, MAX_STREAM_TEXT_CHARS));
  }

  addReasoning(text: string): void {
    this.reasoning += sanitizeText(text, remainingChars(this.reasoning, MAX_STREAM_TEXT_CHARS));
  }

  addToolCallDelta(index: number, tcId = "", name = "", args = ""): void {
    if (!Number.isSafeInteger(index) || index < 0 || index > 10_000) return;
    if (!this.toolCalls.has(index) && this.toolCalls.size >= MAX_TOOL_CALLS) return;
    if (!this.toolCalls.has(index)) {
      this.toolCalls.set(index, { id: "", name: "", arguments: "" });
    }
    const acc = this.toolCalls.get(index)!;
    const safeId = sanitizeId(tcId);
    const safeName = sanitizeName(name);
    if (safeId) acc.id = safeId;
    if (safeName) acc.name = safeName;
    if (args) acc.arguments += sanitizeText(args, remainingChars(acc.arguments, MAX_TOOL_ARGUMENT_CHARS));
  }

  get isEmpty(): boolean {
    return !this.content && !this.reasoning && this.toolCalls.size === 0;
  }
}

function remainingChars(current: string, maxChars: number): number {
  return Math.max(0, maxChars - current.length);
}

function sanitizeText(value: unknown, maxChars: number): string {
  if (maxChars <= 0 || typeof value !== "string") return "";
  return safeSliceTextBoundary(value.replace(CONTROL_TEXT_GLOBAL_RE, " "), maxChars);
}

function sanitizeId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return SAFE_TOOL_CALL_ID_RE.test(trimmed) ? trimmed : "";
}

function sanitizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return SAFE_TOOL_NAME_RE.test(trimmed) ? trimmed : "";
}
