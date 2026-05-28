import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { pickFromList } from "../src/commands/picker.js";
import { nextModeName } from "../src/modes/base.js";
import { fitAnsi, stripAnsi, truncateAnsi, visibleLength, wrapAnsi, wrapAnsiLine } from "../src/ui/ansi.js";
import {
  COMMANDS,
  coalesceInputSequences,
  commandCompletionProvider,
  disableBracketedPaste,
  enableBracketedPaste,
  InputController,
  isBracketedPasteEnd,
  isBracketedPasteStart,
  isPlainTextInputSequence,
  isShiftTabSequence,
  looksLikePasteTextBurst,
  MAX_INPUT_CHARS,
  currentLineEndIndex,
  currentLineStartIndex,
  nextGraphemeIndex,
  nextWordIndex,
  PASTE_BURST_NEWLINE_WINDOW_MS,
  previousGraphemeIndex,
  previousWordIndex,
  readInput,
  restoreTTYInput,
  sanitizeInputText,
  scrollActionForSequence,
  shouldTreatNewlineAsPaste,
  splitInputSequences,
  trailingIncompleteEscapeStart,
} from "../src/ui/input.js";
import { renderMarkdown } from "../src/ui/markdown.js";
import { appendPromptHistory, flushPromptHistoryWrites, loadPromptHistory, normalizePromptHistoryEntries, pushPromptHistoryEntry } from "../src/ui/prompt-history.js";
import { movePickerIndex, pickerActionForSequence, pickerIndexLabel, pickerWindow, safePickerItem, safePickerTitle } from "../src/ui/picker.js";
import { approvalPrompt, commandOutput, footerDivider, statusBar, statusBarFromItems, thinkingHeader, thinkingStatusLine, thinkingText, toolDiffPreview, toolResultPreview, userMessageBlock, welcomeBanner } from "../src/ui/renderer.js";
import { AssistantStream } from "../src/tui/assistant-stream.js";
import { shouldUseAlternateScreen } from "../src/tui/alternate-screen.js";
import { FrameRenderer, shouldUseSynchronizedOutput } from "../src/tui/frame-renderer.js";
import { TuiLayout } from "../src/tui/layout.js";
import { denyModeSwitchWhileRunning, RUNNING_MODE_SWITCH_BLOCKED_MESSAGE } from "../src/tui/live-mode-guard.js";
import { approvalModalLines, pickerModalLines } from "../src/tui/modal.js";
import { runtimeItemsToEngineRuntimeEvents, sessionMessagesToRuntimeEvents } from "../src/tui/runtime-replay.js";
import { StreamingLineBuffer } from "../src/tui/streaming-line-buffer.js";
import { TuiRuntimeViewModel } from "../src/tui/runtime-view-model.js";
import { ActiveToolLines } from "../src/tui/tool-lines.js";
import { Transcript } from "../src/tui/transcript.js";
import { createSession } from "../src/session/types.js";

describe("ANSI helpers", () => {
  it("measures wide characters without counting ANSI codes", () => {
    expect(visibleLength("\x1b[31m你\x1b[0m好🙂")).toBe(6);
  });

  it("ignores OSC hyperlinks and measures grapheme emoji clusters as terminal cells", () => {
    const linked = "\x1b]8;;https://example.com\x1b\\click\x1b]8;;\x1b\\";

    expect(stripAnsi(linked)).toBe("click");
    expect(visibleLength(linked)).toBe(5);
    expect(visibleLength("👨‍👩‍👧‍👦")).toBe(2);
    expect(visibleLength("🇺🇸")).toBe(2);
    expect(visibleLength("❤️")).toBe(2);
  });

  it("fits and truncates colored text to terminal width", () => {
    expect(visibleLength(fitAnsi("\x1b[31mhello\x1b[0m", 8))).toBe(8);
    expect(visibleLength(truncateAnsi("\x1b[31mhello world\x1b[0m", 5))).toBe(5);
    expect(truncateAnsi("hello world", 5)).toBe("hello");
    expect(truncateAnsi("\x1b[31mhello world", 5)).toBe("\x1b[31mhello\x1b[0m");
  });

  it("wraps wide text by display width", () => {
    expect(wrapAnsi("你好abc", 4).map(visibleLength)).toEqual([4, 3]);
    expect(wrapAnsi("a👨‍👩‍👧‍👦b", 3).map(stripAnsi)).toEqual(["a👨‍👩‍👧‍👦", "b"]);
  });

  it("preserves active SGR color across wrapped rows", () => {
    const wrapped = wrapAnsi("\x1b[31mabcdef\x1b[39m", 3);

    expect(wrapped).toHaveLength(2);
    expect(wrapped[1].startsWith("\x1b[31m")).toBe(true);
    expect(wrapped.map(stripAnsi)).toEqual(["abc", "def"]);
  });

  it("preserves bold style after color-only resets across wrapped rows", () => {
    const wrapped = wrapAnsi("\x1b[1m\x1b[31mabc\x1b[39mdef", 3);

    expect(wrapped).toHaveLength(2);
    expect(wrapped[1].startsWith("\x1b[1m")).toBe(true);
    expect(wrapped.map(stripAnsi)).toEqual(["abc", "def"]);
  });

  it("normalizes invalid widths and oversized truncation suffixes", () => {
    expect(fitAnsi("abc", Number.NaN)).toBe("");
    expect(wrapAnsiLine("abc", Number.POSITIVE_INFINITY)[0]).toBe("");
    expect(visibleLength(truncateAnsi("abcdef", 4, "……long"))).toBeLessThanOrEqual(4);
  });

  it("keeps wrapped ANSI carry-over bounded across many SGR changes", () => {
    const manyStyles = Array.from({ length: 300 }, (_, index) => `\x1b[${30 + (index % 8)}m`).join("");
    const wrapped = wrapAnsi(`${manyStyles}abcdef`, 3);

    expect(wrapped).toHaveLength(2);
    expect(wrapped[1].length).toBeLessThan(1100);
    expect(wrapped.map(stripAnsi)).toEqual(["abc", "def"]);
  });
});

describe("User message rendering", () => {
  it("keeps multiline user input visually grouped in the transcript", () => {
    expect(stripAnsi(userMessageBlock("first\r\n  second\n")).split("\n")).toEqual([
      "",
      "› first",
      "│   second",
      "│ ",
    ]);
  });
});

describe("Transcript", () => {
  it("appends streaming deltas onto the current line", () => {
    const transcript = new Transcript();
    transcript.appendDelta("hello");
    transcript.appendDelta(" world\nnext");

    expect(transcript.lines.map(line => line.text)).toEqual(["hello world", "next"]);
  });

  it("clears transcript content and scroll state", () => {
    const transcript = new Transcript();
    transcript.append("hello\nworld");
    transcript.render(1, 10);
    transcript.scrollUp(1);

    transcript.clear();

    expect(transcript.lines).toEqual([]);
    expect(transcript.scrollOffset).toBe(0);
    expect(transcript.desiredHeight(10)).toBe(0);
  });

  it("renders short transcript from the top", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    const rendered = transcript.render(2, 3).split("\n");
    expect(rendered).toHaveLength(2);
    expect(stripAnsi(rendered[0])).toBe("abc");
    expect(rendered.every(line => visibleLength(line) === 3)).toBe(true);
  });

  it("renders empty transcripts as padded blank rows", () => {
    const transcript = new Transcript();
    expect(transcript.render(2, 4).split("\n")).toEqual(["    ", "    "]);
  });

  it("reports wrapped content height", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    expect(transcript.desiredHeight(3)).toBe(2);
  });

  it("scrolls through wrapped transcript content", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n"));

    expect(stripAnsi(transcript.render(3, 80)).split("\n").map(line => line.trim())).toEqual([
      "line 7",
      "line 8",
      "line 9",
    ]);

    transcript.scrollUp(2);
    expect(stripAnsi(transcript.render(3, 80)).split("\n").map(line => line.trim())).toEqual([
      "line 5",
      "line 6",
      "line 7",
    ]);

    transcript.scrollToTop();
    expect(stripAnsi(transcript.render(3, 80)).split("\n").map(line => line.trim())).toEqual([
      "line 0",
      "line 1",
      "line 2",
    ]);

    transcript.scrollToBottom();
    expect(transcript.scrollOffset).toBe(0);
  });

  it("caps scroll offset by wrapped render height", () => {
    const transcript = new Transcript();
    transcript.append("abcdefghij");
    transcript.render(2, 3);

    transcript.scrollUp(100);
    transcript.render(2, 3);

    expect(transcript.scrollOffset).toBe(2);
  });

  it("keeps the visible history anchored while new transcript content arrives", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n"));
    transcript.render(3, 80);
    transcript.scrollUp(2);
    const before = stripAnsi(transcript.render(3, 80)).split("\n").map(line => line.trim());

    transcript.append("line 8\nline 9");
    const after = stripAnsi(transcript.render(3, 80)).split("\n").map(line => line.trim());

    expect(before).toEqual(["line 3", "line 4", "line 5"]);
    expect(after).toEqual(before);
    expect(transcript.scrollOffset).toBe(4);
  });

  it("retains more than ten thousand transcript lines", () => {
    const transcript = new Transcript();
    transcript.maxLines = 20_000;
    transcript.append(Array.from({ length: 12_000 }, (_, index) => `line ${index}`).join("\n"));

    expect(transcript.lines).toHaveLength(12_000);
    expect(transcript.lines[0].text).toBe("line 0");
    expect(transcript.lines.at(-1)?.text).toBe("line 11999");
  });

  it("returns wrapped row ranges that match full wrapping slices", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 60 }, (_, index) => `row-${index}-abcdef`).join("\n"));

    const full = transcript.wrappedRows(5).map(stripAnsi);
    expect(transcript.wrappedRowsRange(5, 10, 18).map(stripAnsi)).toEqual(full.slice(10, 18));
    expect(transcript.wrappedRowsRange(5, full.length - 8, full.length - 2).map(stripAnsi)).toEqual(full.slice(-8, -2));
  });

  it("invalidates cached wrap heights when transcript lines change", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    expect(transcript.desiredHeight(3)).toBe(2);
    transcript.replaceLine(0, "xy");
    expect(transcript.desiredHeight(3)).toBe(1);
    expect(stripAnsi(transcript.render(2, 3)).split("\n").map(line => line.trim())).toEqual(["xy", ""]);

    transcript.appendDelta("z1");
    expect(transcript.desiredHeight(3)).toBe(2);
    transcript.replaceRange(0, 1, "a\nbcdef");
    expect(transcript.desiredHeight(3)).toBe(3);
  });

  it("drops cached wrap heights when old transcript lines are trimmed", () => {
    const transcript = new Transcript();
    transcript.maxLines = 3;
    transcript.append("aaaa\nbbbb\ncccc");
    expect(transcript.desiredHeight(2)).toBe(6);

    transcript.append("dd");
    expect(transcript.lines.map(line => line.text)).toEqual(["bbbb", "cccc", "dd"]);
    expect(transcript.desiredHeight(2)).toBe(5);
    expect(transcript.maxScrollOffset(1, 2)).toBe(4);
  });

  it("ignores out-of-range line replacements and empty wrapped row windows", () => {
    const transcript = new Transcript();
    transcript.append("alpha");

    transcript.replaceLine(-1, "nope");
    transcript.replaceLine(5, "nope");

    expect(transcript.lines.map(line => line.text)).toEqual(["alpha"]);
    expect(transcript.wrappedRowsRange(5, 3, 3)).toEqual([]);
    expect(transcript.wrappedRowsRange(5, 4, 2)).toEqual([]);
  });

  it("normalizes fractional scroll and replacement counts", () => {
    const transcript = new Transcript();
    transcript.append("one\ntwo\nthree");
    transcript.render(1, 80);

    transcript.scrollUp(1.9);
    expect(transcript.scrollOffset).toBe(1);
    transcript.scrollDown(Number.NaN);
    expect(transcript.scrollOffset).toBe(1);
    transcript.replaceRange(1.7, Number.NaN, "inserted");

    expect(transcript.lines.map(line => line.text)).toEqual(["one", "inserted", "two", "three"]);
  });

  it("bounds per-line wrap caches across many terminal widths", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    for (let width = 1; width <= 20; width++) transcript.desiredHeight(width);

    const cache = (transcript.lines[0] as any).wrapCache as Map<number, string[]>;
    expect(cache.size).toBeLessThanOrEqual(8);
    expect(cache.has(20)).toBe(true);
  });

  it("bounds total wrapped-height caches across resize churn", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    for (let width = 1; width <= 40; width++) transcript.desiredHeight(width);

    expect(transcript.cachedWidthCount()).toBeLessThanOrEqual(16);
    expect(transcript.desiredHeight(40)).toBe(1);
  });

  it("normalizes invalid transcript widths and heights", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    expect(transcript.desiredHeight(Number.NaN)).toBe(0);
    expect(transcript.wrappedRows(Number.POSITIVE_INFINITY)).toEqual([]);
    expect(transcript.maxScrollOffset(Number.POSITIVE_INFINITY, 3)).toBe(0);
    expect(transcript.render(Number.NaN, 3)).toBe("");
  });

  it("clamps replacement delete counts to existing transcript lines", () => {
    const transcript = new Transcript();
    transcript.append("one\ntwo");

    transcript.replaceRange(1, 100, "three\nfour");

    expect(transcript.lines.map(line => line.text)).toEqual(["one", "three", "four"]);
    expect(transcript.desiredHeight(80)).toBe(3);
  });

  it("keeps pinned scroll anchored when appended deltas add wrapped rows", () => {
    const transcript = new Transcript();
    transcript.append("abcdef\nuvwxyz\nlast");
    transcript.render(2, 3);
    transcript.scrollUp(1);
    const before = transcript.render(2, 3);

    transcript.appendDelta("123456");
    const after = transcript.render(2, 3);

    expect(stripAnsi(after)).toBe(stripAnsi(before));
    expect(transcript.scrollOffset).toBeGreaterThan(1);
  });

  it("bounds transcript lines and deltas without splitting surrogate pairs", () => {
    const transcript = new Transcript();
    transcript.append("a".repeat(49_999) + "🙂tail");

    expect(transcript.lines[0].text).toHaveLength(49_999);
    expect(transcript.lines[0].text.endsWith("\ud83d")).toBe(false);

    transcript.appendDelta("b".repeat(60_000));
    expect(transcript.lines.at(-1)?.text.length).toBeLessThanOrEqual(50_000);
  });

  it("bounds transcript lines on full grapheme boundaries", () => {
    const transcript = new Transcript();
    const family = "👨‍👩‍👧‍👦";
    transcript.append("a".repeat(49_995) + family + "tail");

    const text = transcript.lines[0]?.text ?? "";
    expect(text).not.toContain(family);
    expect(hasUnpairedSurrogate(text)).toBe(false);
    expect(text).not.toContain("\u200d");
  });

  it("normalizes formatted transcript input arrays", () => {
    const transcript = new Transcript();
    transcript.appendFormatted(["one\ntwo", 1 as any]);

    expect(transcript.lines.map(line => line.text)).toEqual(["one two", ""]);
  });

  it("skips unreadable formatted transcript array items", () => {
    const transcript = new Transcript();
    const lines = ["safe"];
    Object.defineProperty(lines, "1", {
      enumerable: true,
      get() {
        throw new Error("line getter failed");
      },
    });
    lines.length = 2;

    expect(() => transcript.appendFormatted(lines)).not.toThrow();

    expect(transcript.lines.map(line => line.text)).toEqual(["safe", ""]);
  });
});

