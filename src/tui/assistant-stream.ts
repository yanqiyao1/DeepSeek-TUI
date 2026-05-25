/** Maintains transcript line state for one streaming assistant response. */

import { Transcript } from "./transcript.js";
import { renderMarkdown } from "../ui/markdown.js";
import { StreamingLineBuffer } from "./streaming-line-buffer.js";

export class AssistantStream {
  private active = false;
  private startLine = 0;
  private lineCount = 0;
  private raw = "";
  private readonly lineBuffer = new StreamingLineBuffer();

  get mutableStartLine(): number | null {
    if (!this.active) return null;
    return this.startLine + this.completeLogicalLineCount();
  }

  append(transcript: Transcript, text: string): boolean {
    const committable = this.lineBuffer.push(text);
    if (!committable) return false;
    this.appendCommitted(transcript, committable);
    return true;
  }

  flush(transcript: Transcript): boolean {
    const remaining = this.lineBuffer.flush();
    if (!remaining) return false;
    this.appendCommitted(transcript, remaining);
    return true;
  }

  reset(): void {
    this.active = false;
    this.startLine = 0;
    this.lineCount = 0;
    this.raw = "";
    this.lineBuffer.reset();
  }

  private appendCommitted(transcript: Transcript, text: string): void {
    if (!this.active) {
      const reusingBlankLine = Boolean(transcript.lines.length && !transcript.lines.at(-1)?.text.trim());
      if (!transcript.lines.length || transcript.lines.at(-1)?.text.trim()) {
        this.startLine = transcript.lines.length;
      } else {
        this.startLine = transcript.lines.length - 1;
      }
      this.active = true;
      this.lineCount = reusingBlankLine ? 1 : 0;
      this.raw = "";
    }
    this.raw += text;
    this.lineCount = transcript.replaceRange(this.startLine, this.lineCount, renderMarkdown(this.raw));
  }

  private completeLogicalLineCount(): number {
    return this.raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length - 1;
  }
}
