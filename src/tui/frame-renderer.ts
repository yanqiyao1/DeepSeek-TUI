/** Fullscreen terminal frame renderer with line diffing and optional synchronized output. */

import { visibleLength } from "../ui/ansi.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

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
  const configured = safeFrameProperty(env, "SEEKCODE_TUI_SYNC_OUTPUT")
    ?? safeFrameProperty(env, "SEEKCODE_SYNC_OUTPUT");
  if (configured !== undefined) return isEnabledText(configured);
  return safeFrameProperty(stdout, "isTTY") === true && safeFrameProperty(env, "TERM") !== "dumb";
}

export class FrameRenderer {
  private previousFrame: string[] = [];
  private previousRows = 0;
  private previousCols = 0;
  private previousCursor: FrameRenderCursor | null = null;
  private readonly stdout: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  private readonly stderr: Pick<NodeJS.WriteStream, "write">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  lastStats: FrameRenderStats | null = null;

  constructor(private readonly options: FrameRendererOptions = {}) {
    this.stdout = safeWritable(safeFrameProperty(options, "stdout"), process.stdout);
    this.stderr = safeWritable(safeFrameProperty(options, "stderr"), process.stderr);
    const env = safeFrameProperty(options, "env");
    this.env = isRecordLike(env) ? env as NodeJS.ProcessEnv : process.env;
    const now = safeFrameProperty(options, "now");
    this.now = typeof now === "function" ? () => safeNow(now as () => unknown) : (() => performance.now());
  }

  reset(): void {
    this.previousFrame = [];
    this.previousRows = 0;
    this.previousCols = 0;
    this.previousCursor = null;
    this.lastStats = null;
  }

  render(frame: string[], options: FrameRenderOptions): FrameRenderStats {
    const startedAt = this.now();
    const safeFrame = safeFrameItems(frame);
    const colsValue = safeFrameProperty(options, "cols");
    const totalRows = safeRowCount(safeFrame.length);
    const rawCols = colsValue ?? 0;
    const firstLine = safeFrame[0];
    const cols = safeColCount(colsValue ?? (typeof firstLine === "string" ? firstLine.length : 0));
    const cursorCols = colsValue === undefined || !Number.isFinite(Number(rawCols))
      ? Number.POSITIVE_INFINITY
      : cols;
    const cursor = safeCursor(safeFrameProperty(options, "cursor"), totalRows, cursorCols);
    const fullRepaint = safeFrameProperty(options, "force") === true
      || this.previousRows !== totalRows
      || this.previousCols !== cols;
    const rowChunks: string[] = [];
    const nextFrame: string[] = [];
    let changedRows = 0;

    for (let index = 0; index < totalRows; index++) {
      const next = sanitizeFrameLine(safeFrame[index] ?? "");
      nextFrame.push(next);
      const previous = fullRepaint ? undefined : this.previousFrame[index];
      if (next === previous) continue;
      changedRows++;
      const shouldClearRow = fullRepaint || sanitizedVisibleLength(next) < sanitizedVisibleLength(previous ?? "");
      rowChunks.push(`${CSI}${index + 1};1H${next}${shouldClearRow ? `${CSI}K` : ""}`);
    }

    const cursorChanged = !sameCursor(this.previousCursor, cursor);
    if (!fullRepaint && changedRows === 0) {
      if (cursorChanged) this.write([`${CSI}${cursor.row};${cursor.col}H`]);
      this.previousCursor = cursor;
      return this.recordStats({
        changedRows,
        totalRows,
        fullRepaint,
      }, startedAt);
    }

    const chunks: string[] = [];
    chunks.push(`${CSI}?25l`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_START);
    chunks.push(...rowChunks);
    chunks.push(`${CSI}${cursor.row};${cursor.col}H`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_END);
    chunks.push(`${CSI}?25h`);

    this.write(chunks);
    this.previousFrame = nextFrame;
    this.previousRows = totalRows;
    this.previousCols = cols;
    this.previousCursor = cursor;

    const stats = this.recordStats({
      changedRows,
      totalRows,
      fullRepaint,
    }, startedAt);
    return stats;
  }

