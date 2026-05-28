/** Structured modal requests rendered by the TUI input layer. */

import { p } from "../ui/palette.js";
import {
  pickerWindow,
  pickerIndexLabel,
  safePickerDescription,
  safePickerItem,
  safePickerName,
  safePickerTitle,
  type PickItem,
} from "../ui/picker.js";
import * as r from "../ui/renderer.js";

export type TuiModalKind = "picker" | "approval" | "confirm";

export interface TuiModalState {
  kind: TuiModalKind;
  lines: string[];
}

export function pickerModalLines(
  idx: number,
  items: PickItem[],
  title: string,
  maxVisibleItems = 12,
): string[] {
  const safeItems = Array.isArray(items) ? items.map(safePickerItem) : [];
  const window = pickerWindow(safeItems, idx, maxVisibleItems);
  const safeTitle = safePickerTitle(title);
  const lines: string[] = [];
  if (window.start > 0) {
    lines.push(p.dim(`  ↑ ${window.start} newer session${window.start === 1 ? "" : "s"}`));
  }
  for (const [position, entry] of window.entries.entries()) {
    const item = entry.item;
    const prefix = entry.selected ? p.blue("❯ ") : "  ";
    const shortcut = pickerIndexLabel(position);
    const name = safePickerName(item.name);
    const desc = safePickerDescription(item.desc);
    lines.push(desc ? `${prefix}${shortcut}${name}  ${p.dim(desc)}` : `${prefix}${shortcut}${name}`);
  }
  if (window.end < window.total) {
    lines.push(p.dim(`  ↓ ${window.total - window.end} older session${window.total - window.end === 1 ? "" : "s"}`));
  }
  lines.push(p.dim(`${safeTitle}  1-9 pick  ↑↓/j/k move  Enter confirm  Esc cancel`));
  return lines;
}

export function approvalModalLines(toolName: string, args: Record<string, unknown>): string[] {
  return r.approvalPrompt(toolName, args).split("\n");
}