describe("AssistantStream", () => {
  it("buffers streaming deltas until a newline boundary or flush", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream();

    expect(stream.append(transcript, "partial")).toBe(false);
    expect(transcript.lines).toHaveLength(0);

    expect(stream.append(transcript, " line\nnext")).toBe(true);
    expect(transcript.lines.map(line => stripAnsi(line.text))).toEqual(["partial line", ""]);

    expect(stream.flush(transcript)).toBe(true);
    expect(transcript.lines.map(line => stripAnsi(line.text))).toEqual(["partial line", "next"]);
  });

  it("keeps consecutive content deltas on the same assistant line", () => {
    const transcript = new Transcript();
    transcript.append("› hello");
    const stream = new AssistantStream();

    stream.append(transcript, "Hello");
    stream.append(transcript, "!");
    stream.append(transcript, " Ready");
    stream.flush(transcript);

    expect(transcript.lines.map(line => line.text)).toEqual(["› hello", "Hello! Ready"]);
  });

  it("rerenders Markdown across streaming chunks", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream();

    stream.append(transcript, "- **Create");
    stream.append(transcript, " a new project** called `nh`");
    stream.flush(transcript);

    const plain = transcript.lines.map(line => stripAnsi(line.text));
    expect(plain).toEqual(["• Create a new project called nh"]);
    expect(transcript.lines[0].text).not.toContain("**");
    expect(transcript.lines[0].text).not.toContain("`");
  });

  it("rerenders multiline Markdown without duplicating streamed rows", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream();

    stream.append(transcript, "- item one\n```ts\nconst x");
    stream.append(transcript, " = 1;\n```");
    stream.flush(transcript);

    expect(transcript.lines.map(line => stripAnsi(line.text))).toEqual([
      "• item one",
      "  │ ts",
      "  │ const x = 1;",
      "  │",
    ]);
  });

  it("starts a new assistant line after reset", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream();

    stream.append(transcript, "first");
    stream.flush(transcript);
    stream.reset();
    stream.append(transcript, "second");
    stream.flush(transcript);

    expect(transcript.lines.map(line => line.text)).toEqual(["first", "second"]);
  });

  it("drops uncommitted pending text on reset", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream();

    stream.append(transcript, "partial");
    stream.reset();
    stream.append(transcript, "final");
    stream.flush(transcript);

    expect(transcript.lines.map(line => line.text)).toEqual(["final"]);
  });

  it("reuses an existing blank transcript line for the first streamed chunk", () => {
    const transcript = new Transcript();
    transcript.append("");
    const stream = new AssistantStream();

    stream.append(transcript, "hello");
    stream.flush(transcript);

    expect(transcript.lines.map(line => stripAnsi(line.text))).toEqual(["hello"]);
  });

  it("reports only the unfinished logical line as mutable", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream();

    stream.append(transcript, "one\ntwo");
    expect(stream.mutableStartLine).toBe(1);

    stream.append(transcript, "\nthree");
    expect(stream.mutableStartLine).toBe(2);

    stream.reset();
    expect(stream.mutableStartLine).toBeNull();
  });
});

describe("StreamingLineBuffer", () => {
  it("commits only complete newline-terminated text", () => {
    const buffer = new StreamingLineBuffer();

    expect(buffer.push("hello")).toBe("");
    expect(buffer.pendingLength()).toBe(5);
    expect(buffer.push(" world\nnext")).toBe("hello world\n");
    expect(buffer.flush()).toBe("next");
    expect(buffer.isEmpty()).toBe(true);
  });

  it("normalizes CRLF and bare CR while preserving final tails", () => {
    const buffer = new StreamingLineBuffer();

    expect(buffer.push("a\r\nb\rc")).toBe("a\nb\n");
    expect(buffer.flush()).toBe("c");
  });

  it("keeps partial markdown fences hidden until the line is complete", () => {
    const buffer = new StreamingLineBuffer();

    expect(buffer.push("foo```")).toBe("");
    expect(buffer.push("ts\nbody")).toBe("foo```ts\n");
    expect(buffer.push("\n```\n")).toBe("body\n```\n");
  });

  it("commits oversized pending tails at a grapheme boundary", () => {
    const buffer = new StreamingLineBuffer(4);

    expect(buffer.push("ab🙂cd")).toBe("ab🙂c");
    expect(buffer.flush()).toBe("d");
  });
});

