import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { submittedLineValue } from "../src/tui/app.js";
import * as screen from "../src/tui/screen.js";

describe("TUI screen lifecycle", () => {
  let originalWrite: typeof process.stdout.write;
  let originalRows: number | undefined;
  let originalColumns: number | undefined;
  let chunks: string[];

  beforeEach(() => {
    chunks = [];
    originalWrite = process.stdout.write;
    originalRows = process.stdout.rows;
    originalColumns = process.stdout.columns;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    process.stdout.rows = originalRows;
    process.stdout.columns = originalColumns;
  });

  it("leaves the alternate screen without clearing the restored main buffer", () => {
    screen.setup();
    screen.teardown();

    const output = chunks.join("");
    const leaveIndex = output.lastIndexOf("\x1b[?1049l");

    expect(output).toContain("\x1b[?1049h");
    expect(output).toContain("\x1b[?1049l");
    expect(output.slice(leaveIndex)).not.toContain("\x1b[H\x1b[J");
  });

  it("keeps inline setup and teardown out of the alternate buffer", () => {
    screen.setup({ alternateScreen: false });
    screen.teardown();

    const output = chunks.join("");
    expect(output).not.toContain("\x1b[?1049h");
    expect(output).not.toContain("\x1b[?1049l");
    expect(output).toContain("\x1b[?25l");
    expect(output).toContain("\x1b[?25h");
    expect(output.endsWith("\x1b[0m\r\n")).toBe(true);
    expect(output).toContain("\x1b[?2004l\x1b[?1006l\x1b[?1000l");
  });

  it("can suppress the trailing newline for inline teardown", () => {
    screen.setup({ alternateScreen: false });
    screen.teardown({ finalNewline: false });

    const output = chunks.join("");
    expect(output.endsWith("\x1b[0m")).toBe(true);
    expect(output).not.toContain("\r\n");
  });

  it("defensively disables paste and mouse tracking on teardown", () => {
    screen.setup();
    screen.teardown();

    expect(chunks.join("")).toContain("\x1b[?2004l\x1b[?1006l\x1b[?1000l");
  });

  it("keeps teardown matched to the most recent screen mode without losing alternate-screen cleanup", () => {
    screen.setup();
    screen.setup({ alternateScreen: false });
    screen.teardown();

    const output = chunks.join("");
    expect(output).toContain("\x1b[?1049h");
    expect(output).toContain("\x1b[?1049l");
  });

  it("falls back to a default terminal size when dimensions are unavailable", () => {
    process.stdout.rows = undefined as any;
    process.stdout.columns = undefined as any;

    expect(screen.termSize()).toEqual({ rows: 24, cols: 80 });
  });

  it("normalizes invalid terminal sizes and cursor coordinates", () => {
    process.stdout.rows = Number.POSITIVE_INFINITY as any;
    process.stdout.columns = Number.NaN as any;

    expect(screen.termSize()).toEqual({ rows: 24, cols: 80 });

    screen.moveTo(Number.POSITIVE_INFINITY, Number.NaN);
    expect(chunks.join("")).toBe("\x1b[1;1H");
  });

  it("moves the cursor with explicit row and column coordinates", () => {
    screen.moveTo(7, 11);

    expect(chunks.join("")).toBe("\x1b[7;11H");
  });

  it("clears the screen from the home position", () => {
    screen.clearScreen();

    expect(chunks.join("")).toBe("\x1b[H\x1b[J");
  });

  it("toggles mouse reporting sequences", () => {
    screen.enableMouse();
    screen.disableMouse();

    expect(chunks).toEqual(["\x1b[?1000h\x1b[?1006h", "\x1b[?1006l\x1b[?1000l"]);
  });

  it("toggles bracketed paste mode sequences", () => {
    screen.enableBracketedPaste();
    screen.disableBracketedPaste();

    expect(chunks).toEqual(["\x1b[?2004h", "\x1b[?2004l"]);
  });
});

describe("TUI submitted input", () => {
  it("uses trim only for blank detection and preserves submitted content", () => {
    expect(submittedLineValue("  keep\n  indentation  ")).toBe("  keep\n  indentation  ");
    expect(submittedLineValue(" \n\t ")).toBeNull();
  });
});
