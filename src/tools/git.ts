/** Git operation tools. */

import { spawnSync } from "node:child_process";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { resolvePathAlias } from "./path-resolution.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_GIT_OUTPUT_CHARS = 200_000;
const MAX_GIT_OUTPUT_LINE_CHARS = 4_000;
const MAX_GIT_WORKDIR_CHARS = 4_096;
const MAX_GIT_FILE_CHARS = 4_096;
const MAX_GIT_FILES = 128;
const MAX_GIT_LOG_COUNT = 200;
const GIT_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const GIT_CONTROL_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function runGit(args: string[], workdir = "."): string {
  try {
    const result = spawnSync("git", args, { cwd: workdir, encoding: "utf-8", timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    if (result.error) return safeGitText(result.error.message, MAX_GIT_OUTPUT_LINE_CHARS);
    const output = result.status === 0 ? result.stdout : (result.stderr || result.stdout);
    return safeGitOutput(output.trim() || "(no output)");
  } catch (e: any) { return safeGitText(e.stderr?.trim() || e.message || "Error running git", MAX_GIT_OUTPUT_LINE_CHARS); }
}

function splitFiles(files: unknown): string[] {
  if (!files) return [];
  if (Array.isArray(files)) {
    const items = readArrayItems(files, MAX_GIT_FILES);
    if (!items.ok) return [];
    return items.values
      .filter((value): value is string => typeof value === "string")
      .map(value => value.trim())
      .filter(Boolean);
  }
  if (typeof files !== "string") return [];
  const value = files.trim();
  return value ? [value] : [];
}

function resolveWorkdir(args: Record<string, unknown>): string {
  const workspacePath = safeProperty(args, "__workspace_path");
  const workdir = safeProperty(args, "workdir");
  const cwd = safeProperty(args, "cwd");
  const base = typeof workspacePath === "string" && workspacePath.trim()
    ? workspacePath.trim()
    : process.cwd();
  if (typeof workdir === "string" && workdir.trim()) return resolvePathAlias(workdir.trim(), base);
  if (typeof cwd === "string" && cwd.trim()) return resolvePathAlias(cwd.trim(), base);
  return base;
}

function normalizeWorkdirArg(args: Record<string, unknown>): { ok: true; workdir?: string } | { ok: false; message: string } {
  const workdir = readArg(args, "workdir");
  if (!workdir.ok) return { ok: false, message: "workdir must be a string" };
  const cwd = readArg(args, "cwd");
  if (!cwd.ok) return { ok: false, message: "workdir must be a string" };
  for (const value of [workdir.value, cwd.value]) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") return { ok: false, message: "workdir must be a string" };
    if (!value.trim()) continue;
    const error = validateBoundedGitText(value, "workdir", MAX_GIT_WORKDIR_CHARS);
    if (error) return { ok: false, message: error };
    return { ok: true, workdir: value.trim() };
  }
  return { ok: true };
}

function normalizeFilesArg(files: unknown): { ok: true; files: string[] } | { ok: false; message: string } {
  if (files === undefined) return { ok: true, files: [] };
  if (typeof files === "string") {
    const error = files.trim() ? validateBoundedGitText(files, "files", MAX_GIT_FILE_CHARS) : null;
    if (error) return { ok: false, message: error };
    const value = files.trim();
    return { ok: true, files: value ? [value] : [] };
  }
  if (!Array.isArray(files)) {
    return { ok: false, message: "files must be a string or array of strings" };
  }
  const items = readArrayItems(files, MAX_GIT_FILES + 1);
  if (!items.ok || items.values.some(value => typeof value !== "string")) {
    return { ok: false, message: "files must be a string or array of strings" };
  }
  if (items.length > MAX_GIT_FILES) return { ok: false, message: `files must contain ${MAX_GIT_FILES} entries or fewer` };
  const fileValues = items.values.filter((value): value is string => typeof value === "string");
  for (const file of fileValues) {
    const error = file.trim() ? validateBoundedGitText(file, "files", MAX_GIT_FILE_CHARS) : null;
    if (error) return { ok: false, message: error };
  }
  return {
    ok: true,
    files: fileValues.map(value => value.trim()).filter(Boolean),
  };
}

function normalizePositiveIntArg(value: unknown, key: string): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[-+]?\d+$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return { ok: false, message: `${key} must be a positive integer` };
  return { ok: true, value: Math.min(parsed, MAX_GIT_LOG_COUNT) };
}

