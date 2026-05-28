/** Approval policy, sandbox mode, trust boundary, and workspace boundary checks. */

import { isAbsolute, resolve } from "node:path";
import type { Config } from "../config.js";
import type { ApprovalContext } from "./base.js";
import { isToolDestructive, isToolReadOnly } from "./base.js";
import { checkCommand, isCommandReadOnly } from "./exec-policy.js";
import {
  canonicalizePathOrNearestExisting,
  canonicalizeWorkspaceBoundary,
  isPathInsideRoot,
  resolvePathAlias,
} from "./path-resolution.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

export type SandboxDecision = "allow" | "ask" | "deny";

export interface SandboxCheckResult {
  decision: SandboxDecision;
  reason: string;
}

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "github_comment", "github_close_issue", "mcp_manager"]);
const FILE_PATH_ARGS = ["path", "target_file", "workdir", "root", "cwd", "workspace"];
const FILE_ARRAY_ARGS = ["files"];
const SHELL_COMMAND_TOOLS = new Set(["bash", "task_shell_start", "task_gate_run", "task_create"]);
const MAX_SANDBOX_TOKEN_CHARS = 4_000;
const MAX_SANDBOX_PATH_CANDIDATES = 256;
const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bchmod\s+(?:-R\s+)?777\b/,
  /\bdd\s+if=/,
  /\bmkfs\./,
  />\s*\/dev\/sd[a-z]/,
  /:\{\s*:\|:&\s*\};:/,
];

export function checkSandboxPolicy(config: Config, ctx: ApprovalContext): SandboxCheckResult {
  if (config.sandbox_mode === "danger-full-access" && config.approval_policy === "never") {
    return { decision: "allow", reason: "danger-full-access with never approval policy" };
  }

  const workspace = resolve(normalizeWorkspacePath(safeProperty(ctx, "workspace_path")));
  if (config.workspace_boundary && hasMalformedWorkspacePathArgs(ctx)) {
    return { decision: "deny", reason: "tool arguments contain invalid workspace path values" };
  }
  if (config.workspace_boundary && escapesWorkspace(ctx, workspace)) {
    return { decision: "deny", reason: `tool arguments escape workspace boundary: ${workspace}` };
  }

  const trusted = isTrustedWorkspace(config, workspace);
  if (config.sandbox_mode === "read-only" && isMutationTool(ctx)) {
    return { decision: "deny", reason: "read-only sandbox blocks mutating tools" };
  }

  const shellCommand = getShellCommand(ctx);
  if (shellCommand !== null) {
    if (config.sandbox_mode === "read-only" && !isCommandReadOnly(shellCommand)) {
      return { decision: "deny", reason: "read-only sandbox blocks shell mutations" };
    }
    if (config.workspace_boundary && shellCommandEscapesWorkspace(shellCommand, workspace, shellWorkdir(ctx, workspace))) {
      return { decision: "deny", reason: `shell command escapes workspace boundary: ${workspace}` };
    }
    const commandPolicy = checkCommand(shellCommand);
    if (commandPolicy.decision === "deny") {
      return { decision: "deny", reason: `shell command blocked by policy: ${commandPolicy.justification}` };
    }
    if (commandPolicy.decision === "ask") {
      return { decision: "ask", reason: `shell command requires approval: ${commandPolicy.justification}` };
    }
    if (!trusted && DANGEROUS_SHELL_PATTERNS.some(pattern => pattern.test(shellCommand))) {
      return { decision: "deny", reason: "untrusted workspace blocks dangerous shell command" };
    }
  }

  if (config.approval_policy === "untrusted" && !trusted && isMutationTool(ctx)) {
    return { decision: "ask", reason: "mutation in untrusted workspace requires approval" };
  }
  if (config.approval_policy === "never") return { decision: "allow", reason: "approval policy never" };
  return { decision: "allow", reason: "sandbox policy passed" };
}

