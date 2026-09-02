/** File operation tools: read, write, edit, ls, search, glob. */

import { readFileSync, readdirSync, statSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { resolve, relative, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { PermissionLevel, type ToolDef } from "./base.js";
import { getRegistry } from "./registry.js";
import { diffLines } from "../ui/renderer.js";
import { writeTextFileAtomic } from "./atomic-write.js";
import { nearestExistingParent, resolvePathAlias } from "./path-resolution.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

type FileToolExtras = Partial<Omit<ToolDef, "name" | "description" | "parameters" | "execute" | "permission" | "category" | "parallelOk">>;
const FILE_DIFF_MAX_LINES = 160;
const FILE_DIFF_MAX_CHARS = 12_000;
const MAX_FILE_PATH_CHARS = 4_096;
const MAX_FILE_PATTERN_CHARS = 2_000;
const MAX_FILE_INCLUDE_CHARS = 512;
const MAX_FILE_READ_BYTES = 5 * 1024 * 1024;
const MAX_FILE_EDIT_BYTES = 5 * 1024 * 1024;
const MAX_FILE_WRITE_CHARS = 5 * 1024 * 1024;
const MAX_FILE_READ_LINES = 20_000;
const MAX_FILE_OUTPUT_CHARS = 80_000;
const MAX_FILE_OUTPUT_LINE_CHARS = 4_000;
const MAX_GLOB_WALK_ENTRIES = 20_000;
const MAX_GLOB_RESULTS = 200;
const PATH_ALIASES = ["path", "file", "file_path", "filepath", "filename", "target_file", "target_path", "output_path"];
const CONTENT_ALIASES = ["content", "text", "body", "contents", "data"];
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const UNREADABLE_FILE_ARG = Symbol("unreadable_file_arg");
const FILE_TYPED_ARG_KEYS = new Set([
  "__workspace_path",
  "body",
  "case_sensitive",
  "content",
  "contents",
  "cwd",
  "data",
  "file",
  "file_path",
  "filename",
  "filepath",
  "include",
  "limit",
  "new_string",
  "offset",
  "old_string",
  "output_path",
  "path",
  "pattern",
  "regex",
  "replace_all",
  "root",
  "target_file",
  "target_path",
  "text",
  "workspace",
]);
let rgAvailableCache: { path: string | undefined; available: boolean } | null = null;

function resolvePath(path: string): string { return resolve(path); }

function resolveFromRoot(path: string, root: string): string {
  return resolve(path.startsWith("/") || /^[a-zA-Z]:/.test(path) ? path : join(root, path));
}

function workspaceRoot(args: Record<string, unknown>, fallbackPath?: string): string {
  const workspacePathInput = safeFileProperty(args, "__workspace_path");
  const workspacePath = typeof workspacePathInput === "string" && workspacePathInput.trim()
    ? workspacePathInput.trim()
    : "";
  const explicitRoot = firstPresentString(args, ["root", "workspace", "cwd"]);
  if (explicitRoot) {
    const base = workspacePath || process.cwd();
    return resolvePathAlias(explicitRoot.trim(), base);
  }
  if (fallbackPath && (String(fallbackPath).startsWith("/") || /^[a-zA-Z]:/.test(String(fallbackPath)))) {
    const resolvedFallback = resolve(String(fallbackPath));
    try {
      return statSync(resolvedFallback).isDirectory() ? resolvedFallback : dirname(resolvedFallback);
    } catch {
      return nearestExistingParent(resolvedFallback);
    }
  }
  return workspacePath || process.cwd();
}

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
}

function resolveExistingPathInsideRoot(path: string, root: string): string {
  const resolvedRoot = realpathSync(resolvePath(root));
  const resolvedPath = realpathSync(resolveFromRoot(path, resolvedRoot));
  if (!isInsideRoot(resolvedPath, resolvedRoot)) {
    throw new Error(`path escapes root through symlink: ${path}`);
  }
  return resolvedPath;
}

function resolveWritablePathInsideRoot(path: string, root: string): string {
  const resolvedRoot = realpathSync(resolvePath(root));
  const target = resolveFromRoot(path, resolvedRoot);
  if (existsSync(target)) {
    const resolvedTarget = realpathSync(target);
    if (!isInsideRoot(resolvedTarget, resolvedRoot)) {
      throw new Error(`path escapes root through symlink: ${path}`);
    }
    return resolvedTarget;
  }
  const nearestExisting = nearestExistingParent(target);
  const realParent = realpathSync(nearestExisting);
  if (!isInsideRoot(realParent, resolvedRoot)) {
    throw new Error(`path escapes root through symlink: ${path}`);
  }
  return target;
}

function executeError(message: string): string {
  return `Error: ${sanitizeOutputText(message, MAX_FILE_OUTPUT_LINE_CHARS)}`;
}

function validateRootAliases(args: Record<string, unknown>): string | null {
  for (const key of ["root", "workspace", "cwd"]) {
    const value = safeFileProperty(args, key);
    if (value !== undefined && typeof value !== "string") return `${key} must be a string`;
    if (typeof value === "string") {
      const error = validateBoundedText(value, key, MAX_FILE_PATH_CHARS, false);
      if (error) return error;
    }
  }
  return null;
}

function validateOptionalNumber(value: unknown, key: string): string | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isSafeInteger(value) ? null : `${key} must be a number`;
  if (typeof value !== "string") return `${key} must be a number`;
  const trimmed = value.trim();
  return /^[-+]?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))
    ? null
    : `${key} must be a number`;
}

