/** Advanced hunks-based patch system with add/delete/update file types.
 *
 * Adopted from OpenCode: parses unified diffs into structured hunks,
 * supports multi-file patches, add/delete/update operations, move_path
 * detection, and smarter error handling.
 */

import { readFileSync, mkdirSync, existsSync, unlinkSync, statSync, realpathSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { diffLines } from "../ui/renderer.js";
import { writeTextFileAtomic } from "./atomic-write.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_PATCH_TEXT_CHARS = 1_000_000;
const MAX_PATCH_LINES = 20_000;
const MAX_PATCH_LINE_CHARS = 20_000;
const MAX_PATCH_HUNKS = 200;
const MAX_PATCH_CHUNKS = 1_000;
const MAX_PATCH_PATH_CHARS = 4_096;
const MAX_PATCH_FILE_CONTENT_CHARS = 5 * 1024 * 1024;
const MAX_PATCH_RESULT_ITEMS = 200;
const MAX_PATCH_RESULT_CHARS = 100_000;
const MAX_PATCH_RESULT_LINE_CHARS = 600;
const MAX_PATCH_DIFF_CHARS = 60_000;
const PATCH_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const PATCH_CONTROL_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// ── Types ────────────────────────────────────────────────────

export interface AddHunk {
  type: "add";
  path: string;
  contents: string;
}

export interface DeleteHunk {
  type: "delete";
  path: string;
}

export interface UpdateChunk {
  old_lines: string[];
  new_lines: string[];
  change_context?: string;
  is_end_of_file?: boolean;
  old_start?: number;
  new_start?: number;
}

export interface UpdateHunk {
  type: "update";
  path: string;
  move_path?: string;
  chunks: UpdateChunk[];
}

export type Hunk = AddHunk | DeleteHunk | UpdateHunk;

export interface PatchResult {
  path: string;
  type: "add" | "delete" | "update" | "skip" | "error";
  message: string;
  oldContent?: string;
  newContent?: string;
}

interface FileBackup {
  path: string;
  existed: boolean;
  content?: string;
}

export interface ApplyPatchOptions {
  workdir?: string;
  /** Dry run: validate but don't write */
  dryRun?: boolean;
  /** Create parent directories if missing */
  createDirs?: boolean;
  /** Max file size to patch */
  maxFileSize?: number;
}

// ── Unified Diff Parser ─────────────────────────────────────

/**
 * Parse a unified diff into structured Hunk objects.
 *
 * Handles:
 * - Single and multi-file patches
 * - New file (add), deleted file (delete), modified file (update)
 * - Renamed/moved files (similarity index + rename from/to)
 * - Binary file notices
 */
export function parseUnifiedDiff(patchText: string, workdir = "."): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = patchText.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // File header: diff --git a/path b/path
    const diffMatch = line?.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diffMatch?.[1] && diffMatch[2]) {
      const oldPath = diffMatch[1];
      const newPath = diffMatch[2];
      const fileLines: string[] = [];
      let fileMode = "";
      let similarityIndex = 0;
      let isBinary = false;

      i++;
      while (i < lines.length && !lines[i]?.startsWith("diff --git ")) {
        const headerLine = lines[i];

        if (headerLine?.startsWith("new file mode")) fileMode = "add";
        else if (headerLine?.startsWith("deleted file mode")) fileMode = "delete";
        else if (headerLine?.startsWith("similarity index")) {
          const pct = headerLine.match(/\d+/)?.[0];
          similarityIndex = pct ? parseInt(pct, 10) : 0;
        } else if (headerLine?.startsWith("rename from")) fileMode = "rename";
        else if (headerLine?.startsWith("rename to")) {
          fileMode = "rename";
        } else if (headerLine?.startsWith("Binary files")) {
          isBinary = true;
        } else if (
          headerLine?.startsWith("--- ") || headerLine?.startsWith("+++ ") ||
          headerLine?.startsWith("@@") || headerLine?.startsWith(" ") ||
          headerLine?.startsWith("+") || headerLine?.startsWith("-")
        ) {
          fileLines.push(headerLine);
        }
        i++;
      }

      if (isBinary) {
        hunks.push({
          type: "skip" as any,
          path: newPath,
          chunks: [],
        });
        continue; // skip binary files
      }

      // Determine operation type
      if (fileMode === "add" || (oldPath === "/dev/null" && newPath !== "/dev/null")) {
        hunks.push(parseAddHunk(newPath, fileLines, workdir));
      } else if (fileMode === "delete" || (newPath === "/dev/null" && oldPath !== "/dev/null")) {
        hunks.push({ type: "delete", path: oldPath });
      } else if (fileMode === "rename" && similarityIndex >= 50) {
        // Treat as update with move_path
        const hunk = parseUpdateHunk(oldPath, newPath, fileLines, workdir);
        hunk.move_path = newPath;
        hunks.push(hunk);
      } else {
        // Standard update
        hunks.push(parseUpdateHunk(oldPath, newPath, fileLines, workdir));
      }
    } else {
      i++;
    }
  }

  return hunks;
}