  renderAnchored(frame: string[], options: AnchoredFrameRenderOptions): FrameRenderStats {
    const startedAt = this.now();
    const safeFrame = safeFrameItems(frame);
    const previousFrame = safeFrameItems(safeFrameProperty(options, "previousFrame"));
    const rowsToPaint = safeRowCount(Math.max(safeFrame.length, previousFrame.length));
    const cursor = safeCursor(safeFrameProperty(options, "cursor"), rowsToPaint, Number.POSITIVE_INFINITY);
    const fullRepaint = safeFrameProperty(options, "force") === true;
    const chunks: string[] = [];
    let changedRows = 0;

    chunks.push(`${CSI}?25l`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_START);

    for (let index = 0; index < rowsToPaint; index++) {
      const next = sanitizeFrameLine(safeFrame[index] ?? "");
      const previous = fullRepaint ? undefined : sanitizeFrameLine(previousFrame[index] ?? "");
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
    const configured = safeFrameProperty(this.options, "synchronizedOutput");
    if (typeof configured === "boolean") return configured;
    return shouldUseSynchronizedOutput(this.env, this.stdout);
  }

  private logSlowFrame(stats: FrameRenderStats): void {
    const configuredDebug = safeFrameProperty(this.options, "debug");
    const debug = typeof configuredDebug === "boolean"
      ? configuredDebug
      : isEnabledText(safeFrameProperty(this.env, "SEEKCODE_TUI_DEBUG"));
    if (!debug) return;
    const configuredSlowFrameMs = safeFrameProperty(this.options, "slowFrameMs");
    const slowFrameMs = typeof configuredSlowFrameMs === "number"
      ? configuredSlowFrameMs
      : Number.parseFloat(stringOrDefault(safeFrameProperty(this.env, "SEEKCODE_TUI_SLOW_FRAME_MS"), "32"));
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
  return safeSliceTextBoundary(text, maxChars);
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

function safeCursor(cursor: unknown, rows: number, cols: number): FrameRenderCursor {
  const row = Number(safeFrameProperty(cursor, "row"));
  const col = Number(safeFrameProperty(cursor, "col"));
  const maxRow = Math.max(1, rows);
  const maxCol = cols === Number.POSITIVE_INFINITY ? MAX_FRAME_COLS : Math.max(1, cols);
  return {
    row: Number.isFinite(row) ? Math.max(1, Math.min(Math.floor(row), maxRow)) : maxRow,
    col: Number.isFinite(col) ? Math.max(1, Math.min(Math.floor(col), maxCol)) : 1,
  };
}

function sameCursor(a: FrameRenderCursor | null, b: FrameRenderCursor): boolean {
  return !!a && a.row === b.row && a.col === b.col;
}

function isRecordLike(value: unknown): boolean {
  return !!value && (typeof value === "object" || typeof value === "function");
}

function safeFrameProperty(value: unknown, key: string | number | symbol): unknown {
  if (!isRecordLike(value)) return undefined;
  try {
    return (value as Record<string | number | symbol, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeWritable<T extends Pick<NodeJS.WriteStream, "write">>(value: unknown, fallback: T): T {
  return typeof safeFrameProperty(value, "write") === "function" ? value as T : fallback;
}

function safeFrameItems(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const count = safeRowCount(length);
  const items: unknown[] = [];
  for (let index = 0; index < count; index++) {
    items.push(safeFrameProperty(value, index) ?? "");
  }
  return items;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isEnabledText(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(stringOrDefault(value, ""));
}

function safeNow(now: () => unknown): number {
  try {
    const value = Number(now());
    return Number.isFinite(value) ? value : performance.now();
  } catch {
    return performance.now();
  }
}