function normalizeBooleanArg(value: unknown, key: string): { ok: true; value?: boolean } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  return typeof value === "boolean"
    ? { ok: true, value }
    : { ok: false, message: `${key} must be a boolean` };
}

function validateGitArgs(
  args: Record<string, unknown>,
  options: { files?: boolean; n?: boolean; staged?: boolean } = {},
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  const workdir = normalizeWorkdirArg(args);
  if (!workdir.ok) return workdir;
  const normalized: Record<string, unknown> = safeCloneArgs(args);
  if (workdir.workdir !== undefined) normalized.workdir = workdir.workdir;

  if (options.files) {
    const fileInput = readArg(args, "files");
    if (!fileInput.ok) return { ok: false, message: "files must be a string or array of strings" };
    const files = normalizeFilesArg(fileInput.value);
    if (!files.ok) return files;
    if (fileInput.value !== undefined) normalized.files = Array.isArray(fileInput.value) ? files.files : files.files[0] || "";
  }

  if (options.n) {
    const n = readArg(args, "n");
    if (!n.ok) return { ok: false, message: "n must be a positive integer" };
    const count = normalizePositiveIntArg(n.value, "n");
    if (!count.ok) return count;
    if (count.value !== undefined) normalized.n = count.value;
  }

  if (options.staged) {
    const stagedInput = readArg(args, "staged");
    if (!stagedInput.ok) return { ok: false, message: "staged must be a boolean" };
    const staged = normalizeBooleanArg(stagedInput.value, "staged");
    if (!staged.ok) return staged;
    if (staged.value !== undefined) normalized.staged = staged.value;
  }

  return { ok: true, args: normalized };
}

async function gitStatus(a: Record<string, unknown>): Promise<string> {
  const normalized = validateGitArgs(a);
  if (!normalized.ok) return `Error: ${normalized.message}`;
  return runGit(["status", "--short"], resolveWorkdir(normalized.args));
}
async function gitDiff(a: Record<string, unknown>): Promise<string> {
  const normalized = validateGitArgs(a, { files: true, staged: true });
  if (!normalized.ok) return `Error: ${normalized.message}`;
  const args = ["diff", "--no-ext-diff", "--no-textconv"];
  if (normalized.args.staged === true) args.push("--staged");
  args.push("--", ...splitFiles(normalized.args.files));
  return runGit(args, resolveWorkdir(normalized.args));
}
async function gitLog(a: Record<string, unknown>): Promise<string> {
  const normalized = validateGitArgs(a, { n: true });
  if (!normalized.ok) return `Error: ${normalized.message}`;
  return runGit(["log", `-${normalized.args.n || 10}`, "--oneline", "--decorate"], resolveWorkdir(normalized.args));
}
async function gitBranch(a: Record<string, unknown>): Promise<string> {
  const normalized = validateGitArgs(a);
  if (!normalized.ok) return `Error: ${normalized.message}`;
  return runGit(["branch", "--list"], resolveWorkdir(normalized.args));
}

function validateBoundedGitText(value: string, key: string, maxChars: number): string | null {
  if (value.length > maxChars) return `${key} must be ${maxChars} characters or fewer`;
  if (GIT_CONTROL_RE.test(value)) return `${key} contains unsupported control characters`;
  return null;
}

