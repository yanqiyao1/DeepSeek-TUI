/** Raw-mode input with Tab completion. No cursor tricks — just clear and redraw. */

import { p } from "./palette.js";
import { stripAnsi, truncateAnsi, visibleLength } from "./ansi.js";
import { discoverClaudeCommands } from "../commands/compat.js";

export const COMMANDS: [string, string][] = [
  ["help", "Show help"], ["plan", "Plan mode"], ["agent", "Agent mode"],
  ["yolo", "YOLO mode"], ["provider", "Switch provider"], ["model", "Switch model"], ["reasoning", "Cycle effort"],
  ["capabilities", "Model capability matrix"], ["jobs", "Background jobs"],
  ["clear", "Clear history"], ["save", "Save session"], ["load", "Load session"],
  ["delete", "Delete session"], ["sessions", "List sessions"], ["exit", "Save & exit"], ["restore", "Snapshots"],
  ["cost", "Cost breakdown"], ["tokens", "Token usage"], ["tasks", "Tasks"],
  ["skills", "Skills"], ["skill", "Apply/manage skill"], ["permissions", "Permissions"], ["version", "Version"],
];

export type InputResult = { type: "line"; value: string } | { type: "interrupt" } | { type: "eof" };
export type InputControllerMode = "idle" | "running" | "picker" | "approval" | "modal";