function parseAddHunk(path: string, lines: string[], _workdir: string): AddHunk {
  const contentLines: string[] = [];
  let inChunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inChunk = true;
      continue;
    }
    if (!inChunk) continue;
    if (line.startsWith("+")) contentLines.push(line.slice(1));
    else if (line === "\\ No newline at end of file") continue;
  }
  return { type: "add", path, contents: contentLines.join("\n") };
}

function parseUpdateHunk(
  oldPath: string, _newPath: string, lines: string[], workdir: string,
): UpdateHunk {
  const chunks: UpdateChunk[] = [];
  let currentChunk: UpdateChunk | null = null;
  let lineNum = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s*(.*)/);
    if (hunkMatch?.[1] && hunkMatch[3]) {
      if (currentChunk && (currentChunk.old_lines.length || currentChunk.new_lines.length)) {
        chunks.push(currentChunk);
      }
      currentChunk = {
        old_lines: [],
        new_lines: [],
        old_start: parseInt(hunkMatch[1], 10),
        new_start: parseInt(hunkMatch[3], 10),
      };
      const context = hunkMatch[5]?.trim();
      if (context) currentChunk.change_context = context;
      lineNum = parseInt(hunkMatch[3], 10);
      continue;
    }

    if (!currentChunk) continue;

    if (line.startsWith(" ")) {
      // Context line — appears in both old and new
      currentChunk.old_lines.push(line.slice(1));
      currentChunk.new_lines.push(line.slice(1));
      lineNum++;
    } else if (line.startsWith("-")) {
      currentChunk.old_lines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      currentChunk.new_lines.push(line.slice(1));
      lineNum++;
    }
    // No newline at EOF marker
    else if (line === "\\ No newline at end of file") {
      if (currentChunk) {
        currentChunk.is_end_of_file = true;
      }
    }
  }

  if (currentChunk && (currentChunk.old_lines.length || currentChunk.new_lines.length)) {
    chunks.push(currentChunk);
  }

  return { type: "update", path: oldPath, chunks };
}

// ── Apply ──────────────────────────────────────────────────

/**
 * Apply a parsed patch to the filesystem.
 * Returns results for each hunk.
 */
export function applyPatch(
  patchText: string,
  options: ApplyPatchOptions = {},
): PatchResult[] {
  const textError = validatePatchText(patchText);
  if (textError) return [{ path: "unknown", type: "error", message: textError }];
  const workdir = resolve(options.workdir || ".");
  const hunks = parseUnifiedDiff(patchText, workdir);
  if (!hunks.length) {
    return [{ path: "unknown", type: "error", message: "No valid patch hunks found." }];
  }
  const hunkError = validatePatchHunks(hunks);
  if (hunkError) return [{ path: "unknown", type: "error", message: hunkError }];
  const validation = applyHunks(hunks, workdir, { ...options, dryRun: true });
  if (validation.some(result => result.type === "error")) {
    return validation;
  }
  if (options.dryRun) return validation;
  const backups = backupPatchPaths(hunks, workdir);
  const results = applyHunks(hunks, workdir, options);
  if (results.some(result => result.type === "error")) {
    restoreBackups(backups);
  }
  return results;
}

function applyHunks(hunks: Hunk[], workdir: string, options: ApplyPatchOptions): PatchResult[] {
  const results: PatchResult[] = [];
  for (const hunk of hunks) {
    try {
      results.push(applyHunk(hunk, workdir, options));
    } catch (e: any) {
      results.push({ path: safePatchDisplay((hunk as any).path || "unknown"), type: "error", message: safePatchDisplay(e.message) });
    }
  }
  return results;
}

