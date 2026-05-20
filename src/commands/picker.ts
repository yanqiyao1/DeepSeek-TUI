import { p } from "../ui/palette.js";
import {
  movePickerIndex,
  pickerActionForSequence,
  pickerWindow,
  type PickItem,
} from "../ui/picker.js";
import { InputController } from "../ui/input.js";
import type { TuiModalKind } from "../tui/modal.js";
import type { PickerRenderer } from "./types.js";

const MODELS: PickItem[] = [
  { name: "deepseek-v4-pro", desc: "1M context, reasoning, best for complex tasks" },
  { name: "deepseek-v4-flash", desc: "1M context, fast & cheap, best for parallel/simple" },
];

const PROVIDERS: PickItem[] = [
  { name: "deepseek", desc: "Official DeepSeek API" },
  { name: "deepseek-cn", desc: "DeepSeek China endpoint" },
  { name: "nvidia-nim", desc: "NVIDIA NIM hosted DeepSeek" },
  { name: "openrouter", desc: "OpenRouter DeepSeek routes" },
  { name: "novita", desc: "Novita AI DeepSeek routes" },
  { name: "fireworks", desc: "Fireworks AI DeepSeek routes" },
  { name: "sglang", desc: "Self-hosted SGLang endpoint" },
];

export async function pickFromList(
  items: PickItem[],
  title = "Select",
  render?: PickerRenderer,
  clearRender?: () => void,
  kind: TuiModalKind = "picker",
): Promise<string | null> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !items.length) return null;

  let idx = 0;
  const len = items.length;
  let first = true;
  let previousTotalLines = 0;
  let resizeTimer: NodeJS.Timeout | null = null;

  const maxVisibleItems = () => Math.max(1, Math.min(len, (process.stdout.rows || 24) - 6));

  const renderPicker = () => {
    const visibleItems = maxVisibleItems();
    const totalLines = visibleItems + 3;
    const window = pickerWindow(items, idx, visibleItems);
    if (render) {
      render(idx, items, title, visibleItems, kind);
      return;
    }
    stdout.write("\x1b[?25l");
    if (!first && previousTotalLines > 0) stdout.write(`\x1b[${previousTotalLines}A`);
    first = false;
    if (window.start > 0) {
      stdout.write("\r\x1b[2K" + p.dim(`  ↑ ${window.start} newer session${window.start === 1 ? "" : "s"}`) + "\n");
    } else {
      stdout.write("\r\x1b[2K\n");
    }
    for (const entry of window.entries) {
      const item = entry.item;
      const prefix = entry.selected ? p.blue("❯ ") : "  ";
      const line = item.desc ? `${prefix}${item.name}  ${p.dim(item.desc)}` : `${prefix}${item.name}`;
      stdout.write("\r\x1b[2K" + line + "\n");
    }
    while (window.entries.length < visibleItems) stdout.write("\r\x1b[2K\n");
    if (window.end < window.total) {
      stdout.write("\r\x1b[2K" + p.dim(`  ↓ ${window.total - window.end} older session${window.total - window.end === 1 ? "" : "s"}`) + "\n");
    } else {
      stdout.write("\r\x1b[2K\n");
    }
    stdout.write("\r\x1b[2K" + p.dim(`${title}  ↑↓ select  Enter confirm  Esc cancel`) + "\n");
    previousTotalLines = totalLines;
  };

  return new Promise((resolve) => {
    let detachInput: (() => void) | null = null;
    let controller: InputController | null = null;
    let settled = false;
    if (!render) stdout.write("\r\x1b[2K\n");
    renderPicker();

    const handleKey = (key: string) => {
      if (settled) return true;
      const action = pickerActionForSequence(key);
      if (!action) return false;
      if (action === "confirm") {
        const selected = items[idx];
        if (!selected) return false;
        cleanup();
        resolve(selected.name);
        return true;
      }
      if (action === "cancel") {
        cleanup();
        resolve(null);
        return true;
      }
      const nextIndex = movePickerIndex(idx, len, action, maxVisibleItems());
      if (nextIndex !== idx) {
        idx = nextIndex;
        renderPicker();
      }
      return false;
    };

    const onResize = () => {
      if (resizeTimer) return;
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        idx = Math.max(0, Math.min(len - 1, idx));
        renderPicker();
      }, 16);
    };

    const cleanup = () => {
      if (settled) return;
      settled = true;
      detachInput?.();
      controller?.dispose();
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      if (render) {
        clearRender?.();
      } else {
        stdout.write(`${previousTotalLines > 0 ? `\x1b[${previousTotalLines}A` : ""}\x1b[J\r`);
        stdout.write("\x1b[?25h");
      }
    };

    controller = new InputController({
      mode: "picker",
      editable: false,
      onUnhandledSequence: (key) => handleKey(key),
      onCtrlC: () => {
        cleanup();
        resolve(null);
        return true;
      },
    });
    detachInput = controller.attach({
      stdin,
      stdout,
      resizeTarget: stdout,
      bracketedPaste: false,
      onResize,
    });
  });
}

export async function pickModel(
  current: string,
  render?: PickerRenderer,
  clearRender?: () => void,
): Promise<string | null> {
  const idx = MODELS.findIndex(m => m.name === current);
  const items = idx > 0 ? [...MODELS.slice(idx), ...MODELS.slice(0, idx)] : [...MODELS];
  return pickFromList(items, "Select model", render, clearRender);
}

export async function pickProvider(
  current: string,
  render?: PickerRenderer,
  clearRender?: () => void,
): Promise<string | null> {
  const idx = PROVIDERS.findIndex(provider => provider.name === current);
  const items = idx > 0 ? [...PROVIDERS.slice(idx), ...PROVIDERS.slice(0, idx)] : [...PROVIDERS];
  return pickFromList(items, "Select provider", render, clearRender);
}

export async function confirmPrompt(
  message: string,
  render?: PickerRenderer,
  clearRender?: () => void,
): Promise<boolean> {
  const selected = await pickFromList([
    { name: "no", desc: "Cancel" },
    { name: "yes", desc: "Delete permanently" },
  ], message, render, clearRender, "confirm");
  return selected === "yes";
}
