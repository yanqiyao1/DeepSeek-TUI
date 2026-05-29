import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_PATH_INPUT_CHARS = 8_192;
const NUL_RE = /\u0000/;

export function nearestExistingParent(path: string): string {
  let current = safeResolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return parent;
    current = parent;
  }
  return current;
}

export function canonicalizePath(path: string): string {
  return realpathSync(safeResolve(path));
}

export function canonicalizePathOrNearestExisting(path: string): string {
  const resolved = safeResolve(path);
  if (existsSync(resolved)) return realpathSync(resolved);
  let current = resolved;
  const missingSegments: string[] = [];
  while (!existsSync(current)) {
    missingSegments.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return resolve(realpathSync(current), ...missingSegments);
}

export function resolvePathFromBase(rawPath: string, base: string): string {
  const expanded = expandHomeAlias(normalizePathInput(rawPath));
  const resolvedBase = safeResolve(base);
  return resolve(isAbsolute(expanded) ? expanded : resolve(resolvedBase, expanded));
}

export function resolvePathAlias(rawPath: string, base: string): string {
  return resolvePathFromBase(rawPath.trim(), base);
}

export function isPathInsideRoot(path: string, root: string): boolean {
  try {
    const rel = relative(normalizePathInput(root), normalizePathInput(path));
    return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
  } catch {
    return false;
  }
}

export function canonicalizeWorkspaceBoundary(path: string, workspace: string): boolean {
  try {
    return isPathInsideRoot(
      canonicalizePathOrNearestExisting(path),
      canonicalizePathOrNearestExisting(workspace),
    );
  } catch {
    return false;
  }
}

function safeResolve(path: string): string {
  return resolve(normalizePathInput(path));
}

function normalizePathInput(path: string): string {
  if (typeof path !== "string") throw new Error("path must be a string");
  if (path.length > MAX_PATH_INPUT_CHARS) throw new Error("path is too long");
  if (NUL_RE.test(path)) throw new Error("path contains unsupported NUL characters");
  return path;
}

function expandHomeAlias(path: string): string {
  if (path === "~") return process.env.HOME || path;
  if (path.startsWith("~/")) return process.env.HOME ? resolve(process.env.HOME, path.slice(2)) : path;
  return path;
}