describe("TuiRuntimeViewModel", () => {
  it("projects runtime events into transcript and view state", () => {
    const transcript = new Transcript();
    let renderNowCount = 0;
    let requestRenderCount = 0;
    let now = 2_000;
    const view = new TuiRuntimeViewModel(transcript, {
      thinkingVisible: () => true,
      turnStartedAt: () => 1_000,
      now: () => now,
      renderNow: () => { renderNowCount++; },
      requestRender: () => { requestRenderCount++; },
      enableThinkingTimer: false,
    });
    let storeNotifications = 0;
    const unsubscribe = view.subscribe(() => { storeNotifications++; });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "api_call_start", data: {} } as any);
    expect(stripAnsi(view.activeStatusLine || "")).toContain("Thinking 0s");

    view.handleRuntimeEvent({ type: "thinking_delta", data: { text: "- **Plan**" } } as any);
    now = 2_500;
    view.handleRuntimeEvent({ type: "content_delta", data: { text: "Answer\n" } } as any);
    let plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("Plan");
    expect(plain).toContain("Answer");

    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "edit", tool_call_id: "call-1" } } as any);
    expect(view.activeToolCount).toBe(1);
    const linesAfterBegin = transcript.lines.length;
    view.handleRuntimeEvent({ type: "tool_call", data: { id: "call-1", name: "edit", arguments: {} } } as any);
    expect(transcript.lines).toHaveLength(linesAfterBegin);

    view.handleRuntimeEvent({
      type: "tool_progress",
      data: { tool: "edit", tool_call_id: "call-1", progress: { message: "halfway" } },
    } as any);
    plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("halfway");

    view.handleRuntimeEvent({
      type: "tool_result",
      data: { tool_call_id: "call-1", name: "edit", content: "ok", is_error: false },
      preview: [
        "Successfully edited file.ts",
        "",
        "[diff]",
        "  -- file.ts --",
        "- old",
        "+ new",
      ].join("\n"),
    } as any);
    plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(view.activeToolCount).toBe(0);
    expect(plain).toContain("file.ts");
    expect(plain).toContain("+ new");

    view.finishTurn();
    expect(view.activeStatusLine).toBeNull();
    expect(storeNotifications).toBeGreaterThan(0);
    expect(renderNowCount).toBeGreaterThan(0);
    expect(requestRenderCount).toBeGreaterThan(0);
    unsubscribe();
    view.dispose();
  });

  it("holds partial assistant content until a stable boundary", () => {
    const transcript = new Transcript();
    let requestRenderCount = 0;
    const view = new TuiRuntimeViewModel(transcript, {
      requestRender: () => { requestRenderCount++; },
      enableThinkingTimer: false,
    });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "content_delta", data: { text: "```ts" } } as any);
    expect(transcript.lines).toHaveLength(0);
    expect(requestRenderCount).toBe(0);

    view.handleRuntimeEvent({ type: "content_delta", data: { text: "\nconst x = 1" } } as any);
    expect(stripAnsi(transcript.lines.map(line => line.text).join("\n"))).toContain("ts");
    expect(stripAnsi(transcript.lines.map(line => line.text).join("\n"))).not.toContain("const x = 1");

    view.finishTurn();
    expect(stripAnsi(transcript.lines.map(line => line.text).join("\n"))).toContain("const x = 1");
  });

  it("flushes partial assistant content before rendering tool activity", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "content_delta", data: { text: "Partial answer" } } as any);
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "read", tool_call_id: "call-1" } } as any);

    const plainLines = transcript.lines.map(line => stripAnsi(line.text));
    expect(plainLines[0]).toContain("Partial answer");
    expect(plainLines.at(-1)).toContain("Reading file");
  });

  it("flushes partial assistant content and clears active tools when disposed", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "content_delta", data: { text: "partial tail" } } as any);
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "read", tool_call_id: "call-1" } } as any);
    expect(view.activeToolCount).toBe(1);

    view.dispose();
    const lineCountAfterDispose = transcript.lines.length;

    expect(stripAnsi(transcript.lines.map(line => line.text).join("\n"))).toContain("partial tail");
    expect(view.activeToolCount).toBe(0);
    expect(view.activeStatusLine).toBeNull();

    view.dispose();
    expect(transcript.lines).toHaveLength(lineCountAfterDispose);
  });

  it("flushes partial assistant content before final replay messages", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.replayRuntimeItems([
      { type: "content_delta", data: { text: "partial" } },
      {
        type: "assistant_message",
        data: { role: "assistant", content: "partial", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      },
    ]);

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain.match(/\bpartial\b/g)).toHaveLength(1);
  });

  it("upgrades write tool activity from streamed args before completion", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "write", tool_call_id: "call-write-1" } } as any);
    expect(stripAnsi(transcript.lines.at(-1)?.text || "")).toContain("Writing file");

    view.handleRuntimeEvent({
      type: "tool_call_args",
      data: {
        tool_call_id: "call-write-1",
        name: "write",
        arguments: "{\"path\":\"src/components/ToolPanel.tsx\"",
      },
    } as any);

    expect(stripAnsi(transcript.lines.at(-1)?.text || "")).toContain("Writing src/components/ToolPanel.tsx");

    view.handleRuntimeEvent({
      type: "tool_progress",
      data: {
        tool: "write",
        tool_call_id: "call-write-1",
        progress: { message: "writing bytes" },
      },
    } as any);

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("Writing src/components/ToolPanel.tsx");
    expect(plain).toContain("writing bytes");
  });

  it("falls back when tool activity args have hostile getters", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const args: Record<string, unknown> = {};
    Object.defineProperty(args, "path", {
      enumerable: true,
      get() {
        throw new Error("path getter failed");
      },
    });

    view.beginTurn();
    view.handleRuntimeEvent({
      type: "tool_call",
      data: { id: "call-hostile-args", name: "read", arguments: args },
    } as any);

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("Reading file");
    expect(plain).not.toContain("path getter failed");
  });

  it("handles tool_progress events with hostile rendered getters", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const rendered: Record<string, unknown> = {};
    Object.defineProperty(rendered, "preview", {
      enumerable: true,
      get() {
        throw new Error("preview getter failed");
      },
    });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "read", tool_call_id: "call-progress" } } as any);
    expect(() => view.handleRuntimeEvent({
      type: "tool_progress",
      data: { tool: "read", tool_call_id: "call-progress", progress: { message: "halfway" } },
      rendered,
    } as any)).not.toThrow();

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("halfway");
    expect(plain).not.toContain("preview getter failed");
  });

  it("uses runtime tool metadata for activity and compact result labels", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "custom_tool", tool_call_id: "call-custom" } } as any);
    view.handleRuntimeEvent({
      type: "tool_call",
      data: {
        id: "call-custom",
        name: "custom_tool",
        arguments: {},
        metadata: { activity: "Auditing workspace" },
      },
    } as any);
    expect(stripAnsi(transcript.lines.at(-1)?.text || "")).toContain("Auditing workspace");

    view.handleRuntimeEvent({
      type: "tool_result",
      data: { tool_call_id: "call-custom", name: "custom_tool", content: "ok", is_error: false },
      preview: "ok",
      metadata: { summary: "Workspace audit" },
    } as any);

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("Workspace audit");
  });

  it("ignores hostile runtime metadata getters when rendering tool results", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const metadata: Record<string, unknown> = { activity: "Safe activity" };
    Object.defineProperty(metadata, "summary", {
      enumerable: true,
      get() {
        throw new Error("summary getter failed");
      },
    });
    Object.defineProperty(metadata, "render", {
      enumerable: true,
      get() {
        throw new Error("render getter failed");
      },
    });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "custom_tool", tool_call_id: "call-hostile" } } as any);
    expect(() => view.handleRuntimeEvent({
      type: "tool_result",
      data: { tool_call_id: "call-hostile", name: "custom_tool", content: "ok", is_error: false },
      preview: "ok",
      metadata,
    } as any)).not.toThrow();

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("Safe activity");
    expect(plain).not.toContain("getter failed");
  });

  it("adds folded transcript previews for verbose non-diff tool results", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "bash", tool_call_id: "call-shell" } } as any);
    view.handleRuntimeEvent({
      type: "tool_result",
      data: { tool_call_id: "call-shell", name: "bash", content: "", is_error: false },
      preview: [
        "row-0",
        "row-1",
        "row-2",
        "row-3",
        "row-4",
        "row-5",
        "row-6",
        "row-7",
        "row-8",
        "row-9",
      ].join("\n"),
    } as any);

    const plainLines = transcript.lines.map(line => stripAnsi(line.text));
    const plain = plainLines.join("\n");
    expect(plainLines.some(line => line.includes("✓ Running command") && line.includes("row-0") && line.includes("..."))).toBe(true);
    expect(plain).toContain("│ row-0");
    expect(plain).toContain("│ row-7");
    expect(plain).toContain("2 more lines");
    expect(plain).not.toContain("│ row-8");
  });

  it("keeps short one-line tool results on the status line only", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "read", tool_call_id: "call-read" } } as any);
    view.handleRuntimeEvent({
      type: "tool_result",
      data: { tool_call_id: "call-read", name: "read", content: "ok", is_error: false },
      preview: "ok",
    } as any);

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("✓ Reading file  ok");
    expect(plain).not.toContain("│ ok");
  });

  it("renders tool_result is_error as failed even when the preview lacks an Error prefix", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "spawn_agent", tool_call_id: "call-sub" } } as any);
    view.handleRuntimeEvent({
      type: "tool_result",
      data: {
        tool_call_id: "call-sub",
        name: "spawn_agent",
        content: "<deepseek:subagent.error>auth failed</deepseek:subagent.error>",
        is_error: true,
      },
      preview: "<deepseek:subagent.error> auth failed",
    } as any);

    const plain = stripAnsi(transcript.lines.at(-1)?.text || "");
    expect(plain).toContain("✗ spawn_agent");
    expect(plain).toContain("<deepseek:subagent.error>");
    expect(plain).not.toContain("✓ spawn_agent");
  });

  it("keeps concurrent write tool lines associated by tool call id", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "write", tool_call_id: "call-1" } } as any);
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "write", tool_call_id: "call-2" } } as any);
    view.handleRuntimeEvent({
      type: "tool_call",
      data: { id: "call-1", name: "write", arguments: { path: "a.ts", content: "a" } },
    } as any);
    view.handleRuntimeEvent({
      type: "tool_call",
      data: { id: "call-2", name: "write", arguments: { path: "b.ts", content: "b" } },
    } as any);
    view.handleRuntimeEvent({
      type: "tool_result",
      data: { tool_call_id: "call-2", name: "write", content: "ok", is_error: false },
      preview: "Successfully wrote 1 bytes to b.ts",
    } as any);

    const plainLines = transcript.lines.map(line => stripAnsi(line.text));
    expect(plainLines.some(line => line.includes("Writing a.ts"))).toBe(true);
    expect(plainLines.some(line => line.includes("Successfully wrote 1 bytes to b.ts"))).toBe(true);
    expect(view.activeToolCount).toBe(1);
  });

  it("rebuilds a loaded session transcript without leaking runtime state", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const session = createSession({
      id: "session-1",
      title: "Proof session",
      messages: [
        { role: "system", content: "system", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
        { role: "user", content: "prove it", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
        { role: "assistant", content: "**Done**", tool_calls: null, tool_call_id: null, name: null, reasoning_content: "private plan" },
        { role: "tool", content: "ok", tool_calls: null, tool_call_id: "call-1", name: "read_file", reasoning_content: null, is_error: false },
      ],
    });

    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "edit", tool_call_id: "call-2" } } as any);
    expect(view.activeToolCount).toBe(1);

    view.renderSessionTranscript({
      session,
      loaded: true,
      version: "0.2.0",
      model: "deepseek-v4-pro",
      mode: "agent",
      toolCount: 12,
    });

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("Seek Code");
    expect(plain).toContain("Loaded session: Proof session");
    expect(plain).toContain("prove it");
    expect(plain).toContain("private plan");
    expect(plain).toContain("Done");
    expect(plain).toContain("read_file");
    expect(view.activeToolCount).toBe(0);
    expect(view.activeStatusLine).toBeNull();
  });

  it("replays session messages through runtime events", () => {
    const events = sessionMessagesToRuntimeEvents([
      { role: "system", content: "system", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      { role: "user", content: "inspect", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      {
        role: "assistant",
        content: "Calling tool",
        tool_calls: [{ id: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
        tool_call_id: null,
        name: null,
        reasoning_content: "need file",
      },
      { role: "tool", content: "file content", tool_calls: null, tool_call_id: "call-1", name: "read_file", reasoning_content: null, is_error: false },
    ]);
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    expect(events.map(event => event.type)).toEqual(["user_message", "assistant_message", "tool_call", "tool_result"]);
    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("inspect");
    expect(plain).toContain("need file");
    expect(plain).toContain("Calling tool");
    expect(plain).toContain("read_file");
    expect(plain).toContain("file content");
    expect(view.activeToolCount).toBe(0);
  });

  it("replays compaction boundaries as prefix invalidation events", () => {
    const events = sessionMessagesToRuntimeEvents([
      {
        role: "system",
        content: [
          "[Context compaction boundary]",
          "boundary_id: compact_test",
          "projected_tokens_before: 400",
          "projected_tokens_after: 120",
          "preserve_from_index: 6",
          "removed_messages: 10",
          "preserved_messages: 4",
          "actions:",
          "- summary boundary appended",
        ].join("\n"),
        tool_calls: null,
        tool_call_id: null,
        name: "context_compaction_boundary",
        reasoning_content: null,
      },
      {
        role: "system",
        content: "[Earlier conversation summarized for boundary compact_test]\n- user: earlier",
        tool_calls: null,
        tool_call_id: null,
        name: "context_summary",
        reasoning_content: null,
      },
      { role: "user", content: "continue", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
    ]);
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    expect(events.map(event => event.type)).toEqual(["prefix_invalidated", "user_message"]);
    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("Prompt cache reset");
    expect(plain).toContain("compact_test");
    expect(plain).toContain("continue");
  });

  it("bounds replayed compaction boundaries on full grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const events = sessionMessagesToRuntimeEvents([
      {
        role: "system",
        content: `${"a".repeat(199_995)}${family}tail\nboundary_id: emoji_boundary`,
        tool_calls: null,
        tool_call_id: null,
        name: "context_compaction_boundary",
        reasoning_content: null,
      },
    ]);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(family);
    expect(hasUnpairedSurrogate(serialized)).toBe(false);
    expect(serialized).not.toContain("\u200d");
  });

  it("replays server runtime items without duplicating final assistant messages", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    view.replayRuntimeItems([
      { type: "user_message", data: { text: "hello" } },
      { type: "api_call_start", data: {} },
      { type: "content_delta", data: { text: "Hi" } },
      {
        type: "assistant_message",
        data: { role: "assistant", content: "Hi", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      },
    ]);

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("hello");
    expect(plain.match(/\bHi\b/g)).toHaveLength(1);
  });

  it("replays approval_required runtime items as denied tool status", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "tool_call_begin", data: { name: "write", tool_call_id: "call-write-1" } },
      { type: "approval_required", data: { tool: "write", args: { path: "draft.txt", content: "hello" } } },
    ]);

    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("write");
    expect(plain).toContain("Approval required");
    expect(plain).toContain("draft.txt");
  });

  it("renders approval_required runtime items with non-JSON args", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const args: Record<string, unknown> = { count: 1n, fn: () => "ignored" };
    args.self = args;
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "approval_required", data: { tool: "write", args } },
    ]);

    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("Approval required");
    expect(plain).toContain("\"count\":\"1\"");
    expect(plain).toContain("\"self\":\"[Circular]\"");
  });

  it("renders approval_required runtime events with hostile argument getters", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const args: Record<string, unknown> = { path: "draft.txt" };
    Object.defineProperty(args, "content", {
      enumerable: true,
      get() {
        throw new Error("content getter failed");
      },
    });

    expect(() => view.handleRuntimeEvent({
      type: "approval_required",
      data: { tool: "write", args },
    } as any)).not.toThrow();
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("Approval required");
    expect(plain).toContain("\"content\":\"[Unreadable]\"");
    expect(plain).not.toContain("content getter failed");
  });

  it("ignores unknown runtime item types during replay conversion", () => {
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "mystery", data: { value: 1 } },
      { type: "content_delta", data: { text: "kept" } },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "content_delta", data: { text: "kept" } });
  });

  it("does not replay malformed persisted runtime items as [object Object] transcript content", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "user_message", data: { text: { nested: true } as any } },
      { type: "tool_call_begin", data: { name: { nested: true } as any, tool_call_id: "call-1" } },
      { type: "approval_required", data: { tool: { nested: true } as any, args: { path: "draft.txt" } } },
      { type: "content_delta", data: { text: "kept" } },
    ]);

    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("kept");
    expect(plain).not.toContain("[object Object]");
    expect(plain).not.toContain("draft.txt");
  });

  it("sanitizes malformed replayed context and prefix runtime items instead of rendering object coercions", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const events = runtimeItemsToEngineRuntimeEvents([
      {
        type: "context_intervention",
        data: {
          risk: { nested: true } as any,
          action: ["verify"] as any,
          reason: { nested: true } as any,
          compaction: { message: { nested: true } as any },
        },
      },
      {
        type: "prefix_invalidated",
        data: {
          reason: { nested: true } as any,
          boundary_id: { nested: true } as any,
          compaction: {
            finalTokens: "900" as any,
            removed_messages: { nested: true } as any,
            preserved_messages: ["3"] as any,
          },
        },
      },
      { type: "content_delta", data: { text: "kept" } },
    ]);

    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("Context guard: unknown / intervention");
    expect(plain).toContain("Prompt cache reset: unknown");
    expect(plain).toContain("kept");
    expect(plain).not.toContain("[object Object]");
    expect(plain).not.toContain("boundary [object Object]");
    expect(plain).not.toContain("900 projected tokens");
  });

  it("marks tool replay results as errors when persisted content is denial text", () => {
    const events = sessionMessagesToRuntimeEvents([
      {
        role: "tool",
        content: "write was denied.",
        tool_calls: null,
        tool_call_id: "call-1",
        name: "write",
        reasoning_content: null,
        is_error: null,
      },
    ]);

    expect(events).toMatchObject([
      {
        type: "tool_result",
        data: {
          tool_call_id: "call-1",
          name: "write",
          is_error: true,
        },
      },
    ]);
  });

  it("bounds streamed tool args and thinking buffers before rendering", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "thinking_delta", data: { text: "a".repeat(250_000) } } as any);
    view.finishThinkingStatus();
    expect(transcript.lines.map(line => line.text).join("").length).toBeLessThan(210_000);

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "write", tool_call_id: "call-args" } } as any);
    view.handleRuntimeEvent({
      type: "tool_call_args",
      data: { tool_call_id: "call-args", name: "write", arguments: "{\"path\":\"" + "a".repeat(250_000) },
    } as any);
    view.handleRuntimeEvent({
      type: "tool_result",
      data: { tool_call_id: "call-args", name: "write", content: "ok", is_error: false },
      preview: "ok\u0000" + "b".repeat(250_000),
    } as any);

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).not.toContain("\u0000");
    expect(plain.length).toBeLessThan(450_000);
  });

  it("summarizes long tool activity labels on full grapheme boundaries", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const family = "👨‍👩‍👧‍👦";

    view.beginTurn();
    view.handleRuntimeEvent({
      type: "tool_call",
      data: {
        id: "call-emoji",
        name: "read",
        arguments: { path: `${"a".repeat(53)}${family}tail` },
      },
    } as any);

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).not.toContain(family);
    expect(hasUnpairedSurrogate(plain)).toBe(false);
    expect(plain).not.toContain("\u200d");
  });

  it("caps concurrently rendered tool placeholders", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    for (let index = 0; index < 205; index++) {
      view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "read", tool_call_id: `call-${index}` } } as any);
    }

    expect(view.activeToolCount).toBe(200);
    expect(stripAnsi(transcript.lines.at(-1)?.text || "")).toContain("Too many active tools");
  });
});

