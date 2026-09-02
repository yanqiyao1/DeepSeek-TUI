/** Atomic text-file writes with best-effort permission preservation. */

import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
}

let atomicWriteCounter = 0;

function isMissingFileError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function existingTargetMode(path: string): number | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${path}`);
    if (!stat.isFile()) throw new Error(`Refusing to write over non-file path: ${path}`);
    return stat.mode;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  return undefined;
}

function cleanupTemp(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

/** Create a directory tree without following pre-existing symlink components. */
function ensureSafeParentDirectory(path: string): void {
  let current = dirname(path);
  const missing: string[] = [];
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to write through symlink: ${path}`);
      break;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`Unable to create parent directory: ${path}`);
      missing.unshift(basename(current));
      current = parent;
    }
  }
  for (const segment of missing) {
    const next = join(current, segment);
    try {
      mkdirSync(next);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to write through symlink: ${path}`);
    current = next;
  }
}

export function writeTextFileAtomic(path: string, content: string, options: AtomicWriteOptions = {}): void {
  const encoding = options.encoding ?? "utf-8";
  ensureSafeParentDirectory(path);

  const existingMode = existingTargetMode(path);
  const targetMode = existingMode ?? options.mode;
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${atomicWriteCounter++}.tmp`);
  const writeOptions: { encoding: BufferEncoding; flush: boolean; flag: string; mode?: number } = {
    encoding,
    flush: true,
    flag: "wx",
  };
  if (targetMode !== undefined) writeOptions.mode = targetMode;

  try {
    writeFileSync(tempPath, content, writeOptions);
    if (existingMode !== undefined) chmodSync(tempPath, existingMode);
    existingTargetMode(path);
    renameSync(tempPath, path);
  } catch (error) {
    cleanupTemp(tempPath);
    throw error;
  }
}