function applyHunk(
  hunk: Hunk, workdir: string, options: ApplyPatchOptions,
): PatchResult {
  const fullPath = resolvePatchPath(workdir, (hunk as any).path);

  switch (hunk.type) {
    case "add": {
      const parent = dirname(fullPath);
      if ((hunk as AddHunk).contents.length > MAX_PATCH_FILE_CONTENT_CHARS) {
        return {
          path: relative(workdir, fullPath),
          type: "error",
          message: `Patch content too large: ${(hunk as AddHunk).contents.length} bytes`,
        };
      }
      if (existsSync(fullPath)) {
        return {
          path: relative(workdir, fullPath),
          type: "error",
          message: `File already exists: ${relative(workdir, fullPath)}`,
        };
      }
      if (options.createDirs === false && !existsSync(parent)) {
        return {
          path: relative(workdir, fullPath),
          type: "error",
          message: `Parent directory not found: ${relative(workdir, parent)}`,
        };
      }
      if (!options.dryRun) {
        if (options.createDirs !== false) {
          mkdirSync(parent, { recursive: true });
        }
        writeTextFileAtomic(fullPath, (hunk as AddHunk).contents);
      }
      return {
        path: relative(workdir, fullPath),
        type: "add",
        message: `Created: ${(hunk as AddHunk).contents.length} bytes`,
        newContent: (hunk as AddHunk).contents,
      };
    }

    case "delete": {
      if (!existsSync(fullPath)) {
        return {
          path: relative(workdir, fullPath),
          type: "error",
          message: `File not found: ${relative(workdir, fullPath)}`,
        };
      }
      const stat = statSync(fullPath);
      const maxSize = options.maxFileSize || 5 * 1024 * 1024;
      if (!stat.isFile()) {
        return {
          path: relative(workdir, fullPath),
          type: "error",
          message: `Not a regular file: ${relative(workdir, fullPath)}`,
        };
      }
      if (stat.size > maxSize) {
        return {
          path: relative(workdir, fullPath),
          type: "error",
          message: `File too large: ${stat.size} bytes (max ${maxSize})`,
        };
      }
      const oldContent = readFileSync(fullPath, "utf-8");
      if (!options.dryRun) {
        unlinkSync(fullPath);
      }
      return {
        path: relative(workdir, fullPath),
        type: "delete",
        message: "Deleted",
        oldContent,
      };
    }

    case "update": {
      const updateHunk = hunk as UpdateHunk;
      const sourcePath = fullPath;
      const targetPath = updateHunk.move_path
        ? resolvePatchPath(workdir, updateHunk.move_path)
        : sourcePath;

      if (!existsSync(sourcePath)) {
        return {
          path: relative(workdir, sourcePath),
          type: "error",
          message: `File not found: ${relative(workdir, sourcePath)}`,
        };
      }

      const maxSize = options.maxFileSize || 5 * 1024 * 1024; // 5MB
      const stat = statSync(sourcePath);
      if (!stat.isFile()) {
        return {
          path: relative(workdir, sourcePath),
          type: "error",
          message: `Not a regular file: ${relative(workdir, sourcePath)}`,
        };
      }
      if (stat.size > maxSize) {
        return {
          path: relative(workdir, sourcePath),
          type: "error",
          message: `File too large: ${stat.size} bytes (max ${maxSize})`,
        };
      }

      const targetParent = dirname(targetPath);
      if (updateHunk.move_path && targetPath !== fullPath && existsSync(targetPath)) {
        return {
          path: relative(workdir, targetPath),
          type: "error",
          message: `Target already exists: ${relative(workdir, targetPath)}`,
        };
      }
      if (options.createDirs === false && !existsSync(targetParent)) {
        return {
          path: relative(workdir, targetPath),
          type: "error",
          message: `Parent directory not found: ${relative(workdir, targetParent)}`,
        };
      }

      const oldContent = readFileSync(sourcePath, "utf-8");
      const applied = applyUpdateChunks(oldContent, updateHunk.chunks);
      if (!applied.ok) {
        return {
          path: relative(workdir, targetPath),
          type: "error",
          message: `Chunk not found in file. Context: ${applied.context || "none"}`,
          oldContent,
        };
      }
      const newContent = applied.content;

      if (updateHunk.move_path && targetPath !== fullPath) {
        // Rename: write to new path, delete old
        if (!options.dryRun) {
          if (options.createDirs !== false) {
            mkdirSync(targetParent, { recursive: true });
          }
          writeTextFileAtomic(targetPath, newContent);
          if (existsSync(sourcePath)) unlinkSync(sourcePath);
        }
      } else {
        if (!options.dryRun) {
          writeTextFileAtomic(sourcePath, newContent);
        }
      }

      return {
        path: relative(workdir, targetPath),
        type: "update",
        message: `Updated: ${(updateHunk as UpdateHunk).chunks.length} chunk(s)${updateHunk.move_path ? ` (moved from ${relative(workdir, fullPath)})` : ""}`,
        oldContent,
        newContent,
      };
    }

    default:
      return {
        path: (hunk as any).path || "unknown",
        type: "skip",
        message: "Unknown hunk type",
      };
  }
}