describe("Markdown renderer", () => {
  it("renders common markdown constructs for terminal output", () => {
    const rendered = renderMarkdown([
      "# Title",
      "",
      "- **Bold** and *italic* and `code`",
      "> quoted",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n"));

    const plain = stripAnsi(rendered).split("\n");
    expect(plain).toEqual([
      "Title",
      "",
      "• Bold and italic and code",
      "│ quoted",
      "  │ ts",
      "  │ const x = 1;",
      "  │",
    ]);
  });

  it("renders single-star emphasis without leaking markdown markers", () => {
    const rendered = renderMarkdown("This is *2025* and **bold**");
    const plain = stripAnsi(rendered);

    expect(plain).toBe("This is 2025 and bold");
    expect(rendered).not.toContain("*2025*");
  });

  it("keeps ordinary single stars when they are not emphasis", () => {
    const rendered = renderMarkdown("Math stays 2 * 3 * 4 and unfinished *text");

    expect(stripAnsi(rendered)).toBe("Math stays 2 * 3 * 4 and unfinished *text");
  });

  it("sanitizes markdown control characters and bounds pathological inputs", () => {
    const rendered = stripAnsi(renderMarkdown(`hello\u0000${"a".repeat(220_000)}\nignored`));

    expect(rendered).toContain("hello ");
    expect(rendered.length).toBeLessThanOrEqual(200_001);
    expect(rendered).not.toContain("\u0000");
    expect(rendered).not.toContain("ignored");
  });

  it("bounds markdown on full grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const rendered = stripAnsi(renderMarkdown("a".repeat(199_995) + family + "tail"));

    expect(rendered).not.toContain(family);
    expect(hasUnpairedSurrogate(rendered)).toBe(false);
    expect(rendered).not.toContain("\u200d");
  });
});

describe("Renderer", () => {
  it("shows a blue cat in the welcome banner without the tools row", () => {
    const banner = welcomeBanner("0.1.0", "deepseek-v4-pro", "agent", 26);
    const plain = stripAnsi(banner);

    expect(plain).toContain("Seek Code");
    expect(plain).toContain("/\\_____/\\");
    expect(plain).toContain("( ==  ^  == )");
    expect(plain).toContain("deepseek-v4-pro · agent");
    expect(plain).not.toContain("Tools:");
  });

  it("keeps status bar within terminal width", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 40;
    try {
      expect(visibleLength(statusBar("agent", "deepseek-v4-pro", 1234, 0.12, "Tab complete"))).toBe(40);
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("shows the current mode in the footer status bar", () => {
    expect(stripAnsi(statusBar("yolo", "deepseek-v4-pro", 0, 0, "Shift+Tab mode"))).toContain("YOLO");
  });

  it("shows the current folder in the footer status bar", () => {
    expect(stripAnsi(statusBar("agent", "deepseek-v4-pro", 0, 0, "Tab complete", "seek-code"))).toContain("seek-code");
  });

  it("renders configurable status items with context, cache, tools, and elapsed", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 100;
    try {
      const rendered = stripAnsi(statusBarFromItems(["mode", "context", "cache", "tools", "elapsed", "hints"], {
        mode: "agent",
        model: "deepseek-v4-pro",
        tokens: 12_300,
        contextLimit: 1_000_000,
        cacheTokens: 9000,
        activeTools: 2,
        elapsedMs: 65_000,
        keyHints: "Tab complete",
      }));

      expect(rendered).toContain("AGENT");
      expect(rendered).toContain("ctx 12k/1.0M");
      expect(rendered).toContain("cache 9.0k");
      expect(rendered).toContain("tools 2");
      expect(rendered).toContain("elapsed 1m05s");
      expect(rendered).toContain("Tab complete");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("hides the tools status item when no tools are active", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 100;
    try {
      const rendered = stripAnsi(statusBarFromItems(["mode", "tools", "hints"], {
        mode: "agent",
        model: "deepseek-v4-pro",
        activeTools: 0,
        keyHints: "Tab complete",
      }));

      expect(rendered).toContain("AGENT");
      expect(rendered).not.toContain("tools 0");
      expect(rendered).toContain("Tab complete");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("keeps the default footer focused without context, cache, cost, or hints", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 120;
    try {
      const rendered = stripAnsi(statusBarFromItems([], {
        mode: "agent",
        model: "deepseek-v4-pro",
        workspace: "/ssd/yqy/projects/seek-code",
        tokens: 42_000,
        contextLimit: 1_000_000,
        cacheTokens: 7300,
        elapsedMs: 12_000,
        cost: 0.001,
        keyHints: "esc to interrupt  Shift+Tab switch mode",
      }));

      expect(rendered).toContain("AGENT");
      expect(rendered).toContain("deepseek-v4-pro");
      expect(rendered).toContain("/ssd/yqy/projects/seek-code");
      expect(rendered).not.toContain("ctx ");
      expect(rendered).not.toContain("cache ");
      expect(rendered).not.toContain("elapsed ");
      expect(rendered).not.toContain("$");
      expect(rendered).not.toContain("esc");
      expect(rendered).not.toContain("Tab complete");
      expect(rendered).not.toContain("tools ");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("shows Esc interrupt in footer hints", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 120;
    try {
      const rendered = stripAnsi(statusBarFromItems(["mode", "hints"], {
        mode: "agent",
        model: "deepseek-v4-pro",
        keyHints: "Esc interrupt  Tab complete",
      }));

      expect(rendered).toContain("Esc interrupt");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("keeps interrupt hints visible on narrow footers", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 44;
    try {
      const rendered = stripAnsi(statusBarFromItems(["mode", "model", "workspace", "hints"], {
        mode: "agent",
        model: "deepseek-v4-pro",
        workspace: "/ssd/yqy/projects/seek-code",
        keyHints: "esc to interrupt  Shift+Tab switch mode",
      }));

      expect(rendered).toContain("esc to interrupt");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("sanitizes non-finite status metrics and unsafe terminal widths", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = Number.NaN;
    try {
      const rendered = stripAnsi(statusBarFromItems(["mode", "model", "workspace", "context", "cache", "tools", "elapsed", "cost", "hints"], {
        mode: "agent\u0000",
        model: "deepseek-v4-pro\u0007",
        workspace: "/tmp/workspace\u0000bad",
        tokens: Number.POSITIVE_INFINITY,
        contextLimit: Number.NaN,
        cacheTokens: -1,
        activeTools: 1.5,
        elapsedMs: Number.POSITIVE_INFINITY,
        cost: Number.NaN,
        keyHints: "Esc\u0000interrupt",
      }));

      expect(visibleLength(rendered)).toBe(80);
      expect(rendered).toContain("AGENT");
      expect(rendered).toContain("deepseek-v4-pro");
      expect(rendered).toContain("Esc interrupt");
      expect(rendered).not.toContain("NaN");
      expect(rendered).not.toContain("Infinity");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("keeps status text on grapheme boundaries", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 1200;
    try {
      const rendered = stripAnsi(statusBar(
        "agent",
        `${"m".repeat(499)}👨‍👩‍👧‍👦`,
        0,
        0,
        `${"h".repeat(499)}👨‍👩‍👧‍👦`,
        `${"w".repeat(499)}👨‍👩‍👧‍👦`,
      ));

      expect(rendered).not.toContain("\u200d");
      expect(hasUnpairedSurrogate(rendered)).toBe(false);
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("shows elapsed time and interrupt hint in thinking header", () => {
    const rendered = stripAnsi(thinkingHeader(1250, true));

    expect(rendered).toContain("Thinking 1s · esc to interrupt");
    expect(rendered).not.toContain("...");
  });

  it("renders a live thinking status line without a leading newline", () => {
    const rendered = stripAnsi(thinkingStatusLine(1250, true));

    expect(rendered.startsWith("\n")).toBe(false);
    expect(rendered).toContain("Thinking 1s · esc to interrupt");
  });

  it("keeps elapsed time when interrupt hint is hidden", () => {
    const rendered = stripAnsi(thinkingStatusLine(65_000, false));

    expect(rendered).toContain("Thinking 1m05s");
    expect(rendered).not.toContain("esc to interrupt");
  });

  it("updates a thinking line in place", () => {
    const transcript = new Transcript();
    transcript.append(thinkingStatusLine(0, true));
    transcript.replaceLine(0, thinkingStatusLine(2100, true));

    expect(stripAnsi(transcript.lines[0].text)).toContain("Thinking 2s");
    expect(transcript.lines).toHaveLength(1);
  });

  it("renders compact diff previews from tool output", () => {
    const rendered = stripAnsi(toolDiffPreview([
      "Successfully edited file.ts",
      "",
      "[diff]",
      "  ── file.ts ──",
      "- old line",
      "+ new line",
    ].join("\n")));

    expect(rendered).toContain("file.ts");
    expect(rendered).toContain("- old line");
    expect(rendered).toContain("+ new line");
  });

  it("wraps thinking text with consistent indentation", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 14;
    try {
      const lines = thinkingText("abcdef ghijkl").split("\n");

      expect(lines.length).toBeGreaterThan(1);
      expect(lines.every(line => stripAnsi(line).startsWith("  "))).toBe(true);
      expect(lines.every(line => visibleLength(line) <= 14)).toBe(true);
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("lightly renders markdown inside thinking text", () => {
    const renderedRaw = thinkingText(["- **Plan** with *emphasis* and `code`", "> quote"].join("\n"));
    const rendered = stripAnsi(renderedRaw);

    expect(rendered).toContain("  • Plan with emphasis and code");
    expect(rendered).toContain("  │ quote");
    expect(rendered).not.toContain("**");
    expect(rendered).not.toContain("*emphasis*");
    expect(rendered).not.toContain("`");
  });

  it("keeps footer divider valid on very narrow terminals", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 5;
    try {
      expect(() => footerDivider("session-id-too-long")).not.toThrow();
      expect(visibleLength(footerDivider("session-id-too-long"))).toBe(5);
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("sanitizes rendered user, thinking, approval, and command text", () => {
    expect(stripAnsi(userMessageBlock("\x1b[31mred\x1b[0m\0ok\rnext"))).toContain("red ok\n│ next");
    expect(stripAnsi(thinkingText("**safe**\u0007text"))).toContain("safe text");
    expect(stripAnsi(commandOutput("\x1b[31mhello\x1b[0m\0\n"))).toBe("hello");

    const renderedApproval = stripAnsi(approvalPrompt("bash\u0007", {
      command: "\x1b[31mnpm test\x1b[0m\0",
    }));
    expect(renderedApproval).toContain("Approval required: bash");
    expect(renderedApproval).toContain("command=npm test");
  });

  it("renders approval prompts with hostile argument getters", () => {
    const args: Record<string, unknown> = { command: "npm test" };
    Object.defineProperty(args, "bad", {
      enumerable: true,
      get() {
        throw new Error("approval getter failed");
      },
    });

    const rendered = stripAnsi(approvalPrompt("bash", args));

    expect(rendered).toContain("command=npm test");
    expect(rendered).toContain("bad=[unreadable]");
    expect(rendered).not.toContain("approval getter failed");
  });

  it("bounds command output on full grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const rendered = stripAnsi(commandOutput("a".repeat(39_995) + family + "tail"));

    expect(rendered).not.toContain(family);
    expect(hasUnpairedSurrogate(rendered)).toBe(false);
    expect(rendered).not.toContain("\u200d");
  });

  it("bounds renderer previews and handles invalid limits", () => {
    const preview = stripAnsi(toolResultPreview("x".repeat(25_000), Number.POSITIVE_INFINITY));
    expect(preview.length).toBeGreaterThanOrEqual(300);
    expect(preview.length).toBeLessThanOrEqual(360);
    expect(preview).toContain("more chars");

    const renderedDiff = stripAnsi(toolDiffPreview([
      "ok",
      "",
      "[diff]",
      ...Array.from({ length: 300 }, (_, index) => `+line-${index}`),
    ].join("\n"), Number.POSITIVE_INFINITY));

    expect(renderedDiff).toContain("+line-0");
    expect(renderedDiff).toContain("more diff lines");
    expect(renderedDiff).not.toContain("+line-250");
  });

  it("folds multiline tool result previews without splitting grapheme clusters", () => {
    const family = "👨‍👩‍👧‍👦";
    const rendered = stripAnsi(toolResultPreview([
      "line-0",
      `aaaa${family}tail`,
      "line-2",
      "line-3",
    ].join("\n"), 10, 3));

    expect(rendered).toContain("line-0");
    expect(rendered).not.toContain(family);
    expect(rendered).toContain("more chars");
    expect(rendered).toContain("more lines");
    expect(hasUnpairedSurrogate(rendered)).toBe(false);
    expect(rendered).not.toContain("\u200d");
  });
});

describe("Input shortcuts", () => {
  it("recognizes common Shift+Tab terminal sequences", () => {
    expect(isShiftTabSequence("\x1b[Z")).toBe(true);
    expect(isShiftTabSequence("\x1b[1;2Z")).toBe(true);
    expect(isShiftTabSequence("\t")).toBe(false);
  });

  it("pauses stdin again after raw input cleanup", () => {
    let rawMode: boolean | undefined;
    let paused = false;

    restoreTTYInput({
      setRawMode(value: boolean) { rawMode = value; return this as any; },
      pause() { paused = true; return this as any; },
    }, undefined);

    expect(rawMode).toBe(false);
    expect(paused).toBe(true);
  });

  it("returns eof for non-tty stdin that closes without a line", async () => {
    const stdin = Readable.from([]);
    (stdin as any).isTTY = false;
    const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const previousStdin = process.stdin;
    const previousStdout = process.stdout;

    Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
    Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
    try {
      await expect(readInput("> ")).resolves.toEqual({ type: "eof" });
    } finally {
      Object.defineProperty(process, "stdin", { configurable: true, value: previousStdin });
      Object.defineProperty(process, "stdout", { configurable: true, value: previousStdout });
    }
  });

  it("cancels tty picker prompts when stdin closes", async () => {
    const writes: string[] = [];
    const stdin = new Readable({ read() {} });
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(String(chunk));
        callback();
      },
    });
    const previousStdin = process.stdin;
    const previousStdout = process.stdout;
    (stdin as any).isTTY = true;
    (stdin as any).isRaw = false;
    (stdin as any).setRawMode = vi.fn(function (this: typeof stdin) { return this; });
    (stdout as any).columns = 80;
    (stdout as any).rows = 24;

    Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
    Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
    try {
      const selected = pickFromList([{ name: "session-a", desc: "recent" }], "Load session");
      stdin.emit("end");

      await expect(selected).resolves.toBeNull();
      expect(writes.join("")).toContain("\x1b[?25h");
    } finally {
      Object.defineProperty(process, "stdin", { configurable: true, value: previousStdin });
      Object.defineProperty(process, "stdout", { configurable: true, value: previousStdout });
    }
  });

  it("quick-selects numbered rows from the visible tty picker window", async () => {
    const stdin = new Readable({ read() {} });
    const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const previousStdin = process.stdin;
    const previousStdout = process.stdout;
    (stdin as any).isTTY = true;
    (stdin as any).isRaw = false;
    (stdin as any).setRawMode = vi.fn(function (this: typeof stdin) { return this; });
    (stdout as any).columns = 80;
    (stdout as any).rows = 9;

    Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
    Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
    try {
      const selected = pickFromList(
        Array.from({ length: 10 }, (_, index) => ({ name: `session-${index}` })),
        "Load session",
      );
      stdin.emit("data", Buffer.from("\x1b[6~"));
      stdin.emit("data", Buffer.from("1"));

      await expect(selected).resolves.toBe("session-2");
    } finally {
      Object.defineProperty(process, "stdin", { configurable: true, value: previousStdin });
      Object.defineProperty(process, "stdout", { configurable: true, value: previousStdout });
    }
  });

  it("runs non-tty readInput submit hooks for submitted lines", async () => {
    const submitted: string[] = [];
    const stdin = Readable.from(["hello\n"]);
    (stdin as any).isTTY = false;
    const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const previousStdin = process.stdin;
    const previousStdout = process.stdout;

    Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
    Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
    try {
      await expect(readInput("> ", { onSubmit: value => { submitted.push(value); } })).resolves.toEqual({ type: "line", value: "hello" });
      expect(submitted).toEqual(["hello"]);
    } finally {
      Object.defineProperty(process, "stdin", { configurable: true, value: previousStdin });
      Object.defineProperty(process, "stdout", { configurable: true, value: previousStdout });
    }
  });

  it("moves cursor by Unicode grapheme code points instead of UTF-16 halves", () => {
    const value = "a🙂你";

    expect(nextGraphemeIndex(value, 1)).toBe(3);
    expect(previousGraphemeIndex(value, 3)).toBe(1);
    expect(nextGraphemeIndex(value, 3)).toBe(4);
    expect(previousGraphemeIndex(value, value.length)).toBe(3);
  });

  it("finds word boundaries without splitting Unicode graphemes", () => {
    const value = "alpha  beta🙂 gamma";

    expect(previousWordIndex(value, value.length)).toBe("alpha  beta🙂 ".length);
    expect(previousWordIndex(value, "alpha  beta🙂".length)).toBe("alpha  ".length);
    expect(nextWordIndex(value, 0)).toBe("alpha".length);
    expect(nextWordIndex(value, "alpha".length)).toBe("alpha  beta🙂".length);
  });

  it("finds current line boundaries in multiline composer input", () => {
    const value = "alpha\n  beta🙂 gamma\nz";
    const cursor = "alpha\n  beta🙂".length;

    expect(currentLineStartIndex(value, cursor)).toBe("alpha\n".length);
    expect(currentLineEndIndex(value, cursor)).toBe("alpha\n  beta🙂 gamma".length);
  });

  it("maps terminal scroll keys and mouse wheel events", () => {
    expect(scrollActionForSequence("\x1b[5~")).toEqual({ direction: "up", amount: 8 });
    expect(scrollActionForSequence("\x1b[6~")).toEqual({ direction: "down", amount: 8 });
    expect(scrollActionForSequence("\x1b[5;2~")).toEqual({ direction: "up", amount: 8 });
    expect(scrollActionForSequence("\x1b[6;2~")).toEqual({ direction: "down", amount: 8 });
    expect(scrollActionForSequence("\x1b[1;5H")?.direction).toBe("top");
    expect(scrollActionForSequence("\x1b[1;5F")?.direction).toBe("bottom");
    expect(scrollActionForSequence("\x1b[H")).toBeNull();
    expect(scrollActionForSequence("\x1b[F")).toBeNull();
    expect(scrollActionForSequence("\x1b[<64;10;5M")).toEqual({ direction: "up", amount: 3 });
    expect(scrollActionForSequence("\x1b[<65;10;5M")).toEqual({ direction: "down", amount: 3 });
  });

  it("keeps mouse escape sequences out of printable input chunks", () => {
    expect(splitInputSequences("a\x1b[<64;10;5Mb")).toEqual(["a", "\x1b[<64;10;5M", "b"]);
    expect(splitInputSequences("\x1b[5~hello")).toEqual(["\x1b[5~", "h", "e", "l", "l", "o"]);
    expect(splitInputSequences("a\x1bb\x1b\rb")).toEqual(["a", "\x1bb", "\x1b\r", "b"]);
    expect(splitInputSequences("a\x1b[13;2ub")).toEqual(["a", "\x1b[13;2u", "b"]);
    expect(splitInputSequences("qwq")).toEqual(["q", "w", "q"]);
  });

  it("coalesces printable input bursts before editing the prompt", () => {
    expect(isPlainTextInputSequence("hello")).toBe(true);
    expect(isPlainTextInputSequence("hello\n")).toBe(false);
    expect(coalesceInputSequences(splitInputSequences("hello"))).toEqual(["hello"]);
    expect(coalesceInputSequences(splitInputSequences("hi\x1b[D!"))).toEqual(["hi", "\x1b[D", "!"]);
  });

  it("recognizes bracketed paste delimiters", () => {
    const keys = splitInputSequences("\x1b[200~hello\nworld\x1b[201~");

    expect(isBracketedPasteStart(keys[0]!)).toBe(true);
    expect(isBracketedPasteEnd(keys.at(-1)!)).toBe(true);
    expect(keys).toContain("\n");
  });

  it("coalesces bracketed paste payloads including newlines", () => {
    const keys = splitInputSequences("\x1b[200~hello\nworld\x1b[201~");

    expect(coalesceInputSequences(keys)).toEqual(["\x1b[200~", "hello\nworld", "\x1b[201~"]);
  });

  it("coalesces text while already inside bracketed paste mode", () => {
    expect(coalesceInputSequences(["hello", "\n", "world"], { inBracketedPaste: true })).toEqual(["hello\nworld"]);
  });

  it("detects paste-like text bursts from short CJK, whitespace, and long ASCII", () => {
    expect(looksLikePasteTextBurst("请联网搜索：")).toBe(true);
    expect(looksLikePasteTextBurst("abc def")).toBe(true);
    expect(looksLikePasteTextBurst("abcdefghijklmnop")).toBe(true);
    expect(looksLikePasteTextBurst("abc")).toBe(false);
  });

  it("sanitizes pasted text before it reaches the composer", () => {
    expect(sanitizeInputText("\x1b[31mred\x1b[0m\0ok\r\nnext")).toBe("redok\nnext");
  });

  it("treats newlines in paste-like bursts as input text", () => {
    expect(shouldTreatNewlineAsPaste(5, 12, 1000, 0)).toBe(true);
    expect(shouldTreatNewlineAsPaste(0, 1, 1000, 1001)).toBe(true);
    expect(shouldTreatNewlineAsPaste(0, 1, 1000, 0, true)).toBe(true);
    expect(shouldTreatNewlineAsPaste(1, 2, 1000, 0)).toBe(false);
    expect(shouldTreatNewlineAsPaste(0, 1, 1000, 999)).toBe(false);
  });

  it("emits terminal bracketed paste mode sequences", () => {
    const chunks: string[] = [];
    const out = { write(chunk: string) { chunks.push(chunk); return true; } };

    enableBracketedPaste(out as any);
    disableBracketedPaste(out as any);

    expect(chunks).toEqual(["\x1b[?2004h", "\x1b[?2004l"]);
  });

  it("includes session deletion in command completion data", () => {
    expect(COMMANDS.map(([name]) => name)).toContain("delete");
  });

  it("detects incomplete escape prefixes for split terminal keys", () => {
    expect(trailingIncompleteEscapeStart("\x1b")).toBe(0);
    expect(trailingIncompleteEscapeStart("abc\x1b[")).toBe(3);
    expect(trailingIncompleteEscapeStart("abc\x1b[<64;10")).toBe(3);
    expect(trailingIncompleteEscapeStart("abc\x1b[13;")).toBe(3);
    expect(trailingIncompleteEscapeStart("abc\x1b[5~")).toBe(-1);
  });

  it("keeps split mouse wheel escape prefixes pending until complete", () => {
    expect(trailingIncompleteEscapeStart("abc\x1b[<64;10;")).toBe(3);
    expect(splitInputSequences("\x1b[<64;10;5M")).toEqual(["\x1b[<64;10;5M"]);
  });

  it("recognizes incomplete SS3 escape prefixes", () => {
    expect(trailingIncompleteEscapeStart("abc\x1bO")).toBe(3);
  });

  it("handles long input chunks and incomplete escape tails before parsing", () => {
    const hugeChunk = "a".repeat(5_000) + "\x1b[13;";
    const split = splitInputSequences(hugeChunk);

    expect(split).toHaveLength(5_004);
    expect(split.slice(-4)).toEqual(["\x1b[", "1", "3", ";"]);
    expect(trailingIncompleteEscapeStart("a".repeat(10_000) + "\x1b[13;")).toBe(10_000);
  });
});

describe("InputController", () => {
  it("edits, completes, and submits prompt input through one state machine", () => {
    const renders: Array<{ value: string; cursor: number; completions: string[] }> = [];
    const submissions: string[] = [];
    const controller = new InputController({
      mode: "idle",
      completionProvider: commandCompletionProvider,
      onRender: (state) => {
        renders.push({ value: state.value, cursor: state.cursor, completions: state.completions });
      },
      onSubmit: (value) => {
        submissions.push(value);
        return true;
      },
    });

    controller.handleData("/");
    controller.handleData("t");
    controller.handleData("a");
    expect(controller.getState()).toMatchObject({ value: "/ta", cursor: 3 });
    expect(controller.getState().completions.map(stripAnsi).join("\n")).toContain("/tasks");

    controller.handleData("\t");
    expect(controller.getState()).toMatchObject({ value: "/tasks ", cursor: 7 });

    controller.handleData("n");
    controller.handleData("o");
    controller.handleData("w");
    controller.handleData("\x1b[D");
    controller.handleData("\x7f");
    controller.handleData("\r");

    expect(submissions).toEqual(["/tasks nw"]);
    expect(renders.length).toBeGreaterThan(0);
  });

  it("skips hostile completion items while preserving valid neighbors", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "value", {
      enumerable: true,
      get() {
        throw new Error("completion getter failed");
      },
    });
    const controller = new InputController({
      mode: "idle",
      completionProvider: () => [
        hostile as any,
        { value: "good", display: "good completion", replacement: "/good " },
      ],
    });

    expect(() => controller.handleData("\t")).not.toThrow();

    expect(controller.getState()).toMatchObject({ value: "/good ", cursor: 6 });
  });

  it("completes leading-whitespace slash commands without dropping the prefix", () => {
    expect(commandCompletionProvider("explain /ta")).toEqual([]);
    expect(commandCompletionProvider("  /ta").some(item => item.completeText === "  /tasks")).toBe(true);

    const controller = new InputController({
      mode: "idle",
      completionProvider: commandCompletionProvider,
    });

    controller.handleData("  /tas");
    controller.handleData("\t");

    expect(controller.getState()).toMatchObject({ value: "  /tasks ", cursor: 9 });
  });

  it("navigates prompt history with draft restore and duplicate suppression", () => {
    const submissions: string[] = [];
    const controller = new InputController({
      mode: "idle",
      clearOnSubmit: true,
      history: ["older", "latest", "latest"],
      onSubmit: (value) => {
        submissions.push(value);
        return false;
      },
    });

    controller.handleData("draft");
    controller.handleData("\x1b[A");
    expect(controller.getState()).toMatchObject({ value: "latest", cursor: 6 });

    controller.handleData("\x1b[A");
    expect(controller.getState()).toMatchObject({ value: "older", cursor: 5 });

    controller.handleData("\x1b[B");
    expect(controller.getState()).toMatchObject({ value: "latest", cursor: 6 });

    controller.handleData("\x1b[B");
    expect(controller.getState()).toMatchObject({ value: "draft", cursor: 5 });

    controller.handleData("\r");
    controller.handleData("draft");
    controller.handleData("\r");
    expect(submissions).toEqual(["draft", "draft"]);

    controller.handleData("\x1b[A");
    expect(controller.getState()).toMatchObject({ value: "draft" });
    controller.handleData("\x1b[A");
    expect(controller.getState()).toMatchObject({ value: "latest" });
  });

  it("leaves edited prompt history entries in place instead of jumping unexpectedly", () => {
    const unhandled: string[] = [];
    const controller = new InputController({
      mode: "idle",
      history: ["first", "second"],
      onUnhandledSequence: (sequence) => {
        unhandled.push(sequence);
        return false;
      },
    });

    controller.handleData("\x1b[A");
    expect(controller.getState()).toMatchObject({ value: "second" });

    controller.handleData("!");
    controller.handleData("\x1b[A");

    expect(controller.getState()).toMatchObject({ value: "second!" });
    expect(unhandled).toEqual(["\x1b[A"]);
  });

  it("sanitizes and caps seeded prompt history", () => {
    const family = "👨‍👩‍👧‍👦";
    const controller = new InputController({
      mode: "idle",
      historyLimit: 2,
      history: [
        "drop",
        "keep\u0000one",
        "keep\u0000one",
        `${"x".repeat(999_999)}${family}`,
      ],
    });

    controller.handleData("\x1b[A");
    const latest = controller.getState().value;
    expect(latest.length).toBeLessThanOrEqual(1_000_000);
    expect(latest).not.toContain(family);
    expect(latest).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(latest)).toBe(false);

    controller.handleData("\x1b[A");
    expect(controller.getState().value).toBe("keepone");
  });

  it("allows callers to disable prompt history navigation", () => {
    const unhandled: string[] = [];
    const controller = new InputController({
      mode: "idle",
      historyLimit: 0,
      history: ["old"],
      onUnhandledSequence: (sequence) => {
        unhandled.push(sequence);
        return false;
      },
    });

    controller.handleData("\x1b[A");

    expect(controller.getState().value).toBe("");
    expect(unhandled).toEqual(["\x1b[A"]);
  });

  it("searches prompt history with Alt+R and cycles through older matches", () => {
    const controller = new InputController({
      mode: "idle",
      history: [
        "first refactor note",
        "unrelated",
        "second refactor note",
        "third refactor note",
      ],
    });

    controller.handleData("refactor");
    controller.handleData("\x1br");
    expect(controller.getState()).toMatchObject({ value: "third refactor note", cursor: 19 });

    controller.handleData("\x1br");
    expect(controller.getState()).toMatchObject({ value: "second refactor note", cursor: 20 });

    controller.handleData("\x1br");
    expect(controller.getState()).toMatchObject({ value: "first refactor note", cursor: 19 });

    controller.handleData("\x1br");
    expect(controller.getState()).toMatchObject({ value: "third refactor note", cursor: 19 });
  });

  it("resets prompt history search after edits and leaves unmatched Alt+R unhandled", () => {
    const unhandled: string[] = [];
    const controller = new InputController({
      mode: "idle",
      history: ["fix alpha", "fix beta", "ship release"],
      onUnhandledSequence: (sequence) => {
        unhandled.push(sequence);
        return false;
      },
    });

    controller.handleData("fix");
    controller.handleData("\x1br");
    expect(controller.getState().value).toBe("fix beta");

    controller.handleData("!");
    controller.handleData("\x1br");
    expect(controller.getState().value).toBe("fix beta!");
    expect(unhandled).toEqual(["\x1br"]);

    controller.handleData("\x15");
    controller.handleData("release");
    controller.handleData("\x1bR");
    expect(controller.getState().value).toBe("ship release");
  });

  it("clears prompt history search state when reset", () => {
    const controller = new InputController({
      mode: "idle",
      history: ["fix alpha", "fix beta", "ship release"],
    });

    controller.handleData("fix");
    controller.handleData("\x1br");
    expect(controller.getState().value).toBe("fix beta");

    controller.reset({ value: "release", render: false });
    controller.handleData("\x1br");

    expect(controller.getState()).toMatchObject({ value: "ship release", cursor: 12 });
  });

  it("keeps paste newlines as text and submits after paste ends", () => {
    const submissions: string[] = [];
    let now = 1_000;
    const controller = new InputController({
      mode: "running",
      clearOnSubmit: true,
      now: () => now,
      onSubmit: (value) => {
        submissions.push(value);
        return true;
      },
    });

    controller.handleData("\x1b[200~hello\nworld\x1b[201~");
    expect(controller.getState().value).toBe("hello\nworld");

    now = 1_200;
    controller.handleData("\r");
    expect(submissions).toEqual(["hello\nworld"]);
    expect(controller.getState().value).toBe("");
  });

  it("keeps short non-bracketed CJK paste newlines as composer text", () => {
    const submissions: string[] = [];
    let now = 1_000;
    const controller = new InputController({
      mode: "idle",
      clearOnSubmit: true,
      now: () => now,
      onSubmit: (value) => {
        submissions.push(value);
        return false;
      },
    });

    controller.handleData("请联网搜索：\n");
    expect(submissions).toEqual([]);
    expect(controller.getState().value).toBe("请联网搜索：\n");

    now += PASTE_BURST_NEWLINE_WINDOW_MS + 1;
    controller.handleData("DeepSeek");
    controller.handleData("\r");

    expect(submissions).toEqual(["请联网搜索：\nDeepSeek"]);
  });

  it("keeps long unbracketed paste payloads multiline until the next real enter", () => {
    const submissions: string[] = [];
    let now = 2_000;
    const controller = new InputController({
      mode: "idle",
      clearOnSubmit: true,
      now: () => now,
      onSubmit: (value) => {
        submissions.push(value);
        return false;
      },
    });

    controller.handleData("first pasted line\nsecond pasted line\n");
    expect(submissions).toEqual([]);
    expect(controller.getState().value).toBe("first pasted line\nsecond pasted line\n");

    now += PASTE_BURST_NEWLINE_WINDOW_MS + 1;
    controller.handleData("\r");
    expect(submissions).toEqual(["first pasted line\nsecond pasted line\n"]);
  });

  it("clears paste newline suppression after navigation keys", () => {
    const submissions: string[] = [];
    let now = 3_000;
    const controller = new InputController({
      mode: "idle",
      now: () => now,
      onSubmit: (value) => {
        submissions.push(value);
        return false;
      },
    });

    controller.handleData("请联网搜索：");
    controller.handleData("\x1b[D");
    controller.handleData("\r");

    expect(controller.getState().value).toBe("请联网搜索：");
    expect(submissions).toEqual(["请联网搜索："]);
  });

  it("strips control and ANSI text from pasted composer input", () => {
    const controller = new InputController({ mode: "idle" });

    controller.handleData("\x1b[200~\x1b[31mred\x1b[0m\0ok\r\nnext\x1b[201~");

    expect(controller.getState().value).toBe("redok\nnext");
  });

  it("bounds large pasted composer input without splitting surrogate pairs", () => {
    const controller = new InputController({ mode: "idle" });

    controller.handleData("a".repeat(MAX_INPUT_CHARS - 1));
    controller.handleData("🙂tail");

    expect(controller.getState().value).toHaveLength(MAX_INPUT_CHARS - 1);
    expect(controller.getState().value.endsWith("\ud83d")).toBe(false);
  });

  it("bounds large pasted composer input on full grapheme boundaries", () => {
    const controller = new InputController({ mode: "idle" });
    const family = "👨‍👩‍👧‍👦";

    controller.handleData("a".repeat(MAX_INPUT_CHARS - 5));
    controller.handleData(`${family}tail`);

    const value = controller.getState().value;
    expect(value).not.toContain(family);
    expect(hasUnpairedSurrogate(value)).toBe(false);
    expect(value).not.toContain("\u200d");
  });

  it("supports composer continuation keys without accidentally submitting", () => {
    const submissions: string[] = [];
    const controller = new InputController({
      mode: "idle",
      onSubmit: (value) => {
        submissions.push(value);
        return false;
      },
    });
    const type = (text: string) => {
      for (const char of text) controller.handleData(char);
    };

    type("first");
    controller.handleData("\\");
    controller.handleData("\r");
    type("second");
    controller.handleData("\x1b[13;2u");
    type("third");
    controller.handleData("\x1b[13;5u");
    type("fourth");
    controller.handleData("\r");

    expect(submissions).toEqual(["first\nsecond\nthird\nfourth"]);
  });

  it("routes scroll, mode cycle, and interrupts without duplicating parsers", () => {
    const scrolls: string[] = [];
    let interrupted = 0;
    let mode = "idle";
    const controller = new InputController({
      mode: "idle",
      prompt: "a",
      onModeCycle: () => {
        mode = "running";
        return "b";
      },
      onScroll: (direction, amount) => {
        scrolls.push(`${direction}:${amount}`);
      },
      onInterrupt: () => {
        interrupted++;
        return false;
      },
    });

    controller.handleData("\x1b[5~");
    controller.handleData("\x1b[Z");
    controller.handleSequences(["\x1b"]);

    expect(scrolls).toEqual(["up:8"]);
    expect(mode).toBe("running");
    expect(controller.getState().prompt).toBe("b");
    expect(interrupted).toBe(1);
  });

  it("blocks mode cycling while running and explains why", () => {
    const notices: string[] = [];
    const controller = new InputController({
      mode: "running",
      prompt: "● ",
      onModeCycle: () => denyModeSwitchWhileRunning(message => notices.push(message), "● "),
    });

    controller.handleData("\x1b[Z");

    expect(controller.getState().prompt).toBe("● ");
    expect(notices).toHaveLength(1);
    expect(stripAnsi(notices[0]!)).toContain(RUNNING_MODE_SWITCH_BLOCKED_MESSAGE);
  });

  it("clears the current input on ctrl+c instead of treating it as exit", () => {
    let ctrlCCount = 0;
    const controller = new InputController({
      mode: "idle",
      onCtrlC: () => {
        ctrlCCount++;
        controller.reset({ render: false });
        return false;
      },
    });

    controller.handleData("hello");
    expect(controller.getState()).toMatchObject({ value: "hello", cursor: 5 });

    controller.handleData("\x03");

    expect(ctrlCCount).toBe(1);
    expect(controller.getState()).toMatchObject({ value: "", cursor: 0 });
  });

  it("routes ctrl+c to interrupt when no explicit ctrl+c handler exists", () => {
    let interrupts = 0;
    let eof = 0;
    const controller = new InputController({
      mode: "idle",
      onInterrupt: () => {
        interrupts++;
        return false;
      },
      onEof: () => {
        eof++;
        return true;
      },
    });

    controller.handleData("\x03");

    expect(interrupts).toBe(1);
    expect(eof).toBe(0);
  });

  it("passes picker and approval keys through the shared parser without editing text", () => {
    const pickerKeys: string[] = [];
    const picker = new InputController({
      mode: "picker",
      editable: false,
      onUnhandledSequence: (sequence) => {
        pickerKeys.push(sequence);
        return false;
      },
    });

    picker.handleData("\x1b[5~");
    picker.handleData("\x1b[H");
    picker.handleData("y");

    expect(pickerKeys).toEqual(["\x1b[5~", "\x1b[H", "y"]);
    expect(picker.getState()).toMatchObject({ value: "", cursor: 0 });

    const approvals: string[] = [];
    const approval = new InputController({
      mode: "approval",
      editable: false,
      onUnhandledSequence: (sequence) => {
        approvals.push(sequence);
        return true;
      },
    });

    approval.handleData("always");
    expect(approvals).toEqual(["always"]);
    expect(approval.getState().value).toBe("");
  });

  it("falls back for picker items with hostile getters", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "name", {
      enumerable: true,
      get() {
        throw new Error("name getter failed");
      },
    });
    Object.defineProperty(hostile, "desc", {
      enumerable: true,
      get() {
        throw new Error("desc getter failed");
      },
    });

    expect(() => safePickerItem(hostile)).not.toThrow();
    expect(safePickerItem(hostile)).toEqual({ name: "(unnamed)" });
  });

  it("passes Esc through approval mode so modal handlers can cancel without editing text", async () => {
    const sequences: string[] = [];
    vi.useFakeTimers();
    const approval = new InputController({
      mode: "approval",
      editable: false,
      onUnhandledSequence: (sequence) => {
        sequences.push(sequence);
        return true;
      },
    });

    approval.handleData("\x1b");
    await vi.advanceTimersByTimeAsync(30);

    expect(sequences).toEqual(["\x1b"]);
    expect(approval.getState()).toMatchObject({ value: "", cursor: 0 });
    vi.useRealTimers();
  });

  it("flushes a pending bare escape on dispose without mutating input state", async () => {
    vi.useFakeTimers();
    const interrupts: string[] = [];
    const controller = new InputController({
      mode: "idle",
      onInterrupt: () => {
        interrupts.push("interrupt");
        return false;
      },
    });

    controller.handleData("\x1b");
    controller.dispose();
    await vi.advanceTimersByTimeAsync(30);

    expect(interrupts).toEqual([]);
    expect(controller.getState()).toMatchObject({ value: "", cursor: 0, inBracketedPaste: false });
    vi.useRealTimers();
  });

  it("flushes a split escape sequence after the pending timeout", async () => {
    const sequences: string[] = [];
    vi.useFakeTimers();
    const controller = new InputController({
      mode: "approval",
      editable: false,
      onUnhandledSequence: (sequence) => {
        sequences.push(sequence);
        return true;
      },
    });

    controller.handleData("\x1b");
    await vi.advanceTimersByTimeAsync(30);

    expect(sequences).toEqual(["\x1b"]);
    vi.useRealTimers();
  });

  it("treats shift-tab as pasted text while inside bracketed paste mode", () => {
    const controller = new InputController({ mode: "idle" });

    controller.handleData("\x1b[200~");
    controller.handleData("\x1b[Z");
    controller.handleData("\x1b[201~");

    expect(controller.getState().value).toBe("\x1b[Z");
  });

  it("keeps escape-prefixed navigation sequences from editing approval input", () => {
    const sequences: string[] = [];
    const controller = new InputController({
      mode: "approval",
      editable: false,
      onUnhandledSequence: (sequence) => {
        sequences.push(sequence);
        return true;
      },
    });

    controller.handleData("\x1b[C");
    controller.handleData("\x1b[D");

    expect(sequences).toEqual(["\x1b[C", "\x1b[D"]);
    expect(controller.getState().value).toBe("");
  });

  it("detaches raw input listeners idempotently and restores bracketed paste only once", () => {
    const writes: string[] = [];
    let rawMode: boolean | undefined;
    let resumeCount = 0;
    let pauseCount = 0;
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const stdin = {
      isRaw: false,
      setRawMode(value: boolean) { rawMode = value; return this; },
      resume() { resumeCount++; return this; },
      pause() { pauseCount++; return this; },
      on(event: string, handler: (...args: any[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
        return this;
      },
      removeListener(event: string, handler: (...args: any[]) => void) {
        listeners.get(event)?.delete(handler);
        return this;
      },
    };
    const controller = new InputController();

    const detach = controller.attach({
      stdin: stdin as any,
      stdout: { write(chunk: string) { writes.push(chunk); return true; } },
      rawMode: true,
      bracketedPaste: true,
      pauseOnStop: true,
    });

    detach();
    detach();

    expect(writes).toEqual(["\x1b[?2004h", "\x1b[?2004l"]);
    expect(rawMode).toBe(false);
    expect(resumeCount).toBe(1);
    expect(pauseCount).toBe(1);
    expect(listeners.get("data")?.size ?? 0).toBe(0);
    expect(listeners.get("end")?.size ?? 0).toBe(0);
  });

  it("routes attached stdin end events through eof handling", () => {
    let eofCount = 0;
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const stdin = {
      isRaw: false,
      setRawMode() { return this; },
      resume() { return this; },
      pause() { return this; },
      on(event: string, handler: (...args: any[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
        return this;
      },
      removeListener(event: string, handler: (...args: any[]) => void) {
        listeners.get(event)?.delete(handler);
        return this;
      },
    };
    const controller = new InputController({
      onEof: () => {
        eofCount++;
        return true;
      },
    });
    const detach = controller.attach({
      stdin: stdin as any,
      stdout: { write() { return true; } },
      bracketedPaste: false,
    });

    listeners.get("end")?.forEach(handler => handler());
    detach();

    expect(eofCount).toBe(1);
    expect(listeners.get("end")?.size ?? 0).toBe(0);
  });

  it("does not treat ctrl+d as eof while text is present", () => {
    let eofCount = 0;
    const controller = new InputController({
      mode: "idle",
      onEof: () => {
        eofCount++;
        return true;
      },
    });

    controller.handleData("hello");
    controller.handleData("\x04");

    expect(eofCount).toBe(0);
    expect(controller.getState().value).toBe("hello");
  });

  it("supports ctrl+a and ctrl+e cursor movement shortcuts", () => {
    const controller = new InputController({ mode: "idle" });

    controller.handleData("hello");
    controller.handleData("\x01");
    expect(controller.getState().cursor).toBe(0);

    controller.handleData("\x05");
    expect(controller.getState().cursor).toBe(5);
  });

  it("keeps line movement and deletion shortcuts scoped to the current composer line", () => {
    const controller = new InputController({ mode: "idle" });

    controller.handleData("alpha\n  beta gamma\nomega");
    controller.handleData("\x1b[H");
    expect(controller.getState().cursor).toBe("alpha\n  beta gamma\n".length);

    controller.handleData("\x1b[1;5D");
    controller.handleData("\x01");
    expect(controller.getState().cursor).toBe("alpha\n".length);

    controller.handleData("\x05");
    expect(controller.getState().cursor).toBe("alpha\n  beta gamma".length);

    controller.handleData("\x1b[1;5D");
    controller.handleData("\x15");
    expect(controller.getState()).toMatchObject({
      value: "alpha\ngamma\nomega",
      cursor: "alpha\n".length,
    });

    controller.handleData("\x0b");
    expect(controller.getState()).toMatchObject({
      value: "alpha\n\nomega",
      cursor: "alpha\n".length,
    });

    controller.handleData("\x1b[1;5F");
    expect(controller.getState().cursor).toBe("alpha\n".length);
  });

  it("deletes the grapheme after the cursor with terminal Delete sequences", () => {
    const controller = new InputController({ mode: "idle" });

    controller.handleData("a🙂b");
    controller.handleData("\x01");
    controller.handleData("\x1b[3~");
    expect(controller.getState()).toMatchObject({ value: "🙂b", cursor: 0 });

    controller.handleData("\x1b[3;5~");
    expect(controller.getState()).toMatchObject({ value: "b", cursor: 0 });
  });

  it("supports composer word movement and word deletion shortcuts", () => {
    const controller = new InputController({ mode: "idle" });

    controller.handleData("alpha  beta gamma");
    controller.handleData("\x1b[1;5D");
    expect(controller.getState().cursor).toBe("alpha  beta ".length);

    controller.handleData("\x1b[1;3D");
    expect(controller.getState().cursor).toBe("alpha  ".length);

    controller.handleData("\x1b[1;5C");
    expect(controller.getState().cursor).toBe("alpha  beta".length);

    controller.handleData("\x1b[5C");
    expect(controller.getState().cursor).toBe("alpha  beta gamma".length);

    controller.handleData("\x1b[5D");
    expect(controller.getState().cursor).toBe("alpha  beta ".length);

    controller.handleData("\x17");
    expect(controller.getState()).toMatchObject({ value: "alpha  gamma", cursor: "alpha  ".length });

    controller.handleData("\x15");
    expect(controller.getState()).toMatchObject({ value: "gamma", cursor: 0 });
  });

  it("inserts composer newlines with Alt+Enter while plain carriage return still submits", () => {
    const submissions: string[] = [];
    let now = 1_000;
    const controller = new InputController({
      mode: "idle",
      now: () => now,
      onSubmit: (value) => {
        submissions.push(value);
        return false;
      },
    });

    controller.handleData("hello");
    controller.handleSequences(["\x1b\r"]);
    controller.handleData("world");
    expect(controller.getState().value).toBe("hello\nworld");

    now += PASTE_BURST_NEWLINE_WINDOW_MS + 1;
    controller.handleData("\r");
    expect(submissions).toEqual(["hello\nworld"]);
  });

  it("updates the prompt through setPrompt and emits a mode render", () => {
    const prompts: string[] = [];
    const controller = new InputController({
      mode: "idle",
      onRender: (state, meta) => {
        prompts.push(`${state.prompt}:${meta.reason}`);
      },
    });

    controller.setPrompt("next> ");

    expect(controller.getState().prompt).toBe("next> ");
    expect(prompts).toContain("next> :mode");
  });

  it("sanitizes reset values, prompts, and mode-cycle prompts", () => {
    const controller = new InputController({
      mode: "idle",
      prompt: "\x1b[31mred\x1b[0m\0\nprompt",
      onModeCycle: () => "\x1b[31mnext\x1b[0m\0\nprompt",
    });

    expect(stripAnsi(controller.getState().prompt)).toBe("red prompt");

    controller.reset({ value: "\x1b[31mred\x1b[0m\0🙂tail", cursor: "red\ud83d".length });
    expect(controller.getState()).toMatchObject({ value: "red🙂tail", cursor: 3 });

    controller.handleData("\x1b[Z");
    expect(stripAnsi(controller.getState().prompt)).toBe("next prompt");

    controller.setPrompt("x".repeat(200), false);
    expect(visibleLength(controller.getState().prompt)).toBeLessThanOrEqual(120);
  });

  it("bounds and sanitizes completion provider output", () => {
    const controller = new InputController({
      mode: "idle",
      completionLimit: 1000,
      completionProvider: () => [
        { value: "\x1b[31mone\x1b[0m\0", display: "\x1b[31m/one\x1b[0m\0", replacement: "\x1b[31m/one\x1b[0m\0 " },
        { value: `${"x".repeat(1999)}👨‍👩‍👧‍👦`, display: `${"d".repeat(1999)}👨‍👩‍👧‍👦`, replacement: `${"r".repeat(1999)}👨‍👩‍👧‍👦` },
        { value: "" },
        ...Array.from({ length: 100 }, (_, index) => ({ value: `item-${index}` })),
      ],
    });

    expect(controller.getState().completions).toHaveLength(80);
    expect(stripAnsi(controller.getState().completions[0]!)).toBe("/one");
    expect(controller.getState().completions[1]).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(controller.getState().completions[1]!)).toBe(false);

    controller.handleData("\t");
    expect(controller.getState().value).toBe("");
  });

  it("applies common completion prefixes on grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const controller = new InputController({
      mode: "idle",
      completionProvider: () => [
        { value: `/${"x".repeat(1999)}${family}a` },
        { value: `/${"x".repeat(1999)}${family}b` },
      ],
    });

    controller.handleData("/");
    controller.handleData("\t");

    expect(controller.getState().value).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(controller.getState().value)).toBe(false);
  });

  it("ignores malformed or throwing completion providers", () => {
    const malformed = new InputController({
      mode: "idle",
      completionProvider: () => ({ value: "bad" }) as any,
    });
    expect(malformed.getState().completions).toEqual([]);

    const throwing = new InputController({
      mode: "idle",
      completionProvider: () => {
        throw new Error("boom");
      },
    });
    expect(throwing.getState().completions).toEqual([]);
  });

  it("updates mode through setMode and emits a mode render", () => {
    const renders: string[] = [];
    const controller = new InputController({
      mode: "idle",
      onRender: (state, meta) => {
        renders.push(`${state.mode}:${meta.reason}`);
      },
    });

    controller.setMode("running");

    expect(controller.getState().mode).toBe("running");
    expect(renders).toContain("running:mode");
  });
});

describe("Prompt history persistence", () => {
  it("loads prompt history while skipping slash commands, blanks, and consecutive duplicates", async () => {
    const path = tempPromptHistoryPath();
    await writeFile(path, ["first", "", "/help", "second", "second", "third"].join("\n"), "utf-8");

    await expect(loadPromptHistory(path)).resolves.toEqual(["first", "second", "third"]);
  });

  it("appends prompt history asynchronously without storing slash commands", async () => {
    const path = tempPromptHistoryPath();

    appendPromptHistory("first", path);
    appendPromptHistory("first", path);
    appendPromptHistory("/status", path);
    appendPromptHistory("second", path);

    const loaded = await waitForPromptHistory(path, entries => entries.includes("second"));
    expect(loaded).toEqual(["first", "second"]);
    expect(await readFile(path, "utf-8")).toBe("first\nsecond\n");
  });

  it("flushes pending prompt history writes for deterministic shutdown", async () => {
    const path = tempPromptHistoryPath();

    appendPromptHistory("shutdown entry", path);
    await flushPromptHistoryWrites(path);

    expect(await loadPromptHistory(path)).toEqual(["shutdown entry"]);
    expect(await readFile(path, "utf-8")).toBe("shutdown entry\n");
  });

  it("caps persisted prompt history and keeps text on full grapheme boundaries", async () => {
    const path = tempPromptHistoryPath();
    const family = "👨‍👩‍👧‍👦";

    for (let index = 0; index < 205; index++) appendPromptHistory(`entry-${index}`, path);
    appendPromptHistory("a".repeat(3_998) + family + "tail", path);

    const loaded = await waitForPromptHistory(path, entries => entries.at(-1)?.startsWith("a") === true && entries.length === 200);
    const last = loaded.at(-1) ?? "";
    expect(loaded).toHaveLength(200);
    expect(loaded[0]).toBe("entry-6");
    expect(last).not.toContain(family);
    expect(hasUnpairedSurrogate(last)).toBe(false);
    expect(last).not.toContain("\u200d");
  });

  it("normalizes injected prompt history entries defensively", () => {
    expect(normalizePromptHistoryEntries([
      " keep ",
      "/exit",
      "\0bad",
      "\0bad",
      "next",
    ], 3)).toEqual(["keep", "bad", "next"]);
  });

  it("updates in-memory prompt history with the same filtering rules as persistence", () => {
    let history = ["older"];

    history = pushPromptHistoryEntry(history, "/help");
    history = pushPromptHistoryEntry(history, "latest");
    history = pushPromptHistoryEntry(history, "latest");

    expect(history).toEqual(["older", "latest"]);
  });
});

describe("Picker", () => {
  it("keeps the selected item inside a sliding visible window", () => {
    const items = Array.from({ length: 20 }, (_, index) => `session-${index}`);

    expect(pickerWindow(items, 0, 5)).toMatchObject({
      start: 0,
      end: 5,
      selectedIndex: 0,
    });

    const middle = pickerWindow(items, 10, 5);
    expect(middle.entries.map(entry => entry.item)).toEqual([
      "session-8",
      "session-9",
      "session-10",
      "session-11",
      "session-12",
    ]);
    expect(middle.entries.find(entry => entry.selected)?.item).toBe("session-10");

    expect(pickerWindow(items, 19, 5)).toMatchObject({
      start: 15,
      end: 20,
      selectedIndex: 19,
    });
  });

  it("maps navigation keys for session pickers", () => {
    expect(pickerActionForSequence("\x1b[A")).toBe("up");
    expect(pickerActionForSequence("\x1b[B")).toBe("down");
    expect(pickerActionForSequence("k")).toBe("up");
    expect(pickerActionForSequence("j")).toBe("down");
    expect(pickerActionForSequence("\x1b[5~")).toBe("page_up");
    expect(pickerActionForSequence("\x1b[6~")).toBe("page_down");
    expect(pickerActionForSequence("\x1b[H")).toBe("top");
    expect(pickerActionForSequence("\x1b[F")).toBe("bottom");
    expect(pickerActionForSequence("\x1b[<64;10;5M")).toBe("up");
    expect(pickerActionForSequence("\x1b[<65;10;5M")).toBe("down");
    expect(pickerActionForSequence("\r")).toBe("confirm");
    expect(pickerActionForSequence("\x1b")).toBe("cancel");
    expect(pickerActionForSequence("3")).toEqual({ type: "choose", index: 2 });
    expect(pickerActionForSequence("0")).toBeNull();
  });

  it("moves through long picker lists without wrapping away from old sessions", () => {
    expect(movePickerIndex(0, 20, "up", 5)).toBe(0);
    expect(movePickerIndex(0, 20, "down", 5)).toBe(1);
    expect(movePickerIndex(3, 20, "page_down", 5)).toBe(8);
    expect(movePickerIndex(18, 20, "page_down", 5)).toBe(19);
    expect(movePickerIndex(8, 20, "page_up", 5)).toBe(3);
    expect(movePickerIndex(8, 20, "top", 5)).toBe(0);
    expect(movePickerIndex(8, 20, "bottom", 5)).toBe(19);
    expect(movePickerIndex(8, 20, { type: "choose", index: 2 }, 5)).toBe(2);
    expect(movePickerIndex(8, 20, { type: "choose", index: 99 }, 5)).toBe(19);
  });

  it("labels only the first nine picker entries for quick selection", () => {
    expect(pickerIndexLabel(0)).toBe("1. ");
    expect(pickerIndexLabel(8)).toBe("9. ");
    expect(pickerIndexLabel(9)).toBe("");
  });

  it("returns an empty picker window when there is no space to show items", () => {
    expect(pickerWindow(["a", "b"], 0, 0)).toEqual({
      start: 0,
      end: 0,
      selectedIndex: -1,
      total: 2,
      entries: [],
    });
  });

  it("normalizes invalid picker indices and visible counts", () => {
    expect(movePickerIndex(Number.NaN, 2, "down", Number.NaN)).toBe(1);
    expect(movePickerIndex(Number.NaN, Number.POSITIVE_INFINITY, "down", Number.NaN)).toBe(-1);
    expect(pickerWindow(["a", "b"], Number.NaN, 99)).toMatchObject({
      start: 0,
      end: 2,
      selectedIndex: 0,
    });
    expect(pickerWindow(["a", "b"], Number.NaN, Number.POSITIVE_INFINITY).entries).toEqual([]);
    expect(pickerWindow(["a", "b"], 0, Number.NaN).entries).toEqual([]);
  });

  it("sanitizes picker labels and bounds them on grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const item = safePickerItem({
      name: `\x1b[31m${"x".repeat(159)}${family}`,
      desc: `desc\u0000${"y".repeat(400)}`,
    });

    expect(item.name.length).toBeLessThanOrEqual(160);
    expect(item.name).not.toContain("\x1b");
    expect(item.name).not.toContain(family);
    expect(item.name).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(item.name)).toBe(false);
    expect(item.desc).not.toContain("\u0000");
    expect(item.desc?.length).toBeLessThanOrEqual(240);
    expect(safePickerTitle("\x1b[31mPick\u0007 one")).toBe("Pick one");
  });
});

describe("TUI modal requests", () => {
  it("renders picker modal lines from structured state", () => {
    const lines = pickerModalLines(
      3,
      Array.from({ length: 6 }, (_, index) => ({ name: `item-${index}`, desc: `desc-${index}` })),
      "Select item",
      3,
    ).map(stripAnsi);

    expect(lines.join("\n")).toContain("item-3");
    expect(lines.join("\n")).toContain("2. item-3");
    expect(lines.join("\n")).toContain("desc-3");
    expect(lines.at(-1)).toContain("Select item");
  });

  it("renders sanitized bounded picker modal text", () => {
    const lines = pickerModalLines(
      0,
      [{ name: `bad\u0000${"x".repeat(300)}`, desc: `\x1b[31mdesc${"y".repeat(300)}` }],
      `Title\u0007${"z".repeat(300)}`,
      1,
    ).map(stripAnsi);
    const joined = lines.join("\n");

    expect(joined).not.toContain("\u0000");
    expect(joined).not.toContain("\u0007");
    expect(lines.every(line => line.length < 420)).toBe(true);
    expect(lines.at(-1)).toContain("Title");
  });

  it("renders approval modal lines without transcript writes", () => {
    const text = approvalModalLines("bash", { command: "npm test" }).map(stripAnsi).join("\n");

    expect(text).toContain("Approval required: bash");
    expect(text).toContain("command=npm test");
    expect(text).toContain("y yes");
  });
});

describe("Modes", () => {
  it("cycles through interactive modes", () => {
    expect(nextModeName("plan")).toBe("agent");
    expect(nextModeName("agent")).toBe("yolo");
    expect(nextModeName("yolo")).toBe("plan");
    expect(nextModeName("unknown")).toBe("agent");
  });
});

describe("Alternate screen mode", () => {
  it("keeps inline mode as the scrollback-preserving default", () => {
    expect(shouldUseAlternateScreen("never")).toBe(false);
    expect(shouldUseAlternateScreen("always")).toBe(true);
  });

  it("disables auto alternate screen inside Zellij", () => {
    expect(shouldUseAlternateScreen("auto", { ZELLIJ: "1" })).toBe(false);
    expect(shouldUseAlternateScreen("auto", {})).toBe(true);
  });
});

describe("FrameRenderer", () => {
  it("diffs frames and can wrap writes in synchronized output", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: true,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      env: { SEEKCODE_TUI_SYNC_OUTPUT: "1" } as any,
      now: (() => {
        let t = 0;
        return () => ++t;
      })(),
    });

    const first = renderer.render(["alpha", "beta"], { cursor: { row: 2, col: 3 } });
    expect(first).toMatchObject({ changedRows: 2, totalRows: 2, fullRepaint: true });
    expect(chunks.join("")).toContain("\x1b[?2026h");
    expect(chunks.join("")).toContain("\x1b[1;1Halpha");
    expect(chunks.join("")).toContain("\x1b[2;1Hbeta");
    expect(chunks.join("")).toContain("\x1b[?2026l");

    chunks.length = 0;
    const second = renderer.render(["alpha", "gamma"], { cursor: { row: 2, col: 6 } });
    const output = chunks.join("");
    expect(second).toMatchObject({ changedRows: 1, totalRows: 2, fullRepaint: false });
    expect(output).not.toContain("\x1b[1;1Halpha");
    expect(output).toContain("\x1b[2;1Hgamma");
    expect(output).toContain("\x1b[2;6H");
  });

  it("clears stale fullscreen row tails when a changed row becomes shorter", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: false,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      synchronizedOutput: false,
    });

    renderer.render(["longer row"], { cursor: { row: 1, col: 1 }, cols: 20 });
    chunks.length = 0;
    renderer.render(["short"], { cursor: { row: 1, col: 1 }, cols: 20 });

    expect(chunks.join("")).toContain("\x1b[1;1Hshort\x1b[K");
  });

  it("skips fullscreen writes when frame content and cursor are unchanged", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: false,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      synchronizedOutput: false,
    });

    renderer.render(["alpha"], { cursor: { row: 1, col: 3 }, cols: 20 });
    chunks.length = 0;
    const stats = renderer.render(["alpha"], { cursor: { row: 1, col: 3 }, cols: 20 });

    expect(stats).toMatchObject({ changedRows: 0, fullRepaint: false });
    expect(chunks).toEqual([]);
  });

  it("moves only the cursor when fullscreen content is unchanged", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: false,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      synchronizedOutput: false,
    });

    renderer.render(["alpha"], { cursor: { row: 1, col: 1 }, cols: 20 });
    chunks.length = 0;
    const stats = renderer.render(["alpha"], { cursor: { row: 1, col: 5 }, cols: 20 });

    expect(stats).toMatchObject({ changedRows: 0, fullRepaint: false });
    expect(chunks.join("")).toBe("\x1b[1;5H");
  });

  it("sanitizes frame control text and bounds rendered line payloads", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: false,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      synchronizedOutput: false,
    });

    renderer.render([`\x1b[31mred\x1b[0m\u0000${"x".repeat(250_000)}`], { cursor: { row: 1, col: 1 }, cols: 80 });
    const output = chunks.join("");

    expect(output).toContain("\x1b[31mred\x1b[0m ");
    expect(output).not.toContain("\u0000");
    expect(output.length).toBeLessThan(205_000);
  });

  it("logs slow frames only when debug timing is enabled", () => {
    const debug: string[] = [];
    const times = [0, 50];
    const renderer = new FrameRenderer({
      stdout: { isTTY: false, write() { return true; } } as any,
      stderr: { write(chunk: string | Uint8Array) { debug.push(String(chunk)); return true; } } as any,
      env: { SEEKCODE_TUI_DEBUG: "1", SEEKCODE_TUI_SLOW_FRAME_MS: "10" } as any,
      now: () => times.shift() ?? 50,
      synchronizedOutput: false,
    });

    renderer.render(["alpha"], { cursor: { row: 1, col: 1 } });
    expect(debug.join("")).toContain("slow frame 50.0ms");
  });

  it("diffs anchored frames for inline dynamic regions", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: false,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      synchronizedOutput: false,
    });

    const stats = renderer.renderAnchored(["one", "two"], {
      previousFrame: ["one", "old", "stale"],
      cursor: { row: 2, col: 2 },
    });
    const output = chunks.join("");

    expect(stats).toMatchObject({ changedRows: 2, totalRows: 3, fullRepaint: false });
    expect(output).not.toContain("one");
    expect(output).toContain("two");
    expect(output).toContain("\x1b[2K");
    expect(output).toContain("\x1b[1A");
    expect(output).toContain("\x1b[1C");
  });

  it("detects synchronized output support from env and tty", () => {
    expect(shouldUseSynchronizedOutput({ SEEKCODE_TUI_SYNC_OUTPUT: "1" } as any, { isTTY: false } as any)).toBe(true);
    expect(shouldUseSynchronizedOutput({ SEEKCODE_TUI_SYNC_OUTPUT: "0" } as any, { isTTY: true } as any)).toBe(false);
    expect(shouldUseSynchronizedOutput({ TERM: "dumb" } as any, { isTTY: true } as any)).toBe(false);
  });

  it("falls back to SEEKCODE_SYNC_OUTPUT when the TUI-specific env var is unset", () => {
    expect(shouldUseSynchronizedOutput({ SEEKCODE_SYNC_OUTPUT: "yes" } as any, { isTTY: false } as any)).toBe(true);
  });

  it("forces a full repaint after renderer reset even for the same frame", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: false,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      synchronizedOutput: false,
    });

    renderer.render(["alpha"], { cursor: { row: 1, col: 1 } });
    renderer.reset();
    chunks.length = 0;
    const stats = renderer.render(["alpha"], { cursor: { row: 1, col: 1 } });

    expect(stats).toMatchObject({ changedRows: 1, fullRepaint: true });
    expect(chunks.join("")).toContain("\x1b[1;1Halpha");
  });

  it("clamps invalid frame cursor and column values before writing CSI sequences", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: false,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      synchronizedOutput: false,
    });

    renderer.render(["alpha"], { cursor: { row: Number.POSITIVE_INFINITY, col: Number.NaN }, cols: Number.NaN });

    const output = chunks.join("");
    expect(output).toContain("\x1b[1;1H");
    expect(output).not.toContain("NaN");
    expect(output).not.toContain("Infinity");
  });
});

