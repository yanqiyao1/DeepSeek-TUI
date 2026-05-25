/** Apply patch tool. */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { applyPatch as applyAdvancedPatch, formatPatchResult } from "./patch-advanced.js";
import { resolvePathAlias } from "./path-resolution.js";

const MAX_PATCH_TOOL_CHARS = 1_000_000;
const MAX_PATCH_TOOL_WORKDIR_CHARS = 4_096;
const MAX_PATCH_TOOL_PATTERN_CHARS = 4_096;
const PATCH_TOOL_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const PATCH_TOOL_CONTROL_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function normalizePatchWorkdir(args: Record<string, unknown>): string | undefined {
  if (typeof args.workdir === "string" && args.workdir.trim()) return sanitizePatchToolText(args.workdir, MAX_PATCH_TOOL_WORKDIR_CHARS).trim();
  if (typeof args.cwd === "string" && args.cwd.trim()) return sanitizePatchToolText(args.cwd, MAX_PATCH_TOOL_WORKDIR_CHARS).trim();
  if (typeof args.root === "string" && args.root.trim()) return sanitizePatchToolText(args.root, MAX_PATCH_TOOL_WORKDIR_CHARS).trim();
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
  if (typeof args.target_file === "string" && args.target_file.trim()) return `Patch ${args.target_file.trim()}`;
  if (typeof args.patch === "string") {
    const files = patchFiles(args.patch);
    if (files.length === 1) return `Patch ${files[0]}`;
    if (files.length > 1) return `Patch ${files.length} files`;
  }
  return "Apply patch";
}

async function applyPatch(args: Record<string, unknown>): Promise<string> {
  if (typeof args.patch !== "string" || !args.patch.trim()) {
    return "Patch failed:\npatch must be a non-empty string";
  }
  const patchError = validatePatchToolText(args.patch, "patch", MAX_PATCH_TOOL_CHARS, true);
  if (patchError) return `Patch failed:\n${patchError}`;
  const workdirInput = normalizePatchWorkdir(args);
  const rawWorkdirInput = args.workdir ?? args.cwd ?? args.root;
  if (rawWorkdirInput !== undefined && workdirInput === undefined) {
    return "Patch failed:\nworkdir must be a string";
  }
  if (typeof rawWorkdirInput === "string") {
    const workdirError = validatePatchToolText(rawWorkdirInput, "workdir", MAX_PATCH_TOOL_WORKDIR_CHARS, false);
    if (workdirError) return `Patch failed:\n${workdirError}`;
  }
  const patch = args.patch;
  const base = typeof args.__workspace_path === "string" && args.__workspace_path.trim()
    ? args.__workspace_path.trim()
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
      const files = typeof args.patch === "string" ? patchFiles(args.patch) : [];
      if (typeof args.target_file === "string" && args.target_file.trim()) files.unshift(args.target_file.trim());
      return [...new Set(files)];
    },
    toAutoClassifierInput: (args) => typeof args.patch === "string" ? args.patch : "",
    getActivityDescription: (args) => patchSummary(args).replace(/^Patch /, "Applying patch to "),
    getToolUseSummary: patchSummary,
    getTranscriptSearchText: (result) => result,
    renderMetadata: { userFacingName: "Patch", icon: "file-diff", resultKind: "diff" },
    validateInput: (args) => {
      const patch = args.patch;
      if (typeof patch !== "string" || !patch.trim()) {
        return { ok: false, message: "patch must be a non-empty string" };
      }
      const patchError = validatePatchToolText(patch, "patch", MAX_PATCH_TOOL_CHARS, true);
      if (patchError) return { ok: false, message: patchError };
      const workdir = normalizePatchWorkdir(args);
      if ((args.workdir ?? args.cwd ?? args.root) !== undefined && workdir === undefined) {
        return { ok: false, message: "workdir must be a string" };
      }
      const rawWorkdir = args.workdir ?? args.cwd ?? args.root;
      if (typeof rawWorkdir === "string") {
        const workdirError = validatePatchToolText(rawWorkdir, "workdir", MAX_PATCH_TOOL_WORKDIR_CHARS, false);
        if (workdirError) return { ok: false, message: workdirError };
      }
      return workdir === undefined
        ? { ok: true }
        : { ok: true, args: { ...args, workdir } };
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
  return String(value ?? "").replace(PATCH_TOOL_CONTROL_GLOBAL_RE, " ").slice(0, maxChars);
}
