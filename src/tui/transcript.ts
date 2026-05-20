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
    for (const raw of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
      this.pushLine(this.createLine(raw));
    }
    this.trimToMaxLines();
    if (pinnedScroll) this.scrollOffset = Math.min(this.scrollOffset + this.wrapDeltaForText(text), this.maxScrollOffset(undefined, this.lastRenderWidth));
  }

  appendFormatted(lines: string[]): void {
    const pinnedScroll = this.scrollOffset > 0;
    for (const line of lines) {
      this.pushLine(this.createLine(line));
    }
    this.trimToMaxLines();
    if (pinnedScroll) this.scrollOffset = Math.min(this.scrollOffset + this.wrapDeltaForLines(lines), this.maxScrollOffset(undefined, this.lastRenderWidth));
  }

  replaceLine(index: number, text: string): void {
    if (index < 0 || index >= this.lines.length) return;
    const previous = this.lines[index];
    if (!previous) return;
    this.subtractKnownHeights(previous);
    const next = this.createLine(text);
    this.lines[index] = next;
    this.addKnownHeights(next);
  }

  replaceRange(start: number, deleteCount: number, text: string): number {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map(raw => this.createLine(raw));
    const normalizedStart = Math.max(0, Math.min(start, this.lines.length));
    const removed = this.lines.splice(normalizedStart, Math.max(0, deleteCount), ...lines);
    for (const line of removed) this.subtractKnownHeights(line);
    for (const line of lines) this.addKnownHeights(line);
    this.trimToMaxLines();
    return lines.length;
  }

  appendDelta(text: string): void {
    const pinnedScroll = this.scrollOffset > 0;
    const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (!this.lines.length) this.pushLine(this.createLine(""));

    const appendToLast = (chunk: string) => {
      const last = this.lines[this.lines.length - 1];
      if (!last) return;
      this.updateLineText(last, last.text + chunk);
    };

    appendToLast(parts[0] ?? "");
    for (const part of parts.slice(1)) {
      this.pushLine(this.createLine(part));
    }

    this.trimToMaxLines();
    if (pinnedScroll) this.scrollOffset = Math.min(this.scrollOffset + this.appendDeltaWrappedGrowth(parts), this.maxScrollOffset(undefined, this.lastRenderWidth));
  }

  /** Render visible portion into available height */
  render(height: number, width: number): string {
    if (height <= 0 || width <= 0) return "";
    this.lastRenderWidth = width;
    if (this.lines.length === 0) return Array.from({ length: height }, () => " ".repeat(width)).join("\n");

    const totalLines = this.desiredHeight(width);
    if (!totalLines) return Array.from({ length: height }, () => " ".repeat(width)).join("\n");
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset(height, width));
    const visibleEnd = totalLines - this.scrollOffset;
    const visibleStart = Math.max(0, visibleEnd - height);

    const out = this.wrappedRowsRange(width, visibleStart, visibleEnd).map(row => fitAnsi(row, width));

    while (out.length < height) out.push(" ".repeat(width));
    return out.join("\n");
  }

  desiredHeight(width: number): number {
    if (width <= 0 || !this.lines.length) return 0;
    return this.totalWrappedHeight(width);
  }

  wrappedRows(width: number): string[] {
    return this.wrappedRowsRange(width, 0, this.desiredHeight(width));
  }

  wrappedRowOffsetForLine(index: number, width: number): number {
    if (width <= 0 || !this.lines.length) return 0;
    const end = Math.max(0, Math.min(Math.floor(index), this.lines.length));
    let rows = 0;
    for (let lineIndex = 0; lineIndex < end; lineIndex++) {
      const line = this.lines[lineIndex];
      if (line) rows += this.wrapLine(line, width).length;
    }
    return rows;
  }

  wrappedRowsRange(width: number, start: number, end: number): string[] {
    if (width <= 0 || end <= start || !this.lines.length) return [];
    const totalRows = this.desiredHeight(width);
    const safeStart = Math.max(0, Math.min(Math.floor(start), totalRows));
    const safeEnd = Math.max(safeStart, Math.min(Math.floor(end), totalRows));
    if (safeEnd <= safeStart) return [];

    return totalRows - safeEnd < safeStart
      ? this.wrappedRowsRangeFromBottom(width, safeStart, safeEnd, totalRows)
      : this.wrappedRowsRangeFromTop(width, safeStart, safeEnd);
  }

  scrollUp(n: number): void {
    this.scrollOffset = Math.min(this.maxScrollOffset(undefined, this.lastRenderWidth), this.scrollOffset + Math.max(0, n));
  }

  scrollDown(n: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(0, n));
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
  }

  scrollToTop(): void {
    this.scrollOffset = this.maxScrollOffset(undefined, this.lastRenderWidth);
  }

  maxScrollOffset(height = 1, width = this.lastRenderWidth): number {
    return Math.max(0, this.desiredHeight(width) - Math.max(1, height));
  }

  private createLine(text: string): CachedTranscriptLine {
    return {
      id: this.nextLineId++,
      text,
      plainLen: visibleLength(text),
      wrapCache: new Map(),
    };
  }

  private pushLine(line: CachedTranscriptLine): void {
    this.lines.push(line);
    this.addKnownHeights(line);
  }

  private updateLineText(line: CachedTranscriptLine, text: string): void {
    this.subtractKnownHeights(line);
    line.id = this.nextLineId++;
    line.text = text;
    line.plainLen = visibleLength(text);
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
    line.wrapCache.set(width, wrapped);
    return wrapped;
  }

  private wrapDeltaForText(text: string): number {
    if (this.lastRenderWidth <= 0) return 0;
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    return this.wrapDeltaForLines(normalized);
  }

  private wrapDeltaForLines(lines: string[]): number {
    if (this.lastRenderWidth <= 0) return 0;
    return lines.reduce((total, line) => total + Math.max(1, wrapAnsi(line, this.lastRenderWidth).length), 0);
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
