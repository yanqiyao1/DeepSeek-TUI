import { StringDecoder } from "node:string_decoder";

const GRAPHEME_BOUNDARY_CONTEXT_CHARS = 1024;

const graphemeSegmenter: { segment(input: string): Iterable<{ segment: string; index?: number }> } | null =
  typeof Intl !== "undefined" && typeof (Intl as any).Segmenter === "function"
    ? new (Intl as any).Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function safeSliceTextBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, safeGraphemeBoundary(text, maxChars, "start"));
}

export function safeTailTextBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(safeGraphemeBoundary(text, text.length - maxChars, "end"));
}

export function safeUtf8PrefixByBytes(text: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !text) return "";
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  let low = 0;
  let high = Math.min(text.length, maxBytes);
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = safeSliceTextBoundary(text, mid);
    if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function decodeUtf8Prefix(buffer: Buffer): string {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "";
  return new StringDecoder("utf8").write(buffer);
}

export function decodeUtf8Tail(buffer: Buffer, clippedFromStart = true): string {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "";
  const start = clippedFromStart ? firstUtf8TailStart(buffer) : 0;
  if (start >= buffer.length) return "";
  return decodeUtf8Prefix(start > 0 ? buffer.subarray(start) : buffer);
}

export function safeGraphemeBoundary(text: string, index: number, direction: "start" | "end"): number {
  let safe = Math.max(0, Math.min(Math.floor(index), text.length));
  safe = segmentedGraphemeBoundary(text, safe, direction) ?? safe;
  const previous = text.charCodeAt(safe - 1);
  const current = text.charCodeAt(safe);
  if (direction === "start" && current >= 0xdc00 && current <= 0xdfff) return Math.max(0, safe - 1);
  if (direction === "end" && previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return safe - 1;
  return safe;
}

function segmentedGraphemeBoundary(text: string, index: number, direction: "start" | "end"): number | null {
  if (!graphemeSegmenter || index <= 0 || index >= text.length) return null;
  const sliceStart = Math.max(0, index - GRAPHEME_BOUNDARY_CONTEXT_CHARS);
  const sliceEnd = Math.min(text.length, index + GRAPHEME_BOUNDARY_CONTEXT_CHARS);
  const slice = text.slice(sliceStart, sliceEnd);
  let offset = 0;
  for (const item of graphemeSegmenter.segment(slice)) {
    const localStart = typeof item.index === "number" ? item.index : offset;
    const start = sliceStart + localStart;
    const end = start + item.segment.length;
    offset = localStart + item.segment.length;
    if (index === start || index === end) return index;
    if (index > start && index < end) return direction === "start" ? start : end;
    if (index < start) break;
  }
  return null;
}

function firstUtf8TailStart(buffer: Buffer): number {
  let index = 0;
  while (index < buffer.length && (buffer[index]! & 0xc0) === 0x80) index++;
  return index;
}