describe("TuiLayout", () => {
  it("places the footer directly after short transcript content", () => {
    const transcript = new Transcript();
    transcript.append("hello");
    const layout = new TuiLayout(transcript);

    expect(layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input: "" }, 20, 80)).toBe(1);
  });

  it("keeps cursor on screen for wrapped input", () => {
    const layout = new TuiLayout(new Transcript());
    const inputAreaBottomRow = 5;
    const cursor = layout.cursorPosition("● ", "12345678901234567890", 20, 10, inputAreaBottomRow);

    expect(cursor.row).toBeGreaterThanOrEqual(1);
    expect(cursor.row).toBeLessThanOrEqual(inputAreaBottomRow);
    expect(cursor.col).toBeGreaterThanOrEqual(1);
    expect(cursor.col).toBeLessThanOrEqual(10);
  });

  it("keeps the cursor column inside narrow terminal bounds when wrapping exactly at the edge", () => {
    const layout = new TuiLayout(new Transcript());
    const cursor = layout.cursorPosition("● ", "12345678", 8, 5, 4);

    expect(cursor.row).toBeGreaterThanOrEqual(1);
    expect(cursor.row).toBeLessThanOrEqual(4);
    expect(cursor.col).toBeGreaterThanOrEqual(1);
    expect(cursor.col).toBeLessThanOrEqual(5);
  });

  it("normalizes CRLF input and non-integer cursors before computing cursor position", () => {
    const transcript = new Transcript();
    const layout = new TuiLayout(transcript);

    expect(layout.cursorPosition("● ", "a\r\nb", 3, 6, 2)).toEqual({ row: 2, col: 3 });
    expect(layout.cursorPosition("● ", "abc", Number.NaN, 6, 1)).toEqual({ row: 1, col: 6 });
    expect(layout.cursorPosition("● ", "a🙂b", 2.9, 6, 1)).toEqual({ row: 1, col: 4 });
    expect(layout.cursorPosition("● ", "a🙂b", 3.9, 6, 1)).toEqual({ row: 1, col: 6 });
  });

  it("treats non-finite completion limits as zero", () => {
    const transcript = new Transcript();
    const layout = new TuiLayout(transcript);

    expect(layout.visibleTranscriptRows({
      footer: "─\nstatus",
      prompt: "● ",
      input: "",
      completions: ["one", "two"],
      completionLimit: Number.POSITIVE_INFINITY,
    }, 10, 20)).toBe(0);
  });

  it("returns zero visible transcript rows when footer, status, completions, and input consume the viewport", () => {
    const transcript = new Transcript();
    transcript.append("hello");
    const layout = new TuiLayout(transcript);

    expect(layout.visibleTranscriptRows({
      footer: "─\nstatus",
      prompt: "● ",
      input: "line1\nline2\nline3",
      statusLine: "thinking",
      completions: ["a", "b", "c"],
      completionLimit: 3,
    }, 6, 20)).toBe(0);
  });

  it("places cursor on the last visible row for multiline input", () => {
    const layout = new TuiLayout(new Transcript());
    const cursor = layout.cursorPosition("● ", "alpha\nbeta", "alpha\nbeta".length, 20, 5);

    expect(cursor.row).toBe(5);
    expect(cursor.col).toBe(7);
  });

  it("bounds pathological input and prompt widths when computing cursor layout", () => {
    const layout = new TuiLayout(new Transcript());
    const cursor = layout.cursorPosition(">".repeat(2_000), "a".repeat(50_000), 50_000, Number.NaN, 5);

    expect(cursor.row).toBeGreaterThanOrEqual(1);
    expect(cursor.row).toBeLessThanOrEqual(5);
    expect(cursor.col).toBeGreaterThanOrEqual(1);
    expect(cursor.col).toBeLessThanOrEqual(1);
  });

  it("keeps long input windows on grapheme boundaries for complex emoji", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    const family = "👨‍👩‍👧‍👦";
    const input = `${"a".repeat(4050)}${family}tail`;
    process.stdout.columns = 16;
    process.stdout.rows = 8;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const layout = new TuiLayout(new Transcript(), "inline");
      layout.render({ footer: "─\nstatus", prompt: "● ", input, cursor: 4052 });
      const output = stripAnsi(chunks.join(""));

      expect(output).toContain(family);
      expect(hasUnpairedSurrogate(output)).toBe(false);
      const cursor = layout.cursorPosition("● ", input, 4052, 16, 5);
      expect(cursor.row).toBeGreaterThanOrEqual(1);
      expect(cursor.row).toBeLessThanOrEqual(5);
      expect(cursor.col).toBeGreaterThanOrEqual(1);
      expect(cursor.col).toBeLessThanOrEqual(16);
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("keeps the cursor on the correct visible row when editing earlier multiline input", () => {
    const layout = new TuiLayout(new Transcript());
    const input = "one\ntwo\nthree\nfour";
    const cursorIndex = input.indexOf("two") + "two".length;
    const cursor = layout.cursorPosition("● ", input, cursorIndex, 20, 5);

    expect(cursor.row).toBe(4);
    expect(cursor.col).toBe(6);
    expect(layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input, cursor: cursorIndex }, 8, 20)).toBe(0);
  });

  it("honors explicit completion limits for pickers", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
    const layout = new TuiLayout(transcript);
    const completions = Array.from({ length: 12 }, (_, index) => `item ${index}`);

    expect(layout.visibleTranscriptRows({
      footer: "─\nstatus",
      prompt: "● ",
      input: "",
      completions,
      completionLimit: completions.length,
    }, 24, 80)).toBe(9);
  });

  it("reserves a fixed status row above the input", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
    const layout = new TuiLayout(transcript);
    const withoutStatus = layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input: "" }, 12, 80);
    const withStatus = layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input: "", statusLine: thinkingStatusLine(1250, true) }, 12, 80);

    expect(withStatus).toBe(withoutStatus - 1);
  });

  it("renders the fixed status row directly above the input row", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 40;
    process.stdout.rows = 10;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      transcript.append("hello");
      const layout = new TuiLayout(transcript, "inline");
      layout.render({ footer: "─\nfooter", prompt: "● ", input: "/tasks", statusLine: thinkingStatusLine(1250, true) });
      const output = stripAnsi(chunks.join(""));

      expect(output.indexOf("Thinking 1s · esc to interrupt")).toBeLessThan(output.indexOf("● /tasks"));
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("renders fullscreen through a frame diff instead of repainting unchanged rows", () => {
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 24;
    process.stdout.rows = 8;
    try {
      const transcript = new Transcript();
      transcript.append("hello");
      const renderer = new FrameRenderer({
        stdout: {
          isTTY: false,
          write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
        } as any,
        synchronizedOutput: false,
      });
      const layout = new TuiLayout(transcript, "fullscreen", renderer);

      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      expect(renderer.lastStats?.changedRows).toBe(8);
      expect(chunks.join("")).toContain("hello");

      chunks.length = 0;
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      expect(renderer.lastStats?.changedRows).toBe(0);
      expect(chunks.join("")).not.toContain("hello");

      transcript.appendDelta(" world");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      expect(renderer.lastStats?.changedRows).toBeGreaterThan(0);
      expect(chunks.join("")).toContain("hello world");
    } finally {
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("recomputes transcript height when the terminal grows", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"));
    const layout = new TuiLayout(transcript);
    const narrow = layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input: "" }, 12, 80);
    const tall = layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input: "" }, 30, 80);

    expect(tall).toBeGreaterThan(narrow);
  });

  it("can expose wrapped transcript rows for inline scrollback", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    expect(transcript.wrappedRows(3).map(stripAnsi)).toEqual(["abc", "def"]);
  });

  it("can map transcript line indexes to wrapped row offsets", () => {
    const transcript = new Transcript();
    transcript.append("abcdef\nxy");

    expect(transcript.wrappedRowOffsetForLine(0, 3)).toBe(0);
    expect(transcript.wrappedRowOffsetForLine(1, 3)).toBe(2);
    expect(transcript.wrappedRowOffsetForLine(2, 3)).toBe(3);
  });

  it("moves inline cursor below the rendered TUI on finish", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 40;
    process.stdout.rows = 10;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      transcript.append("hello");
      const layout = new TuiLayout(transcript, "inline");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      layout.finish();

      expect(chunks.join("")).toContain("\r\n");
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("updates inline renders without clearing the whole dynamic region", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 40;
    process.stdout.rows = 10;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      const layout = new TuiLayout(transcript, "inline");
      transcript.append("hello");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      chunks.length = 0;
      transcript.appendDelta(" world");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });

      const output = chunks.join("");
      expect(output).not.toContain("\x1b[J");
      expect(output).toContain("\x1b[2K");
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("does not commit mutable streamed markdown rows to inline scrollback", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    const committedRows = () => chunks
      .filter(chunk => chunk.startsWith("\r\x1b[2K") && chunk.endsWith("\n"))
      .map(chunk => stripAnsi(chunk).replace(/[\r\n]/g, ""));

    process.stdout.columns = 24;
    process.stdout.rows = 6;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
      const layout = new TuiLayout(transcript, "inline");
      const render = () => layout.render({
        footer: "─\nstatus",
        prompt: "> ",
        input: "",
        mutableTranscriptStartLine: view.mutableTranscriptStartLine,
      });

      view.beginTurn();
      view.handleRuntimeEvent({
        type: "content_delta",
        data: {
          text: [
            "方案对比一览",
            "| 方案 | 核心思路 | 是否需 retrain | 是否需 external verifier | 新颖度 | 风险 |",
            "|---|---|---|---|---|---|",
            "| A: Lookahead Branch | divergence 点做 3-5 token 前瞻+语法筛选 | ❌",
          ].join("\n"),
        },
      } as any);
      render();
      view.handleRuntimeEvent({
        type: "content_delta",
        data: { text: " | ❌ | 中 | 语法筛选可能误杀，需要保守回退；".repeat(4) },
      } as any);
      render();

      expect(view.mutableTranscriptStartLine).not.toBeNull();
      const beforeFinish = committedRows().join("\n");
      expect(committedRows().length).toBeGreaterThan(0);
      expect(beforeFinish).toContain("方案对比");
      expect(beforeFinish).not.toContain("Lookahead Branch");

      chunks.length = 0;
      view.finishTurn();
      render();

      expect(committedRows().join("\n")).toContain("Lookahead Branch");
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("clears stale inline rows when completions shrink", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 40;
    process.stdout.rows = 12;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      transcript.append("hello");
      const layout = new TuiLayout(transcript, "inline");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "/l", completions: ["  /load", "  /list", "  /logs"], completionLimit: 3 });
      chunks.length = 0;
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "", completions: [], completionLimit: 0 });

      const output = chunks.join("");
      expect(output).not.toContain("\x1b[J");
      expect(output.match(/\x1b\[2K/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("repaints inline layout from the previous top after resize", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 40;
    process.stdout.rows = 12;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      transcript.append("hello");
      const layout = new TuiLayout(transcript, "inline");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      chunks.length = 0;
      process.stdout.columns = 24;
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });

      const output = chunks.join("");
      expect(output).toContain("\x1b[2A");
      expect(output).not.toContain("\x1b[J");
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });
});

describe("ActiveToolLines", () => {
  it("tracks active tool lines by tool call id", () => {
    const lines = new ActiveToolLines();
    lines.start("call-1", 3);
    lines.start("call-2", 7);
    lines.start("call-3", 9);

    expect(lines.current("call-2")).toBe(7);
    expect(lines.earliestLine()).toBe(3);
    expect(lines.finish("call-1")).toBe(3);
    expect(lines.finish("call-1")).toBeUndefined();
    expect(lines.earliestLine()).toBe(7);
    expect(lines.finish("call-3")).toBe(9);
  });
});

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function tempPromptHistoryPath(): string {
  return join(mkdtempSync(join(tmpdir(), "seekcode-prompt-history-")), "prompt-history.txt");
}

async function waitForPromptHistory(path: string, predicate: (entries: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + 2_000;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = await loadPromptHistory(path);
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`prompt history was not persisted in time: ${JSON.stringify(last)}`);
}
