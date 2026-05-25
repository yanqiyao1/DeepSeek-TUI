/** Fullscreen terminal frame renderer with line diffing and optional synchronized output. */

import { visibleLength } from "../ui/ansi.js";

const CSI = "\x1b[";
const SYNC_START = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;
const MAX_FRAME_ROWS = 100_000;
const MAX_FRAME_COLS = 10_000;
const MAX_FRAME_CELL_CHARS = 200_000;
const CONTROL_FRAME_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;

export interface FrameRenderCursor {
  row: number;
  col: number;
}

export interface FrameRenderStats {
  changedRows: number;
  totalRows: number;
  durationMs: number;
  fullRepaint: boolean;
}

export interface FrameRendererOptions {
  stdout?: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  synchronizedOutput?: boolean;
  debug?: boolean;
  slowFrameMs?: number;
}

export interface FrameRenderOptions {
  cursor: FrameRenderCursor;
  force?: boolean;
  cols?: number;
}

export interface AnchoredFrameRenderOptions {
  previousFrame: string[];
  cursor: FrameRenderCursor;
  force?: boolean;
}

export function shouldUseSynchronizedOutput(
  env: NodeJS.ProcessEnv = process.env,
  stdout: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
): boolean {
  const configured = env.SEEKCODE_TUI_SYNC_OUTPUT ?? env.SEEKCODE_SYNC_OUTPUT;
  if (configured !== undefined) return /^(1|true|yes|on)$/i.test(configured);
  return stdout.isTTY === true && env.TERM !== "dumb";
}

export class FrameRenderer {
  private previousFrame: string[] = [];
  private previousRows = 0;
  private previousCols = 0;
  private readonly stdout: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  private readonly stderr: Pick<NodeJS.WriteStream, "write">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  lastStats: FrameRenderStats | null = null;

  constructor(private readonly options: FrameRendererOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => performance.now());
  }

  reset(): void {
    this.previousFrame = [];
    this.previousRows = 0;
    this.previousCols = 0;
    this.lastStats = null;
  }

  render(frame: string[], options: FrameRenderOptions): FrameRenderStats {
    const startedAt = this.now();
    const totalRows = safeRowCount(frame.length);
    const rawCols = options.cols ?? 0;
    const cols = safeColCount(options.cols ?? frame[0]?.length ?? 0);
    const cursorCols = options.cols === undefined || !Number.isFinite(Number(rawCols))
      ? Number.POSITIVE_INFINITY
      : cols;
    const cursor = safeCursor(options.cursor, totalRows, cursorCols);
    const fullRepaint = options.force === true
      || this.previousRows !== totalRows
      || this.previousCols !== cols;
    const chunks: string[] = [];
    let changedRows = 0;

    chunks.push(`${CSI}?25l`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_START);

    for (let index = 0; index < totalRows; index++) {
      const next = sanitizeFrameLine(frame[index] ?? "");
      const previous = fullRepaint ? undefined : this.previousFrame[index];
      if (next === previous) continue;
      changedRows++;
      const shouldClearRow = fullRepaint || sanitizedVisibleLength(next) < sanitizedVisibleLength(previous ?? "");
      chunks.push(`${CSI}${index + 1};1H${next}${shouldClearRow ? `${CSI}K` : ""}`);
    }

    chunks.push(`${CSI}${cursor.row};${cursor.col}H`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_END);
    chunks.push(`${CSI}?25h`);

    this.write(chunks);
    this.previousFrame = frame.slice(0, totalRows).map(line => sanitizeFrameLine(line ?? ""));
    this.previousRows = totalRows;
    this.previousCols = cols;

    const stats = this.recordStats({
      changedRows,
      totalRows,
      fullRepaint,
    }, startedAt);
    return stats;
  }

  renderAnchored(frame: string[], options: AnchoredFrameRenderOptions): FrameRenderStats {
    const startedAt = this.now();
    const rowsToPaint = safeRowCount(Math.max(frame.length, options.previousFrame.length));
    const cursor = safeCursor(options.cursor, rowsToPaint, Number.POSITIVE_INFINITY);
    const fullRepaint = options.force === true;
    const chunks: string[] = [];
    let changedRows = 0;

    chunks.push(`${CSI}?25l`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_START);

    for (let index = 0; index < rowsToPaint; index++) {
      const next = sanitizeFrameLine(frame[index] ?? "");
      const previous = fullRepaint ? undefined : sanitizeFrameLine(options.previousFrame[index] ?? "");
      if (next !== previous) {
        changedRows++;
        chunks.push(`\r${CSI}2K${next}`);
      }
      if (index < rowsToPaint - 1) chunks.push("\r\n");
    }

    const rowsAfterCursor = Math.max(0, rowsToPaint - cursor.row);
    chunks.push("\r");
    if (rowsAfterCursor > 0) chunks.push(`${CSI}${rowsAfterCursor}A`);
    if (cursor.col > 1) chunks.push(`${CSI}${cursor.col - 1}C`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_END);
    chunks.push(`${CSI}?25h`);

    this.write(chunks);
    const stats = this.recordStats({
      changedRows,
      totalRows: rowsToPaint,
      fullRepaint,
    }, startedAt);
    return stats;
  }

  private useSynchronizedOutput(): boolean {
    if (this.options.synchronizedOutput !== undefined) return this.options.synchronizedOutput;
    return shouldUseSynchronizedOutput(this.env, this.stdout);
  }

  private logSlowFrame(stats: FrameRenderStats): void {
    const debug = this.options.debug ?? /^(1|true|yes|on)$/i.test(this.env.SEEKCODE_TUI_DEBUG ?? "");
    if (!debug) return;
    const slowFrameMs = this.options.slowFrameMs ?? Number.parseFloat(this.env.SEEKCODE_TUI_SLOW_FRAME_MS ?? "32");
    if (!Number.isFinite(slowFrameMs) || stats.durationMs <= slowFrameMs) return;
    this.stderr.write(`[seekcode:tui] slow frame ${stats.durationMs.toFixed(1)}ms, rows ${stats.changedRows}/${stats.totalRows}${stats.fullRepaint ? ", full repaint" : ""}\n`);
  }

  private write(chunks: string[]): void {
    this.stdout.write(chunks.join(""));
  }

  private recordStats(stats: Omit<FrameRenderStats, "durationMs">, startedAt: number): FrameRenderStats {
    const frameStats = {
      ...stats,
      durationMs: this.now() - startedAt,
    };
    this.lastStats = frameStats;
    this.logSlowFrame(frameStats);
    return frameStats;
  }
}

function sanitizeFrameLine(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return safeSlice(value.replace(CONTROL_FRAME_RE, " "), MAX_FRAME_CELL_CHARS);
}

function sanitizedVisibleLength(value: string): number {
  return visibleLength(sanitizeFrameLine(value));
}

function safeSlice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, Math.floor(maxChars));
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return text.slice(0, end);
}

function safeRowCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_FRAME_ROWS, Math.floor(parsed));
}

function safeColCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(MAX_FRAME_COLS, Math.floor(parsed));
}

function safeCursor(cursor: FrameRenderCursor, rows: number, cols: number): FrameRenderCursor {
  const row = Number(cursor?.row);
  const col = Number(cursor?.col);
  const maxRow = Math.max(1, rows);
  const maxCol = cols === Number.POSITIVE_INFINITY ? MAX_FRAME_COLS : Math.max(1, cols);
  return {
    row: Number.isFinite(row) ? Math.max(1, Math.min(Math.floor(row), maxRow)) : maxRow,
    col: Number.isFinite(col) ? Math.max(1, Math.min(Math.floor(col), maxCol)) : 1,
  };
}