function applyUpdateChunks(
  content: string,
  chunks: UpdateChunk[],
): { ok: true; content: string } | { ok: false; context?: string } {
  const lines = content.split("\n");
  let searchStart = 0;
  for (const chunk of chunks) {
    const matchIndex = findChunkStart(lines, chunk, searchStart);
    if (matchIndex < 0) {
      return chunk.change_context ? { ok: false, context: chunk.change_context } : { ok: false };
    }
    const oldLineCount = chunk.old_lines.length;
    lines.splice(matchIndex, oldLineCount, ...chunk.new_lines);
    searchStart = matchIndex + chunk.new_lines.length;
  }
  return { ok: true, content: lines.join("\n") };
}

function findChunkStart(lines: string[], chunk: UpdateChunk, searchStart: number): number {
  const oldLines = chunk.old_lines;
  if (!oldLines.length) return Math.max(0, Math.min(searchStart, lines.length));
  const preferredStart = Number.isFinite(chunk.old_start) ? Math.max(0, (chunk.old_start || 1) - 1) : -1;
  if (preferredStart >= 0 && matchesChunkAt(lines, oldLines, preferredStart)) return preferredStart;
  for (let start = Math.max(0, searchStart); start <= lines.length - oldLines.length; start++) {
    if (matchesChunkAt(lines, oldLines, start)) return start;
  }
  for (let start = 0; start < Math.max(0, searchStart); start++) {
    if (matchesChunkAt(lines, oldLines, start)) return start;
  }
  return -1;
}

function matchesChunkAt(lines: string[], oldLines: string[], start: number): boolean {
  if (start < 0 || start + oldLines.length > lines.length) return false;
  for (let offset = 0; offset < oldLines.length; offset++) {
    if (lines[start + offset] !== oldLines[offset]) return false;
  }
  return true;
}

function backupPatchPaths(hunks: Hunk[], workdir: string): FileBackup[] {
  const paths = new Set<string>();
  for (const hunk of hunks) {
    const source = resolvePatchPath(workdir, (hunk as any).path);
    paths.add(source);
    if (hunk.type === "update" && (hunk as UpdateHunk).move_path) {
      paths.add(resolvePatchPath(workdir, (hunk as UpdateHunk).move_path!));
    }
  }
  return [...paths].map(path => {
    const existed = existsSync(path);
    const backup: FileBackup = { path, existed };
    if (existed) backup.content = readFileSync(path, "utf-8");
    return backup;
  });
}

function restoreBackups(backups: FileBackup[]): void {
  for (const backup of backups.reverse()) {
    try {
      if (backup.existed) {
        mkdirSync(dirname(backup.path), { recursive: true });
        writeTextFileAtomic(backup.path, backup.content || "");
      } else if (existsSync(backup.path)) {
        unlinkSync(backup.path);
      }
    } catch {
      // best-effort rollback; original patch error remains authoritative
    }
  }
}

function resolvePatchPath(workdir: string, patchPath: string): string {
  const normalized = stripPatchPrefix(patchPath);
  const pathError = validatePatchPathText(normalized);
  if (pathError || isAbsolute(normalized)) {
    throw new Error(pathError || `Unsafe patch path: ${safePatchDisplay(patchPath)}`);
  }
  const resolved = resolve(workdir, normalized);
  const rel = relative(workdir, resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    assertRealPathInsideWorkdir(resolved, workdir, patchPath);
    return resolved;
  }
  throw new Error(`Patch path escapes workdir: ${safePatchDisplay(patchPath)}`);
}

function stripPatchPrefix(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(?:a|b)\//, "");
}

function assertRealPathInsideWorkdir(path: string, workdir: string, patchPath: string): void {
  const realWorkdir = realpathSync(workdir);
  const realTarget = existsSync(path) ? realpathSync(path) : realpathSync(nearestExistingParent(path));
  const rel = relative(realWorkdir, realTarget);
  if (rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel) && !/^[a-zA-Z]:/.test(rel))) return;
  throw new Error(`Patch path escapes workdir through symlink: ${safePatchDisplay(patchPath)}`);
}