function validateOptionalBoolean(value: unknown, key: string): string | null {
  if (value === undefined) return null;
  return typeof value === "boolean" ? null : `${key} must be a boolean`;
}

function requiredPathInput(args: Record<string, unknown>): { ok: true; args: Record<string, unknown>; path: string } | { ok: false; message: string } {
  const normalized = normalizePathArg(args);
  const message = requireString(normalized, "path");
  if (message) return { ok: false, message };
  const pathError = validateBoundedText(normalized.path, "path", MAX_FILE_PATH_CHARS, true);
  return pathError ? { ok: false, message: pathError } : { ok: true, args: normalized, path: normalized.path as string };
}

function optionalPathInput(
  args: Record<string, unknown>,
  defaultPath = ".",
): { ok: true; args: Record<string, unknown>; path: string } | { ok: false; message: string } {
  const normalized = normalizePathArg(args);
  const value = normalized.path;
  if (value === undefined) return { ok: true, args: normalized, path: defaultPath };
  if (typeof value !== "string") return { ok: false, message: "path must be a string" };
  const pathError = validateBoundedText(value, "path", MAX_FILE_PATH_CHARS, false);
  if (pathError) return { ok: false, message: pathError };
  const path = value.trim();
  return { ok: true, args: normalized, path: path || defaultPath };
}

async function readFile(args: Record<string, unknown>): Promise<string> {
  const pathInput = requiredPathInput(args);
  if (!pathInput.ok) return executeError(pathInput.message);
  const rootError = validateRootAliases(pathInput.args);
  if (rootError) return executeError(rootError);
  const offsetInput = safeFileProperty(pathInput.args, "offset");
  const limitInput = safeFileProperty(pathInput.args, "limit");
  const offsetError = validateOptionalNumber(offsetInput, "offset");
  if (offsetError) return executeError(offsetError);
  const limitError = validateOptionalNumber(limitInput, "limit");
  if (limitError) return executeError(limitError);
  const { args: normalized, path } = pathInput;
  const root = workspaceRoot(normalized, path);
  const { offset, limit } = normalizeReadWindow(offsetInput, limitInput);
  try {
    const target = resolveExistingPathInsideRoot(path, String(root));
    const stat = statSync(target);
    if (!stat.isFile()) return executeError("path must point to a file");
    if (stat.size > MAX_FILE_READ_BYTES) return executeError(`file exceeds ${MAX_FILE_READ_BYTES} bytes`);
    const content = readFileSync(target, "utf-8");
    const lines = content.split("\n");
    return sanitizeOutputText(lines.slice(offset, offset + limit).join("\n"), MAX_FILE_OUTPUT_CHARS);
  } catch (e: any) { return formatCaughtError("Error reading file", e); }
}

function normalizeReadWindow(offsetValue: unknown, limitValue: unknown): { offset: number; limit: number } {
  const rawOffset = Number(offsetValue);
  const rawLimit = Number(limitValue);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_FILE_READ_LINES) : 2000;
  return { offset, limit };
}

