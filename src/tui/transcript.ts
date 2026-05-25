/** Scrollable transcript buffer for chat messages. */

import { fitAnsi, visibleLength, wrapAnsi } from "../ui/ansi.js";

export interface TranscriptLine {
  id: number;
  text: string;    // raw text (may contain ANSI)
  plainLen: number; // visible length
}

interface CachedTranscriptLine extends TranscriptLine {
  wrapCache: Map<number, string[]>;
}

const MAX_WRAP_CACHE_WIDTHS = 8;
const MAX_TOTAL_HEIGHT_CACHE_WIDTHS = 16;
const MAX_APPEND_LINES = 20_000;
const MAX_APPEND_CHARS = 500_000;
const MAX_TRANSCRIPT_LINE_CHARS = 50_000;

export class Transcript {
  lines: CachedTranscriptLine[] = [];
  scrollOffset = 0; // 0 = bottom, positive = scroll up
  maxLines = 100000;
  private lastRenderWidth = 80;
  private nextLineId = 1;
  private totalWrappedHeightByWidth = new Map<number, number>();

  clear(): void {
    this.lines = [];
    this.scrollOffset = 0;
    this.totalWrappedHeightByWidth.clear();
  }

  append(text: string): void {
    const pinnedScroll = this.scrollOffset > 0;
    const lines = normalizeTranscriptText(text).split("\n").slice(0, MAX_APPEND_LINES);
    for (const raw of lines) {
      this.pushLine(this.createLine(raw));
    }
    this.trimToMaxLines();
    this.pruneHeightCaches();
    if (pinnedScroll) this.scrollOffset = Math.min(this.scrollOffset + this.wrapDeltaForLines(lines), this.maxScrollOffset(undefined, this.lastRenderWidth));
  }

  appendFormatted(lines: string[]): void {
    const pinnedScroll = this.scrollOffset > 0;
    const normalized = normalizeTranscriptLines(lines);
    for (const line of normalized) {
      this.pushLine(this.createLine(line));
    }
    this.trimToMaxLines();
    this.pruneHeightCaches();
    if (pinnedScroll) this.scrollOffset = Math.min(this.scrollOffset + this.wrapDeltaForLines(normalized), this.maxScrollOffset(undefined, this.lastRenderWidth));
  }

  replaceLine(index: number, text: string): void {
    if (index < 0 || index >= this.lines.length) return;
    const previous = this.lines[index];
    if (!previous) return;
    this.subtractKnownHeights(previous);
    const next = this.createLine(normalizeTranscriptLine(text));
    this.lines[index] = next;
    this.addKnownHeights(next);
  }

  replaceRange(start: number, deleteCount: number, text: string): number {
    const lines = normalizeTranscriptText(text).split("\n").slice(0, MAX_APPEND_LINES).map(raw => this.createLine(raw));
    const normalizedStart = Math.max(0, Math.min(start, this.lines.length));
    const safeDeleteCount = typeof deleteCount === "number" && Number.isFinite(deleteCount)
      ? Math.min(Math.max(0, Math.floor(deleteCount)), this.lines.length - normalizedStart)
      : 0;
    const removed = this.lines.splice(normalizedStart, safeDeleteCount, ...lines);
    for (const line of removed) this.subtractKnownHeights(line);
    for (const line of lines) this.addKnownHeights(line);
    this.trimToMaxLines();
    return lines.length;
  }

  appendDelta(text: string): void {
    const pinnedScroll = this.scrollOffset > 0;
    const parts = normalizeTranscriptText(text).split("\n").slice(0, MAX_APPEND_LINES);
    if (!this.lines.length) this.pushLine(this.createLine(""));

    const appendToLast = (chunk: string) => {
      const last = this.lines[this.lines.length - 1];
      if (!last) return;
      this.updateLineText(last, last.text + normalizeTranscriptLine(chunk));
    };

    appendToLast(parts[0] ?? "");
    for (const part of parts.slice(1)) {
      this.pushLine(this.createLine(part));
    }

    this.trimToMaxLines();
    this.pruneHeightCaches();
    if (pinnedScroll) this.scrollOffset = Math.min(this.scrollOffset + this.appendDeltaWrappedGrowth(parts), this.maxScrollOffset(undefined, this.lastRenderWidth));
  }

  /** Render visible portion into available height */
  render(height: number, width: number): string {
    const safeHeight = safeRenderHeightValue(height);
    const safeWidth = safeWidthValue(width);
    if (safeHeight <= 0 || safeWidth <= 0) return "";
    this.lastRenderWidth = safeWidth;
    if (this.lines.length === 0) return Array.from({ length: safeHeight }, () => " ".repeat(safeWidth)).join("\n");

    const totalLines = this.desiredHeight(safeWidth);
    if (!totalLines) return Array.from({ length: safeHeight }, () => " ".repeat(safeWidth)).join("\n");
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset(safeHeight, safeWidth));
    const visibleEnd = totalLines - this.scrollOffset;
    const visibleStart = Math.max(0, visibleEnd - safeHeight);

