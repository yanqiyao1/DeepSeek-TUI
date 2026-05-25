/** Git operation tools. */

import { spawnSync } from "node:child_process";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { resolvePathAlias } from "./path-resolution.js";

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
    return files
      .filter((value): value is string => typeof value === "string")
      .map(value => value.trim())
      .filter(Boolean);
  }
  if (typeof files !== "string") return [];
  const value = files.trim();
  return value ? [value] : [];
}

function resolveWorkdir(args: Record<string, unknown>): string {
  const base = typeof args.__workspace_path === "string" && args.__workspace_path.trim()
    ? args.__workspace_path.trim()
    : process.cwd();
  if (typeof args.workdir === "string" && args.workdir.trim()) return resolvePathAlias(args.workdir.trim(), base);
  if (typeof args.cwd === "string" && args.cwd.trim()) return resolvePathAlias(args.cwd.trim(), base);
  return base;
}

function normalizeWorkdirArg(args: Record<string, unknown>): { ok: true; workdir?: string } | { ok: false; message: string } {
  const workdir = args.workdir ?? args.cwd;
  if (workdir !== undefined && typeof workdir !== "string") return { ok: false, message: "workdir must be a string" };
  if (typeof workdir === "string" && workdir.trim()) {
    const error = validateBoundedGitText(workdir, "workdir", MAX_GIT_WORKDIR_CHARS);
    if (error) return { ok: false, message: error };
    return { ok: true, workdir: workdir.trim() };
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
  if (!Array.isArray(files) || files.some(value => typeof value !== "string")) {
    return { ok: false, message: "files must be a string or array of strings" };
  }
  if (files.length > MAX_GIT_FILES) return { ok: false, message: `files must contain ${MAX_GIT_FILES} entries or fewer` };
  for (const file of files) {
    const error = file.trim() ? validateBoundedGitText(file, "files", MAX_GIT_FILE_CHARS) : null;
    if (error) return { ok: false, message: error };
  }
  return {
    ok: true,
    files: files.map(value => value.trim()).filter(Boolean),
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
  const normalized: Record<string, unknown> = { ...args };
  if (workdir.workdir !== undefined) normalized.workdir = workdir.workdir;

  if (options.files) {
    const files = normalizeFilesArg(args.files);
    if (!files.ok) return files;
    if (args.files !== undefined) normalized.files = Array.isArray(args.files) ? files.files : files.files[0] || "";
  }

  if (options.n) {
    const count = normalizePositiveIntArg(args.n, "n");
    if (!count.ok) return count;
    if (count.value !== undefined) normalized.n = count.value;
  }

  if (options.staged) {
    const staged = normalizeBooleanArg(args.staged, "staged");
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
      return line.slice(0, MAX_GIT_OUTPUT_LINE_CHARS);
    });
  const output = lines.join("\n");
  if (output.length > MAX_GIT_OUTPUT_CHARS) return `${output.slice(0, MAX_GIT_OUTPUT_CHARS)}\n[truncated]`;
  return truncated ? `${output}\n[truncated]` : output;
}

function safeGitText(value: string, maxChars: number): string {
  return value.replace(GIT_CONTROL_GLOBAL_RE, " ").slice(0, maxChars);
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
