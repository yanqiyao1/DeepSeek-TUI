/** Raw-mode input with Tab completion. No cursor tricks — just clear and redraw. */

import { p } from "./palette.js";
import { visibleLength } from "./ansi.js";
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

export function isShiftTabSequence(sequence: string): boolean {
  return SHIFT_TAB_SEQUENCES.has(sequence);
}

export function enableBracketedPaste(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  stdout.write("\x1b[?2004h");
}

export function disableBracketedPaste(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  stdout.write("\x1b[?2004l");
}

function matches(prefix: string, workspacePath?: string): [string, string][] {
  if (!prefix.startsWith("/")) return [];
  const p = prefix.slice(1).toLowerCase();
  const commands = [
    ...COMMANDS,
    ...discoverClaudeCommands(workspacePath).map(command => [
      command.name,
      `${command.description} (${command.scope} .claude/commands)`,
    ] as [string, string]),
  ];
  if (!p) return commands;
  return commands.filter(([n]) => n.startsWith(p));
}

function commonPrefix(strings: string[]): string {
  if (!strings.length) return "";
  let pre = strings[0] ?? "";
  for (const s of strings.slice(1)) { while (pre && !s.startsWith(pre)) pre = pre.slice(0, -1); }
  return pre;
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
}

export function commandCompletionProvider(value: string, workspacePath?: string): InputCompletionItem[] {
  return matches(value, workspacePath).map(([name, desc]) => {
    const partial = value.startsWith("/") ? value.slice(1).toLowerCase() : "";
    const highlighted = partial
      ? p.blue(name.slice(0, partial.length)) + p.text(name.slice(partial.length))
      : p.text(name);
    return {
      value: name,
      description: desc,
      display: `  /${highlighted}  ${p.dim(desc)}`,
      replacement: `/${name} `,
      completeText: `/${name}`,
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
  for (let index = 0; index < chunk.length;) {
    if (chunk[index] !== "\x1b") {
      const nextEscape = chunk.indexOf("\x1b", index);
      const end = nextEscape === -1 ? chunk.length : nextEscape;
      sequences.push(...Array.from(chunk.slice(index, end)));
      index = end;
      continue;
    }

    if (chunk.startsWith("\x1b[<", index)) {
      const match = /^\x1b\[<\d+;\d+;\d+[mM]/.exec(chunk.slice(index));
      if (match) {
        sequences.push(match[0]);
        index += match[0].length;
        continue;
      }
    }

    const csiMatch = /^\x1b\[[0-9;?]*[~A-Za-z]/.exec(chunk.slice(index));
    if (csiMatch) {
      sequences.push(csiMatch[0]);
      index += csiMatch[0].length;
      continue;
    }

    const ss3Match = /^\x1bO[A-Za-z]/.exec(chunk.slice(index));
    if (ss3Match) {
      sequences.push(ss3Match[0]);
      index += ss3Match[0].length;
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
  const lastEscape = chunk.lastIndexOf("\x1b");
  if (lastEscape < 0) return -1;
  const tail = chunk.slice(lastEscape);
  if (tail === "\x1b") return lastEscape;
  if (tail === "\x1b[") return lastEscape;
  if (tail === "\x1b[<") return lastEscape;
  if (/^\x1b\[(?:<)?[0-9;?]+$/.test(tail)) return lastEscape;
  if (tail === "\x1bO") return lastEscape;
  return -1;
}

export function isBracketedPasteStart(sequence: string): boolean {
  return sequence === BRACKETED_PASTE_START;
}

export function isBracketedPasteEnd(sequence: string): boolean {
  return sequence === BRACKETED_PASTE_END;
}

export function shouldTreatNewlineAsPaste(_newlineIndex: number, sequenceCount: number, now: number, pasteWindowUntil: number): boolean {
  return sequenceCount >= 3 || (pasteWindowUntil > 0 && now <= pasteWindowUntil);
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
    this.prompt = options.prompt ?? "";
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
    this.prompt = prompt;
    if (render) this.requestRender(true, "mode");
  }

  reset(options: { value?: string; cursor?: number; render?: boolean } = {}): void {
    this.value = options.value ?? "";
    this.cursor = Math.max(0, Math.min(options.cursor ?? this.value.length, this.value.length));
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
    const onResize = () => options.onResize?.();

    if (bracketedPaste) enableBracketedPaste(stdout);
    if (rawMode) stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
    if (options.onResize) resizeTarget.on?.("resize", onResize);

    return () => {
      if (detached) return;
      detached = true;
      stdin.removeListener("data", onData);
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
    const value = this.pendingEscape + data.toString();
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
    const shouldBatchRender = sequenceCount >= 3 || coalesced.length < sequenceCount || this.inBracketedPaste;
    const previousSuppressRender = this.suppressRender;
    if (shouldBatchRender) this.suppressRender = true;
    try {
      for (let index = 0; index < coalesced.length; index++) {
        const shouldStop = this.handleSequence(coalesced[index]!, { index, sequenceCount, now });
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
        this.pasteWindowUntil = now + PASTE_BURST_NEWLINE_WINDOW_MS;
        return false;
      }
      const nextPrompt = this.options.onModeCycle?.();
      if (typeof nextPrompt === "string") this.prompt = nextPrompt;
      this.requestRender(true, "mode");
      return false;
    }

    const scrollAction = scrollActionForSequence(sequence);
    if (scrollAction && !this.inBracketedPaste) {
      this.options.onScroll?.(scrollAction.direction, scrollAction.amount);
      this.requestRender(true, "scroll");
      return false;
    }

    if (sequence.startsWith("\x1b") && sequence.length > 1 && !this.inBracketedPaste) {
      if (sequence === "\x1b[A" || sequence === "\x1bOA") return this.unhandled(sequence, context);
      if (sequence === "\x1b[B" || sequence === "\x1bOB") return this.unhandled(sequence, context);
      if (sequence === "\x1b[D" || sequence === "\x1bOD") {
        if (this.cursor > 0) this.cursor = previousGraphemeIndex(this.value, this.cursor);
        this.requestRender(true, "edit");
        return false;
      }
      if (sequence === "\x1b[C" || sequence === "\x1bOC") {
        if (this.cursor < this.value.length) this.cursor = nextGraphemeIndex(this.value, this.cursor);
        this.requestRender(true, "edit");
        return false;
      }
      if (sequence === "\x1b[H" || sequence === "\x1bOH") {
        this.cursor = 0;
        this.requestRender(true, "edit");
        return false;
      }
      if (sequence === "\x1b[F" || sequence === "\x1bOF") {
        this.cursor = this.value.length;
        this.requestRender(true, "edit");
        return false;
      }
      return this.unhandled(sequence, context);
    }

    if (sequence === "\x1b" && !this.inBracketedPaste) {
      return this.options.onInterrupt?.() === true;
    }

    if (sequence === "\t" && !this.inBracketedPaste) {
      this.applyCompletion();
      return false;
    }

    if (sequence === "\r" || sequence === "\n") {
      if (this.inBracketedPaste || shouldTreatNewlineAsPaste(context.index, context.sequenceCount, now, this.pasteWindowUntil)) {
        this.insertText("\n", true);
        this.pasteWindowUntil = now + PASTE_BURST_NEWLINE_WINDOW_MS;
        return false;
      }
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
      return this.options.onEof?.() !== false;
    }

    if (sequence === "\x03" && !this.inBracketedPaste) {
      const handler = this.options.onCtrlC ?? this.options.onEof;
      return handler?.() !== false;
    }

    if ((sequence === "\x7f" || sequence === "\x08") && !this.inBracketedPaste) {
      if (this.cursor > 0) {
        const previous = previousGraphemeIndex(this.value, this.cursor);
        this.value = this.value.slice(0, previous) + this.value.slice(this.cursor);
        this.cursor = previous;
        this.requestRender(true, "edit");
      }
      return false;
    }

    if ((sequence === "\x01" || sequence === "\x1b[H" || sequence === "\x1bOH") && !this.inBracketedPaste) {
      this.cursor = 0;
      this.requestRender(true, "edit");
      return false;
    }

    if ((sequence === "\x05" || sequence === "\x1b[F" || sequence === "\x1bOF") && !this.inBracketedPaste) {
      this.cursor = this.value.length;
      this.requestRender(true, "edit");
      return false;
    }

    if (isPlainTextInputSequence(sequence)) {
      this.insertText(sequence);
      if (this.inBracketedPaste || context.sequenceCount >= 3) {
        this.pasteWindowUntil = now + PASTE_BURST_NEWLINE_WINDOW_MS;
      }
      return false;
    }

    if (this.inBracketedPaste) {
      this.insertText(sequence, true);
      this.pasteWindowUntil = now + PASTE_BURST_NEWLINE_WINDOW_MS;
      return false;
    }

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
    if (!text) return;
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
    this.requestRender(immediate, "edit");
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
    this.completions = this.completionItems()
      .slice(0, this.options.completionLimit ?? 9)
      .map(item => item.display ?? item.value);
  }

  private completionItems(): InputCompletionItem[] {
    return this.options.completionProvider?.(this.value) ?? [];
  }

  private isEditable(): boolean {
    if (this.options.editable !== undefined) return this.options.editable;
    return this.mode === "idle" || this.mode === "running";
  }

  private unhandled(sequence: string, context: InputKeyContext): boolean {
    return this.options.onUnhandledSequence?.(sequence, context) === true;
  }
}

export async function readInput(
  prompt: string,
  opts?: ReadInputOptions,
): Promise<InputResult> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: stdin, output: stdout, terminal: false });
    return new Promise(r => rl.question("", (l) => { rl.close(); r({ type: "line", value: l }); }));
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
