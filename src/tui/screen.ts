/** Terminal screen management — alternate buffer, layout, rendering. */

const CSI = "\x1b[";
let activeAlternateScreen = false;
const MAX_TERMINAL_ROWS = 1_000;
const MAX_TERMINAL_COLS = 1_000;

export function enterAltScreen(): void {
  process.stdout.write(`${CSI}?1049h${CSI}H${CSI}J`);
}

export function leaveAltScreen(): void {
  process.stdout.write(`${CSI}?1049l`);
}

export function hideCursor(): void {
  process.stdout.write(`${CSI}?25l`);
}

export function showCursor(): void {
  process.stdout.write(`${CSI}?25h`);
}

export function clearScreen(): void {
  process.stdout.write(`${CSI}H${CSI}J`);
}

export function enableMouse(): void {
  process.stdout.write(`${CSI}?1000h${CSI}?1006h`);
}

export function disableMouse(): void {
  process.stdout.write(`${CSI}?1006l${CSI}?1000l`);
}

export function enableBracketedPaste(): void {
  process.stdout.write(`${CSI}?2004h`);
}

export function disableBracketedPaste(): void {
  process.stdout.write(`${CSI}?2004l`);
}

export function moveTo(row: number, col: number): void {
  process.stdout.write(`${CSI}${safePositiveInteger(row, 1, MAX_TERMINAL_ROWS)};${safePositiveInteger(col, 1, MAX_TERMINAL_COLS)}H`);
}

export function termSize(): { rows: number; cols: number } {
  return {
    rows: safePositiveInteger(process.stdout.rows, 24, MAX_TERMINAL_ROWS),
    cols: safePositiveInteger(process.stdout.columns, 80, MAX_TERMINAL_COLS),
  };
}

export function setup(options: { alternateScreen?: boolean } = {}) {
  const useAlternateScreen = options.alternateScreen !== false;
  if (useAlternateScreen && !activeAlternateScreen) {
    enterAltScreen();
  }
  if (!useAlternateScreen && activeAlternateScreen) {
    // Preserve the active alternate-screen state until teardown restores it.
  }
  activeAlternateScreen = activeAlternateScreen || useAlternateScreen;
  hideCursor();
}

export function teardown(options: { finalNewline?: boolean } = {}) {
  process.stdout.write(`${CSI}?2004l${CSI}?1006l${CSI}?1000l`);
  showCursor();
  if (activeAlternateScreen) {
    leaveAltScreen();
  } else {
    process.stdout.write(`${CSI}0m${options.finalNewline === false ? "" : "\r\n"}`);
  }
  activeAlternateScreen = false;
}

function safePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.floor(value));
}