    const out = this.wrappedRowsRange(safeWidth, visibleStart, visibleEnd).map(row => fitAnsi(row, safeWidth));

    while (out.length < safeHeight) out.push(" ".repeat(safeWidth));
    return out.join("\n");
  }

  desiredHeight(width: number): number {
    const safeWidth = safeWidthValue(width);
    if (safeWidth <= 0 || !this.lines.length) return 0;
    return this.totalWrappedHeight(safeWidth);
  }

  wrappedRows(width: number): string[] {
    const safeWidth = safeWidthValue(width);
    return this.wrappedRowsRange(safeWidth, 0, this.desiredHeight(safeWidth));
  }

  wrappedRowOffsetForLine(index: number, width: number): number {
    const safeWidth = safeWidthValue(width);
    if (safeWidth <= 0 || !this.lines.length) return 0;
    const end = Math.max(0, Math.min(Math.floor(index), this.lines.length));
    let rows = 0;
    for (let lineIndex = 0; lineIndex < end; lineIndex++) {
      const line = this.lines[lineIndex];
      if (line) rows += this.wrapLine(line, safeWidth).length;
    }
    return rows;
  }

  wrappedRowsRange(width: number, start: number, end: number): string[] {
    const safeWidth = safeWidthValue(width);
    if (safeWidth <= 0 || end <= start || !this.lines.length) return [];
    const totalRows = this.desiredHeight(safeWidth);
    const safeStart = Math.max(0, Math.min(Math.floor(start), totalRows));
    const safeEnd = Math.max(safeStart, Math.min(Math.floor(end), totalRows));
    if (safeEnd <= safeStart) return [];

    return totalRows - safeEnd < safeStart
      ? this.wrappedRowsRangeFromBottom(safeWidth, safeStart, safeEnd, totalRows)
      : this.wrappedRowsRangeFromTop(safeWidth, safeStart, safeEnd);
  }

  scrollUp(n: number): void {
    this.scrollOffset = Math.min(this.maxScrollOffset(undefined, this.lastRenderWidth), this.scrollOffset + scrollAmount(n));
  }

  scrollDown(n: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - scrollAmount(n));
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
  }

  scrollToTop(): void {
    this.scrollOffset = this.maxScrollOffset(undefined, this.lastRenderWidth);
  }

  maxScrollOffset(height = 1, width = this.lastRenderWidth): number {
    return Math.max(0, this.desiredHeight(width) - safeViewportHeightValue(height));
  }

  cachedWidthCount(): number {
    return this.totalWrappedHeightByWidth.size;
  }

  private createLine(text: string): CachedTranscriptLine {
    const safeText = normalizeTranscriptLine(text);
    return {
      id: this.nextLineId++,
      text: safeText,
      plainLen: visibleLength(safeText),
      wrapCache: new Map(),
    };
  }

  private pushLine(line: CachedTranscriptLine): void {
    this.lines.push(line);
    this.addKnownHeights(line);
  }

  private updateLineText(line: CachedTranscriptLine, text: string): void {
    this.subtractKnownHeights(line);
    const safeText = normalizeTranscriptLine(text);
    line.id = this.nextLineId++;
    line.text = safeText;
    line.plainLen = visibleLength(safeText);
    line.wrapCache.clear();
    this.addKnownHeights(line);
  }

  private trimToMaxLines(): void {
    const excess = this.lines.length - this.maxLines;
    if (excess <= 0) return;
    const removed = this.lines.splice(0, excess);
    for (const line of removed) this.subtractKnownHeights(line);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset(undefined, this.lastRenderWidth));
  }

  private totalWrappedHeight(width: number): number {
    const cached = this.totalWrappedHeightByWidth.get(width);
    if (cached !== undefined) return cached;
    let total = 0;
    for (const line of this.lines) total += this.wrapLine(line, width).length;
    this.totalWrappedHeightByWidth.set(width, total);
    this.pruneHeightCaches();
    return total;
  }

  private addKnownHeights(line: CachedTranscriptLine): void {
    for (const width of this.totalWrappedHeightByWidth.keys()) {
      this.totalWrappedHeightByWidth.set(width, (this.totalWrappedHeightByWidth.get(width) ?? 0) + this.wrapLine(line, width).length);
    }
  }

  private subtractKnownHeights(line: CachedTranscriptLine): void {
    for (const width of this.totalWrappedHeightByWidth.keys()) {
      this.totalWrappedHeightByWidth.set(width, Math.max(0, (this.totalWrappedHeightByWidth.get(width) ?? 0) - this.wrapLine(line, width).length));
    }
  }

  private wrapLine(line: CachedTranscriptLine, width: number): string[] {
    const cached = line.wrapCache.get(width);
    if (cached) return cached;
    const wrapped = wrapAnsi(line.text, width);
    if (line.wrapCache.size >= MAX_WRAP_CACHE_WIDTHS && !line.wrapCache.has(width)) {
      const oldest = line.wrapCache.keys().next().value;
      if (oldest !== undefined) line.wrapCache.delete(oldest);
    }
    line.wrapCache.set(width, wrapped);
    return wrapped;
  }

  private wrapDeltaForText(text: string): number {
    if (this.lastRenderWidth <= 0) return 0;
    const normalized = normalizeTranscriptText(text).split("\n").slice(0, MAX_APPEND_LINES);
    return this.wrapDeltaForLines(normalized);
  }

  private wrapDeltaForLines(lines: string[]): number {
    if (this.lastRenderWidth <= 0) return 0;
    return lines.reduce((total, line) => total + Math.max(1, wrapAnsi(line, this.lastRenderWidth).length), 0);
  }

  private pruneHeightCaches(): void {
    while (this.totalWrappedHeightByWidth.size > MAX_TOTAL_HEIGHT_CACHE_WIDTHS) {
      const oldest = this.totalWrappedHeightByWidth.keys().next().value;
      if (oldest === undefined) break;
      this.totalWrappedHeightByWidth.delete(oldest);
      for (const line of this.lines) line.wrapCache.delete(oldest);
    }
  }

  private appendDeltaWrappedGrowth(parts: string[]): number {
    if (this.lastRenderWidth <= 0 || !parts.length) return 0;
    let growth = 0;
    const lastIndex = this.lines.length - parts.length;
    if (lastIndex >= 0) {
      const updatedLine = this.lines[lastIndex];
      const firstPart = parts[0] ?? "";
      if (updatedLine) {
        const previousText = updatedLine.text.slice(0, Math.max(0, updatedLine.text.length - firstPart.length));
        const previousRows = wrapAnsi(previousText, this.lastRenderWidth).length;
        const nextRows = this.wrapLine(updatedLine, this.lastRenderWidth).length;
        growth += Math.max(0, nextRows - Math.max(1, previousRows));
      }
    }
    for (let index = 1; index < parts.length; index++) {
      growth += Math.max(1, wrapAnsi(parts[index]!, this.lastRenderWidth).length);
    }
    return growth;
  }

  private wrappedRowsRangeFromTop(width: number, start: number, end: number): string[] {
    const out: string[] = [];
    let rowStart = 0;
    for (const line of this.lines) {
      const rows = this.wrapLine(line, width);
      const rowEnd = rowStart + rows.length;
      if (rowEnd > start && rowStart < end) {
        out.push(...rows.slice(Math.max(0, start - rowStart), Math.min(rows.length, end - rowStart)));
      }
      if (rowEnd >= end) break;
      rowStart = rowEnd;
    }
    return out;
  }

  private wrappedRowsRangeFromBottom(width: number, start: number, end: number, totalRows: number): string[] {
    const chunks: string[][] = [];
    let rowEnd = totalRows;
    for (let index = this.lines.length - 1; index >= 0 && rowEnd > start; index--) {
      const line = this.lines[index];
      if (!line) continue;
      const rows = this.wrapLine(line, width);
      const rowStart = rowEnd - rows.length;
      if (rowEnd > start && rowStart < end) {
        chunks.push(rows.slice(Math.max(0, start - rowStart), Math.min(rows.length, end - rowStart)));
      }
      rowEnd = rowStart;
    }
    return chunks.reverse().flat();
  }
}

function scrollAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function safeWidthValue(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(10_000, Math.floor(value));
}

function safeHeightValue(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(100_000, Math.floor(value));
}

function safeRenderHeightValue(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(100_000, Math.floor(value));
}

function safeViewportHeightValue(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return 100_000;
  return safeHeightValue(value);
}

function normalizeTranscriptText(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return safeSliceText(value.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), MAX_APPEND_CHARS);
}

function normalizeTranscriptLines(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, MAX_APPEND_LINES).map(line => normalizeTranscriptLine(line));
}

function normalizeTranscriptLine(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return safeSliceText(value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " "), MAX_TRANSCRIPT_LINE_CHARS);
}

function safeSliceText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, Math.floor(maxChars));
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return text.slice(0, end);
}
