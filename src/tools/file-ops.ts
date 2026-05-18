/** File operation tools: read, write, edit, ls, search, glob. */

import { readFileSync, readdirSync, statSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { resolve, relative, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { PermissionLevel, type ToolDef } from "./base.js";
import { getRegistry } from "./registry.js";
import { diffLines } from "../ui/renderer.js";
import { writeTextFileAtomic } from "./atomic-write.js";
import { nearestExistingParent, resolvePathAlias } from "./path-resolution.js";

type FileToolExtras = Partial<Omit<ToolDef, "name" | "description" | "parameters" | "execute" | "permission" | "category" | "parallelOk">>;
const FILE_DIFF_MAX_LINES = 160;
const FILE_DIFF_MAX_CHARS = 12_000;
const PATH_ALIASES = ["path", "file", "file_path", "filepath", "filename", "target_file", "target_path", "output_path"];
const CONTENT_ALIASES = ["content", "text", "body", "contents", "data"];
let rgAvailableCache: boolean | null = null;

function resolvePath(path: string): string { return resolve(path); }

function resolveFromRoot(path: string, root: string): string {
  return resolve(path.startsWith("/") || /^[a-zA-Z]:/.test(path) ? path : join(root, path));
}

function workspaceRoot(args: Record<string, unknown>, fallbackPath?: string): string {
  const explicitRoot = firstPresentString(args, ["root", "workspace", "cwd"]);
  if (explicitRoot) {
    const base = typeof args.__workspace_path === "string" && args.__workspace_path.trim()
      ? args.__workspace_path.trim()
      : process.cwd();
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
  return process.cwd();
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
  const nearestExisting = nearestExistingParent(target);
  const realParent = realpathSync(nearestExisting);
  if (!isInsideRoot(realParent, resolvedRoot)) {
    throw new Error(`path escapes root through symlink: ${path}`);
  }
  return target;
}

function executeError(message: string): string {
  return `Error: ${message}`;
}

function validateRootAliases(args: Record<string, unknown>): string | null {
  for (const key of ["root", "workspace", "cwd"]) {
    const value = args[key];
    if (value !== undefined && typeof value !== "string") return `${key} must be a string`;
  }
  return null;
}

function validateOptionalNumber(value: unknown, key: string): string | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : `${key} must be a number`;
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
  return message ? { ok: false, message } : { ok: true, args: normalized, path: normalized.path as string };
}

function optionalPathInput(
  args: Record<string, unknown>,
  defaultPath = ".",
): { ok: true; args: Record<string, unknown>; path: string } | { ok: false; message: string } {
  const normalized = normalizePathArg(args);
  const value = normalized.path;
  if (value === undefined) return { ok: true, args: normalized, path: defaultPath };
  if (typeof value !== "string") return { ok: false, message: "path must be a string" };
  const path = value.trim();
  return { ok: true, args: normalized, path: path || defaultPath };
}

async function readFile(args: Record<string, unknown>): Promise<string> {
  const pathInput = requiredPathInput(args);
  if (!pathInput.ok) return executeError(pathInput.message);
  const rootError = validateRootAliases(pathInput.args);
  if (rootError) return executeError(rootError);
  const offsetError = validateOptionalNumber(args.offset, "offset");
  if (offsetError) return executeError(offsetError);
  const limitError = validateOptionalNumber(args.limit, "limit");
  if (limitError) return executeError(limitError);
  const { args: normalized, path } = pathInput;
  const root = workspaceRoot(normalized, path);
  const { offset, limit } = normalizeReadWindow(args.offset, args.limit);
  try {
    const content = readFileSync(resolveExistingPathInsideRoot(path, String(root)), "utf-8");
    const lines = content.split("\n");
    return lines.slice(offset, offset + limit).join("\n");
  } catch (e: any) { return `Error reading file: ${e.message}`; }
}

function normalizeReadWindow(offsetValue: unknown, limitValue: unknown): { offset: number; limit: number } {
  const rawOffset = Number(offsetValue);
  const rawLimit = Number(limitValue);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 2000;
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
  const root = workspaceRoot(normalized, path);
  try {
    const target = resolveWritablePathInsideRoot(path, String(root));
    const oldContent = existsSync(target) ? readFileSync(target, "utf-8") : "";
    writeTextFileAtomic(target, content);
    return [
      `Successfully wrote ${content.length} bytes to ${path}`,
      "",
      "[diff]",
      diffLines(oldContent, content, path, { maxLines: FILE_DIFF_MAX_LINES, maxChars: FILE_DIFF_MAX_CHARS }),
    ].join("\n");
  } catch (e: any) { return `Error writing file: ${e.message}`; }
}

async function editFile(args: Record<string, unknown>): Promise<string> {
  const normalized = normalizeEditArgs(args);
  const pathError = requireString(normalized, "path");
  if (pathError) return executeError(pathError);
  const rootError = validateRootAliases(normalized);
  if (rootError) return executeError(rootError);
  const replaceAllError = validateOptionalBoolean(args.replace_all, "replace_all");
  if (replaceAllError) return executeError(replaceAllError);
  if (typeof normalized.old_string !== "string" || !normalized.old_string) {
    return executeError("old_string must be a non-empty string");
  }
  if (typeof normalized.new_string !== "string") return executeError("new_string must be a string");
  const path = normalized.path as string;
  const root = workspaceRoot(normalized, path);
  const oldString = normalized.old_string;
  const newString = normalized.new_string;
  const replaceAll = (args.replace_all as boolean) || false;
  try {
    const target = resolveExistingPathInsideRoot(path, String(root));
    const content = readFileSync(target, "utf-8");
    const count = content.split(oldString).length - 1;
    if (count === 0) return `Error: old_string not found in ${path}`;
    if (!replaceAll && count > 1) return `Error: old_string found ${count} times. Use replace_all=true or provide more context.`;
    const nextContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
    writeTextFileAtomic(target, nextContent);
    return [
      `Successfully edited ${path}`,
      "",
      "[diff]",
      diffLines(content, nextContent, path, { maxLines: FILE_DIFF_MAX_LINES, maxChars: FILE_DIFF_MAX_CHARS }),
    ].join("\n");
  } catch (e: any) { return `Error editing file: ${e.message}`; }
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
      return `  ${item.name}${suffix}${size}`;
    });
    return lines.join("\n") || "(empty directory)";
  } catch (e: any) { return `Error listing directory: ${e.message}`; }
}