export function isTrustedWorkspace(config: Config, workspacePath: string): boolean {
  const workspace = canonicalizePathOrNearestExisting(workspacePath || ".");
  return (config.trusted_workspaces || []).some(item => {
    const trusted = canonicalizePathOrNearestExisting(expandHome(item));
    return isPathInsideRoot(workspace, trusted);
  });
}

function isMutationTool(ctx: ApprovalContext): boolean {
  const toolDef = safeProperty(ctx, "tool_def") as ApprovalContext["tool_def"] | undefined;
  const toolArgs = safeToolArgs(ctx);
  if (isToolDestructive(toolDef as ApprovalContext["tool_def"], toolArgs)) return true;
  if (isToolReadOnly(toolDef as ApprovalContext["tool_def"], toolArgs)) return false;
  const toolName = safeString(safeProperty(ctx, "tool_name"));
  return typeof toolName === "string" && WRITE_TOOLS.has(toolName);
}

function getShellCommand(ctx: ApprovalContext): string | null {
  const toolName = safeString(safeProperty(ctx, "tool_name"));
  if (typeof toolName !== "string" || !SHELL_COMMAND_TOOLS.has(toolName)) return null;
  const raw = safeArg(ctx, "command");
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function shellWorkdir(ctx: ApprovalContext, workspace: string): string {
  const workdir = safeArg(ctx, "workdir");
  const cwd = safeArg(ctx, "cwd");
  const raw = typeof workdir === "string" && workdir.trim()
    ? workdir
    : cwd;
  if (typeof raw !== "string" || raw.trim() === "") return workspace;
  return resolvePathAlias(raw, workspace);
}

function escapesWorkspace(ctx: ApprovalContext, workspace: string): boolean {
  for (const key of FILE_PATH_ARGS) {
    const raw = safeArg(ctx, key);
    if (typeof raw !== "string" || raw.trim() === "") continue;
    if (!isInsideWorkspace(resolvePathAlias(raw, workspace), workspace)) return true;
  }
  for (const key of FILE_ARRAY_ARGS) {
    const value = safeArg(ctx, key);
    const values = pathListValues(value);
    for (const raw of values) {
      if (typeof raw !== "string" || raw.trim() === "") continue;
      if (!isInsideWorkspace(resolvePathAlias(raw, workspace), workspace)) return true;
    }
  }
  return false;
}

function isInsideWorkspace(path: string, workspace: string): boolean {
  return canonicalizeWorkspaceBoundary(path, workspace);
}

function shellCommandEscapesWorkspace(command: string, workspace: string, shellCwd: string): boolean {
  let checked = 0;
  for (const token of tokenizeShell(command)) {
    for (const candidate of extractShellPathCandidates(token)) {
      if (checked++ >= MAX_SANDBOX_PATH_CANDIDATES) return true;
      if (!isInsideWorkspace(resolveShellPath(candidate, shellCwd), workspace)) return true;
    }
  }
  return false;
}

function tokenizeShell(command: string): string[] {
  return command
    .split(/[\s"'`]+/)
    .map(token => token.trim())
    .filter(Boolean)
    .map(token => safeSliceTextBoundary(token, MAX_SANDBOX_TOKEN_CHARS))
    .map(token => token.replace(/[),;|&]+$/g, "").replace(/^[({]+/g, ""));
}

function extractShellPathCandidate(token: string): string | null {
  if (!token) return null;
  if (token.startsWith("file:///")) return token.replace(/^file:\/\//, "");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) return null;
  if (token === "." || token === "..") return token;
  if (token.includes("=")) {
    const [, value = ""] = token.split("=", 2);
    if (value && !token.startsWith("-")) return extractShellPathCandidate(value);
  }
  if (token === "~" || token.startsWith("~/")) return expandHome(token);
  if (token.startsWith("/") || token.startsWith("./") || token.startsWith("../")) return token;
  const shortOptionPath = shortOptionPathCandidate(token);
  if (shortOptionPath) return shortOptionPath;
  if (token.startsWith("-") && token.includes("=")) {
    const [, value = ""] = token.split("=", 2);
    return extractShellPathCandidate(value);
  }
  if (token.includes("/")) return token;
  return null;
}

function extractShellPathCandidates(token: string): string[] {
  const candidates: string[] = [];
  for (const expanded of expandBracePathToken(token)) {
    const candidate = extractShellPathCandidate(expanded);
    if (candidate) candidates.push(candidate);
    if (candidates.length >= 32) break;
  }
  return [...new Set(candidates)];
}

function hasMalformedWorkspacePathArgs(ctx: ApprovalContext): boolean {
  for (const key of FILE_PATH_ARGS) {
    const read = readArg(ctx, key);
    if (!read.ok) return true;
    const value = read.value;
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") return true;
  }
  for (const key of FILE_ARRAY_ARGS) {
    const read = readArg(ctx, key);
    if (!read.ok) return true;
    const value = read.value;
    if (value === undefined || value === null) continue;
    if (typeof value === "string") continue;
    if (!Array.isArray(value)) return true;
    const items = readPathArrayItems(value);
    if (!items.ok) return true;
    for (const item of items.values) {
      if (item !== undefined && item !== null && item !== "" && typeof item !== "string") return true;
    }
  }
  return false;
}

function pathListValues(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[,\n]/).map(item => item.trim()).filter(Boolean);
  if (Array.isArray(value)) return safeArrayItems(value, MAX_SANDBOX_PATH_CANDIDATES).filter((item): item is string => typeof item === "string");
  return [];
}

function expandBracePathToken(token: string): string[] {
  const match = token.match(/^(.*)\{([^{}]+)\}(.*)$/);
  if (!match?.[2]?.includes(",")) return [token];
  const prefix = match[1] ?? "";
  const suffix = match[3] ?? "";
  const values = match[2].split(",").slice(0, 32);
  return values.map(value => `${prefix}${value}${suffix}`);
}

function shortOptionPathCandidate(token: string): string | null {
  const match = token.match(/^-[A-Za-z]([^-=].*)$/);
  if (!match?.[1]) return null;
  const value = match[1];
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value === "~" || value.startsWith("~/")
    ? value
    : null;
}

function resolveShellPath(path: string, shellCwd: string): string {
  if (path === "~" || path.startsWith("~/")) return resolve(expandHome(path));
  if (isAbsolute(path)) return resolve(path);
  return resolvePathAlias(path, shellCwd);
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME || path;
  if (path.startsWith("~/")) return `${process.env.HOME || "~"}${path.slice(1)}`;
  return path;
}

function normalizeWorkspacePath(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : ".";
}

function safeToolArgs(ctx: ApprovalContext): Record<string, unknown> {
  const value = safeProperty(ctx, "tool_args");
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArg(ctx: ApprovalContext, key: string): { ok: true; value: unknown } | { ok: false; value?: undefined } {
  const args = safeToolArgs(ctx);
  try {
    return { ok: true, value: args[key] };
  } catch {
    return { ok: false };
  }
}

function safeArg(ctx: ApprovalContext, key: string): unknown {
  const read = readArg(ctx, key);
  return read.ok ? read.value : undefined;
}

function safeArrayItems(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return [];
  }
  const limit = Math.min(length, Math.max(0, Math.floor(maxItems)));
  const items: unknown[] = [];
  for (let index = 0; index < limit; index++) {
    try {
      items.push(value[index]);
    } catch {
      items.push(undefined);
    }
  }
  return items;
}

function readPathArrayItems(value: unknown[]): { ok: true; values: unknown[] } | { ok: false; values?: undefined } {
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return { ok: false };
  }
  if (length > MAX_SANDBOX_PATH_CANDIDATES) return { ok: false };
  const values: unknown[] = [];
  for (let index = 0; index < length; index++) {
    try {
      values.push(value[index]);
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, values };
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeProperty(source: unknown, key: string | number | symbol): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string | number | symbol, unknown>)[key];
  } catch {
    return undefined;
  }
}