async function writeFile(args: Record<string, unknown>): Promise<string> {
  const normalized = normalizeWriteArgs(args);
  const pathError = requireString(normalized, "path");
  if (pathError) return executeError(pathError);
  const rootError = validateRootAliases(normalized);
  if (rootError) return executeError(rootError);
  if (typeof normalized.content !== "string") return executeError("content must be a string");
  const path = normalized.path as string;
  const content = normalized.content;
  const pathTextError = validateBoundedText(path, "path", MAX_FILE_PATH_CHARS, true);
  if (pathTextError) return executeError(pathTextError);
  if (content.length > MAX_FILE_WRITE_CHARS) return executeError(`content must be ${MAX_FILE_WRITE_CHARS} characters or fewer`);
  const root = workspaceRoot(normalized, path);
  try {
    const target = resolveWritablePathInsideRoot(path, String(root));
    let oldContent = "";
    if (existsSync(target)) {
      const stat = statSync(target);
      if (!stat.isFile()) return executeError("path must point to a file");
      if (stat.size > MAX_FILE_EDIT_BYTES) return executeError(`existing file exceeds ${MAX_FILE_EDIT_BYTES} bytes`);
      oldContent = readFileSync(target, "utf-8");
    }
    writeTextFileAtomic(target, content);
    return sanitizeOutputText([
      `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`,
      "",
      "[diff]",
      diffLines(oldContent, content, path, { maxLines: FILE_DIFF_MAX_LINES, maxChars: FILE_DIFF_MAX_CHARS }),
    ].join("\n"), MAX_FILE_OUTPUT_CHARS);
  } catch (e: any) { return formatCaughtError("Error writing file", e); }
}

async function editFile(args: Record<string, unknown>): Promise<string> {
  const normalized = normalizeEditArgs(args);
  const pathError = requireString(normalized, "path");
  if (pathError) return executeError(pathError);
  const rootError = validateRootAliases(normalized);
  if (rootError) return executeError(rootError);
  const replaceAllInput = safeFileProperty(normalized, "replace_all");
  const replaceAllError = validateOptionalBoolean(replaceAllInput, "replace_all");
  if (replaceAllError) return executeError(replaceAllError);
  if (typeof normalized.old_string !== "string" || !normalized.old_string) {
    return executeError("old_string must be a non-empty string");
  }
  if (typeof normalized.new_string !== "string") return executeError("new_string must be a string");
  const path = normalized.path as string;
  const pathTextError = validateBoundedText(path, "path", MAX_FILE_PATH_CHARS, true);
  if (pathTextError) return executeError(pathTextError);
  const oldError = validateBoundedText(normalized.old_string, "old_string", MAX_FILE_PATTERN_CHARS, true);
  if (oldError) return executeError(oldError);
  const newError = validateBoundedText(normalized.new_string, "new_string", MAX_FILE_WRITE_CHARS, false);
  if (newError) return executeError(newError);
  const root = workspaceRoot(normalized, path);
  const oldString = normalized.old_string;
  const newString = normalized.new_string;
  const replaceAll = replaceAllInput === true;
  try {
    const target = resolveExistingPathInsideRoot(path, String(root));
    const stat = statSync(target);
    if (!stat.isFile()) return executeError("path must point to a file");
    if (stat.size > MAX_FILE_EDIT_BYTES) return executeError(`file exceeds ${MAX_FILE_EDIT_BYTES} bytes`);
    const content = readFileSync(target, "utf-8");
    const count = content.split(oldString).length - 1;
    if (count === 0) return `Error: old_string not found in ${path}`;
    if (!replaceAll && count > 1) return `Error: old_string found ${count} times. Use replace_all=true or provide more context.`;
    const nextContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
    writeTextFileAtomic(target, nextContent);
    return sanitizeOutputText([
      `Successfully edited ${path}`,
      "",
      "[diff]",
      diffLines(content, nextContent, path, { maxLines: FILE_DIFF_MAX_LINES, maxChars: FILE_DIFF_MAX_CHARS }),
    ].join("\n"), MAX_FILE_OUTPUT_CHARS);
  } catch (e: any) { return formatCaughtError("Error editing file", e); }
}

async function ls(args: Record<string, unknown>): Promise<string> {
  const pathInput = optionalPathInput(args);
  if (!pathInput.ok) return executeError(pathInput.message);
  const rootError = validateRootAliases(pathInput.args);
  if (rootError) return executeError(rootError);
  const { args: normalized, path } = pathInput;
  const root = workspaceRoot(normalized, path);
  try {
    const dir = resolveExistingPathInsideRoot(path, root);
    const items = readdirSync(dir, { withFileTypes: true });
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const lines = items.slice(0, 200).map((item) => {
      const suffix = item.isDirectory() ? "/" : "";
      let size = "";
      if (item.isFile()) {
        try { size = ` (${statSync(join(dir, item.name)).size.toLocaleString()} bytes)`; } catch { /* */ }
      }
      return `  ${displayPath(item.name)}${suffix}${size}`;
    });
    return boundedOutput(lines.join("\n") || "(empty directory)");
  } catch (e: any) { return formatCaughtError("Error listing directory", e); }
}

