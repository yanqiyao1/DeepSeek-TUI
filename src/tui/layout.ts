/** Full-screen TUI layout controller. */

import { fitAnsi, truncateAnsi, visibleLength, wrapAnsiLine } from "../ui/ansi.js";
import { safeGraphemeBoundary, safeSliceTextBoundary } from "../utils/text-boundary.js";
import * as screen from "./screen.js";
import { FrameRenderer } from "./frame-renderer.js";
import { Transcript } from "./transcript.js";

export interface LayoutRenderOptions {
  footer: string;
  prompt: string;
  statusLine?: string;
  input?: string;
  cursor?: number;
  completions?: string[];
  completionLimit?: number;
  freezeHistory?: boolean;
  mutableTranscriptStartLine?: number | null;
}

export type TuiLayoutMode = "fullscreen" | "inline";

const MAX_INPUT_RENDER_CHARS = 1_000_000;
const MAX_FULL_INPUT_WRAP_CHARS = 20_000;
const MAX_INPUT_WINDOW_BEFORE_CHARS = 4_000;
const MAX_INPUT_WINDOW_AFTER_CHARS = 1_000;
const MAX_PROMPT_WIDTH = 1_000;

export class TuiLayout {
  private committedInlineRows = 0;
  private lastInlineRows = 0;
  private lastInlineCursorRow = 1;
  private lastInlineWidth = 0;
  private lastInlineRenderedRows: string[] = [];

  constructor(
    readonly transcript: Transcript,
    readonly mode: TuiLayoutMode = "fullscreen",
    private readonly frameRenderer = new FrameRenderer(),
  ) {}

  visibleTranscriptRows(options: LayoutRenderOptions, rows: number, cols: number): number {
    const size = { rows: Math.max(6, rows), cols: Math.max(20, cols) };
    const completionLines = (options.completions ?? []).slice(0, this.completionLimit(options, size.rows));
    const inputLines = this.inputRows(options.prompt, options.input ?? "", options.cursor ?? (options.input ?? "").length, size.cols);
    const statusRows = options.statusLine ? 1 : 0;
    const reservedRows = 2 + statusRows + completionLines.length + inputLines.length;
    const maxTranscriptRows = Math.max(0, size.rows - reservedRows);
    return Math.min(this.transcript.desiredHeight(size.cols), maxTranscriptRows);
  }

  render(options: LayoutRenderOptions): void {
    if (this.mode === "inline") {
      this.renderInline(options);
      return;
    }
    this.renderFullscreen(options);
  }

  reset(): void {
    this.committedInlineRows = 0;
    this.lastInlineRows = 0;
    this.lastInlineCursorRow = 1;
    this.lastInlineWidth = 0;
    this.lastInlineRenderedRows = [];
    this.frameRenderer.reset();
  }

  finish(): void {
    if (this.mode !== "inline" || this.lastInlineRows <= 0) return;
    process.stdout.write("\r");
    const rowsBelowCursor = Math.max(0, this.lastInlineRows - this.lastInlineCursorRow);
    if (rowsBelowCursor > 0) process.stdout.write(`\x1b[${rowsBelowCursor}B`);
    process.stdout.write("\r\n");
    this.lastInlineRows = 0;
    this.lastInlineCursorRow = 1;
  }

