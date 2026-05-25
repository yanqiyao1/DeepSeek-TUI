export type PickItem = { name: string; desc?: string };

export interface PickerWindowEntry<T> {
  item: T;
  index: number;
  selected: boolean;
}

export interface PickerWindow<T> {
  start: number;
  end: number;
  selectedIndex: number;
  total: number;
  entries: PickerWindowEntry<T>[];
}

export type PickerAction = "up" | "down" | "page_up" | "page_down" | "top" | "bottom" | "confirm" | "cancel";

export function pickerActionForSequence(sequence: string): PickerAction | null {
  if (sequence === "\x1b[A" || sequence === "\x1bOA") return "up";
  if (sequence === "\x1b[B" || sequence === "\x1bOB") return "down";
  if (/^\x1b\[5(?:;\d+)?~$/.test(sequence)) return "page_up";
  if (/^\x1b\[6(?:;\d+)?~$/.test(sequence)) return "page_down";
  if (sequence === "\x1b[H" || sequence === "\x1bOH" || sequence === "\x1b[1~" || sequence === "\x1b[1;5H") return "top";
  if (sequence === "\x1b[F" || sequence === "\x1bOF" || sequence === "\x1b[4~" || sequence === "\x1b[1;5F") return "bottom";
  if (/^\x1b\[<64;\d+;\d+[mM]$/.test(sequence)) return "up";
  if (/^\x1b\[<65;\d+;\d+[mM]$/.test(sequence)) return "down";
  if (sequence === "\r" || sequence === "\n") return "confirm";
  if (sequence === "\x1b" || sequence === "\x03") return "cancel";
  return null;
}

export function movePickerIndex(
  selectedIndex: number,
  total: number,
  action: PickerAction,
  visibleCount: number,
): number {
  const safeTotal = safeItemCount(total);
  if (safeTotal <= 0) return -1;
  const selected = Math.max(0, Math.min(safeTotal - 1, safeInteger(selectedIndex, 0)));
  const page = Math.max(1, Math.min(safeInteger(visibleCount, 1), safeTotal));
  switch (action) {
    case "up":
      return Math.max(0, selected - 1);
    case "down":
      return Math.min(safeTotal - 1, selected + 1);
    case "page_up":
      return Math.max(0, selected - page);
    case "page_down":
      return Math.min(safeTotal - 1, selected + page);
    case "top":
      return 0;
    case "bottom":
      return safeTotal - 1;
    default:
      return selected;
  }
}

export function pickerWindow<T>(
  items: T[],
  selectedIndex: number,
  maxVisibleItems: number,
): PickerWindow<T> {
  const safeItems = Array.isArray(items) ? items : [];
  const total = safeItems.length;
  const safeMaxVisible = safeInteger(maxVisibleItems, 0);
  if (!total || safeMaxVisible <= 0) {
    return { start: 0, end: 0, selectedIndex: -1, total, entries: [] };
  }

  const visibleCount = Math.max(1, Math.min(total, safeMaxVisible));
  const selected = Math.max(0, Math.min(total - 1, safeInteger(selectedIndex, 0)));
  const halfWindow = Math.floor(visibleCount / 2);
  const maxStart = Math.max(0, total - visibleCount);
  const start = Math.max(0, Math.min(selected - halfWindow, maxStart));
  const end = Math.min(total, start + visibleCount);

  return {
    start,
    end,
    selectedIndex: selected,
    total,
    entries: safeItems.slice(start, end).map((item, offset) => {
      const index = start + offset;
      return { item, index, selected: index === selected };
    }),
  };
}

function safeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function safeItemCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}