async function search(args: Record<string, unknown>): Promise<string> {
  const patternError = requireString(args, "pattern");
  if (patternError) return executeError(patternError);
  const pathInput = optionalPathInput(args);
  if (!pathInput.ok) return executeError(pathInput.message);
  const rootError = validateRootAliases(pathInput.args);
  if (rootError) return executeError(rootError);
  const { args: normalized, path } = pathInput;
  const patternInput = safeFileProperty(normalized, "pattern");
  const includeInput = safeFileProperty(normalized, "include");
  const caseSensitiveInput = safeFileProperty(normalized, "case_sensitive");
  const regexInput = safeFileProperty(normalized, "regex");
  if (includeInput !== undefined && typeof includeInput !== "string") return executeError("include must be a string");
  const patternTextError = validateBoundedText(patternInput, "pattern", MAX_FILE_PATTERN_CHARS, true);
  if (patternTextError) return executeError(patternTextError);
  const includeTextError = typeof includeInput === "string"
    ? validateBoundedText(includeInput, "include", MAX_FILE_INCLUDE_CHARS, false)
    : null;
  if (includeTextError) return executeError(includeTextError);
  const caseSensitiveError = validateOptionalBoolean(caseSensitiveInput, "case_sensitive");
  if (caseSensitiveError) return executeError(caseSensitiveError);
  const regexError = validateOptionalBoolean(regexInput, "regex");
  if (regexError) return executeError(regexError);
  const pattern = patternInput as string;
  const include = typeof includeInput === "string" ? includeInput : "";
  const caseSensitive = caseSensitiveInput !== false;
  const regex = regexInput === true;
  const boundary = workspaceRoot(normalized, path);
  try {
    const root = resolveExistingPathInsideRoot(path, boundary);
    const rgResult = runRipgrepSearch({ root, pattern, include, caseSensitive, regex });
    if (rgResult !== null) return rgResult;
    const grepArgs = [regex ? "-rnE" : "-rnF"];
    if (!caseSensitive) grepArgs.push("-i");
    grepArgs.push("--directories=recurse", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=.seekcode", "--exclude-dir=.deepseek");
    if (include) grepArgs.push(`--include=${include}`);
    grepArgs.push("--", pattern, root);
    const result = spawnSync("grep", grepArgs, { encoding: "utf-8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
    if (result.status === 1) return `No matches found for '${sanitizeOutputText(pattern, MAX_FILE_OUTPUT_LINE_CHARS)}'`;
    if (result.error) return `Error searching: ${sanitizeOutputText(result.error.message, MAX_FILE_OUTPUT_LINE_CHARS)}`;
    if (result.status && result.status !== 0) return `Error searching: ${sanitizeOutputText(result.stderr || `grep exited with ${result.status}`, MAX_FILE_OUTPUT_LINE_CHARS)}`;
    return boundedOutput(result.stdout.split("\n").filter(Boolean).slice(0, 500).map(line => sanitizeOutputText(line, MAX_FILE_OUTPUT_LINE_CHARS)).join("\n") || `No matches found for '${sanitizeOutputText(pattern, MAX_FILE_OUTPUT_LINE_CHARS)}'`);
  } catch (e: any) {
    if (e.code === 1 || e.status === 1) return `No matches found for '${sanitizeOutputText(pattern, MAX_FILE_OUTPUT_LINE_CHARS)}'`;
    return formatCaughtError("Error searching", e);
  }
}

async function glob(args: Record<string, unknown>): Promise<string> {
  const patternError = requireString(args, "pattern");
  if (patternError) return executeError(patternError);
  const pathInput = optionalPathInput(args);
  if (!pathInput.ok) return executeError(pathInput.message);
  const rootError = validateRootAliases(pathInput.args);
  if (rootError) return executeError(rootError);
  const { args: normalized, path } = pathInput;
  const pattern = safeFileProperty(normalized, "pattern") as string;
  const patternTextError = validateBoundedText(pattern, "pattern", MAX_FILE_PATTERN_CHARS, true);
  if (patternTextError) return executeError(patternTextError);
  const boundary = workspaceRoot(normalized, path);
  try {
    const results: string[] = [];
    let scanned = 0;
    let truncated = false;
    const root = resolveExistingPathInsideRoot(path, boundary);
    const rgResult = runRipgrepGlob(root, pattern);
    if (rgResult !== null) return rgResult;
    const matcher = globToRegExp(pattern);
    function walk(dir: string) {
      if (truncated || results.length >= MAX_GLOB_RESULTS) return;
      try {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          scanned++;
          if (scanned > MAX_GLOB_WALK_ENTRIES) {
            truncated = true;
            return;
          }
          const full = join(dir, item.name);
          let realFull: string;
          try { realFull = realpathSync(full); }
          catch { continue; }
          if (!isInsideRoot(realFull, root)) continue;
          const rel = relative(root, full).replace(/\\/g, "/");
          if (item.isDirectory()) {
            if (!item.name.startsWith(".") && item.name !== "node_modules") walk(full);
            continue;
          }
          if (matcher.test(rel)) results.push(full);
          if (results.length >= MAX_GLOB_RESULTS) {
            truncated = true;
            return;
          }
        }
      } catch { /* */ }
    }
    walk(root);
    if (!results.length) return `No files matching '${sanitizeOutputText(pattern, MAX_FILE_OUTPUT_LINE_CHARS)}'`;
    const suffix = truncated ? "\n[truncated]" : "";
    return boundedOutput(`${results.map(m => `  ${displayPath(relative(root, m).replace(/\\/g, "/"))}`).join("\n")}${suffix}`);
  } catch (e: any) { return formatCaughtError("Error in glob", e); }
}

function hasRipgrep(): boolean {
  const path = process.env.PATH;
  const cached = rgAvailableCache;
  if (cached && cached.path === path) return cached.available;
  const result = spawnSync("rg", ["--version"], { encoding: "utf-8", timeout: 1000, maxBuffer: 64 * 1024 });
  const available = result.status === 0;
  rgAvailableCache = { path, available };
  return available;
}

function runRipgrepSearch(options: {
  root: string;
  pattern: string;
  include: string;
  caseSensitive: boolean;
  regex: boolean;
}): string | null {
  if (!hasRipgrep()) return null;
  const args = [
    "--line-number",
    "--no-heading",
    "--color", "never",
    "--glob", "!node_modules",
    "--glob", "!.git",
    "--glob", "!.seekcode",
    "--glob", "!.deepseek",
  ];
  if (!options.regex) args.push("--fixed-strings");
  if (!options.caseSensitive) args.push("--ignore-case");
  if (options.include) args.push("--glob", options.include);
  args.push("--", options.pattern, options.root);
  const result = spawnSync("rg", args, { encoding: "utf-8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
  if (result.status === 1) return `No matches found for '${sanitizeOutputText(options.pattern, MAX_FILE_OUTPUT_LINE_CHARS)}'\n[backend: rg]`;
  if (result.error) return null;
  if (result.status && result.status !== 0) return `Error searching: ${sanitizeOutputText(result.stderr || `rg exited with ${result.status}`, MAX_FILE_OUTPUT_LINE_CHARS)}`;
  const lines = result.stdout.split("\n").filter(Boolean).slice(0, 500).map(line => sanitizeOutputText(line, MAX_FILE_OUTPUT_LINE_CHARS));
  return boundedOutput(`${lines.join("\n") || `No matches found for '${sanitizeOutputText(options.pattern, MAX_FILE_OUTPUT_LINE_CHARS)}'`}\n[backend: rg]`);
}

function runRipgrepGlob(root: string, pattern: string): string | null {
  if (!hasRipgrep()) return null;
  const result = spawnSync("rg", [
    "--files",
    "--glob", pattern,
    "--glob", "!node_modules",
    "--glob", "!.git",
    "--glob", "!.seekcode",
    "--glob", "!.deepseek",
  ], { cwd: root, encoding: "utf-8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return null;
  if (result.status === 1) return `No files matching '${sanitizeOutputText(pattern, MAX_FILE_OUTPUT_LINE_CHARS)}'\n[backend: rg]`;
  if (result.status && result.status !== 0) return null;
  const files = result.stdout.split("\n").filter(Boolean).slice(0, 200);
  if (!files.length) return `No files matching '${sanitizeOutputText(pattern, MAX_FILE_OUTPUT_LINE_CHARS)}'\n[backend: rg]`;
  return boundedOutput(`${files.map(file => `  ${renderRgFilePath(root, file)}`).join("\n")}\n[backend: rg]`);
}

function renderRgFilePath(root: string, file: string): string {
  const rendered = file.startsWith("/") || /^[a-zA-Z]:/.test(file)
    ? relative(root, file)
    : file;
  return displayPath(rendered.replace(/\\/g, "/").replace(/^\.\//, ""));
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === undefined) continue;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const followedBySlash = pattern[i + 2] === "/";
        out += followedBySlash ? "(?:.*\/)?" : ".*";
        i += followedBySlash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out);
}

function requireString(args: Record<string, unknown>, key: string): string | null {
  const value = safeFileProperty(args, key);
  if (typeof value !== "string" || !value.trim()) return `${key} must be a non-empty string`;
  return validateBoundedText(value, key, key === "pattern" ? MAX_FILE_PATTERN_CHARS : MAX_FILE_PATH_CHARS, true);
}

function firstPresentString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = safeFileProperty(args, key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstPresentContent(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = safeFileProperty(args, key);
    if (typeof value === "string") return value;
  }
  return undefined;
}

function normalizePathArg(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = safeFileCloneArgs(args);
  const pathInput = safeFileProperty(normalized, "path");
  if (typeof pathInput === "string" && pathInput.trim()) return normalized;
  const path = firstPresentString(args, PATH_ALIASES);
  return path ? { ...normalized, path } : normalized;
}

function normalizeWriteArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizePathArg(args);
  if (typeof safeFileProperty(normalized, "content") === "string") return normalized;
  const content = firstPresentContent(normalized, CONTENT_ALIASES);
  return content !== undefined ? { ...normalized, content } : normalized;
}

function normalizeEditArgs(args: Record<string, unknown>): Record<string, unknown> {
  return normalizePathArg(args);
}

function renderFileResult(kind: "text" | "diff") {
  return (result: string) => ({
    kind,
    title: kind === "diff" ? "File change" : "File result",
    preview: result,
  });
}

function toolPath(args: Record<string, unknown>, fallback = "file"): string {
  const normalized = normalizePathArg(args);
  const pathInput = safeFileProperty(normalized, "path");
  const value = typeof pathInput === "string" && pathInput.trim()
    ? pathInput.trim()
    : fallback;
  return sanitizeOutputText(value, MAX_FILE_OUTPUT_LINE_CHARS);
}

function filePermissionPatterns(args: Record<string, unknown>): string[] {
  return [toolPath(args)].map(path => sanitizeOutputText(path, MAX_FILE_PATH_CHARS)).filter(path => path && path !== "file");
}

function fileActivity(action: string, fallback = "file") {
  return (args: Record<string, unknown>) => `${action} ${toolPath(args, fallback)}`;
}

function fileSummary(action: string, fallback = "file") {
  return (args: Record<string, unknown>) => `${action} ${toolPath(args, fallback)}`;
}

function filePatternText(args: Record<string, unknown>): string {
  const pattern = safeFileProperty(args, "pattern");
  return typeof pattern === "string" && pattern.trim() ? pattern.trim() : "";
}

function textSearch(result: string): string {
  return result;
}

export function registerFileTools(): void {
  const r = getRegistry();
  const t = (
    name: string, desc: string, props: Record<string, unknown>, required: string[],
    fn: (a: Record<string, unknown>) => Promise<string>, perm: PermissionLevel, cat: string, pok: boolean,
    extra: FileToolExtras = {},
  ) => r.register({
    name, description: desc,
    parameters: { type: "object", properties: props, required },
    execute: fn, permission: perm, category: cat, parallelOk: pok,
    ...extra,
  });
  t("read", "Read a file from the filesystem.", { path: { type: "string" }, root: { type: "string", description: "Optional root boundary for symlink safety." }, offset: { type: "integer", default: 0 }, limit: { type: "integer", default: 2000 } }, ["path"], readFile, PermissionLevel.ALWAYS_ALLOW, "file", true, {
    aliases: ["file_read"],
    searchHint: "inspect file contents",
    readOnly: true,
    resultKind: "text",
    renderResult: renderFileResult("text"),
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
    getPermissionPatterns: filePermissionPatterns,
    getActivityDescription: fileActivity("Reading"),
    getToolUseSummary: fileSummary("Read"),
    getTranscriptSearchText: textSearch,
    renderMetadata: { userFacingName: "Read", icon: "file-text", resultKind: "text" },
    validateInput: (args) => {
      const normalized = normalizePathArg(args);
      const message = requireString(normalized, "path");
      if (message) return { ok: false, message };
      const rootError = validateRootAliases(normalized);
      if (rootError) return { ok: false, message: rootError };
      const offsetError = validateOptionalNumber(normalized.offset, "offset");
      if (offsetError) return { ok: false, message: offsetError };
      const limitError = validateOptionalNumber(normalized.limit, "limit");
      if (limitError) return { ok: false, message: limitError };
      return { ok: true, args: normalized };
    },
  });
  t("write", "Write content to a file.", { path: { type: "string" }, content: { type: "string" }, root: { type: "string", description: "Optional root boundary for symlink safety." } }, ["path", "content"], writeFile, PermissionLevel.ASK, "file", false, {
    searchHint: "create overwrite file",
    destructive: true,
    resultKind: "diff",
    renderResult: renderFileResult("diff"),
    maxResultSizeChars: FILE_DIFF_MAX_CHARS,
    getPermissionPatterns: filePermissionPatterns,
    getActivityDescription: fileActivity("Writing"),
    getToolUseSummary: fileSummary("Write"),
    getTranscriptSearchText: textSearch,
    renderMetadata: { userFacingName: "Write", icon: "file-plus", resultKind: "diff" },
    validateInput: (args) => {
      const normalized = normalizeWriteArgs(args);
      const pathError = requireString(normalized, "path");
      if (pathError) return { ok: false, message: pathError };
      const rootError = validateRootAliases(normalized);
      if (rootError) return { ok: false, message: rootError };
      if (typeof normalized.content === "string" && normalized.content.length > MAX_FILE_WRITE_CHARS) {
        return { ok: false, message: `content must be ${MAX_FILE_WRITE_CHARS} characters or fewer` };
      }
      return typeof normalized.content === "string"
        ? { ok: true, args: normalized }
        : { ok: false, message: "content must be a string" };
    },
  });
  t("edit", "Edit a file by replacing old_string with new_string.", { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean", default: false }, root: { type: "string", description: "Optional root boundary for symlink safety." } }, ["path", "old_string", "new_string"], editFile, PermissionLevel.ASK, "file", false, {
    searchHint: "replace text in file",
    destructive: true,
    resultKind: "diff",
    renderResult: renderFileResult("diff"),
    maxResultSizeChars: FILE_DIFF_MAX_CHARS,
    getPermissionPatterns: filePermissionPatterns,
    getActivityDescription: fileActivity("Editing"),
    getToolUseSummary: fileSummary("Edit"),
    getTranscriptSearchText: textSearch,
    renderMetadata: { userFacingName: "Edit", icon: "file-pen", resultKind: "diff" },
    validateInput: (args) => {
      const normalized = normalizeEditArgs(args);
      for (const key of ["path", "old_string"]) {
        const message = requireString(normalized, key);
        if (message) return { ok: false, message };
      }
      const rootError = validateRootAliases(normalized);
      if (rootError) return { ok: false, message: rootError };
      const oldError = validateBoundedText(normalized.old_string, "old_string", MAX_FILE_PATTERN_CHARS, true);
      if (oldError) return { ok: false, message: oldError };
      const newError = validateBoundedText(normalized.new_string, "new_string", MAX_FILE_WRITE_CHARS, false);
      if (newError) return { ok: false, message: newError };
      const replaceAllError = validateOptionalBoolean(normalized.replace_all, "replace_all");
      if (replaceAllError) return { ok: false, message: replaceAllError };
      return typeof normalized.new_string === "string"
        ? { ok: true, args: normalized }
        : { ok: false, message: "new_string must be a string" };
    },
  });
  t("ls", "List directory contents.", { path: { type: "string", default: "." }, root: { type: "string", description: "Optional root boundary for symlink safety." } }, [], ls, PermissionLevel.ALWAYS_ALLOW, "file", true, {
    aliases: ["list"],
    searchHint: "list directory entries",
    readOnly: true,
    resultKind: "text",
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: false, isList: true }),
    getPermissionPatterns: filePermissionPatterns,
    getActivityDescription: fileActivity("Listing", "files"),
    getToolUseSummary: fileSummary("List", "files"),
    getTranscriptSearchText: textSearch,
    renderMetadata: { userFacingName: "List", icon: "folder", resultKind: "text" },
    validateInput: (args) => {
      const pathInput = optionalPathInput(args);
      if (!pathInput.ok) return { ok: false, message: pathInput.message };
      const rootError = validateRootAliases(pathInput.args);
      return rootError ? { ok: false, message: rootError } : { ok: true, args: pathInput.args };
    },
  });
  t("search", "Search for text using ripgrep when available, falling back to grep.", { pattern: { type: "string" }, path: { type: "string", default: "." }, root: { type: "string", description: "Optional root boundary for symlink safety." }, include: { type: "string", default: "" }, case_sensitive: { type: "boolean", default: true }, regex: { type: "boolean", default: false, description: "Treat pattern as a regular expression instead of a literal string." } }, ["pattern"], search, PermissionLevel.ALWAYS_ALLOW, "file", true, {
    aliases: ["grep"],
    searchHint: "grep text across files",
    readOnly: true,
    resultKind: "text",
    maxResultSizeChars: 80_000,
    isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
    getPermissionPatterns: (args) => [filePatternText(args), toolPath(args, ".")].filter(Boolean),
    getActivityDescription: (args) => filePatternText(args)
      ? `Searching for ${sanitizeOutputText(filePatternText(args), MAX_FILE_OUTPUT_LINE_CHARS)}`
      : "Searching files",
    getToolUseSummary: (args) => filePatternText(args)
      ? `Search ${sanitizeOutputText(filePatternText(args), MAX_FILE_OUTPUT_LINE_CHARS)}`
      : "Search files",
    getTranscriptSearchText: textSearch,
    renderMetadata: { userFacingName: "Search", icon: "search", resultKind: "text" },
    validateInput: (args) => {
      const normalized = normalizePathArg(args);
      const message = requireString(normalized, "pattern");
      if (message) return { ok: false, message };
      const rootError = validateRootAliases(normalized);
      if (rootError) return { ok: false, message: rootError };
      const patternError = validateBoundedText(safeFileProperty(normalized, "pattern"), "pattern", MAX_FILE_PATTERN_CHARS, true);
      if (patternError) return { ok: false, message: patternError };
      const includeInput = safeFileProperty(normalized, "include");
      if (includeInput !== undefined && typeof includeInput !== "string") {
        return { ok: false, message: "include must be a string" };
      }
      if (typeof includeInput === "string") {
        const includeError = validateBoundedText(includeInput, "include", MAX_FILE_INCLUDE_CHARS, false);
        if (includeError) return { ok: false, message: includeError };
      }
      const caseSensitiveError = validateOptionalBoolean(safeFileProperty(normalized, "case_sensitive"), "case_sensitive");
      if (caseSensitiveError) return { ok: false, message: caseSensitiveError };
      const regexError = validateOptionalBoolean(safeFileProperty(normalized, "regex"), "regex");
      if (regexError) return { ok: false, message: regexError };
      return { ok: true, args: normalized };
    },
  });
  t("glob", "Find files matching a glob pattern.", { pattern: { type: "string" }, path: { type: "string", default: "." }, root: { type: "string", description: "Optional root boundary for symlink safety." } }, ["pattern"], glob, PermissionLevel.ALWAYS_ALLOW, "file", true, {
    aliases: ["find_files"],
    searchHint: "find files by glob",
    readOnly: true,
    resultKind: "text",
    maxResultSizeChars: 80_000,
    isSearchOrReadCommand: () => ({ isSearch: true, isRead: false, isList: true }),
    getPermissionPatterns: (args) => [filePatternText(args), toolPath(args, ".")].filter(Boolean),
    getActivityDescription: (args) => filePatternText(args)
      ? `Finding ${sanitizeOutputText(filePatternText(args), MAX_FILE_OUTPUT_LINE_CHARS)}`
      : "Finding files",
    getToolUseSummary: (args) => filePatternText(args)
      ? `Glob ${sanitizeOutputText(filePatternText(args), MAX_FILE_OUTPUT_LINE_CHARS)}`
      : "Find files",
    getTranscriptSearchText: textSearch,
    renderMetadata: { userFacingName: "Glob", icon: "files", resultKind: "text" },
    validateInput: (args) => {
      const normalized = normalizePathArg(args);
      const message = requireString(normalized, "pattern");
      if (message) return { ok: false, message };
      const rootError = validateRootAliases(normalized);
      if (rootError) return { ok: false, message: rootError };
      const patternError = validateBoundedText(safeFileProperty(normalized, "pattern"), "pattern", MAX_FILE_PATTERN_CHARS, true);
      return patternError ? { ok: false, message: patternError } : { ok: true, args: normalized };
    },
  });
}

function validateBoundedText(value: unknown, key: string, maxChars: number, requireNonEmpty: boolean): string | null {
  if (typeof value !== "string") return `${key} must be a string`;
  const trimmed = value.trim();
  if (requireNonEmpty && !trimmed) return `${key} must be a non-empty string`;
  if (value.length > maxChars) return `${key} must be ${maxChars} characters or fewer`;
  if (CONTROL_TEXT_RE.test(value)) return `${key} contains unsupported control characters`;
  return null;
}

function sanitizeOutputText(value: unknown, maxChars: number): string {
  return safeSliceTextBoundary(String(value ?? "").replace(CONTROL_TEXT_GLOBAL_RE, " "), maxChars);
}

function displayPath(path: string): string {
  return sanitizeOutputText(path.replace(/\\/g, "/"), MAX_FILE_OUTPUT_LINE_CHARS);
}

function boundedOutput(value: string): string {
  return value.length > MAX_FILE_OUTPUT_CHARS ? `${safeSliceTextBoundary(value, MAX_FILE_OUTPUT_CHARS)}\n[truncated]` : value;
}

function formatCaughtError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${sanitizeOutputText(message, MAX_FILE_OUTPUT_LINE_CHARS)}`;
}

function safeFileProperty(source: unknown, key: string): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return FILE_TYPED_ARG_KEYS.has(key) ? null : UNREADABLE_FILE_ARG;
  }
}

function safeFileCloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(args);
  } catch {
    return clone;
  }
  for (const key of keys) {
    const value = safeFileProperty(args, key);
    if (value !== UNREADABLE_FILE_ARG) clone[key] = value;
  }
  return clone;
}