async function search(args: Record<string, unknown>): Promise<string> {
  const patternError = requireString(args, "pattern");
  if (patternError) return executeError(patternError);
  const pathInput = optionalPathInput(args);
  if (!pathInput.ok) return executeError(pathInput.message);
  const rootError = validateRootAliases(pathInput.args);
  if (rootError) return executeError(rootError);
  if (args.include !== undefined && typeof args.include !== "string") return executeError("include must be a string");
  const caseSensitiveError = validateOptionalBoolean(args.case_sensitive, "case_sensitive");
  if (caseSensitiveError) return executeError(caseSensitiveError);
  const regexError = validateOptionalBoolean(args.regex, "regex");
  if (regexError) return executeError(regexError);
  const { args: normalized, path } = pathInput;
  const pattern = args.pattern as string;
  const include = typeof normalized.include === "string" ? normalized.include : "";
  const caseSensitive = normalized.case_sensitive !== false;
  const regex = normalized.regex === true;
  const boundary = workspaceRoot(normalized, path);
  try {
    const root = resolveExistingPathInsideRoot(path, boundary);
    const rgResult = runRipgrepSearch({ root, pattern, include, caseSensitive, regex });
    if (rgResult !== null) return rgResult;
    const grepArgs = [regex ? "-rnE" : "-rnF"];
    if (!caseSensitive) grepArgs.push("-i");
    grepArgs.push("--directories=recurse", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=.seekcode", "--exclude-dir=.deepseek");
    if (include) grepArgs.push(`--include=${include}`);
    grepArgs.push(pattern, root);
    const result = spawnSync("grep", grepArgs, { encoding: "utf-8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
    if (result.status === 1) return `No matches found for '${pattern}'`;
    if (result.error) return `Error searching: ${result.error.message}`;
    if (result.status && result.status !== 0) return `Error searching: ${result.stderr || `grep exited with ${result.status}`}`;
    return result.stdout.split("\n").filter(Boolean).slice(0, 500).join("\n") || `No matches found for '${pattern}'`;
  } catch (e: any) {
    if (e.code === 1 || e.status === 1) return `No matches found for '${pattern}'`;
    return `Error searching: ${e.message}`;
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
  const pattern = args.pattern as string;
  const boundary = workspaceRoot(normalized, path);
  try {
    const results: string[] = [];
    const root = resolveExistingPathInsideRoot(path, boundary);
    const rgResult = runRipgrepGlob(root, pattern);
    if (rgResult !== null) return rgResult;
    const matcher = globToRegExp(pattern);
    function walk(dir: string) {
      try {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
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
        }
      } catch { /* */ }
    }
    walk(root);
    if (!results.length) return `No files matching '${pattern}'`;
    return results.slice(0, 200).map(m => `  ${relative(root, m).replace(/\\/g, "/")}`).join("\n");
  } catch (e: any) { return `Error in glob: ${e.message}`; }
}

function hasRipgrep(): boolean {
  if (rgAvailableCache !== null) return rgAvailableCache;
  const result = spawnSync("rg", ["--version"], { encoding: "utf-8", timeout: 1000, maxBuffer: 64 * 1024 });
  rgAvailableCache = result.status === 0;
  return rgAvailableCache;
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
  if (result.status === 1) return `No matches found for '${options.pattern}'\n[backend: rg]`;
  if (result.error) return null;
  if (result.status && result.status !== 0) return `Error searching: ${result.stderr || `rg exited with ${result.status}`}`;
  const lines = result.stdout.split("\n").filter(Boolean).slice(0, 500);
  return `${lines.join("\n") || `No matches found for '${options.pattern}'`}\n[backend: rg]`;
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
  if (result.status === 1) return `No files matching '${pattern}'\n[backend: rg]`;
  if (result.status && result.status !== 0) return null;
  const files = result.stdout.split("\n").filter(Boolean).slice(0, 200);
  if (!files.length) return `No files matching '${pattern}'\n[backend: rg]`;
  return `${files.map(file => `  ${renderRgFilePath(root, file)}`).join("\n")}\n[backend: rg]`;
}

function renderRgFilePath(root: string, file: string): string {
  const rendered = file.startsWith("/") || /^[a-zA-Z]:/.test(file)
    ? relative(root, file)
    : file;
  return rendered.replace(/\\/g, "/").replace(/^\.\//, "");
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
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
  const value = args[key];
  return typeof value === "string" && value.trim() ? null : `${key} must be a non-empty string`;
}

function firstPresentString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstPresentContent(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function normalizePathArg(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.path === "string" && args.path.trim()) return args;
  const path = firstPresentString(args, PATH_ALIASES);
  return path ? { ...args, path } : args;
}

function normalizeWriteArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizePathArg(args);
  if (typeof normalized.content === "string") return normalized;
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
  return typeof normalized.path === "string" && normalized.path.trim()
    ? normalized.path.trim()
    : fallback;
}

function filePermissionPatterns(args: Record<string, unknown>): string[] {
  return [toolPath(args)].filter(path => path && path !== "file");
}

function fileActivity(action: string, fallback = "file") {
  return (args: Record<string, unknown>) => `${action} ${toolPath(args, fallback)}`;
}

function fileSummary(action: string, fallback = "file") {
  return (args: Record<string, unknown>) => `${action} ${toolPath(args, fallback)}`;
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
    getPermissionPatterns: (args) => [typeof args.pattern === "string" ? args.pattern.trim() : "", toolPath(args, ".")].filter(Boolean),
    getActivityDescription: (args) => typeof args.pattern === "string" && args.pattern.trim()
      ? `Searching for ${args.pattern.trim()}`
      : "Searching files",
    getToolUseSummary: (args) => typeof args.pattern === "string" && args.pattern.trim()
      ? `Search ${args.pattern.trim()}`
      : "Search files",
    getTranscriptSearchText: textSearch,
    renderMetadata: { userFacingName: "Search", icon: "search", resultKind: "text" },
    validateInput: (args) => {
      const normalized = normalizePathArg(args);
      const message = requireString(args, "pattern");
      if (message) return { ok: false, message };
      const rootError = validateRootAliases(normalized);
      if (rootError) return { ok: false, message: rootError };
      if (normalized.include !== undefined && typeof normalized.include !== "string") {
        return { ok: false, message: "include must be a string" };
      }
      const caseSensitiveError = validateOptionalBoolean(normalized.case_sensitive, "case_sensitive");
      if (caseSensitiveError) return { ok: false, message: caseSensitiveError };
      const regexError = validateOptionalBoolean(normalized.regex, "regex");
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
    getPermissionPatterns: (args) => [typeof args.pattern === "string" ? args.pattern.trim() : "", toolPath(args, ".")].filter(Boolean),
    getActivityDescription: (args) => typeof args.pattern === "string" && args.pattern.trim()
      ? `Finding ${args.pattern.trim()}`
      : "Finding files",
    getToolUseSummary: (args) => typeof args.pattern === "string" && args.pattern.trim()
      ? `Glob ${args.pattern.trim()}`
      : "Find files",
    getTranscriptSearchText: textSearch,
    renderMetadata: { userFacingName: "Glob", icon: "files", resultKind: "text" },
    validateInput: (args) => {
      const normalized = normalizePathArg(args);
      const message = requireString(args, "pattern");
      if (message) return { ok: false, message };
      const rootError = validateRootAliases(normalized);
      return rootError ? { ok: false, message: rootError } : { ok: true, args: normalized };
    },
  });
}