function nearestExistingParent(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return parent;
    current = parent;
  }
  return current;
}

export function formatPatchResult(results: PatchResult[]): string {
  if (!results.length) return "No changes to apply.";

  const byType: Record<string, PatchResult[]> = {};
  for (const r of results.slice(0, MAX_PATCH_RESULT_ITEMS)) {
    (byType[r.type] = byType[r.type] || []).push(r);
  }

  const lines: string[] = [];
  if (results.length > MAX_PATCH_RESULT_ITEMS) lines.push(`[truncated ${results.length - MAX_PATCH_RESULT_ITEMS} patch result(s)]`);
  for (const [type, items] of Object.entries(byType)) {
    const icon = type === "add" ? "+" : type === "delete" ? "-" : type === "update" ? "~" : type === "error" ? "✗" : "○";
    for (const item of items) {
      lines.push(`  ${icon} ${safePatchDisplay(item.path)}: ${safePatchDisplay(item.message, MAX_PATCH_RESULT_LINE_CHARS)}`);
    }
  }
  const diffPreviews = results
    .filter(item => (item.oldContent !== undefined || item.newContent !== undefined) && item.type !== "error")
    .map(item => diffLines(
      safePatchDisplay(item.oldContent || "", MAX_PATCH_DIFF_CHARS),
      safePatchDisplay(item.newContent || "", MAX_PATCH_DIFF_CHARS),
      safePatchDisplay(item.path),
      { maxChars: MAX_PATCH_DIFF_CHARS },
    ))
    .filter(Boolean);
  if (diffPreviews.length) {
    lines.push("", "[diff]", ...diffPreviews);
  }
  return boundedPatchOutput(lines.join("\n"));
}

function validatePatchText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "patch must be a non-empty string";
  if (value.length > MAX_PATCH_TEXT_CHARS) return `patch must be ${MAX_PATCH_TEXT_CHARS} characters or fewer`;
  if (PATCH_CONTROL_RE.test(value)) return "patch contains unsupported control characters";
  const lines = value.split("\n");
  if (lines.length > MAX_PATCH_LINES) return `patch must contain ${MAX_PATCH_LINES} lines or fewer`;
  if (lines.some(line => line.length > MAX_PATCH_LINE_CHARS)) return `patch lines must be ${MAX_PATCH_LINE_CHARS} characters or fewer`;
  return null;
}

function validatePatchHunks(hunks: Hunk[]): string | null {
  if (hunks.length > MAX_PATCH_HUNKS) return `patch must contain ${MAX_PATCH_HUNKS} file hunks or fewer`;
  let chunks = 0;
  for (const hunk of hunks) {
    const pathError = validatePatchPathText((hunk as any).path);
    if (pathError) return pathError;
    if (hunk.type === "add" && hunk.contents.length > MAX_PATCH_FILE_CONTENT_CHARS) {
      return `patch file content must be ${MAX_PATCH_FILE_CONTENT_CHARS} characters or fewer`;
    }
    if (hunk.type === "update") {
      if (hunk.move_path) {
        const moveError = validatePatchPathText(hunk.move_path);
        if (moveError) return moveError;
      }
      chunks += hunk.chunks.length;
      if (chunks > MAX_PATCH_CHUNKS) return `patch must contain ${MAX_PATCH_CHUNKS} chunks or fewer`;
    }
  }
  return null;
}

function validatePatchPathText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "Unsafe patch path";
  if (value.length > MAX_PATCH_PATH_CHARS) return `patch path must be ${MAX_PATCH_PATH_CHARS} characters or fewer`;
  if (PATCH_CONTROL_RE.test(value)) return "patch path contains unsupported control characters";
  if (value === "." || value === "..") return "Unsafe patch path";
  return null;
}

function safePatchDisplay(value: unknown, maxChars = MAX_PATCH_PATH_CHARS): string {
  return safeSliceTextBoundary(String(value ?? "").replace(PATCH_CONTROL_GLOBAL_RE, " "), maxChars);
}

function boundedPatchOutput(value: string): string {
  return value.length > MAX_PATCH_RESULT_CHARS ? `${safeSliceTextBoundary(value, MAX_PATCH_RESULT_CHARS)}\n[truncated]` : value;
}