  private renderFullscreen(options: LayoutRenderOptions): void {
    const rawSize = screen.termSize();
    const size = { rows: Math.max(6, rawSize.rows), cols: Math.max(20, rawSize.cols) };
    const [dividerLine = "", statusLine = ""] = options.footer.split("\n").slice(0, 2);

    const completionLines = (options.completions ?? []).slice(0, this.completionLimit(options, size.rows));
    const inputValue = options.input ?? "";
    const inputCursor = options.cursor ?? inputValue.length;
    const inputView = this.inputView(options.prompt, inputValue, inputCursor, size.cols);
    const inputLines = inputView.rows;
    const transcriptRows = this.visibleTranscriptRows(options, size.rows, size.cols);
    const fixedStatusLine = options.statusLine ? fitAnsi(options.statusLine, size.cols) : null;

    const frame: string[] = [];
    if (transcriptRows > 0) frame.push(...this.transcript.render(transcriptRows, size.cols).split("\n"));
    frame.push(fitAnsi(dividerLine, size.cols));
    frame.push(...completionLines.map(line => fitAnsi(line, size.cols)));
    if (fixedStatusLine) frame.push(fixedStatusLine);
    frame.push(...inputLines.map(line => fitAnsi(line, size.cols)));
    const inputBottomRow = frame.length;
    frame.push(fitAnsi(statusLine, size.cols));
    while (frame.length < size.rows) frame.push(" ".repeat(size.cols));
    if (frame.length > size.rows) frame.length = size.rows;

    const cursor = this.cursorPosition(
      options.prompt,
      inputValue,
      inputCursor,
      size.cols,
      inputBottomRow,
    );
    this.frameRenderer.render(frame, { cursor, cols: size.cols });
  }

  private renderInline(options: LayoutRenderOptions): void {
    const rawSize = screen.termSize();
    const size = { rows: Math.max(6, rawSize.rows), cols: Math.max(20, rawSize.cols) };
    const [dividerLine = "", statusLine = ""] = options.footer.split("\n").slice(0, 2);

    if (this.lastInlineWidth && this.lastInlineWidth !== size.cols) {
      this.clearInlineRows();
      this.reset();
    }
    this.lastInlineWidth = size.cols;

    const completionLines = (options.completions ?? []).slice(0, this.completionLimit(options, size.rows));
    const inputValue = options.input ?? "";
    const inputCursor = options.cursor ?? inputValue.length;
    const inputView = this.inputView(options.prompt, inputValue, inputCursor, size.cols);
    const inputLines = inputView.rows;
    const transcriptRows = this.visibleTranscriptRows(options, size.rows, size.cols);
    const totalWrappedRows = this.transcript.desiredHeight(size.cols);
    const fixedStatusLine = options.statusLine ? fitAnsi(options.statusLine, size.cols) : null;
    const desiredCommitTarget = options.freezeHistory
      ? Math.min(this.committedInlineRows, totalWrappedRows)
      : Math.max(0, totalWrappedRows - transcriptRows);
    const commitLimit = options.mutableTranscriptStartLine === undefined || options.mutableTranscriptStartLine === null
      ? totalWrappedRows
      : this.transcript.wrappedRowOffsetForLine(options.mutableTranscriptStartLine, size.cols);
    const commitTarget = Math.min(desiredCommitTarget, commitLimit);

    screen.hideCursor();
    if (this.lastInlineRows > 0) {
      process.stdout.write("\r");
      if (this.lastInlineCursorRow > 1) process.stdout.write(`\x1b[${this.lastInlineCursorRow - 1}A`);
    }

    const historyRows = commitTarget > this.committedInlineRows
      ? this.transcript.wrappedRowsRange(size.cols, this.committedInlineRows, commitTarget)
      : [];
    if (commitTarget > this.committedInlineRows) {
      if (historyRows.length) {
        for (const line of historyRows) {
          process.stdout.write(`\r\x1b[2K${fitAnsi(line, size.cols)}\n`);
        }
      }
      this.committedInlineRows = commitTarget;
    }

    const transcriptOutput = transcriptRows > 0 ? this.transcript.render(transcriptRows, size.cols).split("\n") : [];
    const rows = [
      ...transcriptOutput,
      fitAnsi(dividerLine, size.cols),
      ...completionLines.map(line => fitAnsi(line, size.cols)),
      ...(fixedStatusLine ? [fixedStatusLine] : []),
      ...inputLines.map(line => fitAnsi(line, size.cols)),
      fitAnsi(statusLine, size.cols),
    ];

    const previousRows = historyRows.length
      ? this.lastInlineRenderedRows.slice(historyRows.length)
      : this.lastInlineRenderedRows;

    const inputBottomRow = transcriptOutput.length + 1 + completionLines.length + (fixedStatusLine ? 1 : 0) + inputLines.length;
    const cursor = this.cursorPosition(
      options.prompt,
      inputValue,
      inputCursor,
      size.cols,
      inputBottomRow,
    );
    this.frameRenderer.renderAnchored(rows, {
      previousFrame: previousRows,
      cursor,
    });

    this.lastInlineRows = rows.length;
    this.lastInlineCursorRow = cursor.row;
    this.lastInlineRenderedRows = rows;
  }

