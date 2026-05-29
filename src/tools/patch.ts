/** Apply patch tool. */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { applyPatch as applyAdvancedPatch, formatPatchResult } from "./patch-advanced.js";
import { resolvePathAlias } from "./path-resolution.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_PATCH_TOOL_CHARS = 1_000_000;
const MAX_PATCH_TOOL_WORKDIR_CHARS = 4_096;
const MAX_PATCH_TOOL_PATTERN_CHARS = 4_096;
const PATCH_TOOL_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const PATCH_TOOL_CONTROL_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const UNREADABLE_PATCH_ARG = Symbol("unreadable_patch_arg");

function normalizePatchWorkdir(args: Record<string, unknown>): string | undefined {
  const workdir = safePatchProperty(args, "workdir");
  const cwd = safePatchProperty(args, "cwd");
  const root = safePatchProperty(args, "root");
  if (typeof workdir === "string" && workdir.trim()) return sanitizePatchToolText(workdir, MAX_PATCH_TOOL_WORKDIR_CHARS).trim();
  if (typeof cwd === "string" && cwd.trim()) return sanitizePatchToolText(cwd, MAX_PATCH_TOOL_WORKDIR_CHARS).trim();
  if (typeof root === "string" && root.trim()) return sanitizePatchToolText(root, MAX_PATCH_TOOL_WORKDIR_CHARS).trim();
  return undefined;
}

function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match?.[1] && !PATCH_TOOL_CONTROL_RE.test(match[1])) files.add(sanitizePatchToolText(match[1].trim(), MAX_PATCH_TOOL_PATTERN_CHARS));
  }
  return [...files];
}

function patchSummary(args: Record<string, unknown>): string {
  const targetFile = safePatchProperty(args, "target_file");
  const patch = safePatchProperty(args, "patch");
  if (typeof targetFile === "string" && targetFile.trim()) return `Patch ${targetFile.trim()}`;
  if (typeof patch === "string") {
    const files = patchFiles(patch);
    if (files.length === 1) return `Patch ${files[0]}`;
    if (files.length > 1) return `Patch ${files.length} files`;
  }
  return "Apply patch";
}

async function applyPatch(args: Record<string, unknown>): Promise<string> {
  const patchInput = safePatchProperty(args, "patch");
  if (typeof patchInput !== "string" || !patchInput.trim()) {
    return "Patch failed:\npatch must be a non-empty string";
  }
  const patchError = validatePatchToolText(patchInput, "patch", MAX_PATCH_TOOL_CHARS, true);
  if (patchError) return `Patch failed:\n${patchError}`;
  const workdirInput = normalizePatchWorkdir(args);
  const rawWorkdirInput = firstPatchValue(args, ["workdir", "cwd", "root"]);
  if (rawWorkdirInput !== undefined && workdirInput === undefined) {
    return "Patch failed:\nworkdir must be a string";
  }
  if (typeof rawWorkdirInput === "string") {
    const workdirError = validatePatchToolText(rawWorkdirInput, "workdir", MAX_PATCH_TOOL_WORKDIR_CHARS, false);
    if (workdirError) return `Patch failed:\n${workdirError}`;
  }
  const patch = patchInput;
  const workspacePath = safePatchProperty(args, "__workspace_path");
  const base = typeof workspacePath === "string" && workspacePath.trim()
    ? workspacePath.trim()
    : process.cwd();
  const workdir = workdirInput ? resolvePathAlias(workdirInput, base) : base;
  try {
    const results = applyAdvancedPatch(patch, { workdir });
    const formatted = formatPatchResult(results);
    return results.some(result => result.type === "error")
      ? `Patch failed:\n${formatted}`
      : `Patch applied successfully:\n${formatted}`;
  } catch (e: any) { return `Patch failed:\n${sanitizePatchToolText(e.message, MAX_PATCH_TOOL_PATTERN_CHARS)}`; }
}

export function registerPatchTool(): void {
  getRegistry().register({
    name: "apply_patch", description: "Apply a unified diff patch.",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string" },
        workdir: { type: "string", description: "Optional workspace root where the patch is applied." },
        target_file: { type: "string", default: "" },
      },
      required: ["patch"],
    },
    execute: applyPatch,
    permission: PermissionLevel.ASK,
    category: "file",
    parallelOk: false,
    destructive: true,
    searchHint: "apply unified diff",
    resultKind: "diff",
    getPermissionPatterns: (args) => {
      const patch = safePatchProperty(args, "patch");
      const targetFile = safePatchProperty(args, "target_file");
      const files = typeof patch === "string" ? patchFiles(patch) : [];
      if (typeof targetFile === "string" && targetFile.trim()) files.unshift(targetFile.trim());
      return [...new Set(files)];
    },
    toAutoClassifierInput: (args) => {
      const patch = safePatchProperty(args, "patch");
      return typeof patch === "string" ? patch : "";
    },
    getActivityDescription: (args) => patchSummary(args).replace(/^Patch /, "Applying patch to "),
    getToolUseSummary: patchSummary,
    getTranscriptSearchText: (result) => result,
    renderMetadata: { userFacingName: "Patch", icon: "file-diff", resultKind: "diff" },
    validateInput: (args) => {
      const patch = safePatchProperty(args, "patch");
      if (typeof patch !== "string" || !patch.trim()) {
        return { ok: false, message: "patch must be a non-empty string" };
      }
      const patchError = validatePatchToolText(patch, "patch", MAX_PATCH_TOOL_CHARS, true);
      if (patchError) return { ok: false, message: patchError };
      const workdir = normalizePatchWorkdir(args);
      if (firstPatchValue(args, ["workdir", "cwd", "root"]) !== undefined && workdir === undefined) {
        return { ok: false, message: "workdir must be a string" };
      }
      const rawWorkdir = firstPatchValue(args, ["workdir", "cwd", "root"]);
      if (typeof rawWorkdir === "string") {
        const workdirError = validatePatchToolText(rawWorkdir, "workdir", MAX_PATCH_TOOL_WORKDIR_CHARS, false);
        if (workdirError) return { ok: false, message: workdirError };
      }
      return workdir === undefined
        ? { ok: true }
        : { ok: true, args: { ...safePatchCloneArgs(args), workdir } };
    },
  });
}

function validatePatchToolText(value: string, key: string, maxChars: number, requireNonEmpty: boolean): string | null {
  if (requireNonEmpty && !value.trim()) return `${key} must be a non-empty string`;
  if (value.length > maxChars) return `${key} must be ${maxChars} characters or fewer`;
  if (PATCH_TOOL_CONTROL_RE.test(value)) return `${key} contains unsupported control characters`;
  return null;
}

function sanitizePatchToolText(value: unknown, maxChars: number): string {
  return safeSliceTextBoundary(stringFromPatchValue(value).replace(PATCH_TOOL_CONTROL_GLOBAL_RE, " "), maxChars);
}

function firstPatchValue(args: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = safePatchProperty(args, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function safePatchProperty(source: unknown, key: string | number | symbol): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string | number | symbol, unknown>)[key];
  } catch {
    return UNREADABLE_PATCH_ARG;
  }
}

function safePatchCloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(args);
  } catch {
    return clone;
  }
  for (const key of keys) {
    const value = safePatchProperty(args, key);
    if (value !== UNREADABLE_PATCH_ARG) clone[key] = value;
  }
  return clone;
}

function stringFromPatchValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null || value === UNREADABLE_PATCH_ARG) return "";
  try {
    return String(value);
  } catch {
    return "";
  }
}
