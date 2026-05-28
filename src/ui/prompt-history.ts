import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { seekcodeDataPath } from "../paths.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

export const MAX_PROMPT_HISTORY_ENTRIES = 200;

const PROMPT_HISTORY_FILE = "prompt-history.txt";
const MAX_PROMPT_HISTORY_FILE_BYTES = 512 * 1024;
const MAX_PROMPT_HISTORY_ENTRY_CHARS = 4_000;
const promptHistoryWrites = new Map<string, Promise<void>>();

export function promptHistoryPath(): string {
  return seekcodeDataPath(PROMPT_HISTORY_FILE);
}

export async function loadPromptHistory(path = promptHistoryPath()): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  if (text.length > MAX_PROMPT_HISTORY_FILE_BYTES) {
    text = safeSliceTextBoundary(text, MAX_PROMPT_HISTORY_FILE_BYTES);
  }
  return normalizePromptHistoryEntries(text.split(/\r?\n/), MAX_PROMPT_HISTORY_ENTRIES);
}

export function appendPromptHistory(entry: string, path = promptHistoryPath()): void {
  const normalized = normalizePromptHistoryEntry(entry);
  if (!normalized || normalized.startsWith("/")) return;
  const previous = promptHistoryWrites.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => appendPromptHistoryAsync(normalized, path))
    .catch(() => undefined)
    .finally(() => {
      if (promptHistoryWrites.get(path) === next) promptHistoryWrites.delete(path);
    });
  promptHistoryWrites.set(path, next);
}

export async function flushPromptHistoryWrites(path?: string): Promise<void> {
  if (path !== undefined) {
    await (promptHistoryWrites.get(path) ?? Promise.resolve());
    return;
  }
  await Promise.all([...promptHistoryWrites.values()]);
}

export function pushPromptHistoryEntry(entries: string[], entry: string, limit = MAX_PROMPT_HISTORY_ENTRIES): string[] {
  const normalized = normalizePromptHistoryEntry(entry);
  if (!normalized || normalized.startsWith("/")) return normalizePromptHistoryEntries(entries, limit);
  const next = normalizePromptHistoryEntries(entries, limit);
  if (next.at(-1) !== normalized) next.push(normalized);
  const safeLimit = safePromptHistoryLimit(limit);
  return safeLimit > 0 ? next.slice(-safeLimit) : [];
}

async function appendPromptHistoryAsync(entry: string, path: string): Promise<void> {
  const entries = await loadPromptHistory(path);
  if (entries.at(-1) === entry) return;
  entries.push(entry);
  const bounded = entries.slice(-MAX_PROMPT_HISTORY_ENTRIES);
  await writePromptHistoryFile(path, bounded);
}

async function writePromptHistoryFile(path: string, entries: string[]): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const payload = entries.join("\n") + (entries.length ? "\n" : "");
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, payload, "utf-8");
  await rename(tmp, path);
}

export function normalizePromptHistoryEntries(value: unknown, limit = MAX_PROMPT_HISTORY_ENTRIES): string[] {
  if (!Array.isArray(value) || limit <= 0) return [];
  const safeLimit = safePromptHistoryLimit(limit);
  if (safeLimit <= 0) return [];
  const entries: string[] = [];
  for (const item of value.slice(-safeLimit * 2)) {
    const entry = normalizePromptHistoryEntry(item);
    if (!entry || entry.startsWith("/") || entries.at(-1) === entry) continue;
    entries.push(entry);
    if (entries.length > safeLimit) entries.shift();
  }
  return entries;
}

function safePromptHistoryLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_PROMPT_HISTORY_ENTRIES, Math.floor(parsed));
}

function normalizePromptHistoryEntry(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const normalized = safeSliceTextBoundary(value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\u0000/g, " "), MAX_PROMPT_HISTORY_ENTRY_CHARS).trim();
  return normalized;
}