  private clearInlineRows(): void {
    if (this.lastInlineRows <= 0) return;
    process.stdout.write("\r");
    if (this.lastInlineCursorRow > 1) process.stdout.write(`\x1b[${this.lastInlineCursorRow - 1}A`);
    for (let i = 0; i < this.lastInlineRows; i++) {
      process.stdout.write("\r\x1b[2K");
      if (i < this.lastInlineRows - 1) process.stdout.write("\n");
    }
    process.stdout.write("\r");
    if (this.lastInlineRows > 1) process.stdout.write(`\x1b[${this.lastInlineRows - 1}A`);
  }

  private inputRows(prompt: string, input: string, cursor: number, cols: number): string[] {
    return this.inputView(prompt, input, cursor, cols).rows;
  }

  cursorPosition(prompt: string, input: string, cursor: number, cols: number, rows: number): { row: number; col: number } {
    const view = this.inputView(prompt, input, cursor, cols);
    return {
      row: rows - view.rows.length + view.cursorRow,
      col: view.cursorCol,
    };
  }

  private maxCompletions(rows: number): number {
    return Math.max(0, Math.min(8, rows - 8));
  }

  private completionLimit(options: LayoutRenderOptions, rows: number): number {
    if (options.completionLimit === undefined) return this.maxCompletions(rows);
    const parsed = Number(options.completionLimit);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(Math.floor(parsed), rows - 3));
  }

  private inputView(prompt: string, input: string, cursor: number, cols: number): { rows: string[]; cursorRow: number; cursorCol: number } {
    const safeCols = Math.max(1, Math.floor(Number.isFinite(cols) ? cols : 1));
    const safePrompt = safePromptPrefix(prompt);
    const normalizedInput = safeSliceText(input.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), MAX_INPUT_RENDER_CHARS);
    const normalizedCursor = Math.min(normalizedInput.length, normalizedCursorIndex(input, cursor));
    const safeCursor = safeGraphemeBoundaryEnd(normalizedInput, normalizedCursor);
    if (normalizedInput.length > MAX_FULL_INPUT_WRAP_CHARS) {
      return this.inputWindowView(safePrompt, normalizedInput, safeCursor, safeCols);
    }
    const logicalLines = normalizedInput.split("\n");
    const promptPadding = " ".repeat(Math.min(MAX_PROMPT_WIDTH, visibleLength(safePrompt)));
    const allRows: string[] = [];
    for (let index = 0; index < logicalLines.length; index++) {
      const prefix = index === 0 ? safePrompt : promptPadding;
      allRows.push(...wrapAnsiLine(prefix + logicalLines[index], safeCols));
    }

    const beforeCursor = normalizedInput.slice(0, safeCursor);
    const logicalBeforeCursor = beforeCursor.split("\n");
    let cursorRowAbsolute = 0;
    for (let index = 0; index < logicalBeforeCursor.length; index++) {
      const prefix = index === 0 ? safePrompt : promptPadding;
      cursorRowAbsolute += wrapAnsiLine(prefix + logicalBeforeCursor[index], safeCols).length;
    }

    const promptWidth = visibleLength(safePrompt);
    const currentLogicalLine = logicalBeforeCursor.at(-1) ?? "";
    const width = promptWidth + visibleLength(currentLogicalLine);
    const cursorCol = width > 0 && width % safeCols === 0 ? safeCols : (width % safeCols) + 1;

    const visibleCount = Math.min(3, Math.max(1, allRows.length));
    const maxStart = Math.max(0, allRows.length - visibleCount);
    const windowStart = Math.min(Math.max(0, cursorRowAbsolute - visibleCount), maxStart);

    return {
      rows: allRows.slice(windowStart, windowStart + visibleCount),
      cursorRow: Math.max(1, cursorRowAbsolute - windowStart),
      cursorCol,
    };
  }

  private inputWindowView(prompt: string, input: string, cursor: number, cols: number): { rows: string[]; cursorRow: number; cursorCol: number } {
    const lineStart = input.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
    const nextNewline = input.indexOf("\n", cursor);
    const lineEnd = nextNewline < 0 ? input.length : nextNewline;
    const line = input.slice(lineStart, lineEnd);
    const cursorInLine = safeGraphemeBoundaryEnd(line, Math.max(0, Math.min(cursor - lineStart, line.length)));
    const windowStartInLine = safeGraphemeBoundaryStart(line, Math.max(0, cursorInLine - MAX_INPUT_WINDOW_BEFORE_CHARS));
    const windowEndInLine = safeGraphemeBoundaryEnd(line, Math.min(line.length, cursorInLine + MAX_INPUT_WINDOW_AFTER_CHARS));
    const windowLine = line.slice(windowStartInLine, windowEndInLine);
    const windowCursor = Math.max(0, Math.min(cursorInLine - windowStartInLine, windowLine.length));
    const promptPadding = " ".repeat(Math.min(MAX_PROMPT_WIDTH, visibleLength(prompt)));
    const prefix = lineStart === 0 ? prompt : promptPadding;
    const rows = wrapAnsiLine(prefix + windowLine, cols);
    const beforeCursor = windowLine.slice(0, windowCursor);
    const beforeCursorRows = wrapAnsiLine(prefix + beforeCursor, cols);
    const cursorRowAbsolute = beforeCursorRows.length;
    const width = visibleLength(prefix) + visibleLength(beforeCursor);
    const cursorCol = width > 0 && width % cols === 0 ? cols : (width % cols) + 1;
    const visibleCount = Math.min(3, Math.max(1, rows.length));
    const maxStart = Math.max(0, rows.length - visibleCount);
    const windowStart = Math.min(Math.max(0, cursorRowAbsolute - visibleCount), maxStart);

    return {
      rows: rows.slice(windowStart, windowStart + visibleCount),
      cursorRow: Math.max(1, cursorRowAbsolute - windowStart),
      cursorCol,
    };
  }
}

