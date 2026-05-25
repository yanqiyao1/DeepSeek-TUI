/** Holds streaming text until stable line boundaries are available. */

const DEFAULT_MAX_PENDING_CHARS = 4_000;

export class StreamingLineBuffer {
  private pending = "";

  constructor(private readonly maxPendingChars = DEFAULT_MAX_PENDING_CHARS) {}

  push(delta: string): string {
    if (!delta) return "";
    this.pending += normalizeNewlines(delta);
    return this.takeCommittable();
  }

  takeCommittable(): string {
    const lastNewline = this.pending.lastIndexOf("\n");
    if (lastNewline >= 0) {
      const committable = this.pending.slice(0, lastNewline + 1);
      this.pending = this.pending.slice(lastNewline + 1);
      return committable;
    }

    if (this.maxPendingChars > 0 && Array.from(this.pending).length > this.maxPendingChars) {
      const end = overflowCommitIndex(this.pending, this.maxPendingChars);
      const committable = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      return committable;
    }

    return "";
  }

  flush(): string {
    const remaining = this.pending;
    this.pending = "";
    return remaining;
  }

  reset(): void {
    this.pending = "";
  }

  isEmpty(): boolean {
    return this.pending.length === 0;
  }

  pendingLength(): number {
    return this.pending.length;
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function overflowCommitIndex(text: string, maxChars: number): number {
  let utf16Index = 0;
  let lastWhitespaceBoundary = -1;
  let consumedChars = 0;

  for (const char of Array.from(text)) {
    const nextIndex = utf16Index + char.length;
    consumedChars++;
    if (/\s/u.test(char)) lastWhitespaceBoundary = nextIndex;
    utf16Index = nextIndex;
    if (consumedChars >= maxChars) break;
  }

  const minimumUsefulBoundary = Math.floor(utf16Index * 0.6);
  if (lastWhitespaceBoundary >= minimumUsefulBoundary) return lastWhitespaceBoundary;
  return Math.max(1, utf16Index);
}
