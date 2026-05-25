/** TUI App — full-screen layout: transcript + footer + input. */

import * as screen from "./screen.js";
import { Transcript } from "./transcript.js";
import { readInput, type InputResult } from "../ui/input.js";
import { p } from "../ui/palette.js";
import * as r from "../ui/renderer.js";

export interface TuiCallbacks {
  onSubmit: (input: string) => Promise<void>;
  onInterrupt: () => void;
  getFooter: () => string;
  getPrompt: () => string;
}

export function submittedLineValue(value: string): string | null {
  return value.trim() ? value : null;
}

export async function runTui(callbacks: TuiCallbacks): Promise<void> {
  screen.setup();
  screen.enableBracketedPaste();
  const transcript = new Transcript();
  let running = true;

  const render = () => {
    const size = screen.termSize();

    // 1. Transcript (rows - 4 for footer + input area)
    const transcriptRows = Math.max(1, size.rows - 4);
    screen.moveTo(1, 1);
    const transcriptOut = transcript.render(transcriptRows, size.cols);
    process.stdout.write(transcriptOut);
    // Clear remaining transcript lines
    for (let i = 0; i < transcriptRows; i++) {
      process.stdout.write(`\x1b[${i + 2};1H\x1b[2K`);
    }
    screen.moveTo(1, 1);
    process.stdout.write(transcriptOut);

    // 2. Footer
    const footerRow = transcriptRows + 1;
    screen.moveTo(footerRow, 1);
    process.stdout.write(`\x1b[2K${p.dim("─".repeat(size.cols))}`);
    screen.moveTo(footerRow + 1, 1);
    process.stdout.write(`\x1b[2K${callbacks.getFooter()}`);

    // 3. Input
    screen.moveTo(size.rows, 1);
    process.stdout.write(`\x1b[2K${callbacks.getPrompt()}`);
  };

  try {
    // Initial render
    render();

    // Input loop
    while (running) {
      const result = await readInput(callbacks.getPrompt(), {
        onInterrupt: () => {
          callbacks.onInterrupt();
          render();
        },
      });

      if (result.type === "eof") {
        running = false;
        break;
      }
      if (result.type !== "line") {
        render();
        continue;
      }
      const input = submittedLineValue(result.value);
      if (input === null) {
        render();
        continue;
      }

      // Add user message to transcript
      transcript.append(r.userMessageBlock(input));

      // Call submit
      await callbacks.onSubmit(input);
      transcript.scrollToBottom();
      render();
    }
  } finally {
    screen.teardown();
  }
}

// Export for external use
export { Transcript };