function safePromptPrefix(value: string): string {
  if (!value) return "";
  return truncateAnsi(value.replace(/\r\n/g, " ").replace(/\r/g, " ").replace(/\n/g, " "), MAX_PROMPT_WIDTH);
}

function safeSliceText(text: string, maxChars: number): string {
  return safeSliceTextBoundary(text, maxChars);
}

function safeGraphemeBoundaryStart(text: string, index: number): number {
  return safeGraphemeBoundary(text, index, "start");
}

function safeGraphemeBoundaryEnd(text: string, index: number): number {
  return safeGraphemeBoundary(text, index, "end");
}

function normalizedCursorIndex(input: string, cursor: number): number {
  const sourceCursor = typeof cursor === "number" && Number.isFinite(cursor)
    ? Math.max(0, Math.min(Math.floor(cursor), input.length))
    : input.length;
  let normalizedIndex = 0;
  let lastBoundary = 0;
  for (let index = 0; index < sourceCursor;) {
    if (input[index] === "\r") {
      if (input[index + 1] === "\n" && index + 1 < sourceCursor) index += 2;
      else index += 1;
      normalizedIndex += 1;
      lastBoundary = normalizedIndex;
      continue;
    }
    const codePoint = input.codePointAt(index);
    if (codePoint === undefined) break;
    const charLength = codePoint > 0xffff ? 2 : 1;
    if (index + charLength > sourceCursor) break;
    index += charLength;
    normalizedIndex += charLength;
    lastBoundary = normalizedIndex;
  }
  return lastBoundary;
}