const SHIFT_TAB_SEQUENCES = new Set(["\x1b[Z", "\x1b[1;2Z"]);
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
export const PASTE_BURST_NEWLINE_WINDOW_MS = 80;
export const MAX_INPUT_CHARS = 1_000_000;
const CONTROL_INPUT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CONTROL_PROMPT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;
const ANSI_SEQUENCE_RE = /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?\x1b\\|\x1b[@-_])/g;
const SAFE_SGR_RE = /^\x1b\[[0-9;]*m$/;
const INSERT_NEWLINE_SEQUENCES = new Set([
  "\x1b\r",
  "\x1b\n",
  "\x1b[13;2u",
  "\x1b[13;3u",
  "\x1b[13;4u",
  "\x1b[13;5u",
  "\x1b[106;5u",
]);
const MAX_COMPLETION_ITEMS = 80;
const MAX_COMPLETION_SCAN_ITEMS = 320;
const MAX_COMPLETION_DESC_CHARS = 160;
const MAX_COMPLETION_PREFIX_CHARS = 256;
const MAX_COMPLETION_VALUE_CHARS = 512;
const MAX_COMPLETION_DISPLAY_WIDTH = 240;
const MAX_INPUT_PROMPT_WIDTH = 120;
const DEFAULT_COMPLETION_LIMIT = 9;

export function isShiftTabSequence(sequence: string): boolean {
  return SHIFT_TAB_SEQUENCES.has(sequence);
}

export function enableBracketedPaste(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  stdout.write("\x1b[?2004h");
}

export function disableBracketedPaste(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  stdout.write("\x1b[?2004l");
}

function slashCompletionContext(value: string): { leading: string; partial: string } | null {
  const match = /^([ \t]*)\/([^\s]*)$/.exec(value);
  if (!match) return null;
  return { leading: match[1] ?? "", partial: (match[2] ?? "").toLowerCase() };
}

function matches(prefix: string, workspacePath?: string): { leading: string; items: [string, string][] } {
  if (prefix.length > MAX_COMPLETION_PREFIX_CHARS) return { leading: "", items: [] };
  const context = slashCompletionContext(prefix);
  if (!context) return { leading: "", items: [] };
  const commands = [
    ...COMMANDS,
    ...discoverClaudeCommands(workspacePath).map(command => [
      command.name,
      `${truncateCompletionText(command.description, MAX_COMPLETION_DESC_CHARS)} (${command.scope} .claude/commands)`,
    ] as [string, string]),
  ];
  const items = context.partial
    ? commands.filter(([n]) => n.startsWith(context.partial))
    : commands;
  return { leading: context.leading, items: items.slice(0, MAX_COMPLETION_ITEMS) };
}

function commonPrefix(strings: string[]): string {
  if (!strings.length) return "";
  let pre = strings[0] ?? "";
  for (const s of strings.slice(1)) { while (pre && !s.startsWith(pre)) pre = pre.slice(0, -1); }
  return pre;
}

function truncateCompletionText(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

export interface InputCompletionItem {
  value: string;
  description?: string;
  display?: string;
  replacement?: string;
  completeText?: string;
}

export type InputCompletionProvider = (value: string) => InputCompletionItem[];

export interface InputControllerState {
  mode: InputControllerMode;
  prompt: string;
  value: string;
  cursor: number;
  completions: string[];
  inBracketedPaste: boolean;
}

export interface InputRenderMeta {
  immediate: boolean;
  reason: "reset" | "edit" | "submit" | "mode" | "scroll" | "paste" | "completion";
}

export interface InputControllerOptions {
  mode?: InputControllerMode;
  prompt?: string;
  completionProvider?: InputCompletionProvider;
  completionLimit?: number;
  clearOnSubmit?: boolean;
  editable?: boolean;
  now?: () => number;
  onRender?: (state: InputControllerState, meta: InputRenderMeta) => void;
  onSubmit?: (value: string) => boolean | void;
  onInterrupt?: () => boolean | void;
  onCtrlC?: () => boolean | void;
  onEof?: () => boolean | void;
  onModeCycle?: () => string | void;
  onScroll?: (direction: ScrollDirection, amount: number) => void;
  onUnhandledSequence?: (sequence: string, context: InputKeyContext) => boolean | void;
}

export interface InputAttachOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  resizeTarget?: NodeJS.WriteStream;
  rawMode?: boolean;
  bracketedPaste?: boolean;
  pauseOnStop?: boolean;
  onResize?: () => void;
}

export interface InputKeyContext {
  index: number;
  sequenceCount: number;
  now: number;
  pasteLikeBurst: boolean;
}

export function commandCompletionProvider(value: string, workspacePath?: string): InputCompletionItem[] {
  const matched = matches(value, workspacePath);
  return matched.items.map(([name, desc]) => {
    const partial = matched.leading.length <= value.length ? value.slice(matched.leading.length + 1).toLowerCase() : "";
    const completed = `${matched.leading}/${name}`;
    const highlighted = partial
      ? p.blue(name.slice(0, partial.length)) + p.text(name.slice(partial.length))
      : p.text(name);
    return {
      value: name,
      description: desc,
      display: `  /${highlighted}  ${p.dim(desc)}`,
      replacement: `${completed} `,
      completeText: completed,
    };
  });
}

export interface ReadInputOptions {
  onInterrupt?: () => void;
  onModeCycle?: () => string | void;
  onScroll?: (direction: "up" | "down" | "top" | "bottom", amount: number) => void;
  onRender?: (state: { prompt: string; value: string; cursor: number; completions: string[] }) => void;
  completionProvider?: InputCompletionProvider;
}

export type ScrollDirection = "up" | "down" | "top" | "bottom";

export function previousGraphemeIndex(text: string, index: number): number {
  const before = Array.from(text.slice(0, Math.max(0, index)));
  before.pop();
  return before.join("").length;
}

export function nextGraphemeIndex(text: string, index: number): number {
  const next = Array.from(text.slice(Math.max(0, index)))[0];
  return next ? index + next.length : index;
}

export function previousWordIndex(text: string, index: number): number {
  const chars = Array.from(text.slice(0, Math.max(0, index)));
  while (chars.length && /\s/u.test(chars[chars.length - 1] ?? "")) chars.pop();
  while (chars.length && !/\s/u.test(chars[chars.length - 1] ?? "")) chars.pop();
  return chars.join("").length;
}

export function nextWordIndex(text: string, index: number): number {
  const prefix = text.slice(0, Math.max(0, index));
  const chars = Array.from(text.slice(Math.max(0, index)));
  let offset = 0;
  while (offset < chars.length && /\s/u.test(chars[offset] ?? "")) offset++;
  while (offset < chars.length && !/\s/u.test(chars[offset] ?? "")) offset++;
  return prefix.length + chars.slice(0, offset).join("").length;
}

export function currentLineStartIndex(text: string, index: number): number {
  const safeIndex = Math.max(0, Math.min(index, text.length));
  const newline = text.lastIndexOf("\n", Math.max(0, safeIndex - 1));
  return newline < 0 ? 0 : newline + 1;
}

export function currentLineEndIndex(text: string, index: number): number {
  const safeIndex = Math.max(0, Math.min(index, text.length));
  const newline = text.indexOf("\n", safeIndex);
  return newline < 0 ? text.length : newline;
}

export function restoreTTYInput(
  stdin: Pick<NodeJS.ReadStream, "setRawMode" | "pause">,
  wasRaw: boolean | undefined,
  pauseInput = true,
): void {
  stdin.setRawMode?.(!!wasRaw);
  if (pauseInput) stdin.pause();
}

export function scrollActionForSequence(sequence: string): { direction: ScrollDirection; amount: number } | null {
  if (/^\x1b\[5(?:;\d+)?~$/.test(sequence)) return { direction: "up", amount: 8 };
  if (/^\x1b\[6(?:;\d+)?~$/.test(sequence)) return { direction: "down", amount: 8 };
  if (sequence === "\x1b[1;5H" || sequence === "\x1b[5;5~") return { direction: "top", amount: Number.POSITIVE_INFINITY };
  if (sequence === "\x1b[1;5F" || sequence === "\x1b[6;5~") return { direction: "bottom", amount: Number.POSITIVE_INFINITY };
  if (/^\x1b\[1;[25]A$/.test(sequence)) return { direction: "up", amount: 3 };
  if (/^\x1b\[1;[25]B$/.test(sequence)) return { direction: "down", amount: 3 };
  if (/^\x1b\[<64;\d+;\d+[mM]$/.test(sequence)) return { direction: "up", amount: 3 };
  if (/^\x1b\[<65;\d+;\d+[mM]$/.test(sequence)) return { direction: "down", amount: 3 };
  return null;
}

export function splitInputSequences(chunk: string): string[] {
  const sequences: string[] = [];
  if (!chunk) return sequences;
  const safeChunk = safeSliceInputText(chunk, MAX_INPUT_CHARS * 2);
  for (let index = 0; index < safeChunk.length;) {
    if (safeChunk[index] !== "\x1b") {
      const nextEscape = safeChunk.indexOf("\x1b", index);
      const end = nextEscape === -1 ? safeChunk.length : nextEscape;
      for (const char of Array.from(safeChunk.slice(index, end))) sequences.push(char);
      index = end;
      continue;
    }

    if (safeChunk.startsWith("\x1b[<", index)) {
      const match = /^\x1b\[<\d+;\d+;\d+[mM]/.exec(safeChunk.slice(index));
      if (match) {
        sequences.push(match[0]);
        index += match[0].length;
        continue;
      }
    }

    const csiMatch = /^\x1b\[[0-9;?]*[~A-Za-z]/.exec(safeChunk.slice(index));
    if (csiMatch) {
      sequences.push(csiMatch[0]);
      index += csiMatch[0].length;
      continue;
    }

    const csiUMatch = /^\x1b\[[0-9;]*u/.exec(safeChunk.slice(index));
    if (csiUMatch) {
      sequences.push(csiUMatch[0]);
      index += csiUMatch[0].length;
      continue;
    }

    const ss3Match = /^\x1bO[A-Za-z]/.exec(safeChunk.slice(index));
    if (ss3Match) {
      sequences.push(ss3Match[0]);
      index += ss3Match[0].length;
      continue;
    }

    if (index + 1 < safeChunk.length) {
      sequences.push(safeChunk.slice(index, index + 2));
      index += 2;
      continue;
    }

    sequences.push("\x1b");
    index += 1;
  }
  return sequences;
}

export function isPlainTextInputSequence(sequence: string): boolean {
  const chars = Array.from(sequence);
  return chars.length > 0 && chars.every(char => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 0x7f && char !== "\x1b";
  });
}

export function coalesceInputSequences(sequences: string[], options: { inBracketedPaste?: boolean } = {}): string[] {
  const coalesced: string[] = [];
  const pending: string[] = [];
  let inBracketedPaste = !!options.inBracketedPaste;

  const flushPending = () => {
    if (!pending.length) return;
    coalesced.push(pending.join(""));
    pending.length = 0;
  };

  for (const sequence of sequences) {
    if (isBracketedPasteStart(sequence)) {
      flushPending();
      coalesced.push(sequence);
      inBracketedPaste = true;
      continue;
    }

    if (isBracketedPasteEnd(sequence)) {
      flushPending();
      coalesced.push(sequence);
      inBracketedPaste = false;
      continue;
    }

    if (inBracketedPaste || isPlainTextInputSequence(sequence)) {
      pending.push(sequence);
      continue;
    }

    flushPending();
    coalesced.push(sequence);
  }

  flushPending();
  return coalesced;
}

export function trailingIncompleteEscapeStart(chunk: string): number {
  if (chunk.length > 4096) {
    const tailStart = Math.max(0, chunk.length - 4096);
    const tailResult = trailingIncompleteEscapeStart(chunk.slice(tailStart));
    return tailResult < 0 ? -1 : tailStart + tailResult;
  }
  const lastEscape = chunk.lastIndexOf("\x1b");
  if (lastEscape < 0) return -1;
  const tail = chunk.slice(lastEscape);
  if (tail === "\x1b") return lastEscape;
  if (tail === "\x1b[") return lastEscape;
  if (tail === "\x1b[<") return lastEscape;
  if (/^\x1b\[(?:<)?[0-9;?]+$/.test(tail)) return lastEscape;
  if (/^\x1b\[[0-9;]*$/.test(tail)) return lastEscape;
  if (tail === "\x1bO") return lastEscape;
  return -1;
}

export function isBracketedPasteStart(sequence: string): boolean {
  return sequence === BRACKETED_PASTE_START;
}

export function isBracketedPasteEnd(sequence: string): boolean {
  return sequence === BRACKETED_PASTE_END;
}

export function shouldTreatNewlineAsPaste(
  _newlineIndex: number,
  sequenceCount: number,
  now: number,
  pasteWindowUntil: number,
  pasteLikeBurst = sequenceCount >= 3,
): boolean {
  return pasteLikeBurst || (pasteWindowUntil > 0 && now <= pasteWindowUntil);
}

export function looksLikePasteTextBurst(text: string): boolean {
  const normalized = sanitizeInputText(text);
  if (!normalized) return false;
  const chars = Array.from(normalized);
  if (chars.length >= 16) return true;
  if (chars.length >= 4 && chars.some(char => /\s/u.test(char))) return true;
  return chars.length >= 2 && chars.some(char => !isAscii(char));
}

export function sanitizeInputText(text: string): string {
  return stripAnsi(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")).replace(CONTROL_INPUT_RE, "");
}

export class InputController {
  private mode: InputControllerMode;
  private prompt: string;
  private value = "";
  private cursor = 0;
  private completions: string[] = [];
  private pendingEscape = "";
  private pendingEscapeTimer: NodeJS.Timeout | null = null;
  private inBracketedPaste = false;
  private pasteWindowUntil = 0;
  private suppressRender = false;
  private needsRender = false;
  private pendingImmediateRender = false;

  constructor(private readonly options: InputControllerOptions = {}) {
    this.mode = options.mode ?? "idle";
    this.prompt = sanitizePromptText(options.prompt ?? "");
    this.refreshCompletions();
  }

  getState(): InputControllerState {
    return {
      mode: this.mode,
      prompt: this.prompt,
      value: this.value,
      cursor: this.cursor,
      completions: [...this.completions],
      inBracketedPaste: this.inBracketedPaste,
    };
  }

  setMode(mode: InputControllerMode, render = true): void {
    this.mode = mode;
    if (render) this.requestRender(true, "mode");
  }

  setPrompt(prompt: string, render = true): void {
    this.prompt = sanitizePromptText(prompt);
    if (render) this.requestRender(true, "mode");
  }

  reset(options: { value?: string; cursor?: number; render?: boolean } = {}): void {
    this.value = safeInputValue(options.value ?? "");
    this.cursor = safeCursorIndex(this.value, options.cursor ?? this.value.length);
    this.inBracketedPaste = false;
    this.pasteWindowUntil = 0;
    this.pendingEscape = "";
    this.refreshCompletions();
    if (options.render !== false) this.requestRender(true, "reset");
  }

  render(immediate = true): void {
    this.requestRender(immediate, "edit");
  }

  dispose(): void {
    if (this.pendingEscapeTimer) {
      clearTimeout(this.pendingEscapeTimer);
      this.pendingEscapeTimer = null;
    }
    this.pendingEscape = "";
    this.inBracketedPaste = false;
    this.pasteWindowUntil = 0;
  }

  attach(options: InputAttachOptions = {}): () => void {
    const stdin = options.stdin ?? process.stdin;
    const stdout = options.stdout ?? process.stdout;
    const resizeTarget = options.resizeTarget ?? process.stdout;
    const rawMode = options.rawMode !== false;
    const bracketedPaste = options.bracketedPaste !== false;
    const pauseOnStop = options.pauseOnStop !== false;
    const wasRaw = stdin.isRaw;
    let detached = false;

	    const onData = (data: Buffer) => this.handleData(data);
	    const onEnd = () => {
	      if (this.pendingEscape) {
	        const pending = this.pendingEscape;
	        this.pendingEscape = "";
	        if (this.pendingEscapeTimer) {
	          clearTimeout(this.pendingEscapeTimer);
	          this.pendingEscapeTimer = null;
	        }
	        this.handleSequences(splitInputSequences(pending));
	      }
	      this.options.onEof?.();
	    };
	    const onResize = () => options.onResize?.();

    if (bracketedPaste) enableBracketedPaste(stdout);
    if (rawMode) stdin.setRawMode?.(true);
	    stdin.resume();
	    stdin.on("data", onData);
	    stdin.on("end", onEnd);
	    if (options.onResize) resizeTarget.on?.("resize", onResize);

    return () => {
      if (detached) return;
	      detached = true;
	      stdin.removeListener("data", onData);
	      stdin.removeListener("end", onEnd);
	      if (options.onResize) resizeTarget.removeListener?.("resize", onResize);
      if (bracketedPaste) disableBracketedPaste(stdout);
      this.dispose();
      if (rawMode) restoreTTYInput(stdin, wasRaw, pauseOnStop);
      else if (pauseOnStop) stdin.pause();
    };
  }

  handleData(data: Buffer | string): void {
    if (this.pendingEscapeTimer) {
      clearTimeout(this.pendingEscapeTimer);
      this.pendingEscapeTimer = null;
    }
    const value = safeSliceInputText(this.pendingEscape + data.toString(), MAX_INPUT_CHARS * 2);
    this.pendingEscape = "";
    const incompleteEscapeStart = trailingIncompleteEscapeStart(value);
    if (incompleteEscapeStart >= 0) {
      const complete = value.slice(0, incompleteEscapeStart);
      this.pendingEscape = value.slice(incompleteEscapeStart);
      this.handleSequences(splitInputSequences(complete));
      this.pendingEscapeTimer = setTimeout(() => {
        const pending = this.pendingEscape;
        this.pendingEscape = "";
        this.pendingEscapeTimer = null;
        this.handleSequences(splitInputSequences(pending));
      }, 25);
      return;
    }
    this.handleSequences(splitInputSequences(value));
  }

  handleSequences(sequences: string[]): void {
    const now = this.options.now?.() ?? Date.now();
    const sequenceCount = sequences.length;
    const coalesced = coalesceInputSequences(sequences, { inBracketedPaste: this.inBracketedPaste });
    const pasteLikeBurst = this.inBracketedPaste || coalesced.some(sequence => isPotentialTextPayload(sequence) && looksLikePasteTextBurst(sequence));
    const shouldBatchRender = sequenceCount >= 3 || coalesced.length < sequenceCount || this.inBracketedPaste;
    const previousSuppressRender = this.suppressRender;
    if (shouldBatchRender) this.suppressRender = true;
    try {
      for (let index = 0; index < coalesced.length; index++) {
        const shouldStop = this.handleSequence(coalesced[index]!, { index, sequenceCount, now, pasteLikeBurst });
        if (shouldStop) break;
      }
    } finally {
      this.suppressRender = previousSuppressRender;
      if (!this.suppressRender && this.needsRender) {
        const immediate = this.pendingImmediateRender;
        this.needsRender = false;
        this.pendingImmediateRender = false;
        this.requestRender(immediate, "edit");
      }
    }
  }

  private handleSequence(sequence: string, context: InputKeyContext): boolean {
    const now = context.now;

    if (isBracketedPasteStart(sequence)) {
      this.inBracketedPaste = true;
      this.pasteWindowUntil = now + PASTE_BURST_NEWLINE_WINDOW_MS;
      return false;
    }

    if (isBracketedPasteEnd(sequence)) {
      this.inBracketedPaste = false;
      this.pasteWindowUntil = now + PASTE_BURST_NEWLINE_WINDOW_MS;
      this.requestRender(true, "paste");
      return false;
    }

    if (!this.isEditable()) {
      if (sequence === "\x1b" && !this.inBracketedPaste) {
        if (this.unhandled(sequence, context)) return true;
        return this.options.onInterrupt?.() === true;
      }
      if (sequence === "\x03" && !this.inBracketedPaste) {
        const handler = this.options.onCtrlC ?? this.options.onInterrupt;
        return handler?.() !== false;
      }
      return this.unhandled(sequence, context);
    }

    if (isShiftTabSequence(sequence)) {
      if (this.inBracketedPaste) {
        this.insertText(sequence, true);
        this.markPasteWindow(now);
        return false;
      }
      this.clearPasteWindow();
      const nextPrompt = this.options.onModeCycle?.();
      if (typeof nextPrompt === "string") this.prompt = sanitizePromptText(nextPrompt);
      this.requestRender(true, "mode");
      return false;
    }

    const scrollAction = scrollActionForSequence(sequence);
    if (scrollAction && !this.inBracketedPaste) {
      this.clearPasteWindow();
      this.options.onScroll?.(scrollAction.direction, scrollAction.amount);
      this.requestRender(true, "scroll");
      return false;
    }

    if (isInsertNewlineSequence(sequence) && !this.inBracketedPaste) {
      this.clearPasteWindow();
      this.insertText("\n", true);
      return false;
    }

    if (sequence.startsWith("\x1b") && sequence.length > 1 && !this.inBracketedPaste) {
      if (sequence === "\x1b[A" || sequence === "\x1bOA") return this.unhandled(sequence, context);
      if (sequence === "\x1b[B" || sequence === "\x1bOB") return this.unhandled(sequence, context);
      if (sequence === "\x1b[1;5D" || sequence === "\x1b[5D" || sequence === "\x1b[1;3D" || sequence === "\x1b[3D" || sequence === "\x1bb") {
        this.clearPasteWindow();
        this.cursor = previousWordIndex(this.value, this.cursor);
        this.requestRender(true, "edit");
        return false;
      }
      if (sequence === "\x1b[1;5C" || sequence === "\x1b[5C" || sequence === "\x1b[1;3C" || sequence === "\x1b[3C" || sequence === "\x1bf") {
        this.clearPasteWindow();
        this.cursor = nextWordIndex(this.value, this.cursor);
        this.requestRender(true, "edit");
        return false;
      }
      if (sequence === "\x1b[D" || sequence === "\x1bOD") {
        this.clearPasteWindow();
        if (this.cursor > 0) this.cursor = previousGraphemeIndex(this.value, this.cursor);
        this.requestRender(true, "edit");
        return false;
      }
      if (sequence === "\x1b[C" || sequence === "\x1bOC") {
        this.clearPasteWindow();
        if (this.cursor < this.value.length) this.cursor = nextGraphemeIndex(this.value, this.cursor);
        this.requestRender(true, "edit");
        return false;
      }
      if (isDeleteSequence(sequence)) {
        this.clearPasteWindow();
        this.deleteNextGrapheme();
        return false;
      }
      if (isHomeSequence(sequence)) {
        this.clearPasteWindow();
        this.cursor = currentLineStartIndex(this.value, this.cursor);
        this.requestRender(true, "edit");
        return false;
      }
      if (isEndSequence(sequence)) {
        this.clearPasteWindow();
        this.cursor = currentLineEndIndex(this.value, this.cursor);
        this.requestRender(true, "edit");
        return false;
      }
      return this.unhandled(sequence, context);
    }

    if (sequence === "\x1b" && !this.inBracketedPaste) {
      this.clearPasteWindow();
      return this.options.onInterrupt?.() === true;
    }

    if (sequence === "\t" && !this.inBracketedPaste) {
      this.clearPasteWindow();
      this.applyCompletion();
      return false;
    }

    if (sequence === "\r" || sequence === "\n") {
      if (this.inBracketedPaste || shouldTreatNewlineAsPaste(context.index, context.sequenceCount, now, this.pasteWindowUntil, context.pasteLikeBurst)) {
        this.insertText("\n", true);
        this.markPasteWindow(now);
        return false;
      }
      if (this.consumeTrailingBackslashForNewline()) return false;
      this.clearPasteWindow();
      const submitted = this.value;
      const shouldStop = this.options.onSubmit?.(submitted) !== false;
      if (this.options.clearOnSubmit) {
        this.value = "";
        this.cursor = 0;
        this.refreshCompletions();
        this.requestRender(true, "submit");
      }
      return shouldStop;
    }

    if (sequence === "\x04" && !this.value && !this.inBracketedPaste) {
      this.clearPasteWindow();
      return this.options.onEof?.() !== false;
    }

    if (sequence === "\x03" && !this.inBracketedPaste) {
      this.clearPasteWindow();
      const handler = this.options.onCtrlC ?? this.options.onInterrupt ?? this.options.onEof;
      return handler?.() !== false;
    }

    if ((sequence === "\x7f" || sequence === "\x08") && !this.inBracketedPaste) {
      this.clearPasteWindow();
      if (this.cursor > 0) {
        const previous = previousGraphemeIndex(this.value, this.cursor);
        this.value = this.value.slice(0, previous) + this.value.slice(this.cursor);
        this.cursor = previous;
        this.requestRender(true, "edit");
      }
      return false;
    }

    if (isDeleteSequence(sequence) && !this.inBracketedPaste) {
      this.clearPasteWindow();
      this.deleteNextGrapheme();
      return false;
    }

    if (sequence === "\x15" && !this.inBracketedPaste) {
      this.clearPasteWindow();
      const start = currentLineStartIndex(this.value, this.cursor);
      if (this.cursor > start) {
        this.value = this.value.slice(0, start) + this.value.slice(this.cursor);
        this.cursor = start;
        this.requestRender(true, "edit");
      }
      return false;
    }

    if (sequence === "\x0b" && !this.inBracketedPaste) {
      this.clearPasteWindow();
      const end = currentLineEndIndex(this.value, this.cursor);
      const deleteEnd = end > this.cursor ? end : this.value[end] === "\n" ? end + 1 : end;
      if (deleteEnd > this.cursor) {
        this.value = this.value.slice(0, this.cursor) + this.value.slice(deleteEnd);
        this.requestRender(true, "edit");
      }
      return false;
    }

    if (sequence === "\x17" && !this.inBracketedPaste) {
      this.clearPasteWindow();
      if (this.cursor > 0) {
        const previous = previousWordIndex(this.value, this.cursor);
        this.value = this.value.slice(0, previous) + this.value.slice(this.cursor);
        this.cursor = previous;
        this.requestRender(true, "edit");
      }
      return false;
    }

    if ((sequence === "\x01" || isHomeSequence(sequence)) && !this.inBracketedPaste) {
      this.clearPasteWindow();
      this.cursor = currentLineStartIndex(this.value, this.cursor);
      this.requestRender(true, "edit");
      return false;
    }

    if ((sequence === "\x05" || isEndSequence(sequence)) && !this.inBracketedPaste) {
      this.clearPasteWindow();
      this.cursor = currentLineEndIndex(this.value, this.cursor);
      this.requestRender(true, "edit");
      return false;
    }

    if (isPlainTextInputSequence(sequence)) {
      this.insertText(sequence);
      if (this.inBracketedPaste || context.pasteLikeBurst || looksLikePasteTextBurst(sequence)) {
        this.markPasteWindow(now);
      }
      return false;
    }

    if (this.inBracketedPaste) {
      this.insertText(sequence, true);
      this.markPasteWindow(now);
      return false;
    }

    this.clearPasteWindow();
    return this.unhandled(sequence, context);
  }

  private applyCompletion(): void {
    const items = this.completionItems();
    if (items.length === 1) {
      const [first] = items;
      if (!first) return;
      const replacement = first.replacement ?? first.completeText ?? first.value;
      this.value = replacement;
      this.cursor = this.value.length;
      this.requestRender(true, "completion");
      return;
    }
    if (items.length > 1) {
      const prefix = commonPrefix(items.map(item => item.completeText ?? item.replacement ?? item.value));
      if (prefix.length > this.value.length) {
        this.value = prefix;
        this.cursor = this.value.length;
      }
      this.requestRender(true, "completion");
    }
  }

  private insertText(text: string, immediate = false): void {
    const cleanText = this.inBracketedPaste ? sanitizeBracketedPasteText(text) : sanitizeInputText(text);
    if (!cleanText) return;
    const remaining = Math.max(0, MAX_INPUT_CHARS - this.value.length);
    if (remaining <= 0) return;
    const boundedText = safeSliceInputText(cleanText, remaining);
    if (!boundedText) return;
    this.value = this.value.slice(0, this.cursor) + boundedText + this.value.slice(this.cursor);
    this.cursor += boundedText.length;
    this.requestRender(immediate, "edit");
  }

  private deleteNextGrapheme(): void {
    if (this.cursor >= this.value.length) return;
    const next = nextGraphemeIndex(this.value, this.cursor);
    this.value = this.value.slice(0, this.cursor) + this.value.slice(next);
    this.requestRender(true, "edit");
  }

  private consumeTrailingBackslashForNewline(): boolean {
    if (this.cursor === 0 || this.value[this.cursor - 1] !== "\\") return false;
    this.clearPasteWindow();
    this.value = this.value.slice(0, this.cursor - 1) + "\n" + this.value.slice(this.cursor);
    this.cursor = this.cursor;
    this.requestRender(true, "edit");
    return true;
  }

  private requestRender(immediate: boolean, reason: InputRenderMeta["reason"]): void {
    this.refreshCompletions();
    if (this.suppressRender) {
      this.needsRender = true;
      this.pendingImmediateRender ||= immediate;
      return;
    }
    this.options.onRender?.(this.getState(), { immediate, reason });
  }

  private refreshCompletions(): void {
    const limit = safeCompletionLimit(this.options.completionLimit);
    if (limit <= 0) {
      this.completions = [];
      return;
    }
    this.completions = this.completionItems()
      .slice(0, limit)
      .map(item => item.display ?? item.value);
  }

  private completionItems(): InputCompletionItem[] {
    const provider = this.options.completionProvider;
    if (!provider) return [];
    let provided: unknown;
    try {
      provided = provider(this.value);
    } catch {
      return [];
    }
    if (!Array.isArray(provided)) return [];
    const sanitized: InputCompletionItem[] = [];
    for (const item of provided.slice(0, MAX_COMPLETION_SCAN_ITEMS)) {
      const normalized = normalizeCompletionItem(item);
      if (normalized) sanitized.push(normalized);
      if (sanitized.length >= MAX_COMPLETION_ITEMS) break;
    }
    return sanitized;
  }

  private isEditable(): boolean {
    if (this.options.editable !== undefined) return this.options.editable;
    return this.mode === "idle" || this.mode === "running";
  }

  private unhandled(sequence: string, context: InputKeyContext): boolean {
    return this.options.onUnhandledSequence?.(sequence, context) === true;
  }

  private markPasteWindow(now: number): void {
    this.pasteWindowUntil = now + PASTE_BURST_NEWLINE_WINDOW_MS;
  }

  private clearPasteWindow(): void {
    this.pasteWindowUntil = 0;
  }
}

function isPotentialTextPayload(sequence: string): boolean {
  if (!sequence) return false;
  if (isBracketedPasteStart(sequence) || isBracketedPasteEnd(sequence)) return false;
  if (sequence === "\r" || sequence === "\n") return false;
  if (sequence === "\x03" || sequence === "\x04" || sequence === "\x7f" || sequence === "\x08") return false;
  return !sequence.startsWith("\x1b");
}

function isAscii(char: string): boolean {
  return (char.codePointAt(0) ?? 0) <= 0x7f;
}

function normalizeInputText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function safeInputValue(value: unknown, maxChars = MAX_INPUT_CHARS): string {
  if (typeof value !== "string" || maxChars <= 0) return "";
  return safeSliceInputText(sanitizeInputText(value), maxChars);
}

function sanitizePromptText(value: unknown): string {
  if (typeof value !== "string") return "";
  return sanitizeStyledSingleLine(value, MAX_INPUT_PROMPT_WIDTH);
}

function sanitizeCompletionText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = safeInputValue(value, maxChars).replace(/\n+/g, " ").trim();
  return normalized || undefined;
}

function sanitizeCompletionDisplay(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = sanitizeStyledSingleLine(value, MAX_COMPLETION_DISPLAY_WIDTH);
  return stripAnsi(text).trim() ? text : undefined;
}

function normalizeCompletionItem(item: unknown): InputCompletionItem | null {
  if (!item || typeof item !== "object") return null;
  const source = item as Partial<InputCompletionItem>;
  const value = sanitizeCompletionText(source.value, MAX_COMPLETION_VALUE_CHARS);
  if (!value) return null;
  const normalized: InputCompletionItem = { value };
  const description = sanitizeCompletionText(source.description, MAX_COMPLETION_DESC_CHARS);
  const display = sanitizeCompletionDisplay(source.display);
  const replacement = safeInputValue(source.replacement, MAX_INPUT_CHARS);
  const completeText = safeInputValue(source.completeText, MAX_COMPLETION_VALUE_CHARS);
  if (description) normalized.description = description;
  if (display) normalized.display = display;
  if (replacement) normalized.replacement = replacement;
  if (completeText) normalized.completeText = completeText;
  return normalized;
}

function safeCompletionLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_COMPLETION_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_COMPLETION_ITEMS, Math.floor(parsed));
}

function sanitizeStyledSingleLine(value: string, maxWidth: number): string {
  const normalized = normalizeInputText(value).replace(/\n+/g, " ");
  const safeAnsi = normalized
    .replace(ANSI_SEQUENCE_RE, sequence => SAFE_SGR_RE.test(sequence) ? sequence : "")
    .replace(CONTROL_PROMPT_RE, "")
    .replace(/\x1b(?!\[[0-9;]*m)/g, "");
  return truncateAnsi(safeAnsi, maxWidth);
}

function safeCursorIndex(value: string, cursor: unknown): number {
  const parsed = typeof cursor === "number" && Number.isFinite(cursor)
    ? Math.floor(cursor)
    : value.length;
  let index = Math.max(0, Math.min(parsed, value.length));
  const previous = value.charCodeAt(index - 1);
  const next = value.charCodeAt(index);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) index--;
  return index;
}

function sanitizeBracketedPasteText(text: string): string {
  const normalized = normalizeInputText(text);
  return isShiftTabSequence(normalized) ? normalized : sanitizeInputText(normalized);
}

function safeSliceInputText(text: string, maxCodeUnits: number): string {
  if (text.length <= maxCodeUnits) return text;
  let end = Math.max(0, maxCodeUnits);
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end--;
  }
  return text.slice(0, end);
}

function isInsertNewlineSequence(sequence: string): boolean {
  return INSERT_NEWLINE_SEQUENCES.has(sequence);
}

function isDeleteSequence(sequence: string): boolean {
  return sequence === "\x1b[3~" || sequence === "\x1b[3;2~" || sequence === "\x1b[3;5~" || sequence === "\x1b[3;3~";
}

function isHomeSequence(sequence: string): boolean {
  return sequence === "\x1b[H" || sequence === "\x1bOH" || /^\x1b\[1;\d+H$/.test(sequence);
}

function isEndSequence(sequence: string): boolean {
  return sequence === "\x1b[F" || sequence === "\x1bOF" || /^\x1b\[1;\d+F$/.test(sequence);
}

export async function readInput(
  prompt: string,
  opts?: ReadInputOptions,
): Promise<InputResult> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: stdin, output: stdout, terminal: false });
    return new Promise(r => rl.question("", (l) => { rl.close(); r({ type: "line", value: safeInputValue(l) }); }));
  }

  let showComps = false;
  let detachInput: (() => void) | null = null;
  let controller: InputController | null = null;

  function redraw(state: InputControllerState) {
    if (opts?.onRender) {
      opts.onRender({ prompt: state.prompt, value: state.value, cursor: state.cursor, completions: state.completions });
      showComps = state.completions.length > 0;
      return;
    }

    // Move to start of input line, clear it
    stdout.write("\r\x1b[2K" + state.prompt + state.value);
    // Position cursor within buf
    if (state.cursor < state.value.length) stdout.write(`\x1b[${state.cursor - state.value.length}D`);

    // Show completions below
    if (state.completions.length) {
      stdout.write("\n");
      for (const line of state.completions) stdout.write(`\x1b[2K${line}\n`);
      // Move back up to input line
      stdout.write(`\x1b[${state.completions.length}A\x1b[${visibleLength(state.prompt) + state.cursor}C`);
      showComps = true;
    } else if (showComps) {
      // Clear previous completions
      stdout.write("\n\x1b[J\x1b[1A");
      showComps = false;
    }
  }

  return new Promise((resolve) => {
    let cleaned = false;
    let settled = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      detachInput?.();
      controller?.dispose();
      if (!opts?.onRender && showComps) { stdout.write("\n\x1b[J"); showComps = false; }
    };

    const finish = (result: InputResult): boolean => {
      if (settled) return false;
      settled = true;
      cleanup();
      resolve(result);
      return true;
    };

    controller = new InputController({
      mode: "idle",
      prompt,
      completionProvider: opts?.completionProvider ?? commandCompletionProvider,
      onRender: redraw,
      onCtrlC: () => {
        controller?.reset({ render: true });
        return false;
      },
      onInterrupt: () => {
        opts?.onInterrupt?.();
        return false;
      },
      ...(opts?.onModeCycle ? { onModeCycle: opts.onModeCycle } : {}),
      ...(opts?.onScroll ? { onScroll: opts.onScroll } : {}),
      onSubmit: (value) => {
        if (!opts?.onRender) stdout.write("\n");
        return finish({ type: "line", value });
      },
      onEof: () => {
        if (!opts?.onRender) stdout.write("\n");
        return finish({ type: "eof" });
      },
    });

    if (opts?.onRender) controller.render(true);
    else stdout.write("\n" + prompt);
    detachInput = controller.attach({ stdin, stdout });
  });
}