function safeGitOutput(value: string): string {
  let truncated = false;
  const lines = value
    .replace(GIT_CONTROL_GLOBAL_RE, " ")
    .split("\n")
    .map(line => {
      if (line.length > MAX_GIT_OUTPUT_LINE_CHARS) truncated = true;
      return safeSliceTextBoundary(line, MAX_GIT_OUTPUT_LINE_CHARS);
    });
  const output = lines.join("\n");
  if (output.length > MAX_GIT_OUTPUT_CHARS) return `${safeSliceTextBoundary(output, MAX_GIT_OUTPUT_CHARS)}\n[truncated]`;
  return truncated ? `${output}\n[truncated]` : output;
}

function safeGitText(value: string, maxChars: number): string {
  return safeSliceTextBoundary(value.replace(GIT_CONTROL_GLOBAL_RE, " "), maxChars);
}

function readArg(args: Record<string, unknown>, key: string): { ok: true; value: unknown } | { ok: false; value?: undefined } {
  try {
    return { ok: true, value: args[key] };
  } catch {
    return { ok: false };
  }
}

function safeProperty(args: Record<string, unknown>, key: string): unknown {
  const read = readArg(args, key);
  return read.ok ? read.value : undefined;
}

function readArrayItems(value: unknown[], maxItems: number): { ok: true; values: unknown[]; length: number } | { ok: false; values?: undefined; length?: undefined } {
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return { ok: false };
  }
  const limit = Math.min(length, Math.max(0, Math.floor(maxItems)));
  const values: unknown[] = [];
  for (let index = 0; index < limit; index++) {
    try {
      values.push(value[index]);
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, values, length };
}

function safeCloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(args);
  } catch {
    return clone;
  }
  for (const key of keys) {
    const read = readArg(args, key);
    if (read.ok) clone[key] = read.value;
  }
  return clone;
}

export function registerGitTools(): void {
  const r = getRegistry();
  r.register({
    name: "git_status", description: "Show git working tree status.",
    parameters: { type: "object", properties: { workdir: { type: "string", default: "." } } },
    execute: gitStatus, permission: PermissionLevel.ALWAYS_ALLOW, category: "git", parallelOk: true,
    readOnly: true, searchHint: "working tree status", resultKind: "text",
    validateInput: (args) => validateGitArgs(args),
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: true, isList: true }),
  });
  r.register({
    name: "git_diff", description: "Show git diff.",
    parameters: {
      type: "object",
      properties: {
        staged: { type: "boolean", default: false },
        files: {
          oneOf: [
            { type: "string", default: "" },
            { type: "array", items: { type: "string" } },
          ],
        },
        workdir: { type: "string", default: "." },
      },
    },
    execute: gitDiff, permission: PermissionLevel.ALWAYS_ALLOW, category: "git", parallelOk: true,
    readOnly: true, searchHint: "diff local changes", resultKind: "diff", maxResultSizeChars: 100_000,
    validateInput: (args) => validateGitArgs(args, { files: true, staged: true }),
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
  });
  r.register({
    name: "git_log", description: "Show recent commit history.",
    parameters: { type: "object", properties: { n: { type: "integer", default: 10 }, workdir: { type: "string", default: "." } } },
    execute: gitLog, permission: PermissionLevel.ALWAYS_ALLOW, category: "git", parallelOk: true,
    readOnly: true, searchHint: "commit history", resultKind: "text",
    validateInput: (args) => validateGitArgs(args, { n: true }),
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: true, isList: true }),
  });
  r.register({
    name: "git_branch", description: "List local branches.",
    parameters: { type: "object", properties: { workdir: { type: "string", default: "." } } },
    execute: gitBranch, permission: PermissionLevel.ALWAYS_ALLOW, category: "git", parallelOk: true,
    readOnly: true, searchHint: "list branches", resultKind: "text",
    validateInput: (args) => validateGitArgs(args),
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: false, isList: true }),
  });
}
